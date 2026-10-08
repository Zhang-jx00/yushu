import { describe, expect, it } from "vitest";
import {
  LLM_API_VERSION,
  LLM_FORMAT_VERSION,
  checkCacheOrchestration,
  computeCost,
  costTokensOf,
  accumulateUsage,
  formatCost,
  lintLlmConfig,
  parseLlmConfig,
  serializeLlmConfig,
  summarizeCosts,
  type CostEntry,
  type LlmConfig,
  type ModelPricing,
} from "@yushu/llm";

/**
 * T3-12 Token 与成本（J09）：双口径（本地估算 + usage 实报）、按任务/模型聚合、
 * 未配置价格不猜价（计入 unpriced），以及 prompt caching 稳定前缀编排核对。
 * 单价口径：每 1M tokens（J09 §5 pricing/*.yaml 的 per_mtok）。
 */

const PRICING: ModelPricing = { currency: "CNY", input: 2.0, output: 8.0 };

function configWithModel(model: Record<string, unknown>): LlmConfig {
  return {
    apiVersion: LLM_API_VERSION,
    format_version: LLM_FORMAT_VERSION,
    providers: [
      {
        id: "primary",
        kind: "cloud",
        protocol: "openai_chat",
        base_url: "https://api.example.com/v1",
        models: [model as never],
      },
    ],
  };
}

describe("computeCost：usage 实报 → 金额", () => {
  it("按每 1M tokens 单价折算输入与输出", () => {
    const cost = computeCost({ prompt: 1000, completion: 500 }, PRICING);
    expect(cost).not.toBeNull();
    expect(cost!.inputCost).toBeCloseTo(0.002, 12);
    expect(cost!.outputCost).toBeCloseTo(0.004, 12);
    expect(cost!.cacheReadCost).toBe(0);
    expect(cost!.cacheWriteCost).toBe(0);
    expect(cost!.total).toBeCloseTo(0.006, 12);
    expect(cost!.currency).toBe("CNY");
  });

  it("cache_read / cache_write 缺省时与 input 同价（未声明折扣不猜价）", () => {
    const cost = computeCost({ prompt: 1000, cached: 1000, cache_write: 1000 }, PRICING);
    expect(cost!.inputCost).toBeCloseTo(0.002, 12);
    expect(cost!.cacheReadCost).toBeCloseTo(0.002, 12);
    expect(cost!.cacheWriteCost).toBeCloseTo(0.002, 12);
  });

  it("声明缓存单价时按各自单价计（Anthropic 读 0.1× / 写 1.25×）", () => {
    const cost = computeCost(
      { prompt: 1000, cached: 1000, cache_write: 1000 },
      { input: 2.0, output: 8.0, cache_read: 0.2, cache_write: 2.5 },
    );
    expect(cost!.cacheReadCost).toBeCloseTo(0.0002, 12);
    expect(cost!.cacheWriteCost).toBeCloseTo(0.0025, 12);
  });

  it("未配置价格返回 null（不猜价——成本由调用方标注「未配置价格」）", () => {
    expect(computeCost({ prompt: 1000 }, undefined)).toBeNull();
  });

  it("负数 token 视为脏数据按 0 计，不产生负金额", () => {
    const cost = computeCost({ prompt: -5, completion: -1 }, PRICING);
    expect(cost!.total).toBe(0);
  });
});

