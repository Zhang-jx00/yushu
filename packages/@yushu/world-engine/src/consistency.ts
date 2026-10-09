import { LAYER_KEYS } from "@yushu/core";
import { collectIndexInput, type IndexEntityRow, type IndexRefRow, type IndexSourceReader } from "./index-input.js";
import { parseWorldConfig } from "./world-config.js";

/**
 * 结构完整性规则（M4 / T4-2，docs/03 §分级规则 + K05 §完整性校验）。
 *
 * 输入是**纯真源产物**（`collectIndexInput` 的实体行与引用行），不读 SQLite：
 * 索引是可删的派生物，校验结论必须删库后不变（docs/04 §7.5 A5）。
 *
 * 严重度取 **docs/03 §分级规则**（结构破坏 = error）。**口径分歧如实记录**：
 * K05:122 把 `layer-order-violation` 记 warn，docs/03:381 记 error；本实现取架构文档（约束源），
 * 需要豁免走 T4-3 的白名单（必须写理由），而不是在这里改死。
 */

export type StructureRuleId = "ref-dangling" | "ref-cycle" | "layer-order-violation";
/** 已实现的结构规则 id（豁免清单按这份名单校验，避免"豁免了一条不存在的规则"） */
export const STRUCTURE_RULE_IDS: readonly StructureRuleId[] = [
  "ref-dangling",
  "ref-cycle",
  "layer-order-violation",
];
export type StructureSeverity = "error" | "warn" | "info";

export interface StructureFinding {
  rule: StructureRuleId;
  severity: StructureSeverity;
  /** 发起方实体 id */
  subject: string;
  /** 相关方：被引用目标 / 环内下一个节点 */
  related?: string;
  /** 环路径（仅 ref-cycle，首尾同 id） */
  path?: string[];
  /** 层级倒置两端的层名（报告要按层给修法，不能只靠句子） */
  fromLayer?: string;
  toLayer?: string;
  /** 可读证据：谁在哪个文件通过什么关系引用了谁 */
  evidence: string;
}

export interface StructureInput {
  entities: readonly IndexEntityRow[];
  refs: readonly IndexRefRow[];
  /** 已启用的世界层；未列出的层**整条不参与校验**（docs/03：未启用层不参与校验与传播） */
  enabledLayers?: readonly string[];
}

/** 未纳入本轮范围的引用目标（章节 / 大纲 id 不在 entities 里） */
export interface StructureSkippedRef {
  referrer: string;
  relation: string;
  target: string;
  reason: string;
}

export interface StructureReport {
  findings: StructureFinding[];
  outOfScope: StructureSkippedRef[];
  skipped: { disabledLayerEntities: number; cycleDepthCapped: number };
  checked: { entities: number; refs: number };
}

/** 章节 / 大纲 id 不在 entities 表里（collectIndexInput 只把设定卡作为实体入表） */
const NON_CARD_ID_PREFIXES = ["ch-", "co-", "vol-"] as const;

