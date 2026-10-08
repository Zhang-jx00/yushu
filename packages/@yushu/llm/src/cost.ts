import type { ChatUsage, ModelPricing } from "./types.js";

/**
 * Token 与成本（T3-12，J09）：本地估算 + usage 实报的**双口径**成本数学与聚合，纯逻辑、无 IO。
 *
 * 口径约定：
 * - 单价一律「每 1M tokens」（J09 §5 定价表 per_mtok）；
 * - **未配置价格不猜价**：`pricing` 缺失时金额返回 `null`，聚合行计入 `unpricedEntries`；
 * - `cache_read` / `cache_write` 缺省与 `input` 同价（声明了价格但没声明折扣 → 不打折）；
 * - token 来源缺失（旧记录 / provider 未回传 usage）计入 `entriesWithoutTokens`——对应 J09 的
 *   `cost-usage-missing` 线索，绝不拿字数臆造 token；
 * - **多币种禁止强行合计**：行成本仅在单一币种时可给出数值，否则 `cost = null` 并按币种分列。
 *
 * 双口径落在**记录层**（usage 实报 token vs 发送前估算 token），金额一律由 `computeCost` 单一定价
 * 函数折算；两者的 token 差值经 `promptDeviationMedian` 呈现，面板可据此核对估算口径是否需校准。
 */

/** 计价单位：每 1M tokens（J09 定价表口径） */
export const PRICING_UNIT_TOKENS = 1_000_000;
/** 定价未声明币种时的缺省（国产 Provider 为主；显式写 currency 即覆盖） */
export const DEFAULT_CURRENCY = "CNY";

/** 成本数学的输入 token（四段互不重叠；归一由各协议适配器完成） */
export interface CostTokens {
  /** 常规输入（不含命中缓存与前缀写入） */
  prompt?: number;
  completion?: number;
  /** 命中 prompt caching 的输入 */
  cached?: number;
  /** 写入缓存的输入（Anthropic cache_creation） */
  cache_write?: number;
}

export interface CostBreakdown {
  inputCost: number;
  outputCost: number;
  cacheReadCost: number;
  cacheWriteCost: number;
  total: number;
  currency: string;
}

/** 脏数据（负数 / NaN）按 0 计——成本不存在负数语义 */
function billable(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? Math.max(0, value) : 0;
}

function line(tokens: number, price: number): number {
  return (billable(tokens) / PRICING_UNIT_TOKENS) * price;
}

/** 缓存读单价（缺省 = input，即不打折） */
function cacheReadPrice(pricing: ModelPricing): number {
  return pricing.cache_read ?? pricing.input;
}

/** 缓存写单价（缺省 = input） */
function cacheWritePrice(pricing: ModelPricing): number {
  return pricing.cache_write ?? pricing.input;
}

/** usage 实报 → 金额（无价格 → null，调用方如实标注「未配置价格」） */
export function computeCost(tokens: CostTokens, pricing?: ModelPricing): CostBreakdown | null {
  if (!pricing) return null;
  const inputCost = line(tokens.prompt ?? 0, pricing.input);
  const outputCost = line(tokens.completion ?? 0, pricing.output);
  const cacheReadCost = line(tokens.cached ?? 0, cacheReadPrice(pricing));
  const cacheWriteCost = line(tokens.cache_write ?? 0, cacheWritePrice(pricing));
  return {
    inputCost,
    outputCost,
    cacheReadCost,
    cacheWriteCost,
    total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
    currency: pricing.currency ?? DEFAULT_CURRENCY,
  };
}

/** ChatUsage → CostTokens（字段名收敛，供记录与聚合共用） */
export function costTokensOf(usage: ChatUsage | undefined): CostTokens {
  if (!usage) return {};
  const tokens: CostTokens = {};
  if (usage.prompt_tokens !== undefined) tokens.prompt = usage.prompt_tokens;
  if (usage.completion_tokens !== undefined) tokens.completion = usage.completion_tokens;
  if (usage.cached_tokens !== undefined) tokens.cached = usage.cached_tokens;
  if (usage.cache_write_tokens !== undefined) tokens.cache_write = usage.cache_write_tokens;
  return tokens;
}

/**
 * 两次 usage 逐字段相加（T3-12）。
 * 一次业务动作可能是多次请求——设定抽取的修复闭环最多 1+maxRepair 次，每次都在真花钱，
 * 只记最后一次会把成本系统性低估。
 * `total_tokens` 规则：两侧都回了 total 才沿用协议原值相加；
 * 有一侧缺 total 时按分项重算，避免拿「半截 total」当合计。
 */
