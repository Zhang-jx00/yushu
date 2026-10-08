import { PRICING_UNIT_TOKENS, DEFAULT_CURRENCY } from "./cost.js";
import type { ModelCacheCapability, ModelPricing } from "./types.js";

/**
 * prompt caching 稳定前缀编排核对（T3-12 步骤 5，J09 §2.4 / J02 断点设计）。
 *
 * 缓存按**字节相同的前缀**命中：稳定内容（系统提示 / 世界设定总纲 / 常驻摘要）必须全部置头，
 * 易变内容（本章细纲 / 最近正文 / RAG 片段）一律排在断点之后。任何一段稳定内容落在易变内容之后，
 * 就等于每次请求都击穿该段及其后全部缓存——J09 称之为 `cache-prefix-unstable`。
 *
 * 本模块**只读核对**：从组装结果取「槽位 + 是否稳定 + token 数」，判定顺序、断点位置与节省额，
 * 不改写任何内容。节省额为**投影**（按已声明的读价或 read_mult），未声明折扣则按不打折计、不臆造。
 */

/** 一个上下文槽位的编排事实（由 app 层从组装结果投影） */
export interface CacheSlotRow {
  slot: string;
  /** 该槽位内容跨请求不变（可进缓存前缀） */
  stable: boolean;
  tokens: number;
}

export interface CacheSaving {
  /** 单次调用因稳定前缀命中而省下的金额（**投影**：假设该前缀真的命中缓存） */
  perCall: number;
  currency: string;
}

export interface CacheOrchestration {
  ordered: boolean;
  /** 出现在易变槽位之后的稳定槽位名（击穿点） */
  misplaced: string[];
  breakpointAfter: string;
  /** 断点槽位在清单中的下标；断点槽位不存在 → -1（绝不静默按 0 处理） */
  breakpointIndex: number;
  stableSlots: string[];
  stableTokens: number;
  unstableTokens: number;
  cacheDeclared: boolean;
  cacheMode: string | null;
  /** 稳定前缀未达 provider 的缓存门槛（不会命中） */
  belowMinTokens: boolean;
  saving: CacheSaving | null;
  warnings: string[];
}

export interface CacheOrchestrationInput {
  slots: CacheSlotRow[];
  /** 断点槽位名（对齐 context.cache.breakpoint_after） */
  breakpointAfter: string;
  /** provider 声明的缓存能力（未声明 = 无折扣） */
  cache?: ModelCacheCapability;
  /** 模型定价（未配置 → 节省额不估算） */
  pricing?: ModelPricing;
}

export function checkCacheOrchestration(
  input: CacheOrchestrationInput,
): CacheOrchestration {
  const { slots, breakpointAfter, cache, pricing } = input;
  const firstUnstable = slots.findIndex((slot) => !slot.stable);
  const misplaced = slots.filter(
    (slot) => slot.stable && firstUnstable !== -1 && slots.indexOf(slot) > firstUnstable,
  ).map((slot) => slot.slot);
  const stableSlots = slots.filter((slot) => slot.stable).map((slot) => slot.slot);
  const stableTokens = slots
    .filter((slot) => slot.stable)
    .reduce((sum, slot) => sum + Math.max(0, slot.tokens), 0);
  const unstableTokens = slots
    .filter((slot) => !slot.stable)
    .reduce((sum, slot) => sum + Math.max(0, slot.tokens), 0);
  const breakpointIndex = slots.findIndex((slot) => slot.slot === breakpointAfter);
  const minTokens = cache?.min_tokens;
  const belowMinTokens = minTokens !== undefined && stableTokens < minTokens;

  const warnings: string[] = [];
  if (misplaced.length > 0) {
    warnings.push(
      `稳定前缀被击穿：${misplaced.join("、")} 排在易变槽位之后（cache-prefix-unstable）——把稳定内容整体移到断点之前才能命中缓存`,
    );
  }
  if (breakpointIndex === -1) {
    warnings.push(`断点槽位「${breakpointAfter}」不在组装清单中：缓存断点无法对齐`);
  }

  let saving: CacheSaving | null = null;
  if (!cache) {
    warnings.push("provider 未声明 cache 能力：稳定前缀不会命中缓存（无折扣）");
  } else if (belowMinTokens) {
    warnings.push(
      `稳定前缀 ${stableTokens} token 低于缓存门槛 ${minTokens} token：按当前编排不会命中`,
    );
  }
  if (cache && pricing) {
    // 命中读价：优先绝对单价 cache_read，其次按 read_mult 折算；两者都未声明 → 不打折（节省 0）
    const readPrice =
      pricing.cache_read ?? (cache.read_mult !== undefined ? pricing.input * cache.read_mult : pricing.input);
    if (pricing.cache_read === undefined && cache.read_mult === undefined) {
      warnings.push("未声明 cache_read 单价或 read_mult 折扣：节省额按不打折计（不臆造折扣）");
    }
    const perCall =
      (stableTokens / PRICING_UNIT_TOKENS) * pricing.input -
      (stableTokens / PRICING_UNIT_TOKENS) * readPrice;
    saving = {
      perCall,
      currency: pricing.currency ?? DEFAULT_CURRENCY,
    };
  }

  return {
    ordered: misplaced.length === 0,
    misplaced,
    breakpointAfter,
    breakpointIndex,
    stableSlots,
    stableTokens,
    unstableTokens,
    cacheDeclared: Boolean(cache),
    cacheMode: cache?.mode ?? null,
    belowMinTokens,
    saving,
    warnings,
  };
}