function isNonCardId(id: string): boolean {
  return NON_CARD_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** 层序表：不在 LAYER_KEYS 内的层返回 -1（视为未知，不参与层级倒置判定） */
function layerIndexOf(layer: string): number {
  return (LAYER_KEYS as readonly string[]).indexOf(layer);
}

/** 环搜索的路径深度上限：超长链会把 JS 调用栈打爆，超限即停止下探并如实计数 */
const MAX_CYCLE_DEPTH = 64;

export function checkStructure(input: StructureInput): StructureReport {
  const byId = new Map<string, IndexEntityRow>();
  for (const entity of input.entities) byId.set(entity.id, entity);
  const enabled = input.enabledLayers ? new Set(input.enabledLayers) : null;
  const active = (id: string): boolean => {
    if (!enabled) return true;
    const entity = byId.get(id);
    return entity === undefined ? true : enabled.has(entity.layer);
  };

  const findings: StructureFinding[] = [];
  const outOfScope: StructureSkippedRef[] = [];
  let disabledLayerEntities = 0;

  // ① 悬空引用：只按 id 精确匹配，名称与别名不算存在（否则真悬空会被洗成命中）
  for (const link of input.refs) {
    const from = byId.get(link.referrer);
    if (enabled && from && !enabled.has(from.layer)) {
      disabledLayerEntities += 1;
      continue;
    }
    if (!from) {
      // 发起方本身不在实体表内：同样是结构破坏，不能因为"目标存在"就放过
      findings.push({
        rule: "ref-dangling",
        severity: "error",
        subject: link.referrer,
        related: link.target,
        evidence: `引用发起方「${link.referrer}」不在实体表内（经关系「${link.relation}」指向「${link.target}」）`,
      });
      continue;
    }
    if (byId.has(link.target)) continue;
    const where = from ? `设定卡「${link.referrer}」（${from.filePath}）` : `实体「${link.referrer}」`;
    if (isNonCardId(link.target)) {
      outOfScope.push({
        referrer: link.referrer,
        relation: link.relation,
        target: link.target,
        reason: `${where}经关系「${link.relation}」指向 ${link.target}——章节 / 大纲类 id 未纳入本轮结构校验范围`,
      });
      continue;
    }
    findings.push({
      rule: "ref-dangling",
      severity: "error",
      subject: link.referrer,
      related: link.target,
      evidence: `${where}经关系「${link.relation}」引用了不存在的实体「${link.target}」（按 id 精确匹配，名称与别名不算存在）`,
    });
  }

  const cycles = findCycles(byId, input.refs, active);
  findings.push(...cycles.findings);

  // ③ 层级倒置：上游层（LAYER_KEYS 靠前）引用下游层。层未知时**不判定**——不猜层序。
  for (const link of input.refs) {
    const from = byId.get(link.referrer);
    const to = byId.get(link.target);
    if (!from || !to) continue;
    if (!active(from.id)) continue;
    const fromIndex = layerIndexOf(from.layer);
    const toIndex = layerIndexOf(to.layer);
    if (fromIndex < 0 || toIndex < 0 || fromIndex >= toIndex) continue;
    findings.push({
      rule: "layer-order-violation",
      severity: "error",
      subject: from.id,
      related: to.id,
      fromLayer: from.layer,
      toLayer: to.layer,
      evidence:
        `倒置引用：「${from.name}」处于第 ${fromIndex + 1} 层 ${from.layer}，却经关系「${link.relation}」` +
        `依赖第 ${toIndex + 1} 层 ${to.layer} 的「${to.name}」——上游设定不应依赖下游产物（会影响传播方向与回滚范围）`,
    });
  }

  findings.sort((a, b) => {
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
    if ((a.related ?? "") !== (b.related ?? "")) return (a.related ?? "") < (b.related ?? "") ? -1 : 1;
    return 0;
  });
  outOfScope.sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0));

  return {
    findings,
    outOfScope,
    skipped: { disabledLayerEntities, cycleDepthCapped: cycles.depthCapped },
    checked: { entities: input.entities.length, refs: input.refs.length },
  };
}

/**
 * 环的规范形：旋转到环内最小 id 起笔，再补回首节点。
 * 同一环不论从哪个节点先被 DFS 发现，规范形都相同，因此天然只报一次。
 */
function canonicalCycle(path: string[]): string[] {
  const body = path.slice(0, Math.max(0, path.length - 1));
  let minIndex = 0;
  for (const [index, id] of body.entries()) if ((id ?? "") < (body[minIndex] ?? "")) minIndex = index;
  const rotated = [...body.slice(minIndex), ...body.slice(0, minIndex)];
  return [...rotated, rotated[0] ?? ""];
}

