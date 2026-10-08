import {
  chapterCostsOf,
  checkCacheOrchestration,
  currentMonthKey,
  formatCost,
  hasUsageTokens,
  lintCost,
  orderProvidersByRoute,
  resolveCapabilities,
  resolveRoute,
  spentInMonth,
  summarizeCosts,
  type BudgetConfig,
  type CostAggregateRow,
  type CostEntry,
  type CostTokens,
  type ModelPricing,
} from "@yushu/llm";
import { estimateTokens } from "@yushu/memory";
import { BUDGET_CONFIG_PATH } from "@yushu/world-engine";
import type {
  AiCostPanelPayload,
  AiCostPayload,
  BudgetStatePayload,
  CostPricingRowPayload,
  CostRowPayload,
} from "../shared/ipc.js";
import { loadBudgetConfigForUse, loadLlmConfigForUse, loadRoutingConfigForUse } from "./ai-ops.js";
import type { ProjectGateway } from "./file-gateway.js";
import { buildContextPreview } from "./prompt-ops.js";
import { AI_USAGE_PATH, readAiUsage } from "./ai-usage.js";

/**
 * Token 与成本面板（T3-12，J09）：把 `.yushu/ai-usage.jsonl` 的实报/估算投影成可分解的成本，
 * 并对当前章节的稳定前缀编排做一次只读核对（prompt caching 断点是否真的置头）。
 *
 * 口径纪律（与 @yushu/llm cost.ts / cache.ts / budget.ts 同源，面板 notes 如实外显）：
 * - 价格只来自 `config/llm.yaml` 的 `models[].pricing`；查不到即「未配置价格」，**绝不按市场价猜**；
 * - token 优先 usage 实报，缺实时只有估算（估算来自 @yushu/memory 的 estimateTokens，全局单一口径）；
 * - 聚合与体检都是**只读**的：不改真源、不写文件（派生日志本身已由生成路径落盘）；
 * - 体检「只报不改」：降级小模型 / 拦截生成属策略变更，需要作者在场决定，面板只给结论与依据。
 */

/** 扫描上限：本地 JSONL 一次读满 1 万条（超出即只聚合最近的部分，notes 里如实说明） */
const COST_SCAN_LIMIT = 10000;

/** 预估 vs 实付偏差的告警阈值（J09：超此值提示校准 tokenizer / 定价表，而不是只显示数字） */
const DEVIATION_ALERT_RATIO = 0.5;

/** provider+model → pricing 的索引键（用 JSON 序列化避免分隔符歧义） */
function pricingKey(providerId: string, model: string): string {
  return JSON.stringify([providerId, model]);
}

/**
 * 聚合行 → IPC 行：数字原样透传（e2e 与后续导出用），展示文本在主进程统一生成
 * ——渲染层不导入 @yushu 包，格式化只此一处，避免长出第二套口径。
 */
function toRowPayload(row: CostAggregateRow): CostRowPayload {
  const pricedCurrencies = Object.keys(row.costByCurrency);
  const costText =
    row.cost !== null && row.currency
      ? formatCost(row.cost, row.currency)
      : pricedCurrencies.length > 1
        ? "多币种（见分列）"
        : "未配置价格";
  const cacheSavedText =
    row.currency && row.currency in row.cacheSavedByCurrency
      ? formatCost(row.cacheSavedByCurrency[row.currency]!, row.currency)
      : Object.keys(row.cacheSavedByCurrency).length > 1
        ? "多币种（见分列）"
        : "—";
  const deviation = row.promptDeviationMedian;
  let deviationText =
    deviation === null
      ? "无可对账记录（缺 usage 或缺估算）"
      : `${deviation >= 0 ? "+" : ""}${(deviation * 100).toFixed(1)}%`;
  // J09 实践 2：偏差超阈值要点名（本地端点常不回传真实 usage，只甩一个惊悚百分比等于没提示）
  if (deviation !== null && Math.abs(deviation) > DEVIATION_ALERT_RATIO) {
    deviationText += `（偏差过大：核查 provider 是否回传真实 usage、定价与估算口径是否匹配）`;
  }
  return {
    ...row,
    costText,
    cacheSavedText,
    deviationText,
  };
}

function toCostEntry(entry: {
  task?: string;
  provider_id?: string;
  model?: string;
  channel?: "batch" | "sync";
  chapter_id?: string;
  time?: string;
  tokens?: CostTokens;
  estimate?: CostTokens;
}): CostEntry {
  const item: CostEntry = {};
  if (entry.task) item.task = entry.task;
  if (entry.chapter_id) item.chapter_id = entry.chapter_id;
  if (entry.time) item.time = entry.time;
  if (entry.provider_id) item.provider_id = entry.provider_id;
  if (entry.model) item.model = entry.model;
  if (entry.channel) item.channel = entry.channel;
  if (entry.tokens) item.tokens = entry.tokens;
  if (entry.estimate) item.estimate = entry.estimate;
  return item;
}

