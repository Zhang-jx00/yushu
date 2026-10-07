import { createHash } from "node:crypto";

/**
 * 上下文快照（T3-9；docs/04 §6.4 产物 → `.yushu/context-log/`）：
 * - 上下文预览器的**可复现载体**：完整记录「槽位 / 来源 / Token 数 / 命中键 / 是否被截断」
 *   与逐出、去重、截断证据，以及 RAG 检索回执；
 * - `fingerprint` = 决策内容（除 `generated_at` 外全部字段，键序显式排序）的 sha256——
 *   **同一输入两次调用指纹一致**（docs/04 §6.5 A1 验收）；generated_at 不参与指纹；
 * - 纯逻辑（应用层负责落盘与命名）；快照为派生日志：可删、可重建，绝不作为真源。
 */

export const CONTEXT_SNAPSHOT_FORMAT = "yushu.context-snapshot/v1";
export type ContextSnapshotFormat = typeof CONTEXT_SNAPSHOT_FORMAT;

export interface ContextSnapshotItem {
  id: string;
  title: string;
  source?: string;
  tokens: number;
  truncated: boolean;
  priority: number;
  recency: number;
  stable: boolean;
  matched_keys: string[];
  text: string;
}

export interface ContextSnapshotSlot {
  slot: string;
  mode: string;
  cap_tokens: number;
  tokens: number;
  truncated: boolean;
  items: ContextSnapshotItem[];
}

export interface ContextSnapshotRag {
  status: string;
  query: string;
  hits: number;
  store: string;
  note?: string;
}

/**
 * 快照输入（与 `@yushu/memory` 组装输出 / 桌面端 IPC 载荷结构兼容——
 * 结构声明独立于 assemble 内部类型，两侧各自声明、避免跨层耦合）。
 */
export interface ContextSnapshotAssemblyInput {
  slots: ContextSnapshotSlot[];
  stableTokens: number;
  totalTokens: number;
  budget_total: number;
  dropped: { id: string; slot: string; reason: string; detail: string; tokens: number }[];
  dedup: { by_id: number; by_similarity: number };
  truncatedItems: number;
}

export interface ContextSnapshot {
  format: ContextSnapshotFormat;
  generated_at: string;
  chapter: { id: string; title: string; ordinal: number; path: string };
  budget_total: number;
  rag?: ContextSnapshotRag;
  slots: ContextSnapshotSlot[];
  dropped: ContextSnapshotAssemblyInput["dropped"];
  dedup: { by_id: number; by_similarity: number };
  stableTokens: number;
  totalTokens: number;
  truncatedItems: number;
  /** 决策内容 sha256（64 位 hex；同一输入两次调用一致——可复现判定） */
  fingerprint: string;
}

export interface ContextSnapshotInput {
  chapter: { id: string; title: string; ordinal: number; path: string };
  /** 组装结果（含全部决策证据） */
  assembly: ContextSnapshotAssemblyInput;
  rag?: ContextSnapshotRag;
  generatedAt: string;
}

/** 稳定序列化：对象键排序、数组保序——指纹不受键序 / 属性插入顺序影响 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

/**
 * 构造上下文快照与指纹（键序显式固定；`generated_at` 不参与指纹——可复现判定只看决策内容）。
 * 文本内容全部入指纹：任何影响实际提示词的变化（含截断后的文本）都会改变指纹。
 */
export function buildContextSnapshot(input: ContextSnapshotInput): ContextSnapshot {
  const decision = {
    format: CONTEXT_SNAPSHOT_FORMAT,
    chapter: input.chapter,
    budget_total: input.assembly.budget_total,
    ...(input.rag ? { rag: input.rag } : {}),
    slots: input.assembly.slots.map((slot) => ({
      slot: slot.slot,
      mode: slot.mode,
      cap_tokens: slot.cap_tokens,
      tokens: slot.tokens,
      truncated: slot.truncated,
      items: slot.items.map((item) => ({
        id: item.id,
        title: item.title,
        ...(item.source ? { source: item.source } : {}),
        tokens: item.tokens,
        truncated: item.truncated,
        priority: item.priority,
        recency: item.recency,
        stable: item.stable,
        matched_keys: [...item.matched_keys],
        text: item.text,
      })),
    })),
    dropped: input.assembly.dropped,
    dedup: input.assembly.dedup,
    stableTokens: input.assembly.stableTokens,
    totalTokens: input.assembly.totalTokens,
    truncatedItems: input.assembly.truncatedItems,
  };
  const fingerprint = createHash("sha256").update(stableStringify(decision), "utf8").digest("hex");
  return {
    format: CONTEXT_SNAPSHOT_FORMAT,
    generated_at: input.generatedAt,
    chapter: decision.chapter,
    budget_total: decision.budget_total,
    ...(decision.rag ? { rag: decision.rag } : {}),
    slots: decision.slots,
    dropped: decision.dropped,
    dedup: decision.dedup,
    stableTokens: decision.stableTokens,
    totalTokens: decision.totalTokens,
    truncatedItems: decision.truncatedItems,
    fingerprint,
  };
}

/** 快照文件内容（美化 JSON + 尾换行——人工可读、diff 友好） */
export function serializeContextSnapshot(snapshot: ContextSnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}