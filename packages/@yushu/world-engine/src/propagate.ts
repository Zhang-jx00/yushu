import { createHash } from "node:crypto";
import { YushuError } from "@yushu/core";
import type { IndexEntityRow, IndexRefRow } from "./index-input.js";

/**
 * 影响传播的反向遍历（docs/03 §7 / M4 T4-5，R60）。
 *
 * 改一个上游字段会波及谁——答案必须**逐项可确认**，绝不能静默改一批卡（红线：AI 与引擎都不直接覆盖设定）。
 * 本文件只做纯计算：输入是设定索引已有的 `entities / refs` 两份行表，输出是一份待确认提案，
 * 落盘与面板决策都在桌面侧（R61）。
 *
 * 三条"不猜"：
 * ① **只走反向边**（谁引用了我）。把被改实体自己引用的东西也算成受影响，等于把依赖图读反；
 * ② 关系权重**没定义就按 1 计并标 `weightAssumed`**——编一个小数等于把"这条边影响不大"写成事实；
 * ③ 深度封顶**如实给出被砍掉的那一层**，成环**整单阻断并给环路径**：半张传播表比没有更危险，
 *    作者会以为那就是全部影响面。
 */

/** 触发传播的那次改动 */
export interface PropagateChange {
  entity: string;
  field: string;
}

export interface PropagateInput {
  entities: readonly IndexEntityRow[];
  refs: readonly IndexRefRow[];
}

export interface PropagateOptions {
  /** 最大传播深度（默认 3）。到深度就停，并把被砍掉的下一层如实报出 */
  maxDepth?: number;
  /** 关系权重（0~1 的衰减系数）；未列出的关系按 1 计并标 assumed */
  weights?: Readonly<Record<string, number>>;
}

export type ImpactSeverity = "error" | "warn" | "info";

export interface ImpactRow {
  entity: string;
  /** 触发这次波及的那条边 */
  relation: string;
  /** 距被改实体几跳（1 起） */
  depth: number;
  severity: ImpactSeverity;
  /** 显式传播路径：从被改实体一路到本行（含两端） */
  path: string[];
  /** 路径上各边权重的累乘 */
  weight: number;
  /** 路径上存在未定义权重的边 */
  weightAssumed: boolean;
}

export interface Proposal {
  proposalId: string;
  change: PropagateChange;
  status: "awaiting_confirmation" | "blocked";
  impact: ImpactRow[];
  /** 深度封顶：frontier = 被砍掉的下一层节点，count = 其条数 */
  truncated: { frontier: string[]; count: number } | null;
  /** 成环时的环路径（首尾同 id）；无环为 null */
  cycle: string[] | null;
  /** 走过且没有定义权重的关系名（去重、码点序） */
  assumedRelations: string[];
  maxDepth: number;
}

export class PropagateError extends YushuError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "PropagateError";
  }
}

export const PROPAGATE_DEFAULT_MAX_DEPTH = 3;

/** 码点序比较（红线：不用 localeCompare，换机器换 locale 不能换序） */
function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function severityFor(depth: number): ImpactSeverity {
  if (depth === 1) return "error";
  if (depth === 2) return "warn";
  return "info";
}

/** 提案指纹：同一改动 + 同一影响面必须得到同一个 id（可复现、可对比两次提案） */
function proposalIdOf(payload: {
  change: PropagateChange;
  impact: ImpactRow[];
  truncated: { frontier: string[]; count: number } | null;
  cycle: string[] | null;
  maxDepth: number;
}): string {
  const canonical = JSON.stringify(payload);
  return `prop-${createHash("sha256").update(canonical, "utf8").digest("hex").slice(0, 12)}`;
}