export async function readCostPanel(
  gateway: ProjectGateway,
  payload: AiCostPayload = {},
): Promise<AiCostPanelPayload> {
  const usageEntries = await readAiUsage(gateway.root, COST_SCAN_LIMIT);
  const config = await loadLlmConfigForUse(gateway);

  const pricingIndex = new Map<string, ModelPricing>();
  const pricingRows: CostPricingRowPayload[] = [];
  /** provider.id → 该 provider 已配置价格的模型清单（回显名查不中时的回落依据） */
  const pricedModelsByProvider = new Map<string, ModelPricing[]>();
  for (const provider of config.providers) {
    const priced: ModelPricing[] = [];
    for (const model of provider.models) {
      if (model.pricing) {
        pricingIndex.set(pricingKey(provider.id, model.name), model.pricing);
        priced.push(model.pricing);
        pricingRows.push({
          provider_id: provider.id,
          model: model.name,
          configured: true,
          ...(model.pricing.currency ? { currency: model.pricing.currency } : {}),
          input: model.pricing.input,
          output: model.pricing.output,
          ...(model.pricing.cache_read !== undefined
            ? { cache_read: model.pricing.cache_read }
            : {}),
          ...(model.pricing.cache_write !== undefined
            ? { cache_write: model.pricing.cache_write }
            : {}),
        });
      } else {
        pricingRows.push({ provider_id: provider.id, model: model.name, configured: false });
      }
    }
    if (priced.length > 0) pricedModelsByProvider.set(provider.id, priced);
  }
  // 回落只在「该 provider 只有一个价」时启用：真端点常回显具体版本名（带日期后缀），
  // 与配置里的别名对不上；多价 provider 无法判断该用哪个，宁可计入未配置价格也不猜。
  const pricingFor = (
    providerId?: string,
    model?: string,
  ): { pricing?: ModelPricing; viaFallback: boolean } => {
    if (!providerId || !model) return { viaFallback: false };
    const exact = pricingIndex.get(pricingKey(providerId, model));
    if (exact) return { pricing: exact, viaFallback: false };
    const priced = pricedModelsByProvider.get(providerId);
    if (priced && priced.length === 1) return { pricing: priced[0], viaFallback: true };
    return { viaFallback: false };
  };
  const resolvePricing = (providerId?: string, model?: string): ModelPricing | undefined =>
    pricingFor(providerId, model).pricing;

  // 只对「模型调用」聚合：adopt 记录是用户采纳动作，没有 token 语义，计入会虚增条目数
  const callEntries = usageEntries.filter((entry) => entry.type === "generate");
  const costEntries: CostEntry[] = callEntries.map((entry) =>
    toCostEntry({
      task: entry.task,
      provider_id: entry.provider_id,
      model: entry.model,
      channel: entry.channel,
      chapter_id: entry.chapter_id,
      time: entry.time,
      tokens: entry.tokens as CostTokens | undefined,
      estimate: entry.estimate as CostTokens | undefined,
    }),
  );
  const summary = summarizeCosts(costEntries, resolvePricing);
  /**
   * 回落条数单独走一遍：查价本身已无副作用。
   * R49 把月度与章节体检接进来后，同一个 `resolvePricing` 被三处聚合调用，
   * 原先"计数塞在查价里"立刻把 1 条记成 2 条（单测抓到）——计数属于统计，不属于取数。
   */
  const fallbackEntries = costEntries.filter(
    (entry) => hasUsageTokens(entry) && pricingFor(entry.provider_id, entry.model).viaFallback,
  ).length;

  // 编排核对与组装溢出体检共用一次预览（各算一遍会因两次读盘取到不同正文而漂移）
  const drafting = await auditDrafting(gateway, config, payload);
  const budgetPayload = await buildBudgetState(gateway, config, costEntries, resolvePricing, drafting);

  const notes: string[] = [
    `金额按 config/llm.yaml 的 models[].pricing 折算（每 1M tokens）；未配置价格的模型只报 token，金额标注「未配置价格」（共 ${
      pricingRows.filter((row) => !row.configured).length
    } 个模型未配置）。`,
    "token 优先取 provider 的 usage 实报；实报缺失的记录计入「无 token 记录」，绝不拿字数臆造 token。",
    "多币种不强行合计：混合时行金额留空，按币种分列。",
    "采纳（adopt）记录属用户动作、非模型调用，不参与成本聚合。",
    "缓存节省为**单次调用的投影**（假设稳定前缀命中）：同前缀实际被复用几次并无记录来源，故不给累计金额。",
    `口径：本地估算 = CJK≈1 token/字、ASCII≈1/4 字符（@yushu/memory estimateTokens，全局单一口径）。`,
    `扫描上限 ${COST_SCAN_LIMIT} 条：本文件读到 ${usageEntries.length} 条参与聚合（超出上限的历史记录不计入）。`,
    `成本体检只报不改：不自动改配置、不拦截生成（降级与小档切换需作者在场）；归月按记录时间的 UTC 前 7 位（本月 ${budgetPayload.monthKey}），未定价与缺 token 口径的记录**不进本月分子**，只计条数。`,
  ];
  if (fallbackEntries > 0) {
    notes.push(
      `${fallbackEntries} 条记录的**回显模型名与配置名不一致**（端点常返回带日期后缀的具体版本）：已按该 provider 的唯一单价折算；若该 provider 配了多个价模型则不猜价、计入未配置。`,
    );
  }

  return {
    path: AI_USAGE_PATH,
    entries: usageEntries.length,
    byTask: summary.byTask.map(toRowPayload),
    byModel: summary.byModel.map(toRowPayload),
    byChapter: summary.byChapter.map(toRowPayload),

    totals: toRowPayload(summary.totals),
    entriesWithoutTokens: summary.entriesWithoutTokens,
    currencies: summary.currencies,
    pricingFallback: fallbackEntries,
    pricing: pricingRows,
    cache: drafting.cache,
    budget: budgetPayload,
    notes,
  };
}