export function accumulateUsage(
  base: ChatUsage | undefined,
  delta: ChatUsage | undefined,
): ChatUsage | undefined {
  const parts = [base, delta].filter((item): item is ChatUsage => item !== undefined);
  if (parts.length === 0) return undefined;
  const sum = (key: keyof ChatUsage): number | undefined => {
    let seen = false;
    let total = 0;
    for (const item of parts) {
      const value = item[key];
      if (value === undefined) continue;
      seen = true;
      total += Number.isFinite(value) ? Math.max(0, value) : 0;
    }
    return seen ? total : undefined;
  };
  const usage: ChatUsage = {};
  const prompt = sum("prompt_tokens");
  const completion = sum("completion_tokens");
  const cached = sum("cached_tokens");
  const cacheWrite = sum("cache_write_tokens");
  if (prompt !== undefined) usage.prompt_tokens = prompt;
  if (completion !== undefined) usage.completion_tokens = completion;
  if (cached !== undefined) usage.cached_tokens = cached;
  if (cacheWrite !== undefined) usage.cache_write_tokens = cacheWrite;
  const reportedTotals = parts
    .map((item) => item.total_tokens)
    .filter((value): value is number => value !== undefined);
  if (reportedTotals.length === parts.length && reportedTotals.length > 0) {
    usage.total_tokens = reportedTotals.reduce((acc, value) => acc + value, 0);
  } else {
    const components = [prompt, completion, cached, cacheWrite].filter(
      (value): value is number => value !== undefined,
    );
    if (components.length > 0) usage.total_tokens = components.reduce((acc, value) => acc + value, 0);
  }
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** 聚合输入的一条记录（app 侧从 `.yushu/ai-usage.jsonl` 投影） */
export interface CostEntry {
  task?: string;
  provider_id?: string;
  model?: string;
  /** 通道归属（T3-11）；聚合仅记账不重复打折 */
  channel?: "batch" | "sync" | "local";
  /** usage 实报 token */
  tokens?: CostTokens;
  /** 发送前的本地估算（仅 prompt 维度可对账） */
  estimate?: CostTokens;
}

export interface CostAggregateRow {
  key: string;
  entries: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  /** 已配置价格部分的金额合计；全部未配置或币种混合时为 null */
  cost: number | null;
  /** 唯一币种；无价格或混合币种 → null */
  currency: string | null;
  costByCurrency: Record<string, number>;
  /** 缓存命中相对全价输入的节省（按币种；未声明折扣则为 0） */
  cacheSavedByCurrency: Record<string, number>;
  /** 未配置价格的条目数（如实标注） */
  unpricedEntries: number;
  /** (估算 prompt − 实报 prompt) / 实报 prompt 的中位数；无可对账条目时 null（J09 实践 2） */
  promptDeviationMedian: number | null;
}

export interface CostSummary {
  byTask: CostAggregateRow[];
  byModel: CostAggregateRow[];
  totals: CostAggregateRow;
  /** 无 token 记录的条目数（旧记录 / provider 未回传 usage） */
  entriesWithoutTokens: number;
  /** 出现的币种集合（多于一种时面板须分列） */
  currencies: string[];
}

const UNTASKED = "（未标注任务）";
const UNMODELLED = "（未标注模型）";
const TOTALS_KEY = "合计";

interface Bucket {
  row: CostAggregateRow;
  deviations: number[];
}

function emptyRow(key: string): CostAggregateRow {
  return {
    key,
    entries: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    cacheWriteTokens: 0,
    cost: null,
    currency: null,
    costByCurrency: {},
    cacheSavedByCurrency: {},
    unpricedEntries: 0,
    promptDeviationMedian: null,
  };
}

/** 码点序比较（不用 localeCompare——避免 ICU/locale 漂移导致同输入不同序） */
function byCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 码点序比较（不用 localeCompare——避免 ICU/locale 漂移导致同输入不同序） */
function byKeyCode(a: CostAggregateRow, b: CostAggregateRow): number {
  return byCode(a.key, b.key);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function accumulate(bucket: Bucket, entry: CostEntry, pricing: ModelPricing | undefined): void {
  const row = bucket.row;
  const tokens = entry.tokens;
  const hasTokens =
    tokens !== undefined &&
    (tokens.prompt !== undefined ||
      tokens.completion !== undefined ||
      tokens.cached !== undefined ||
      tokens.cache_write !== undefined);
  row.entries += 1;
  if (!hasTokens) return;
  row.promptTokens += billable(tokens.prompt);
  row.completionTokens += billable(tokens.completion);
  row.cachedTokens += billable(tokens.cached);
  row.cacheWriteTokens += billable(tokens.cache_write);

  if (entry.estimate?.prompt !== undefined && billable(tokens.prompt) > 0) {
    bucket.deviations.push(
      (billable(entry.estimate.prompt) - billable(tokens.prompt)) / billable(tokens.prompt),
    );
  }

  if (!pricing) {
    row.unpricedEntries += 1;
    return;
  }
  const currency = pricing.currency ?? DEFAULT_CURRENCY;
  const cost = computeCost(tokens, pricing);
  row.costByCurrency[currency] = (row.costByCurrency[currency] ?? 0) + (cost?.total ?? 0);
  // 「节省」只计**读折扣**：缓存写入常是溢价（Anthropic 1.25×），把它折进节省会算出负数，
  // 而写溢价本身已经体现在 input 成本里，不该再记一次。
  const saved = line(tokens.cached ?? 0, pricing.input) - line(tokens.cached ?? 0, cacheReadPrice(pricing));
  row.cacheSavedByCurrency[currency] = (row.cacheSavedByCurrency[currency] ?? 0) + saved;
}

function finalize(bucket: Bucket): CostAggregateRow {
  const row = bucket.row;
  row.promptDeviationMedian = median(bucket.deviations);
  const currencies = Object.keys(row.costByCurrency).sort(byCode);
  if (currencies.length === 1) {
    row.currency = currencies[0]!;
    row.cost = row.costByCurrency[currencies[0]!] ?? null;
  } else {
    row.currency = null;
    row.cost = null;
  }
  return row;
}

/**
 * 聚合成本（按任务 / 按模型 + 总计）。
 * `resolvePricing(provider_id, model)` 由调用方从 config/llm.yaml 查出该条目对应的价格；
 * 返回 undefined 即「未配置价格」，条目计入 `unpricedEntries`。
 */
export function summarizeCosts(
  entries: CostEntry[],
  resolvePricing: (providerId: string | undefined, model: string | undefined) => ModelPricing | undefined,
): CostSummary {
  const tasks = new Map<string, Bucket>();
  const models = new Map<string, Bucket>();
  const totals: Bucket = { row: emptyRow(TOTALS_KEY), deviations: [] };

  for (const entry of entries) {
    const taskKey = entry.task && entry.task.trim() !== "" ? entry.task : UNTASKED;
    // 「按模型」以模型名为键（docs/04 口径）；同名跨 provider 会并入一行——
    // 若两家币种不同，行成本自动降级为 null 并按币种分列，不强行合计
    const modelKey =
      entry.model && entry.model.trim() !== ""
        ? entry.model
        : entry.provider_id && entry.provider_id.trim() !== ""
          ? `provider:${entry.provider_id}`
          : UNMODELLED;
    const pricing = resolvePricing(entry.provider_id, entry.model);

    for (const [map, key] of [
      [tasks, taskKey],
      [models, modelKey],
    ] as const) {
      let bucket = map.get(key);
      if (!bucket) {
        bucket = { row: emptyRow(key), deviations: [] };
        map.set(key, bucket);
      }
      accumulate(bucket, entry, pricing);
    }
    accumulate(totals, entry, pricing);
  }

  const rowsOf = (map: Map<string, Bucket>): CostAggregateRow[] =>
    [...map.values()].map(finalize).sort(byKeyCode);

  const totalsRow = finalize(totals);
  const byTask = rowsOf(tasks);
  const byModel = rowsOf(models);
  const currencies = Object.keys(totalsRow.costByCurrency).sort(byCode);

  return {
    byTask,
    byModel,
    totals: totalsRow,
    entriesWithoutTokens: totalsRow.entries - countWithTokens(entries),
    currencies,
  };
}

function countWithTokens(entries: CostEntry[]): number {
  return entries.filter(
    (entry) =>
      entry.tokens !== undefined &&
      (entry.tokens.prompt !== undefined ||
        entry.tokens.completion !== undefined ||
        entry.tokens.cached !== undefined ||
        entry.tokens.cache_write !== undefined),
  ).length;
}

const CURRENCY_SYMBOLS: Record<string, string> = { CNY: "¥", USD: "$" };

/**
 * 面板金额展示：null → 「未配置价格」（与 0 严格区分）；
 * 0 直出；极小金额（<0.01）保留 4 位小数，其余 2 位。
 */
export function formatCost(cost: number | null, currency: string): string {
  if (cost === null || !Number.isFinite(cost)) return "未配置价格";
  const symbol = CURRENCY_SYMBOLS[currency];
  const prefix = symbol ? symbol : `${currency} `;
  if (cost === 0) return `${prefix}0`;
  let digits = Math.abs(cost) < 0.01 ? 4 : 2;
  let text = cost.toFixed(digits);
  // 非零金额四舍五入后不得显示成 0（「花了钱」看起来像「免费」是最坏的展示）
  while (Number(text) === 0 && digits < 12) {
    digits += 2;
    text = cost.toFixed(digits);
  }
  return `${prefix}${text}`;
}