export function propagate(
  change: PropagateChange,
  input: PropagateInput,
  options: PropagateOptions = {},
): Proposal {
  const maxDepth = options.maxDepth ?? PROPAGATE_DEFAULT_MAX_DEPTH;
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new PropagateError("E_PROPAGATE_DEPTH", `maxDepth 必须是 ≥1 的整数，收到 ${String(options.maxDepth)}`);
  }
  const known = new Set(input.entities.map((entity) => entity.id));
  if (!known.has(change.entity)) {
    // 空清单和"这个实体不存在"是两件事：后者说明改动本身有问题，静默返回空等于说"没有影响"
    throw new PropagateError(
      "E_PROPAGATE_NO_ENTITY",
      `要传播的实体「${change.entity}」不在设定索引里（先确认 id，或先重建索引再传播）`,
    );
  }

  // 反向邻接表：target → 若干条 referrer 边（同层内按 referrer 码点序，边再按关系名码点序）
  const reverse = new Map<string, Array<{ from: string; relation: string }>>();
  for (const row of input.refs) {
    const list = reverse.get(row.target);
    const edge = { from: row.referrer, relation: row.relation };
    if (list) list.push(edge);
    else reverse.set(row.target, [edge]);
  }
  for (const list of reverse.values()) {
    list.sort((a, b) => byCodePoint(a.from, b.from) || byCodePoint(a.relation, b.relation));
  }

  const weights = options.weights ?? {};
  const assumed = new Set<string>();
  const impact: ImpactRow[] = [];
  const visited = new Set<string>([change.entity]);
  const frontier = new Set<string>();
  let cycle: string[] | null = null;

  let level: Array<{ id: string; path: string[]; weight: number; assumedSoFar: boolean }> = [
    { id: change.entity, path: [change.entity], weight: 1, assumedSoFar: false },
  ];
  for (let depth = 1; depth <= maxDepth && cycle === null; depth += 1) {
    const next: Array<{ id: string; path: string[]; weight: number; assumedSoFar: boolean }> = [];
    for (const node of level) {
      for (const edge of reverse.get(node.id) ?? []) {
        if (node.path.includes(edge.from)) {
          // 环：整单阻断。给完整环路径（首尾同 id），面板才能指出"是哪条边把图绕回去了"
          cycle = [...node.path, edge.from];
          break;
        }
        if (visited.has(edge.from)) continue;
        const declared = weights[edge.relation];
        const assumedEdge = declared === undefined;
        if (assumedEdge) assumed.add(edge.relation);
        const weight = node.weight * (assumedEdge ? 1 : declared);
        const path = [...node.path, edge.from];
        const assumedSoFar = node.assumedSoFar || assumedEdge;
        visited.add(edge.from);
        impact.push({
          entity: edge.from,
          relation: edge.relation,
          depth,
          severity: severityFor(depth),
          path,
          weight,
          // 整条路径上只要有一条边没定义权重就标出来，不是只标最后那一条
          weightAssumed: assumedSoFar,
        });
        next.push({ id: edge.from, path, weight, assumedSoFar });
      }
      if (cycle !== null) break;
    }
    if (cycle !== null) break;
    if (depth === maxDepth) {
      // 封顶：把这一层还没走过的下游如实点名（只算下一层，不走去数整棵未展开子树）
      for (const node of next) {
        for (const edge of reverse.get(node.id) ?? []) {
          if (!visited.has(edge.from) && !node.path.includes(edge.from)) frontier.add(edge.from);
        }
      }
    }
    level = next;
  }

  const payload = {
    change,
    impact,
    truncated: frontier.size > 0 ? { frontier: [...frontier].sort(byCodePoint), count: frontier.size } : null,
    cycle,
    maxDepth,
  };
  return {
    proposalId: proposalIdOf(payload),
    change,
    status: cycle === null ? "awaiting_confirmation" : "blocked",
    impact: cycle === null ? impact : [],
    truncated: payload.truncated,
    cycle,
    assumedRelations: cycle === null ? [...assumed].sort(byCodePoint) : [],
    maxDepth,
  };
}
