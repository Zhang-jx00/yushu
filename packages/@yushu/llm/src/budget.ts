import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { YushuError } from "@yushu/core";
import type { CostEntry } from "./cost.js";
import { computeCost } from "./cost.js";
import type { LlmProviderSpec, ModelPricing } from "./types.js";

/**
 * 预算护栏与成本体检（M3 / T3-12 遗留，J09 §5）。
 *
 * J09 把成本立方体的第四维与两条规则列为**遗留**（第 40 轮注记），本文件把它们从"隐含计数"
 * 升级成真正的 lint 结果：
 * - `cost-usage-missing`（warn）：provider 声明 `usage: true` 却没有任何 usage 回写 → 大概率是解析层漏了；
 * - `budget-context-overflow`（error）：组装输入 token > `context − max_output`（不给输出留余量就会撞墙）；
 * - `budget-monthly-cap`（warn / error）：月度已用相对 `monthly_cap` 的临近与超支（J09「临近上限时提示」）；
 * - `cost-per-chapter-anomaly`（warn）：单章成本超过全书均值的 N 倍（同章样本过少时不下结论）。
 *
 * **只报告、不自动改**：降级到小模型 / 拦截生成属于策略变更，需要用户在场决定（本轮不做，见 docs 遗留）。
 */

export const BUDGET_API_VERSION = "yushu.budget/v1";

export interface BudgetConfig {
  apiVersion: string;
  /** 月度上限（金额，单位见 currency）；缺省 = 不设预算 */
  monthly_cap?: number;
  /** 单次调用预估超过该值需用户确认（J09 `per_call_confirm_over`） */
  per_call_confirm_over?: number;
  currency?: string;
  /** 临近上限的比例阈值，达到即 warn（缺省 0.8） */
  warn_ratio?: number;
  /** 单章成本超过全书均值的该倍数即 warn（缺省 3） */
  chapter_anomaly_multiple?: number;
}

/** 成本体检结果（severity 与记忆体检同为 error | warn） */
export interface CostLintFinding {
  severity: "error" | "warn";
  code: string;
  /** 涉及的主体（provider / 章节 / 组装），便于面板定位 */
  subject_id: string;
  message: string;
}

export interface CostLintInput {
  entries: CostEntry[];
  /** 解析后的 provider 列表（用于判断"声明了 usage 却没回写"） */
  providers?: LlmProviderSpec[];
  budget?: BudgetConfig | null;
  /** 本自然月已发生的金额（按币种；由调用方从记录聚合） */
  spentThisMonth?: Record<string, number>;
  /** 一次组装的实测输入 token 与所选模型的上下文窗口 / 输出上限 */
  assembly?: { inputTokens: number; context?: number; maxOutput?: number } | null;
  /** 各章节已折算金额（只有配了价格才可能异常；未定价章节不参与判定） */
  chapterCosts?: Array<{ chapterId: string; cost: number; currency: string }>;
}

/** 用 YushuError 而非 LlmError：shared.ts 侧存在循环导入（R42 同因），错误码仍为 E_LLM_BUDGET */
function fail(message: string): never {
  throw new YushuError("E_LLM_BUDGET", message);
}

/**
 * 解析 `config/budget.yaml`（可选文件；不存在时调用方直接用缺省预算=不设限）。
 * 与 llm/routing 同一套严格约定：apiVersion 必须、未知键一律拒绝、数值必须为正。
 */