/** drafting 路由目标模型的组装结果（编排核对 + 溢出体检共用） */
interface DraftingAssembly {
  inputTokens: number;
  context?: number;
  maxOutput?: number;
}

/**
 * 稳定前缀编排核对（T3-12 步骤 5）与组装体检输入（R49，J09 `budget-context-overflow`）：
 * 以 drafting 路由**实际会用的那个模型**声明的 cache 能力、定价与窗口为基准，检查组装槽位是否
 * 「稳定在前、易变在后」，并给出断点下位与投影节省。
 * 未选定章纲时两者都返回 null（没有可核对的组装结果，不做无中生有的推断）。
 */
async function auditDrafting(
  gateway: ProjectGateway,
  config: Awaited<ReturnType<typeof loadLlmConfigForUse>>,
  payload: AiCostPayload,
): Promise<{ cache: AiCostPanelPayload["cache"]; assembly: DraftingAssembly | null }> {
  if (!payload.volumeId || !payload.chapterId) return { cache: null, assembly: null };
  const preview = await buildContextPreview(gateway, {
    volumeId: payload.volumeId,
    chapterId: payload.chapterId,
  });
  if (!preview.target) return { cache: null, assembly: null };
  const routing = await loadRoutingConfigForUse(gateway);
  const route = resolveRoute("drafting", config.providers, routing);
  const head = orderProvidersByRoute(config.providers, route)[0];
  const model = head?.models[0];
  const target = head && model ? `${head.id} · ${model.name}` : "（无可用 provider）";
  const cache = model ? resolveCapabilities(model).cache : undefined;
  const slotRows = preview.slots.map((slot) => ({
    slot: slot.slot,
    stable: slot.stable,
    tokens: estimateTokens(slot.text),
  }));
  // 组装输入 = 全部槽位估算之和（与编排核对同一份 token 口径，不另起一算）
  const assembly: DraftingAssembly = {
    inputTokens: slotRows.reduce((sum, slot) => sum + slot.tokens, 0),
    ...(model?.limits?.context !== undefined ? { context: model.limits.context } : {}),
    ...(model?.limits?.max_output !== undefined ? { maxOutput: model.limits.max_output } : {}),
  };
  const audit = checkCacheOrchestration({
    slots: slotRows,
    breakpointAfter: preview.cacheBreakpointAfter,
    ...(cache ? { cache } : {}),
    ...(model?.pricing ? { pricing: model.pricing } : {}),
  });
  return {
    cache: {
      chapter_id: payload.chapterId,
      breakpointAfter: audit.breakpointAfter,
      breakpointIndex: audit.breakpointIndex,
      ordered: audit.ordered,
      misplaced: audit.misplaced,
      stableTokens: audit.stableTokens,
      unstableTokens: audit.unstableTokens,
      cacheDeclared: audit.cacheDeclared,
      cacheMode: audit.cacheMode,
      belowMinTokens: audit.belowMinTokens,
      saving: audit.saving,
      savingText: audit.saving
        ? `单次投影（假设前缀命中）：${formatCost(audit.saving.perCall, audit.saving.currency)}`
        : "不估算（未配置价格或未声明缓存读价）",
      warnings: audit.warnings,
      slots: slotRows,
      target,
    },
    assembly,
  };
}

