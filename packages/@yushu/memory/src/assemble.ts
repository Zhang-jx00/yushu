import { estimateTokens, truncateToTokens } from "./injection.js";

/**
 * 上下文组装算法（T3-7；docs/03 §10.2）：
 * - 固定槽位顺序：system_prompt → world_core → volume_summary → chapter_summary →
 *   triggered_cards → facts → rag_chunks → recent_prose；
 * - 去重：`by_id`（同 id 保留先出现的槽位）+ `by_similarity`（归一化文本 bigram Jaccard ≥ 0.95）；
 * - 预算：槽位 cap（token）逐槽裁剪（超限先截断末条、再丢弃）；全局 `budget_total` 超限时按
 *   「槽位价值序逐出 + priority_then_recent（同优先级保新）」；
 * - 输出完整决策证据（截断 / 逐出 / 去重清单），供上下文预览器（T3-9）与快照复现。
 */

/** 固定槽位（docs/03 §10.2 顺序；不可变） */
export type ContextSlotName =
  | "system_prompt"
  | "world_core"
  | "volume_summary"
  | "chapter_summary"
  | "triggered_cards"
  | "facts"
  | "rag_chunks"
  | "recent_prose";

export const SLOT_ORDER: readonly ContextSlotName[] = [
  "system_prompt",
  "world_core",
  "volume_summary",
  "chapter_summary",
  "triggered_cards",
  "facts",
  "rag_chunks",
  "recent_prose",
];

export interface SlotConfig {
  name: ContextSlotName;
  /** always = 恒定填充；trigger = 仅填充被触发项（由 T3-6 决策提供）；query = 检索填充（T3-8） */
  mode: "always" | "trigger" | "query";
  cap_tokens: number;
  /** 近 N 条（缺省不限；按 recency 取新） */
  recent_n?: number;
}

/** 缺省槽位配置（docs/03 §10.2 的 caps） */
export const DEFAULT_SLOT_CONFIG: readonly SlotConfig[] = [
  { name: "system_prompt", mode: "always", cap_tokens: 1200 },
  { name: "world_core", mode: "always", cap_tokens: 3000 },
  { name: "volume_summary", mode: "always", cap_tokens: 800 },
  { name: "chapter_summary", mode: "always", cap_tokens: 1500, recent_n: 3 },
  { name: "triggered_cards", mode: "trigger", cap_tokens: 6000 },
  { name: "facts", mode: "trigger", cap_tokens: 2000, recent_n: 20 },
  { name: "rag_chunks", mode: "query", cap_tokens: 4000 },
  { name: "recent_prose", mode: "always", cap_tokens: 6000 },
];

/**
 * 全局预算超限时的逐出顺序（槽位价值序）：
 * 先动检索与触发类（可再取回），摘要随后，最近原文靠后，世界核心最后；
 * system_prompt 不整条逐出（只截断——人设与任务约束必须保留）。
 */
export const EVICTION_ORDER: readonly ContextSlotName[] = [
  "rag_chunks",
  "facts",
  "triggered_cards",
  "chapter_summary",
  "volume_summary",
  "recent_prose",
  "world_core",
];

/** 逐出后仍超限时的兜底截断顺序（低价值槽位先截；system_prompt 最后） */
export const TRUNCATE_ORDER: readonly ContextSlotName[] = [
  "rag_chunks",
  "facts",
  "triggered_cards",
  "chapter_summary",
  "volume_summary",
  "recent_prose",
  "world_core",
  "system_prompt",
];

export interface AssemblyItem {
  /** 去重键（by_id） */
  id: string;
  slot: ContextSlotName;
  title: string;
  text: string;
  /** 稳定前缀（prompt caching 断点前——预览器据此标断点） */
  stable?: boolean;
  /** 预算裁剪的优先级（高者先留；缺省 50） */
  priority?: number;
  /** 新近度（越大越新；同优先级保新；缺省 0） */
  recency?: number;
  source?: string;
  /** 触发命中键（trigger 模式命中的 keys；T3-9 预览器「命中键」列数据源） */
  matched_keys?: string[];
}

export interface AssembleBudget {
  /** 总预算（tokens） */
  budget_total: number;
  /** 槽位配置覆盖（cap / recent_n） */
  slots?: Partial<Record<ContextSlotName, Partial<Omit<SlotConfig, "name">>>>;
}

export interface AssembledItem {
  id: string;
  title: string;
  text: string;
  tokens: number;
  /** 本条被预算截断（保头部） */
  truncated: boolean;
  priority: number;
  recency: number;
  stable: boolean;
  source?: string;
  /** 触发命中键（T3-9 预览器「命中键」列；缺省空数组） */
  matched_keys: string[];
}

export interface AssembledSlot {
  slot: ContextSlotName;
  mode: SlotConfig["mode"];
  cap_tokens: number;
  items: AssembledItem[];
  tokens: number;
  /** 槽内发生截断或丢弃 */
  truncated: boolean;
}