export function parseBudgetConfig(text: string): BudgetConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    return fail(`config/budget.yaml 无法解析：${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("config/budget.yaml 顶层应为映射");
  const record = raw as Record<string, unknown>;
  const apiVersion = record["apiVersion"];
  if (typeof apiVersion !== "string" || apiVersion !== BUDGET_API_VERSION) {
    fail(`config/budget.yaml 的 apiVersion 应为 ${BUDGET_API_VERSION}`);
  }
  for (const key of Object.keys(record)) {
    if (!["apiVersion", "monthly_cap", "per_call_confirm_over", "currency", "warn_ratio", "chapter_anomaly_multiple"].includes(key)) {
      fail(`config/budget.yaml 含未知键「${key}」（拒绝静默忽略：拼错的键会让护栏以为未配置）`);
    }
  }
  const positive = (key: string): number | undefined => {
    const value = record[key];
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      fail(`config/budget.yaml 的 ${key} 应为正数`);
    }
    return value;
  };
  const warnRatio = positive("warn_ratio");
  if (warnRatio !== undefined && warnRatio >= 1) fail("config/budget.yaml 的 warn_ratio 应小于 1（如 0.8）");
  const currency = record["currency"];
  if (currency !== undefined && typeof currency !== "string") fail("config/budget.yaml 的 currency 应为字符串");
  return {
    apiVersion: BUDGET_API_VERSION,
    ...(positive("monthly_cap") === undefined ? {} : { monthly_cap: positive("monthly_cap") }),
    ...(positive("per_call_confirm_over") === undefined ? {} : { per_call_confirm_over: positive("per_call_confirm_over") }),
    ...(typeof currency === "string" && currency.trim() !== "" ? { currency } : {}),
    ...(warnRatio === undefined ? {} : { warn_ratio: warnRatio }),
    ...(positive("chapter_anomaly_multiple") === undefined ? {} : { chapter_anomaly_multiple: positive("chapter_anomaly_multiple") }),
  };
}

/** 序列化（按键名固定顺序，同输入同字节；供 UI 落盘与快照可 diff） */
export function serializeBudgetConfig(config: BudgetConfig): string {
  const ordered: Record<string, unknown> = { apiVersion: config.apiVersion };
  if (config.currency !== undefined) ordered["currency"] = config.currency;
  if (config.monthly_cap !== undefined) ordered["monthly_cap"] = config.monthly_cap;
  if (config.per_call_confirm_over !== undefined) ordered["per_call_confirm_over"] = config.per_call_confirm_over;
  if (config.warn_ratio !== undefined) ordered["warn_ratio"] = config.warn_ratio;
  if (config.chapter_anomaly_multiple !== undefined) ordered["chapter_anomaly_multiple"] = config.chapter_anomaly_multiple;
  return stringifyYaml(ordered, { lineWidth: 0 });
}

/** 缺省预算：不设月度上限、临近阈值 0.8、单章异常倍数 3 */
export function defaultBudgetConfig(): BudgetConfig {
  return { apiVersion: BUDGET_API_VERSION, warn_ratio: 0.8, chapter_anomaly_multiple: 3 };
}

function usageDeclared(providers: LlmProviderSpec[] | undefined, providerId: string | undefined, model: string | undefined): boolean | null {
  if (!providers || !providerId) return null;
  const provider = providers.find((candidate) => candidate.id === providerId);
  if (!provider) return null;
  const spec =
    (model ? provider.models.find((candidate) => candidate.name === model) : undefined) ?? provider.models[0];
  if (!spec) return null;
  // capabilities 在规范类型里是可选的（解析层才合并保守默认），因此用可选链：未声明即视为未声明
  return spec.capabilities?.usage === true;
}

/**
 * 成本体检：四条规则一次跑完，**只报不调**（结果按严重度 → 规则码 → 主体排序，同输入同输出）。
 * 缺输入的规则整条跳过——不猜、也不用 0 冒充。
 */
export function lintCost(input: CostLintInput): CostLintFinding[] {
  const findings: CostLintFinding[] = [];

  // ① cost-usage-missing：声明 usage 却没回写 tokens
  const missing = new Map<string, number>();
  for (const entry of input.entries) {
    if (isAdoptEntry(entry)) continue;
    const declared = usageDeclared(input.providers, entry.provider_id, entry.model);
    if (declared !== true) continue;
    const hasTokens =
      entry.tokens !== undefined &&
      (entry.tokens.prompt !== undefined ||
        entry.tokens.completion !== undefined ||
        entry.tokens.cached !== undefined ||
        entry.tokens.cache_write !== undefined);
    if (hasTokens) continue;
    const key = `${entry.provider_id ?? "?"}/${entry.model ?? "?"}`;
    missing.set(key, (missing.get(key) ?? 0) + 1);
  }
  for (const [key, count] of missing) {
    findings.push({
      severity: "warn",
      code: "cost-usage-missing",
      subject_id: key,
      message: `${key} 声明支持 usage 回写，却有 ${count} 条记录没有 token —— 成本面板只能按估算显示，请检查协议解析层是否丢弃了 usage 字段`,
    });
  }

  // ② budget-context-overflow：输入 + 输出余量超过上下文窗口
  const assembly = input.assembly;
  if (assembly && assembly.context !== undefined && assembly.context > 0) {
    const reserve = assembly.maxOutput ?? 0;
    const limit = assembly.context - reserve;
    if (assembly.inputTokens > limit) {
      findings.push({
        severity: "error",
        code: "budget-context-overflow",
        subject_id: "assembly",
        message: `组装输入 ${assembly.inputTokens} tok 超过可用窗口 ${limit} tok（context ${assembly.context} − 预留输出 ${reserve}）：继续发送会被截断或直接报错，请先降预算逐出或换长上下文模型`,
      });
    }
  }

  // ③ 月度预算护栏
  const budget = input.budget;
  if (budget?.monthly_cap !== undefined) {
    const currency = budget.currency ?? Object.keys(input.spentThisMonth ?? {})[0];
    const spent = currency !== undefined ? (input.spentThisMonth?.[currency] ?? 0) : 0;
    const ratio = spent / budget.monthly_cap;
    const warnAt = budget.warn_ratio ?? 0.8;
    if (ratio > 1) {
      findings.push({
        severity: "error",
        code: "budget-monthly-cap",
        subject_id: `monthly:${currency ?? "?"}`,
        message: `本月已用 ${spent.toFixed(4)} 已超过月度上限 ${budget.monthly_cap}（${Math.round(ratio * 100)}%）：建议本轮改用本地模型或小档`,
      });
    } else if (ratio >= warnAt) {
      findings.push({
        severity: "warn",
        code: "budget-monthly-cap",
        subject_id: `monthly:${currency ?? "?"}`,
        message: `本月已用 ${spent.toFixed(4)} 达月度上限 ${budget.monthly_cap} 的 ${Math.round(ratio * 100)}%（提示阈值 ${Math.round(warnAt * 100)}%）`,
      });
    }
  }

  // ④ 单章成本异常：超过全书均值 N 倍（样本 < 3 不下结论，避免两章时必然"异常"）
  const chapters = input.chapterCosts ?? [];
  const multiple = budget?.chapter_anomaly_multiple ?? 3;
  if (chapters.length >= 3) {
    const mean = chapters.reduce((sum, item) => sum + item.cost, 0) / chapters.length;
    if (mean > 0) {
      for (const chapter of chapters) {
        if (chapter.cost > mean * multiple) {
          findings.push({
            severity: "warn",
            code: "cost-per-chapter-anomaly",
            subject_id: chapter.chapterId,
            message: `章节 ${chapter.chapterId} 成本 ${chapter.cost.toFixed(4)} 为全书均值 ${mean.toFixed(4)} 的 ${(chapter.cost / mean).toFixed(1)} 倍（阈值 ${multiple}×）：确认是否整章重生成或上下文异常膨胀`,
          });
        }
      }
    }
  }

  return findings.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "error" ? -1 : 1;
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    return a.subject_id < b.subject_id ? -1 : a.subject_id > b.subject_id ? 1 : 0;
  });
}

/** 采纳类记录不参与 usage 判定：采纳不发请求，自然没有 usage 回写 */
function isAdoptEntry(entry: CostEntry): boolean {
  return entry.task === "adopt";
}

/** 章节维度金额（供 lintCost 的异常判定与面板下钻共用，避免两处各算一遍） */
export function chapterCostsOf(
  entries: CostEntry[],
  resolvePricing: (providerId: string | undefined, model: string | undefined) => ModelPricing | undefined,
): Array<{ chapterId: string; cost: number; currency: string }> {
  const buckets = new Map<string, { cost: number; currency: string }>();
  for (const entry of entries) {
    const chapterId = entry.chapter_id;
    if (!chapterId || chapterId.trim() === "") continue;
    const tokens = entry.tokens;
    if (!tokens) continue;
    const cost = computeCost(tokens, resolvePricing(entry.provider_id, entry.model));
    if (cost === null) continue;
    const existing = buckets.get(chapterId);
    if (existing) {
      if (existing.currency === cost.currency) existing.cost += cost.total;
      continue; // 币种不同的章节不强行相加
    }
    buckets.set(chapterId, { cost: cost.total, currency: cost.currency });
  }
  return [...buckets.entries()]
    .map(([chapterId, value]) => ({ chapterId, cost: value.cost, currency: value.currency }))
    .sort((a, b) => (a.chapterId < b.chapterId ? -1 : a.chapterId > b.chapterId ? 1 : 0));
}

/** 记录时间 → 归月键（`YYYY-MM`）；与写入侧 `new Date().toISOString()` 同为 UTC 口径 */
export function monthKeyOf(time: string | undefined): string | null {
  if (!time) return null;
  const match = /^(\d{4})-(\d{2})/.exec(time);
  return match ? `${match[1]}-${match[2]}` : null;
}

/** 当前归月（now 由调用方注入以便测；UTC 与记录写入同口径，跨月边界至多差一天并在面板写明） */
export function currentMonthKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** 月度已用（按币种与来源口径分列） */
export interface MonthSpend {
  /** 合计金额（实报 + 仅估算两口径相加；来源见 bySource） */
  byCurrency: Record<string, number>;
  bySource: { usage: Record<string, number>; estimate: Record<string, number> };
  /** 本月内「有 token 口径但没配价格」→ 无法折算金额 */
  unpriced: number;
  /** 本月内「usage 与估算都缺」→ 连 token 数都无法确定 */
  uncounted: number;
  /** 归入本月的记录总数（含上面两类无法计入的） */
  records: number;
}

/**
 * 本自然月已用金额。
 *
 * 口径：优先 usage 实报；实报缺失但存在本地估算的记录**也计入合计**（护栏要回答"这个月花了多少"，
 * 只算实报会系统性少报），但两个来源分列可见，不混为一谈。
 * 未定价、两口径皆缺、`time` 缺失或不可解析的记录一律不进分子——**用 0 冒充会让护栏看起来在工作**。
 */
export function spentInMonth(
  entries: CostEntry[],
  resolvePricing: (providerId: string | undefined, model: string | undefined) => ModelPricing | undefined,
  monthKey: string,
): MonthSpend {
  const usage: Record<string, number> = {};
  const estimate: Record<string, number> = {};
  const total: Record<string, number> = {};
  const add = (bucket: Record<string, number>, cost: { total: number; currency: string }) => {
    bucket[cost.currency] = (bucket[cost.currency] ?? 0) + cost.total;
    total[cost.currency] = (total[cost.currency] ?? 0) + cost.total;
  };
  let unpriced = 0;
  let uncounted = 0;
  let records = 0;
  for (const entry of entries) {
    if (monthKeyOf(entry.time) !== monthKey) continue;
    records += 1;
    const tokens = entry.tokens ?? entry.estimate;
    if (!tokens) {
      uncounted += 1;
      continue;
    }
    const cost = computeCost(tokens, resolvePricing(entry.provider_id, entry.model));
    if (cost === null) {
      unpriced += 1;
      continue;
    }
    add(entry.tokens ? usage : estimate, cost);
  }
  return { byCurrency: total, bySource: { usage, estimate }, unpriced, uncounted, records };
}
