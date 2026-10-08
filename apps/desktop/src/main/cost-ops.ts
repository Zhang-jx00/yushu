import {
  checkCacheOrchestration,
  formatCost,
  orderProvidersByRoute,
  resolveCapabilities,
  resolveRoute,
  summarizeCosts,
  type CostAggregateRow,
  type CostEntry,
  type CostTokens,
  type ModelPricing,
} from "@yushu/llm";
import { estimateTokens } from "@yushu/memory";
import type {
  AiCostPanelPayload,
  AiCostPayload,
  CostPricingRowPayload,
  CostRowPayload,
} from "../shared/ipc.js";
import { loadLlmConfigForUse, loadRoutingConfigForUse } from "./ai-ops.js";
import type { ProjectGateway } from "./file-gateway.js";
import { buildContextPreview } from "./prompt-ops.js";
import { AI_USAGE_PATH, readAiUsage } from "./ai-usage.js";

/**
 * Token 与成本面板（T3-12，J09）：把 `.yushu/ai-usage.jsonl` 的实报/估算投影成可分解的成本，
 * 并对当前章节的稳定前缀编排做一次只读核对（prompt caching 断点是否真的置头）。
 *
 * 口径纪律（与 @yushu/llm cost.ts / cache.ts 同源，面板 notes 如实外显）：
 * - 价格只来自 `config/llm.yaml` 的 `models[].pricing`；查不到即「未配置价格」，**绝不按市场价猜**；
 * - token 优先 usage 实报，缺实时只有估算（估算来自 @yushu/memory 的 estimateTokens，全局单一口径）；
 * - 聚合是只读的：不改真源、不写文件（派生日志本身已由生成路径落盘）。
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
  let fallbackEntries = 0;
  const resolvePricing = (providerId?: string, model?: string): ModelPricing | undefined => {
    if (!providerId || !model) return undefined;
    const exact = pricingIndex.get(pricingKey(providerId, model));
    if (exact) return exact;
    const priced = pricedModelsByProvider.get(providerId);
    if (priced && priced.length === 1) {
      fallbackEntries += 1;
      return priced[0];
    }
    return undefined;
  };

  // 只对「模型调用」聚合：adopt 记录是用户采纳动作，没有 token 语义，计入会虚增条目数
  const callEntries = usageEntries.filter((entry) => entry.type === "generate");
  const summary = summarizeCosts(
    callEntries.map((entry) =>
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
    ),
    resolvePricing,
  );

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
    cache: await auditCache(gateway, config, payload),
    notes,
  };
}

/**
 * 稳定前缀编排核对（T3-12 步骤 5）：以 drafting 路由**实际会用的那个模型**声明的 cache 能力与
 * 定价为基准，检查组装槽位是否「稳定在前、易变在后」，并给出断点下位与投影节省。
 * 未选定章纲时返回 null（没有可核对的组装结果，不做无中生有的推断）。
 */
async function auditCache(
  gateway: ProjectGateway,
  config: Awaited<ReturnType<typeof loadLlmConfigForUse>>,
  payload: AiCostPayload,
): Promise<AiCostPanelPayload["cache"]> {
  if (!payload.volumeId || !payload.chapterId) return null;
  const preview = await buildContextPreview(gateway, {
    volumeId: payload.volumeId,
    chapterId: payload.chapterId,
  });
  if (!preview.target) return null;
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
  const audit = checkCacheOrchestration({
    slots: slotRows,
    breakpointAfter: preview.cacheBreakpointAfter,
    ...(cache ? { cache } : {}),
    ...(model?.pricing ? { pricing: model.pricing } : {}),
  });
  return {
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
  };
}