/**
 * 预算护栏与成本体检（R49，J09 §5）：把「本月已用 + 组装实测 + 章节金额」喂给 `lintCost`。
 *
 * 三条口径纪律：
 * - **缺输入的规则整条跳过并说明原因**（skipped），不把"没跑"显示成"没问题"；
 * - `config/budget.yaml` 解析失败时按内置默认继续，但错误原文外显 + 追加一条 error 级发现，
 *   **绝不静默回落到"未配置"**（那会让作者以为护栏正按他写的上限盯着）；
 * - 本月已用优先 usage 实报、实报缺失时用本地估算补（分列展示），未定价与无 token 的记录
 *   不进分子——用 0 冒充会让护栏看起来在工作。
 */
async function buildBudgetState(
  gateway: ProjectGateway,
  config: Awaited<ReturnType<typeof loadLlmConfigForUse>>,
  costEntries: CostEntry[],
  resolvePricing: (providerId?: string, model?: string) => ModelPricing | undefined,
  drafting: { assembly: DraftingAssembly | null },
): Promise<BudgetStatePayload> {
  const loaded = await loadBudgetConfigForUse(gateway);
  const budget: BudgetConfig = loaded.config;
  const currency = budget.currency ?? "CNY"; // 与定价缺省币种同源（llm/types：pricing.currency 缺省 CNY）
  const monthKey = currentMonthKey();
  const spend = spentInMonth(costEntries, resolvePricing, monthKey);
  const chapterCosts = chapterCostsOf(costEntries, resolvePricing);
  const findings = lintCost({
    entries: costEntries,
    providers: config.providers,
    budget,
    spentThisMonth: spend.byCurrency,
    ...(drafting.assembly ? { assembly: drafting.assembly } : {}),
    chapterCosts,
  });
  if (loaded.error !== null) {
    // 配置错误排在最前：它解释了后面这些数字为什么用的是默认值
    findings.unshift({
      severity: "error",
      code: "budget-config-invalid",
      subject_id: BUDGET_CONFIG_PATH,
      message: `${BUDGET_CONFIG_PATH} 解析失败，本轮按内置默认（不设月度上限）核对：${loaded.error}`,
    });
  }

  const skipped: string[] = [];
  if (budget.monthly_cap === undefined) {
    skipped.push("budget-monthly-cap：未配置 monthly_cap —— 不设月度上限（护栏不替作者猜一个预算）");
  }
  if (!drafting.assembly) {
    skipped.push("budget-context-overflow：未选定章纲或该章无组装结果 —— 没有实测输入 token 可核对");
  } else if (drafting.assembly.context === undefined) {
    skipped.push("budget-context-overflow：所选模型未声明 limits.context —— 没有窗口值可比");
  }
  if (chapterCosts.length < 3) {
    skipped.push(
      `cost-per-chapter-anomaly：可折算金额的章节 ${chapterCosts.length} 个 < 3 —— 样本太短时"高的那章"必然超均值倍数，报了就是误报`,
    );
  }
  const declaresUsage = config.providers.some((provider) =>
    provider.models.some((model) => model.capabilities?.usage === true),
  );
  if (!declaresUsage) {
    skipped.push("cost-usage-missing：没有任何 provider 声明 usage 能力 —— 无从判断「声明了却没回写」");
  }

  return {
    path: BUDGET_CONFIG_PATH,
    exists: loaded.exists,
    error: loaded.error,
    monthlyCap: budget.monthly_cap ?? null,
    monthlyCapText:
      budget.monthly_cap === undefined ? "未配置（不设月度上限）" : formatCost(budget.monthly_cap, currency),
    currency: budget.currency ?? null,
    warnRatio: budget.warn_ratio ?? 0.8,
    chapterMultiple: budget.chapter_anomaly_multiple ?? 3,
    monthKey,
    spentRows: Object.entries(spend.byCurrency).map(([rowCurrency, total]) => ({
      currency: rowCurrency,
      totalText: formatCost(total, rowCurrency),
      usageText: formatCost(spend.bySource.usage[rowCurrency] ?? 0, rowCurrency),
      estimateText: formatCost(spend.bySource.estimate[rowCurrency] ?? 0, rowCurrency),
    })),
    unpriced: spend.unpriced,
    uncounted: spend.uncounted,
    records: spend.records,
    lint: findings,
    skipped,
  };
}
