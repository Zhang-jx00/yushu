import { describe, expect, it } from "vitest";
import {
  chapterCostsOf,
  defaultBudgetConfig,
  lintCost,
  parseBudgetConfig,
  serializeBudgetConfig,
  summarizeCosts,
  type CostEntry,
  type LlmProviderSpec,
} from "../src/index.js";

/**
 * 预算护栏与成本体检（T3-12 遗留收口，J09 §5）。
 * 四条规则都必须有"该命中"与"**不该命中**"两侧断言——lint 误报一次，作者就会开始忽略整个面板。
 */

const providers: LlmProviderSpec[] = [
  {
    id: "cloud",
    kind: "cloud",
    protocol: "openai_chat",
    base_url: "https://api.example.com/v1",
    models: [
      {
        name: "big",
        tier: "flagship",
        capabilities: {
          tools: false,
          structured_output: false,
          stream: true,
          usage: true,
          reasoning: false,
          vision: false,
          batch: false,
        },
        pricing: { input: 12, output: 36 },
      },
    ],
  },
  {
    id: "local",
    kind: "local",
    protocol: "openai_chat",
    base_url: "http://127.0.0.1:11434/v1",
    models: [
      {
        name: "small",
        tier: "small",
        capabilities: {
          tools: false,
          structured_output: false,
          stream: true,
          usage: false,
          reasoning: false,
          vision: false,
          batch: false,
        },
      },
    ],
  },
];

const priced = (providerId: string | undefined, model: string | undefined) =>
  providerId === "cloud" && model === "big" ? { input: 12, output: 36 } : undefined;

const entry = (over: Partial<CostEntry> = {}): CostEntry => ({
  task: "generate",
  provider_id: "cloud",
  model: "big",
  tokens: { prompt: 1000, completion: 500 },
  ...over,
});

describe("config/budget.yaml 解析", () => {
  it("正常解析与缺省值", () => {
    const config = parseBudgetConfig(
      ["apiVersion: yushu.budget/v1", "currency: CNY", "monthly_cap: 30", "per_call_confirm_over: 1"].join("\n"),
    );
    expect(config).toEqual({
      apiVersion: "yushu.budget/v1",
      currency: "CNY",
      monthly_cap: 30,
      per_call_confirm_over: 1,
    });
    expect(defaultBudgetConfig().monthly_cap).toBeUndefined(); // 缺省 = 不设预算，不猜一个数
    expect(defaultBudgetConfig().warn_ratio).toBe(0.8);
  });

  it("未知键 / 非正数 / 错 apiVersion / warn_ratio≥1 一律拒绝", () => {
    expect(() => parseBudgetConfig("apiVersion: yushu.budget/v1\nmonthly_caps: 30")).toThrowError(/未知键/);
    expect(() => parseBudgetConfig("apiVersion: yushu.budget/v1\nmonthly_cap: 0")).toThrowError(/正数/);
    expect(() => parseBudgetConfig("apiVersion: yushu.budget/v2\nmonthly_cap: 30")).toThrowError(/apiVersion/);
    expect(() => parseBudgetConfig("apiVersion: yushu.budget/v1\nwarn_ratio: 1.5")).toThrowError(/warn_ratio/);
    expect(() => parseBudgetConfig("not yaml: [")).toThrowError(/无法解析/);
  });

  it("序列化确定性 + 往返一致", () => {
    const config = parseBudgetConfig(
      ["apiVersion: yushu.budget/v1", "currency: CNY", "monthly_cap: 30", "warn_ratio: 0.75"].join("\n"),
    );
    expect(serializeBudgetConfig(config)).toBe(serializeBudgetConfig(config));
    expect(parseBudgetConfig(serializeBudgetConfig(config))).toEqual(config);
  });
});

describe("lintCost：cost-usage-missing", () => {
  it("声明 usage 却无 token 回写 → warn 并按主体计数", () => {
    const findings = lintCost({
      providers,
      entries: [entry({ tokens: undefined }), entry({ tokens: undefined }), entry()],
    });
    const hit = findings.filter((f) => f.code === "cost-usage-missing");
    expect(hit.length).toBe(1);
    expect(hit[0]!.severity).toBe("warn");
    expect(hit[0]!.subject_id).toBe("cloud/big");
    expect(hit[0]!.message).toContain("2 条");
  });

  it("不该命中：未声明 usage 的本地模型 / 有 tokens / 采纳记录", () => {
    expect(lintCost({ providers, entries: [entry({ tokens: undefined, model: "small", provider_id: "local" })] })).toEqual([]);
    expect(lintCost({ providers, entries: [entry()] })).toEqual([]);
    expect(lintCost({ providers, entries: [entry({ tokens: undefined, task: "adopt" })] })).toEqual([]);
  });
});