export interface AssemblyDrop {
  id: string;
  slot: ContextSlotName;
  /** cap=槽位上限；budget=全局预算逐出；recent_n=近 N 条窗口外；by_id / by_similarity=去重 */
  reason: "cap" | "budget" | "recent_n" | "by_id" | "by_similarity";
  detail: string;
  tokens: number;
}

export interface AssemblyResult {
  slots: AssembledSlot[];
  /** 稳定前缀合计（断点 = 最后一个 stable 槽位之后） */
  stableTokens: number;
  totalTokens: number;
  budget_total: number;
  dropped: AssemblyDrop[];
  /** 去重统计（证据） */
  dedup: { by_id: number; by_similarity: number };
  /** 截断条目数（槽内 + 全局） */
  truncatedItems: number;
}

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 归一化文本的字符 bigram Jaccard 相似度（确定性、零依赖） */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === "" || nb === "") return na === nb ? 1 : 0;
  if (na === nb) return 1;
  const bigrams = (text: string) => {
    const set = new Set<string>();
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
    if (set.size === 0) set.add(text);
    return set;
  };
  const setA = bigrams(na);
  const setB = bigrams(nb);
  let inter = 0;
  for (const gram of setA) if (setB.has(gram)) inter += 1;
  return inter / (setA.size + setB.size - inter);
}

export const SIMILARITY_THRESHOLD = 0.95;

/**
 * 组装上下文（T3-7 核心）：
 * 1) 固定槽位顺序分组；槽内按 priority 降序、recency 降序、id 升序（priority_then_recent）；
 * 2) recent_n 窗口（按 recency 取新）；
 * 3) 去重（跨槽 by_id 保先；by_similarity 保先）；
 * 4) 槽位 cap：末条截断 → 仍不足则丢弃（reason=cap）；
 * 5) 全局 budget_total：按逐出顺序（EVICTION_ORDER）从最低 (priority, recency) 起整条逐出；
 *    全部逐出后仍超（稳定前缀过大）→ 对逐出序末尾槽位的末条截断。
 */