/**
 * 引用图上的环检测（只使用两端都存在于实体表的边；悬空边归 ref-dangling，不参与成环）。
 *
 * 三点如实说明：
 * - **深度上限**：链路过长时停止下探并计 `cycleDepthCapped`，不假装"没有环"；
 * - **枚举范围**：DFS 走过即标 done，因此**同一强连通分量只报出先发现的那个环**，
 *   不保证枚举全部初等环（那需要 Johnson 算法，本轮不引入）——报告里如实写明；
 * - **确定性**：邻接表与起点都按 id 码点排序，同输入同输出。
 */
function findCycles(
  byId: Map<string, IndexEntityRow>,
  refs: readonly IndexRefRow[],
  active: (id: string) => boolean,
): { findings: StructureFinding[]; depthCapped: number } {
  const adjacency = new Map<string, string[]>();
  for (const link of refs) {
    if (!byId.has(link.referrer) || !byId.has(link.target)) continue;
    if (!active(link.referrer)) continue;
    const list = adjacency.get(link.referrer) ?? [];
    if (!list.includes(link.target)) list.push(link.target);
    adjacency.set(link.referrer, list);
  }
  for (const list of adjacency.values()) list.sort();

  const findings: StructureFinding[] = [];
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  let depthCapped = 0;

  const record = (path: string[]): void => {
    const canonical = canonicalCycle(path);
    findings.push({
      rule: "ref-cycle",
      severity: "error",
      subject: canonical[0] ?? "",
      related: canonical[1] ?? canonical[0] ?? "",
      path: canonical,
      evidence: `引用成环：${canonical.join(" → ")}（同一环只报一次：邻接去重 + 已访问标记保证；同一强连通分量只报先发现的环）`,
    });
  };

  const visit = (node: string): void => {
    if (stack.length >= MAX_CYCLE_DEPTH) {
      depthCapped += 1;
      return;
    }
    state.set(node, "visiting");
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      if (next === node) {
        record([node, node]);
        continue;
      }
      const mark = state.get(next);
      if (mark === "visiting") {
        const index = stack.indexOf(next);
        if (index >= 0) record([...stack.slice(index), next]);
      } else if (mark === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(node, "done");
  };

  for (const node of [...adjacency.keys()].sort()) {
    if (state.get(node) === undefined) visit(node);
  }
  return { findings, depthCapped };
}

/** 真源侧的校验报告（额外说明结论来自哪些文件，而不是只给结论） */
export interface StructureSourceReport extends StructureReport {
  /** 参与校验的层（world.yaml 未关闭的层）；关闭的层要看得见，否则"零发现"会被读成"结构没问题" */
  enabledLayers: string[];
  sources: { entities: number; refs: number };
  /** world.yaml 缺失或非法时的说明（此时按全部层启用，不猜配置） */
  worldNote: string | null;
}

/**
 * 从真源直接跑结构校验：`collectIndexInput`（纯文件读取）→ 三条规则。
 *
 * **刻意不读 SQLite**：索引是可删的派生物，删掉 `.yushu/index.db` 后结论必须一字不变
 * （docs/04 §7.5 A5 的验收口径）。
 */
export async function checkStructureFromSources(reader: IndexSourceReader): Promise<StructureSourceReport> {
  const input = await collectIndexInput(reader);
  let enabledLayers: readonly string[] | undefined;
  let worldNote: string | null = null;
  try {
    const world = parseWorldConfig(await reader.readText("world/world.yaml"));
    const layers = world.layers ?? {};
    enabledLayers = (LAYER_KEYS as readonly string[]).filter((key) => layers[key as (typeof LAYER_KEYS)[number]] !== false);
  } catch (err) {
    worldNote = `world.yaml 缺失或不可解析，按全部层启用：${err instanceof Error ? err.message : String(err)}`;
  }
  const report = checkStructure({ entities: input.entities, refs: input.refs, ...(enabledLayers ? { enabledLayers } : {}) });
  return {
    ...report,
    enabledLayers: (enabledLayers ?? LAYER_KEYS as readonly string[]).slice(),
    sources: { entities: input.entities.length, refs: input.refs.length },
    worldNote,
  };
}