describe("costTokensOf：usage 字段收敛", () => {
  it("ChatUsage → CostTokens（cached / cache_write 字段名收敛）", () => {
    expect(
      costTokensOf({
        prompt_tokens: 400,
        completion_tokens: 200,
        cached_tokens: 600,
        cache_write_tokens: 100,
      }),
    ).toEqual({ prompt: 400, completion: 200, cached: 600, cache_write: 100 });
    expect(costTokensOf(undefined)).toEqual({});
  });

  it("accumulateUsage：多轮请求的 usage 逐字段相加（修复轮也要记账）", () => {
    expect(
      accumulateUsage(
        { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
        { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      ),
    ).toEqual({ prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 });
    expect(
      accumulateUsage(
        { prompt_tokens: 10, cached_tokens: 4, cache_write_tokens: 2 },
        { prompt_tokens: 1, cached_tokens: 6, total_tokens: 7 },
      ),
    ).toEqual({
      prompt_tokens: 11,
      cached_tokens: 10,
      cache_write_tokens: 2,
      total_tokens: 23,
    });
  });

  it("accumulateUsage：两侧皆空给 undefined（缺 usage 不伪造 0 记录）", () => {
    expect(accumulateUsage(undefined, undefined)).toBeUndefined();
    expect(accumulateUsage({}, {})).toBeUndefined();
  });

  it("accumulateUsage：有一方未回传 total 时按分项重算，不沿用半截 total", () => {
    expect(accumulateUsage({ prompt_tokens: 5, total_tokens: 5 }, { completion_tokens: 3 })).toEqual(
      { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    );
  });
});

describe("summarizeCosts：按任务 / 模型聚合 + 未配置价格如实计入", () => {
  const entries: CostEntry[] = [
    { task: "drafting", provider_id: "p1", model: "big", tokens: { prompt: 1000, completion: 500 } },
    { task: "drafting", provider_id: "p1", model: "big", tokens: { prompt: 2000, completion: 1000 } },
    { task: "summarize", provider_id: "p2", model: "small", tokens: { prompt: 800, completion: 100 } },
    // 无价格条目
    { task: "extract", provider_id: "p3", model: "unknown", tokens: { prompt: 500 } },
    // 旧记录 / 未回传 usage：无 tokens
    { task: "summarize", provider_id: "p1", model: "big" },
  ];

  function resolve(providerId?: string, model?: string): ModelPricing | undefined {
    if (providerId === "p1" && model === "big") return { input: 2, output: 8 };
    if (providerId === "p2" && model === "small") return { currency: "USD", input: 0.5, output: 2 };
    return undefined;
  }

  it("按任务聚合：条数、token 合计与排序稳定", () => {
    const summary = summarizeCosts(entries, resolve);
    expect(summary.byTask.map((row) => row.key)).toEqual(["drafting", "extract", "summarize"]);
    const drafting = summary.byTask.find((row) => row.key === "drafting")!;
    expect(drafting.entries).toBe(2);
    expect(drafting.promptTokens).toBe(3000);
    expect(drafting.completionTokens).toBe(1500);
    expect(drafting.cost).toBeCloseTo(0.018, 12);
  });

  it("未配置价格的条目计入 unpricedEntries，行成本为 null", () => {
    const summary = summarizeCosts(entries, resolve);
    const extract = summary.byTask.find((row) => row.key === "extract")!;
    expect(extract.unpricedEntries).toBe(1);
    expect(extract.cost).toBeNull();
    expect(extract.currency).toBeNull();
  });

  it("缺 usage 的条目计入 entriesWithoutTokens（cost-usage-missing 线索）", () => {
    const summary = summarizeCosts(entries, resolve);
    expect(summary.entriesWithoutTokens).toBe(1);
  });

  it("多币种不强行合计：行成本为 null，但按币种分别给出金额", () => {
    const summary = summarizeCosts(entries, resolve);
    const byModel = summary.byModel.find((row) => row.key === "small")!;
    expect(byModel.currency).toBe("USD");
    expect(byModel.costByCurrency["USD"]).toBeCloseTo(0.0006, 12);
    const totals = summary.totals;
    expect(totals.currency).toBeNull();
    // drafting 两条（0.006 + 0.012）= CNY 0.018；summarize 一条 USD 0.0006；extract 无价格
    expect(totals.costByCurrency["CNY"]).toBeCloseTo(0.018, 12);
    expect(totals.costByCurrency["USD"]).toBeCloseTo(0.0006, 12);
  });

  it("预估 vs 实报偏差取中位数（A3「偏差在可接受范围」的可核对口径）", () => {
    const summary = summarizeCosts(
      [
        { task: "drafting", provider_id: "p1", model: "big", tokens: { prompt: 1000 }, estimate: { prompt: 1200 } },
        { task: "drafting", provider_id: "p1", model: "big", tokens: { prompt: 1000 }, estimate: { prompt: 900 } },
      ],
      resolve,
    );
    const drafting = summary.byTask.find((row) => row.key === "drafting")!;
    expect(drafting.promptDeviationMedian).toBeCloseTo(0.05, 12);
  });

  it("缓存命中 token 单列，并按「全价 − 命中价」折算实际节省", () => {
    const summary = summarizeCosts(
      [
        {
          task: "drafting",
          provider_id: "p1",
          model: "big",
          tokens: { prompt: 1000, cached: 4000, completion: 500 },
        },
      ],
      () => ({ input: 2, output: 8, cache_read: 0.2 }),
    );
    const row = summary.totals;
    expect(row.cachedTokens).toBe(4000);
    // 4000 token 全价 0.008，命中价 0.0008 → 节省 0.0072
    expect(row.cacheSavedByCurrency["CNY"]).toBeCloseTo(0.0072, 12);
  });

  it("缓存写溢价不算进「节省」（Anthropic 写 1.25× 会把节省算成负数）", () => {
    const summary = summarizeCosts(
      [
        {
          task: "drafting",
          provider_id: "p1",
          model: "big",
          tokens: { prompt: 1000, cached: 1000, cache_write: 1000 },
        },
      ],
      () => ({ input: 2, output: 8, cache_read: 0.2, cache_write: 2.5 }),
    );
    // 节省只含读折扣：1000 tok ×（2 − 0.2）/1M = 0.0018；写溢价（0.0005）本身已在成本里，不重复折成负节省
    expect(summary.totals.cacheSavedByCurrency["CNY"]).toBeCloseTo(0.0018, 12);
  });

  it("空记录集给出空聚合而非报错", () => {
    const summary = summarizeCosts([], resolve);
    expect(summary.byTask).toEqual([]);
    expect(summary.totals.entries).toBe(0);
    expect(summary.totals.cost).toBeNull();
  });
});

describe("formatCost：面板金额展示", () => {
  it("零显示为 0；极小非零金额不得显示成 0（否则「花了钱」看起来像「免费」）", () => {
    expect(formatCost(0, "CNY")).toBe("¥0");
    expect(formatCost(0.000012, "CNY")).toBe("¥0.000012");
    expect(formatCost(0.006, "CNY")).toBe("¥0.0060");
    expect(formatCost(12.5, "CNY")).toBe("¥12.50");
    expect(formatCost(1.5, "USD")).toBe("$1.50");
    expect(formatCost(1.5, "EUR")).toBe("EUR 1.50");
  });

  it("null（未配置价格）给出明确文案而非 0", () => {
    expect(formatCost(null, "CNY")).toBe("未配置价格");
  });
});

describe("定价表解析与体检（config/llm.yaml model.pricing）", () => {
  it("pricing 往返保留（写入 YAML 再读回一致）", () => {
    const config = configWithModel({
      name: "big",
      tier: "flagship",
      pricing: { currency: "CNY", input: 2.5, output: 10, cache_read: 0.25 },
    });
    const parsed = parseLlmConfig(serializeLlmConfig(config));
    expect(parsed.providers[0]!.models[0]!.pricing).toEqual({
      currency: "CNY",
      input: 2.5,
      output: 10,
      cache_read: 0.25,
    });
  });

  it("pricing 非数字 / 负数 / 未知键 / NaN 一律拒绝", () => {
    const bad = [
      { input: "2.5", output: 8 },
      { input: -1, output: 8 },
      { input: 2, output: -0.5 },
      { input: 2, output: Number.NaN },
      { input: 2, output: 8, cache_read: -0.1 },
      { input: 2, output: 8, extra: 1 },
    ];
    for (const pricing of bad) {
      const text = serializeLlmConfig(configWithModel({ name: "m", tier: "small", pricing } as never));
      expect(() => parseLlmConfig(text)).toThrowError(/pricing/);
    }
  });

  it("本地零成本路径合法：input / output 允许 0（J09 实践 8，本地端点应显示 ¥0 而非「未配置价格」）", () => {
    const parsed = parseLlmConfig(
      serializeLlmConfig(configWithModel({ name: "m", tier: "small", pricing: { input: 0, output: 0 } } as never)),
    );
    expect(parsed.providers[0]!.models[0]!.pricing).toEqual({ input: 0, output: 0 });
    expect(computeCost({ prompt: 1000, completion: 500 }, { input: 0, output: 0 })!.total).toBe(0);
  });

  it("缺省不猜价：未配置 pricing 时 lint 提示「未配置价格」（面板标注来源）", () => {
    const warnings = lintLlmConfig(configWithModel({ name: "m", tier: "small" }));
    expect(warnings.some((item) => item.message.includes("未配置价格"))).toBe(true);
    const priced = lintLlmConfig(
      configWithModel({ name: "m", tier: "small", pricing: { input: 2, output: 8 } }),
    );
    expect(priced.some((item) => item.message.includes("未配置价格"))).toBe(false);
  });
});

describe("checkCacheOrchestration：稳定前缀置头与断点对齐（T3-12 步骤 5）", () => {
  const slots = [
    { slot: "system_prompt", stable: true, tokens: 300 },
    { slot: "world_core", stable: true, tokens: 1200 },
    { slot: "volume_summary", stable: true, tokens: 500 },
    { slot: "chapter_summary", stable: false, tokens: 400 },
    { slot: "recent_prose", stable: false, tokens: 900 },
  ];

  it("稳定槽位全部前置 → ordered，断点下标为最后一个稳定槽位", () => {
    const audit = checkCacheOrchestration({ slots, breakpointAfter: "volume_summary" });
    expect(audit.ordered).toBe(true);
    expect(audit.misplaced).toEqual([]);
    expect(audit.breakpointIndex).toBe(2);
    expect(audit.stableTokens).toBe(2000);
    expect(audit.unstableTokens).toBe(1300);
  });

  it("稳定槽位出现在不稳定槽位之后 → 判为击穿并点名（cache-prefix-unstable）", () => {
    const broken = [
      { slot: "system_prompt", stable: true, tokens: 300 },
      { slot: "chapter_summary", stable: false, tokens: 400 },
      { slot: "world_core", stable: true, tokens: 1200 },
    ];
    const audit = checkCacheOrchestration({ slots: broken, breakpointAfter: "system_prompt" });
    expect(audit.ordered).toBe(false);
    expect(audit.misplaced).toEqual(["world_core"]);
    expect(audit.warnings.some((text) => text.includes("前缀"))).toBe(true);
  });

  it("断点槽位不在清单中 → breakpointIndex = -1 并告警（不静默按 0 处理）", () => {
    const audit = checkCacheOrchestration({ slots, breakpointAfter: "style_card" });
    expect(audit.breakpointIndex).toBe(-1);
    expect(audit.warnings.some((text) => text.includes("style_card"))).toBe(true);
  });

  it("provider 未声明 cache 能力 → 如实提示无折扣", () => {
    const audit = checkCacheOrchestration({ slots, breakpointAfter: "volume_summary" });
    expect(audit.cacheDeclared).toBe(false);
    expect(audit.saving).toBeNull();
    expect(audit.warnings.some((text) => text.includes("未声明 cache"))).toBe(true);
  });

  it("声明 cache + 定价 → 只给「单次调用」的投影节省，不伪造累计复用次数", () => {
    const audit = checkCacheOrchestration({
      slots,
      breakpointAfter: "volume_summary",
      cache: { mode: "explicit", min_tokens: 1024, read_mult: 0.1 },
      pricing: { input: 2.0, output: 8.0 },
    });
    expect(audit.cacheDeclared).toBe(true);
    expect(audit.cacheMode).toBe("explicit");
    expect(audit.belowMinTokens).toBe(false);
    // 稳定前缀 2000 token：全价 0.004，命中价 0.1× → 单次节省 0.0036
    expect(audit.saving!.perCall).toBeCloseTo(0.0036, 12);
    // 累计需要「同一前缀被复用了几次」的真实计数——记录里并没有，因此不提供 total / calls
    expect(audit.saving!.total).toBeUndefined();
    expect(audit.saving!.currency).toBe("CNY");
  });

  it("稳定前缀未达 min_tokens 门槛 → 标注 belowMinTokens（缓存不会命中）", () => {
    const audit = checkCacheOrchestration({
      slots: [{ slot: "system_prompt", stable: true, tokens: 100 }],
      breakpointAfter: "system_prompt",
      cache: { mode: "explicit", min_tokens: 1024 },
      pricing: { input: 2.0, output: 8.0 },
    });
    expect(audit.belowMinTokens).toBe(true);
    expect(audit.warnings.some((text) => text.includes("1024"))).toBe(true);
  });

  it("未配置价格时节省额为 null（不猜价）", () => {
    const audit = checkCacheOrchestration({
      slots,
      breakpointAfter: "volume_summary",
      cache: { mode: "automatic" },
    });
    expect(audit.saving).toBeNull();
  });
});