export function assembleContext(
  items: AssemblyItem[],
  budget: AssembleBudget,
): AssemblyResult {
  const configs = new Map<ContextSlotName, SlotConfig>();
  for (const config of DEFAULT_SLOT_CONFIG) {
    configs.set(config.name, { ...config, ...(budget.slots?.[config.name] ?? {}) });
  }

  const dropped: AssemblyDrop[] = [];
  const kept: AssembledItem[][] = SLOT_ORDER.map(() => []);

  // 1) 分组（固定槽位顺序）
  const bySlot = new Map<ContextSlotName, AssemblyItem[]>();
  for (const slot of SLOT_ORDER) bySlot.set(slot, []);
  for (const item of items) {
    const bucket = bySlot.get(item.slot);
    if (!bucket) continue; // 未知槽位：忽略（组装只认固定槽位）
    bucket.push(item);
  }

  // 2) 槽内排序（priority 降序 → recency 降序 → id 升序）与 recent_n 窗口
  for (let index = 0; index < SLOT_ORDER.length; index += 1) {
    const slot = SLOT_ORDER[index]!;
    const config = configs.get(slot)!;
    const bucket = bySlot.get(slot)!;
    bucket.sort((a, b) => {
      const pa = a.priority ?? 50;
      const pb = b.priority ?? 50;
      if (pa !== pb) return pb - pa;
      const ra = a.recency ?? 0;
      const rb = b.recency ?? 0;
      if (ra !== rb) return rb - ra;
      return a.id.localeCompare(b.id);
    });
    if (config.recent_n !== undefined && bucket.length > config.recent_n) {
      for (const extra of bucket.slice(config.recent_n)) {
        dropped.push({
          id: extra.id,
          slot,
          reason: "recent_n",
          detail: `超出近 ${config.recent_n} 条窗口（按新近度保留）`,
          tokens: estimateTokens(extra.text),
        });
      }
      bucket.length = config.recent_n;
    }
    bySlot.set(slot, bucket);
  }

  // 3) 去重（跨槽按槽位顺序：先出现者保留）
  const seenIds = new Map<string, ContextSlotName>();
  const keptTexts: { id: string; slot: ContextSlotName; text: string }[] = [];
  let byIdCount = 0;
  let bySimCount = 0;
  for (const slot of SLOT_ORDER) {
    const bucket = bySlot.get(slot)!;
    const survivors: AssemblyItem[] = [];
    for (const item of bucket) {
      const firstSlot = seenIds.get(item.id);
      if (firstSlot !== undefined) {
        byIdCount += 1;
        dropped.push({
          id: item.id,
          slot,
          reason: "by_id",
          detail: `重复 id（已在槽位 ${firstSlot} 保留）`,
          tokens: estimateTokens(item.text),
        });
        continue;
      }
      const twin = keptTexts.find((entry) => textSimilarity(entry.text, item.text) >= SIMILARITY_THRESHOLD);
      if (twin) {
        bySimCount += 1;
        dropped.push({
          id: item.id,
          slot,
          reason: "by_similarity",
          detail: `与「${twin.id}」（${twin.slot}）相似度 ≥ ${SIMILARITY_THRESHOLD}（去重）`,
          tokens: estimateTokens(item.text),
        });
        continue;
      }
      seenIds.set(item.id, slot);
      keptTexts.push({ id: item.id, slot, text: item.text });
      survivors.push(item);
    }
    bySlot.set(slot, survivors);
  }

  // 4) 槽位 cap（末条截断 → 丢弃）
  for (let index = 0; index < SLOT_ORDER.length; index += 1) {
    const slot = SLOT_ORDER[index]!;
    const config = configs.get(slot)!;
    const bucket = bySlot.get(slot)!;
    let tokens = 0;
    let capTruncated = false; // 每槽最多截断一条（其后逐条丢弃）
    for (const item of bucket) {
      const cost = estimateTokens(item.text);
      if (tokens + cost <= config.cap_tokens) {
        kept[index]!.push(toAssembled(item, item.text, cost));
        tokens += cost;
        continue;
      }
      const remaining = config.cap_tokens - tokens;
      if (remaining >= 50 && !capTruncated) {
        capTruncated = true;
        const clipped = truncateToTokens(item.text, remaining);
        kept[index]!.push(toAssembled(item, clipped.text, clipped.tokens, true));
        tokens += clipped.tokens;
        dropped.push({
          id: item.id,
          slot,
          reason: "cap",
          detail: `槽位 cap ${config.cap_tokens} 不足：已截断至 ${clipped.tokens} token`,
          tokens: cost,
        });
        continue; // 后续条目仍逐条判定（cap 已近满，通常整体丢弃）
      }
      dropped.push({
        id: item.id,
        slot,
        reason: "cap",
        detail: `槽位 cap ${config.cap_tokens} 已满（剩余 ${Math.max(remaining, 0)} token < 50）`,
        tokens: cost,
      });
    }
  }

  // 5) 全局预算：按逐出顺序整条逐出（同槽内从尾起——低 priority / 旧者先出）
  const totalTokens = () => kept.reduce((sum, bucket) => sum + bucket.reduce((s, item) => s + item.tokens, 0), 0);
  if (totalTokens() > budget.budget_total) {
    for (const slot of EVICTION_ORDER) {
      const index = SLOT_ORDER.indexOf(slot);
      const bucket = kept[index]!;
      while (bucket.length > 0 && totalTokens() > budget.budget_total) {
        const evicted = bucket.pop()!;
        dropped.push({
          id: evicted.id,
          slot,
          reason: "budget",
          detail: `全局预算 ${budget.budget_total} 超限：按逐出顺序（${EVICTION_ORDER.join(" → ")}）逐出`,
          tokens: evicted.tokens,
        });
      }
      if (totalTokens() <= budget.budget_total) break;
    }
    // 全部逐出后仍超：按兜底截断顺序对末条截断（稳定前缀过大时的最后手段）
    for (const slot of TRUNCATE_ORDER) {
      if (totalTokens() <= budget.budget_total) break;
      const index = SLOT_ORDER.indexOf(slot);
      const bucket = kept[index]!;
      const last = bucket[bucket.length - 1];
      if (!last) continue;
      const overshoot = totalTokens() - budget.budget_total;
      // 截断下限：正常不低于 50 token（避免碎成无意义片段）；预算本身极小则对齐预算
      const floor = Math.min(50, budget.budget_total);
      const target = Math.max(last.tokens - overshoot, floor);
      if (last.tokens <= target) continue;
      const clipped = truncateToTokens(last.text, target);
      last.text = clipped.text;
      last.truncated = true;
      last.tokens = clipped.tokens;
      dropped.push({
        id: last.id,
        slot,
        reason: "budget",
        detail: `全局预算仍超限：末条截断至 ${clipped.tokens} token（稳定前缀过大）`,
        tokens: last.tokens,
      });
    }
  }

  const slots: AssembledSlot[] = SLOT_ORDER.map((slot, index) => {
    const bucket = kept[index]!;
    const config = configs.get(slot)!;
    return {
      slot,
      mode: config.mode,
      cap_tokens: config.cap_tokens,
      items: bucket,
      tokens: bucket.reduce((sum, item) => sum + item.tokens, 0),
      truncated: dropped.some((entry) => entry.slot === slot && (entry.reason === "cap" || entry.reason === "budget")),
    };
  });

  const stableTokens = slots
    .filter((slot) => slot.items.some((item) => item.stable))
    .reduce((sum, slot) => sum + slot.tokens, 0);

  return {
    slots,
    stableTokens,
    totalTokens: totalTokens(),
    budget_total: budget.budget_total,
    dropped,
    dedup: { by_id: byIdCount, by_similarity: bySimCount },
    truncatedItems: slots.reduce((sum, slot) => sum + slot.items.filter((item) => item.truncated).length, 0),
  };
}

function toAssembled(item: AssemblyItem, text: string, tokens: number, truncated = false): AssembledItem {
  return {
    id: item.id,
    title: item.title,
    text,
    tokens,
    truncated,
    priority: item.priority ?? 50,
    recency: item.recency ?? 0,
    stable: item.stable ?? false,
    ...(item.source ? { source: item.source } : {}),
    matched_keys: [...(item.matched_keys ?? [])],
  };
}