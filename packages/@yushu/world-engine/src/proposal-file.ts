import { parseDocument } from "yaml";
import { YushuError } from "@yushu/core";
import type { ImpactRow, Proposal } from "./propagate.js";

/**
 * 影响传播提案文件的严格读写格式（M4 / T4-5，R61）。
 *
 * 放引擎侧而不是桌面侧，理由与 `parseConsistencyAllowList` 一样：
 * "认不认识这个字段"是数据模型的事，不该跟着进程边界走（顺带一条现实约束：`yaml` 这个依赖在引擎包里，
 * 桌面端直接 import 它会撞上 pnpm 的严格 node_modules）。
 *
 * 一条硬规矩：**未知键一律拒绝**。半读半丢比读不了更坏——作者会以为提案还是原来那一份。
 */

export const PROPOSAL_API_VERSION = "yushu.proposal/v1";

export type ProposalDecision = "accept" | "reject" | "pending";

export interface ProposalFile {
  proposal: Proposal;
  /** 逐条决策：条目下标 → accept/reject/pending。没表态的条目不在这里 */
  decisions: Record<string, ProposalDecision>;
  createdAt: string;
  updatedAt: string;
}

export class ProposalError extends YushuError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ProposalError";
  }
}

const DECISIONS: readonly ProposalDecision[] = ["accept", "reject", "pending"];
const TOP_KEYS = [
  "apiVersion",
  "proposalId",
  "change",
  "status",
  "impact",
  "truncated",
  "cycle",
  "assumedRelations",
  "maxDepth",
  "decisions",
  "createdAt",
  "updatedAt",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function impactRow(value: unknown, position: number): ImpactRow {
  if (!isRecord(value)) {
    throw new ProposalError("E_PROPOSAL_PARSE", `impact[${position}] 不是对象`);
  }
  const { entity, relation, depth, severity, path, weight, weightAssumed } = value as Record<string, unknown>;
  if (typeof entity !== "string" || typeof relation !== "string") {
    throw new ProposalError("E_PROPOSAL_PARSE", `impact[${position}] 缺 entity/relation 字符串`);
  }
  if (!Number.isInteger(depth) || (depth as number) < 1) {
    throw new ProposalError("E_PROPOSAL_PARSE", `impact[${position}].depth 必须是 ≥1 的整数`);
  }
  if (severity !== "error" && severity !== "warn" && severity !== "info") {
    throw new ProposalError("E_PROPOSAL_PARSE", `impact[${position}].severity 只能是 error/warn/info`);
  }
  if (!Array.isArray(path) || path.some((item) => typeof item !== "string")) {
    // 传播路径是 A1 的硬要求：没有 path 的一行等于没说"是谁把它带进来的"
    throw new ProposalError("E_PROPOSAL_PARSE", `impact[${position}].path 必须是字符串数组`);
  }
  if (typeof weight !== "number" || !Number.isFinite(weight)) {
    throw new ProposalError("E_PROPOSAL_PARSE", `impact[${position}].weight 必须是有限数字`);
  }
  if (typeof weightAssumed !== "boolean") {
    throw new ProposalError("E_PROPOSAL_PARSE", `impact[${position}].weightAssumed 必须是布尔`);
  }
  return { entity, relation, depth: depth as number, severity, path: path as string[], weight, weightAssumed };
}

/** 严格解析：未知键拒绝、缺 apiVersion 拒绝、字段类型逐条点名 */
export function parseProposalFile(path: string, text: string): ProposalFile {
  const doc = parseDocument(text, { prettyErrors: true });
  if (doc.errors.length > 0) {
    throw new ProposalError("E_PROPOSAL_PARSE", `${path} YAML 读不了：${doc.errors[0]?.message ?? "解析错误"}`);
  }
  const root = doc.toJS() as unknown;
  if (!isRecord(root)) {
    throw new ProposalError("E_PROPOSAL_PARSE", `${path} 顶层必须是对象`);
  }
  if (root["apiVersion"] !== PROPOSAL_API_VERSION) {
    throw new ProposalError("E_PROPOSAL_PARSE", `${path} apiVersion 必须是 ${PROPOSAL_API_VERSION}`);
  }
  const unknown = Object.keys(root).filter((key) => !TOP_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new ProposalError(
      "E_PROPOSAL_PARSE",
      `${path} 含未知键 ${unknown.join("、")}（本版本不认识的字段一律拒绝，避免半读半丢）`,
    );
  }
  const change = root["change"];
  if (!isRecord(change) || typeof change["entity"] !== "string" || typeof change["field"] !== "string") {
    throw new ProposalError("E_PROPOSAL_PARSE", `${path} change 需要 entity 与 field 两个字符串`);
  }
  const status = root["status"];
  if (status !== "awaiting_confirmation" && status !== "blocked") {
    throw new ProposalError("E_PROPOSAL_PARSE", `${path} status 只能是 awaiting_confirmation / blocked`);
  }
  const impactRaw = root["impact"];
  if (!Array.isArray(impactRaw)) {
    throw new ProposalError("E_PROPOSAL_PARSE", `${path} impact 必须是数组`);
  }
  const impact = impactRaw.map((item, index) => impactRow(item, index));
  const cycleRaw = root["cycle"];
  if (!(cycleRaw === null || (Array.isArray(cycleRaw) && cycleRaw.every((item) => typeof item === "string")))) {
    throw new ProposalError("E_PROPOSAL_PARSE", `${path} cycle 必须是字符串数组或 null`);
  }
  const assumedRaw = root["assumedRelations"];
  if (!Array.isArray(assumedRaw) || assumedRaw.some((item) => typeof item !== "string")) {
    throw new ProposalError("E_PROPOSAL_PARSE", `${path} assumedRelations 必须是字符串数组`);
  }
  const truncatedRaw = root["truncated"];
  if (!(truncatedRaw === null || (isRecord(truncatedRaw) && Array.isArray(truncatedRaw["frontier"])))) {
    throw new ProposalError("E_PROPOSAL_PARSE", `${path} truncated 必须是 null 或含 frontier 数组`);
  }
  const decisionsRaw = root["decisions"];
  if (!(decisionsRaw === undefined || isRecord(decisionsRaw))) {
    throw new ProposalError("E_PROPOSAL_PARSE", `${path} decisions 必须是映射`);
  }
  const decisions: Record<string, ProposalDecision> = {};
  for (const [key, value] of Object.entries(isRecord(decisionsRaw) ? decisionsRaw : {})) {
    if (!/^\d+$/.test(key)) {
      throw new ProposalError("E_PROPOSAL_PARSE", `${path} decisions 的键必须是条目下标（收到「${key}」）`);
    }
    if (!DECISIONS.includes(value as ProposalDecision)) {
      throw new ProposalError(
        "E_PROPOSAL_PARSE",
        `${path} decisions[${key}] 只能是 ${DECISIONS.join("/")}（收到「${String(value)}」）`,
      );
    }
    decisions[key] = value as ProposalDecision;
  }
  const proposalId = root["proposalId"];
  const maxDepth = root["maxDepth"];
  if (typeof proposalId !== "string" || proposalId === "") {
    throw new ProposalError("E_PROPOSAL_PARSE", `${path} 缺 proposalId`);
  }
  if (!Number.isInteger(maxDepth) || (maxDepth as number) < 1) {
    throw new ProposalError("E_PROPOSAL_PARSE", `${path} maxDepth 必须是 ≥1 的整数`);
  }
  const truncated = truncatedRaw as { frontier?: unknown[]; count?: unknown } | null;
  return {
    proposal: {
      proposalId,
      change: { entity: change["entity"] as string, field: change["field"] as string },
      status,
      impact,
      truncated: truncated === null ? null : {
        frontier: (truncated.frontier ?? []).map((item) => String(item)),
        count: typeof truncated.count === "number" ? truncated.count : (truncated.frontier ?? []).length,
      },
      cycle: (cycleRaw as string[] | null) ?? null,
      assumedRelations: assumedRaw as string[],
      maxDepth: maxDepth as number,
    },
    decisions,
    createdAt: typeof root["createdAt"] === "string" ? root["createdAt"] : "",
    updatedAt: typeof root["updatedAt"] === "string" ? root["updatedAt"] : "",
  };
}

/** 手写序列化（不用 stringify）：键序固定 ⇒ 同一提案两次写出逐字一致，幂等判断才有意义 */
export function serializeProposal(file: ProposalFile): string {
  const { proposal } = file;
  const list = (items: string[]) => (items.length === 0 ? " []" : `\n${items.map((item) => `  - ${JSON.stringify(item)}`).join("\n")}`);
  const lines: string[] = [
    `apiVersion: ${PROPOSAL_API_VERSION}`,
    `proposalId: ${JSON.stringify(proposal.proposalId)}`,
    `status: ${proposal.status}`,
    `maxDepth: ${proposal.maxDepth}`,
    `createdAt: ${JSON.stringify(file.createdAt)}`,
    `updatedAt: ${JSON.stringify(file.updatedAt)}`,
    "change:",
    `  entity: ${JSON.stringify(proposal.change.entity)}`,
    `  field: ${JSON.stringify(proposal.change.field)}`,
    `assumedRelations:${list(proposal.assumedRelations)}`,
    `cycle:${proposal.cycle === null ? " null" : list(proposal.cycle)}`,
    `truncated:${proposal.truncated === null ? " null" : ""}`,
  ];
  if (proposal.truncated !== null) {
    lines.push(`  count: ${proposal.truncated.count}`);
    lines.push(`  frontier:${list(proposal.truncated.frontier)}`);
  }
  lines.push(`impact:${proposal.impact.length === 0 ? " []" : ""}`);
  for (const row of proposal.impact) {
    lines.push(`  - entity: ${JSON.stringify(row.entity)}`);
    lines.push(`    relation: ${JSON.stringify(row.relation)}`);
    lines.push(`    depth: ${row.depth}`);
    lines.push(`    severity: ${row.severity}`);
    lines.push(`    weight: ${row.weight}`);
    lines.push(`    weightAssumed: ${row.weightAssumed}`);
    lines.push(`    path:${row.path.map((item) => `\n      - ${JSON.stringify(item)}`).join("")}`);
  }
  const decided = Object.entries(file.decisions).sort(([a], [b]) => Number(a) - Number(b));
  lines.push(`decisions:${decided.length === 0 ? " {}" : ""}`);
  for (const [index, decision] of decided) {
    lines.push(`  ${index}: ${decision}`);
  }
  return `${lines.join("\n").replace(/\n(?=\n)/g, "\n")}\n`;
}