describe("lintCost：budget-context-overflow 与月度预算", () => {
  it("输入 + 预留输出超过窗口 → error；留有余量则不报", () => {
    const over = lintCost({
      entries: [],
      assembly: { inputTokens: 33000, context: 32768, maxOutput: 2048 },
    });
    expect(over[0]).toMatchObject({ severity: "error", code: "budget-context-overflow" });
    expect(over[0]!.message).toContain("33000");
    expect(lintCost({ entries: [], assembly: { inputTokens: 20000, context: 32768, maxOutput: 2048 } })).toEqual([]);
    // 窗口未声明时不猜：整条规则跳过，而不是按 0 比较报一堆
    expect(lintCost({ entries: [], assembly: { inputTokens: 999999 } })).toEqual([]);
  });

  it("月度已用：≥80% warn、>100% error、未设上限不报", () => {
    const near = lintCost({
      entries: [],
      budget: { ...defaultBudgetConfig(), monthly_cap: 30, currency: "CNY" },
      spentThisMonth: { CNY: 25 },
    });
    expect(near[0]).toMatchObject({ severity: "warn", code: "budget-monthly-cap" });
    const over = lintCost({
      entries: [],
      budget: { ...defaultBudgetConfig(), monthly_cap: 30, currency: "CNY" },
      spentThisMonth: { CNY: 33 },
    });
    expect(over[0]!.severity).toBe("error");
    expect(lintCost({ entries: [], budget: defaultBudgetConfig(), spentThisMonth: { CNY: 9999 } })).toEqual([]);
  });
});

describe("lintCost：单章成本异常", () => {
  // 均值 0.575、3 倍门槛 1.725：只有 ch-d 超阈（样本数刻意 ≥3，否则规则应整条沉默）
  const chapters = [
    { chapterId: "ch-a", cost: 0.1, currency: "CNY" },
    { chapterId: "ch-b", cost: 0.1, currency: "CNY" },
    { chapterId: "ch-c", cost: 0.1, currency: "CNY" },
    { chapterId: "ch-d", cost: 2.0, currency: "CNY" },
  ];

  it("超过均值 3 倍 → warn 并给出倍数", () => {
    const findings = lintCost({ entries: [], chapterCosts: chapters });
    expect(findings.length).toBe(1);
    expect(findings[0]).toMatchObject({ severity: "warn", code: "cost-per-chapter-anomaly", subject_id: "ch-d" });
    expect(findings[0]!.message).toContain("3.5 倍");
  });

  it("样本不足 3 章不下结论（两章时「高的那章」必然超倍数）", () => {
    expect(lintCost({ entries: [], chapterCosts: chapters.slice(0, 2) })).toEqual([]);
    expect(lintCost({ entries: [], chapterCosts: [] })).toEqual([]);
  });

  it("结果排序稳定：error 先于 warn，同码按主体", () => {
    const mixed = lintCost({
      entries: [entry({ tokens: undefined })],
      providers,
      assembly: { inputTokens: 40000, context: 32768, maxOutput: 1024 },
      chapterCosts: chapters,
    });
    expect(mixed.map((f) => f.severity)).toEqual(["error", "warn", "warn"]);
    expect(JSON.stringify(mixed)).toBe(JSON.stringify(lintCost({
      entries: [entry({ tokens: undefined })],
      providers,
      assembly: { inputTokens: 40000, context: 32768, maxOutput: 1024 },
      chapterCosts: chapters,
    })));
  });
});

describe("章节维度聚合（J09 四维的最后一维）", () => {
  it("summarizeCosts.byChapter 按章节分行，未标注者归一行", () => {
    const summary = summarizeCosts(
      [entry({ chapter_id: "ch-a" }), entry({ chapter_id: "ch-a" }), entry({ chapter_id: "ch-b" }), entry({})],
      priced,
    );
    expect(summary.byChapter.map((row) => row.key)).toEqual(["ch-a", "ch-b", "（未标注章节）"]);
    expect(summary.byChapter[0]!.entries).toBe(2);
    expect(summary.byChapter[0]!.promptTokens).toBe(2000);
    expect(summary.byChapter[0]!.cost).not.toBeNull();
  });

  it("chapterCostsOf 只算已定价章节，跨币种不强行相加", () => {
    const rows = chapterCostsOf(
      [
        entry({ chapter_id: "ch-a" }),
        entry({ chapter_id: "ch-a" }),
        entry({ chapter_id: "ch-b", tokens: undefined }),
        entry({ chapter_id: "ch-c", provider_id: "local", model: "small" }),
      ],
      priced,
    );
    expect(rows.map((row) => row.chapterId)).toEqual(["ch-a"]);
    expect(rows[0]!.cost).toBeCloseTo(0.06, 5); // ch-a 两条记录各 0.03，按章节累加
  });
});
