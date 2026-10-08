import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendAiUsage } from "../src/main/ai-usage.js";
import { readCostPanel } from "../src/main/cost-ops.js";
import { saveAiConfig } from "../src/main/ai-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import {
  createOutlineChapter,
  createProject,
  generateOutline,
  writeCardDoc,
} from "../src/main/project-ops.js";

/**
 * T3-12 成本面板主进程聚合（J09）：只读投影 `.yushu/ai-usage.jsonl`。
 * 盯的是接线层最易错的四件事——定价索引键（provider×model）、adopt 记录不得混入、
 * 缺 usage 不拿字数臆造 token、以及「未声明折扣就不估节省额」。
 */

let dir: string;

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-cost-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function setupProject() {
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  const gateway = new ProjectGateway(dir);
  await writeCardDoc(gateway, {
    card: { type: "character", name: "林渊", layer: "characters", visibility: "revealed" },
    body: "边城少年，剑道天赋被夺。",
  });
  const generated = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 2,
  });
  const volume = generated.doc.volumes[0]!;
  const chapter = volume.chapters[0]!;
  const draft = await createOutlineChapter(gateway, {
    volumeId: volume.id,
    chapterId: chapter.id,
    baseHash: generated.hash,
  });
  return { gateway, volumeId: volume.id, chapterId: chapter.id, chapterPath: draft.chapterPath };
}

/** provider 载荷：pricing / cache 能力按需声明（其余按 v2 保守默认） */
function providersWith(options: {
  pricing?: { currency?: string; input: number; output: number; cache_read?: number };
  cache?: { mode: string; min_tokens?: number; read_mult?: number };
}) {
  return [
    {
      id: "mock",
      kind: "local",
      protocol: "openai_chat",
      base_url: "http://127.0.0.1:1/v1",
      models: [
        {
          name: "mock-model",
          tier: "flagship",
          ...(options.cache ? { capabilities: { cache: options.cache } } : {}),
          ...(options.pricing ? { pricing: options.pricing } : {}),
        },
      ],
    },
  ];
}

describe("成本聚合（T3-12）", () => {
  it("配置里的 pricing 能透出并被索引命中 → 折算金额（每 1M tokens 口径）", async () => {
    const { gateway } = await setupProject();
    await saveAiConfig(gateway, {
      providers: providersWith({ pricing: { currency: "CNY", input: 2, output: 8 } }) as never,
    });
    await appendAiUsage(dir, {
      id: "ai-1",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "mock-model",
      status: "ok",
      chars: 6,
      tokens: { prompt: 1000, completion: 500 },
    });

    const panel = await readCostPanel(gateway);
    expect(panel.totals.entries).toBe(1);
    expect(panel.totals.cost).toBeCloseTo(0.006, 12);
    expect(panel.totals.currency).toBe("CNY");
    expect(panel.totals.costText).toBe("¥0.0060");
    expect(panel.totals.unpricedEntries).toBe(0);
    expect(panel.byTask.map((row) => row.key)).toEqual(["drafting"]);
    expect(panel.byModel.map((row) => row.key)).toEqual(["mock-model"]);
    expect(panel.pricing).toEqual([
      { provider_id: "mock", model: "mock-model", configured: true, currency: "CNY", input: 2, output: 8 },
    ]);
  });

  it("未配置价格 → 金额 null、文案「未配置价格」、条目计入 unpricedEntries", async () => {
    const { gateway } = await setupProject();
    await saveAiConfig(gateway, { providers: providersWith({}) as never });
    await appendAiUsage(dir, {
      id: "ai-1",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "mock-model",
      status: "ok",
      tokens: { prompt: 1000 },
    });

    const panel = await readCostPanel(gateway);
    expect(panel.totals.cost).toBeNull();
    expect(panel.totals.costText).toBe("未配置价格");
    expect(panel.totals.unpricedEntries).toBe(1);
    expect(panel.totals.promptTokens).toBe(1000);
  });

  it("端点回显的模型名与配置名不一致：provider 只有一个价 → 回落该价并显式计数", async () => {
    const { gateway } = await setupProject();
    await saveAiConfig(gateway, {
      providers: providersWith({ pricing: { input: 2, output: 8 } }) as never,
    });
    await appendAiUsage(dir, {
      id: "ai-1",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "mock-model-2026-10-01", // 真端点常回显带日期后缀的具体版本
      status: "ok",
      tokens: { prompt: 1000 },
    });

    const panel = await readCostPanel(gateway);
    expect(panel.totals.cost).toBeCloseTo(0.002, 12);
    expect(panel.pricingFallback).toBe(1);
    expect(panel.notes.some((note) => note.includes("回显模型名"))).toBe(true);
  });

  it("provider 有多个已配置价格的模型 → 回显名查不中时不猜价（计入 unpriced）", async () => {
    const { gateway } = await setupProject();
    await saveAiConfig(gateway, {
      providers: [
        {
          id: "mock",
          kind: "local",
          protocol: "openai_chat",
          base_url: "http://127.0.0.1:1/v1",
          models: [
            { name: "small-m", tier: "small", pricing: { input: 1, output: 4 } },
            { name: "big-m", tier: "flagship", pricing: { input: 8, output: 32 } },
          ],
        },
      ] as never,
    });
    await appendAiUsage(dir, {
      id: "ai-1",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "echoed-name",
      status: "ok",
      tokens: { prompt: 1000 },
    });

    const panel = await readCostPanel(gateway);
    expect(panel.totals.cost).toBeNull();
    expect(panel.totals.unpricedEntries).toBe(1);
    expect(panel.pricingFallback).toBe(0);
  });

  it("adopt 记录不参与成本聚合（用户采纳动作没有 token 语义）", async () => {
    const { gateway } = await setupProject();
    await saveAiConfig(gateway, {
      providers: providersWith({ pricing: { input: 2, output: 8 } }) as never,
    });
    await appendAiUsage(dir, {
      id: "ai-1",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "mock-model",
      status: "ok",
      tokens: { prompt: 1000, completion: 500 },
    });
    await appendAiUsage(dir, { id: "ai-2", type: "adopt", usage_id: "ai-1", chars: 6 });

    const panel = await readCostPanel(gateway);
    expect(panel.entries).toBe(2);
    expect(panel.totals.entries).toBe(1);
  });

  it("provider 未回传 usage 的旧记录计入 entriesWithoutTokens，绝不按字数臆造 token", async () => {
    const { gateway } = await setupProject();
    await saveAiConfig(gateway, {
      providers: providersWith({ pricing: { input: 2, output: 8 } }) as never,
    });
    await appendAiUsage(dir, {
      id: "ai-1",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "mock-model",
      status: "ok",
      chars: 6,
    });
    await appendAiUsage(dir, {
      id: "ai-2",
      type: "generate",
      task: "summarize",
      provider_id: "mock",
      model: "mock-model",
      status: "ok",
      tokens: { prompt: 200 },
    });

    const panel = await readCostPanel(gateway);
    expect(panel.entriesWithoutTokens).toBe(1);
    expect(panel.totals.promptTokens).toBe(200);
  });

  it("预估 vs 实付：偏差取中位数并给出展示文本", async () => {
    const { gateway } = await setupProject();
    await saveAiConfig(gateway, {
      providers: providersWith({ pricing: { input: 2, output: 8 } }) as never,
    });
    await appendAiUsage(dir, {
      id: "ai-1",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "mock-model",
      status: "ok",
      tokens: { prompt: 1000 },
      estimate: { prompt: 1200 },
    });
    await appendAiUsage(dir, {
      id: "ai-2",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "mock-model",
      status: "aborted",
      estimate: { prompt: 900, completion: 30 },
      tokens: { prompt: 1000 },
    });

    const panel = await readCostPanel(gateway);
    expect(panel.totals.promptDeviationMedian).toBeCloseTo(0.05, 12);
    expect(panel.totals.deviationText).toBe("+5.0%");
  });

  it("偏差过大（provider 未回传真实 usage / 定价口径错）必须在面板点名，不抛惊悚数字了事", async () => {
    const { gateway } = await setupProject();
    await saveAiConfig(gateway, {
      providers: providersWith({ pricing: { input: 2, output: 8 } }) as never,
    });
    await appendAiUsage(dir, {
      id: "ai-1",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "mock-model",
      status: "ok",
      tokens: { prompt: 100 },
      estimate: { prompt: 1000 },
    });

    const panel = await readCostPanel(gateway);
    expect(panel.totals.promptDeviationMedian).toBeCloseTo(9, 12);
    expect(panel.totals.deviationText).toContain("+900.0%");
    expect(panel.totals.deviationText).toContain("偏差过大");
  });

  it("偏差在 ±50% 内不加警示（避免正常噪声也报警）", async () => {
    const { gateway } = await setupProject();
    await saveAiConfig(gateway, {
      providers: providersWith({ pricing: { input: 2, output: 8 } }) as never,
    });
    await appendAiUsage(dir, {
      id: "ai-1",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "mock-model",
      status: "ok",
      tokens: { prompt: 1000 },
      estimate: { prompt: 1200 },
    });

    const panel = await readCostPanel(gateway);
    expect(panel.totals.deviationText).toBe("+20.0%");
  });

  it("缺任一口径时偏差给出「无可对账记录」而非 0%", async () => {    const { gateway } = await setupProject();
    await saveAiConfig(gateway, {
      providers: providersWith({ pricing: { input: 2, output: 8 } }) as never,
    });
    await appendAiUsage(dir, {
      id: "ai-1",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "mock-model",
      status: "ok",
      tokens: { prompt: 1000 },
    });

    const panel = await readCostPanel(gateway);
    expect(panel.totals.promptDeviationMedian).toBeNull();
    expect(panel.totals.deviationText).toContain("无可对账");
  });

  it("缓存命中单列并折算实际节省（声明 cache_read 才算）", async () => {
    const { gateway } = await setupProject();
    await saveAiConfig(gateway, {
      providers: providersWith({ pricing: { input: 2, output: 8, cache_read: 0.2 } }) as never,
    });
    await appendAiUsage(dir, {
      id: "ai-1",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "mock-model",
      status: "ok",
      tokens: { prompt: 1000, cached: 4000, completion: 500 },
    });

    const panel = await readCostPanel(gateway);
    expect(panel.totals.cachedTokens).toBe(4000);
    expect(panel.totals.cacheSavedByCurrency["CNY"]).toBeCloseTo(0.0072, 12);
    expect(panel.totals.cacheSavedText).toBe("¥0.0072");
  });
});

describe("稳定前缀编排核对（T3-12 步骤 5）", () => {
  it("默认组装：稳定槽位全部置头，断点落在 world_constraints#2", async () => {
    const { gateway, volumeId, chapterId } = await setupProject();
    await saveAiConfig(gateway, {
      providers: providersWith({ pricing: { input: 2, output: 8 } }) as never,
    });

    const panel = await readCostPanel(gateway, { volumeId, chapterId });
    expect(panel.cache).not.toBeNull();
    const audit = panel.cache!;
    expect(audit.chapter_id).toBe(chapterId);
    expect(audit.breakpointAfter).toBe("world_constraints");
    expect(audit.breakpointIndex).toBe(2);
    expect(audit.ordered).toBe(true);
    expect(audit.misplaced).toEqual([]);
    expect(audit.stableTokens).toBeGreaterThan(0);
    expect(audit.slots.map((slot) => slot.slot)).toEqual([
      "system_prompt",
      "world_core",
      "world_constraints",
      "outline_chapter",
      "recent_prose",
    ]);
    expect(audit.target).toBe("mock · mock-model");
    // 未声明 cache 能力 → 如实提示，不给节省额
    expect(audit.cacheDeclared).toBe(false);
    expect(audit.saving).toBeNull();
    expect(audit.savingText).toContain("不估算");
    expect(audit.warnings.some((text) => text.includes("未声明 cache"))).toBe(true);
  });

  it("声明 cache + read_mult → 只给单次投影节省（不伪造累计复用次数）", async () => {
    const { gateway, volumeId, chapterId } = await setupProject();
    await saveAiConfig(gateway, {
      providers:
        providersWith({
          pricing: { input: 2, output: 8 },
          // 门槛取 1：本用例只验「节省口径」，不让断言依赖固定前缀长度
          cache: { mode: "explicit", min_tokens: 1, read_mult: 0.1 },
        }) as never,
    });

    const panel = await readCostPanel(gateway, { volumeId, chapterId });
    const audit = panel.cache!;
    expect(audit.cacheDeclared).toBe(true);
    expect(audit.cacheMode).toBe("explicit");
    expect(audit.belowMinTokens).toBe(false);
    expect(audit.saving).not.toBeNull();
    // 节省 = 稳定前缀全价 − 0.1× 命中价；固定前缀里只有 perCall 这一个口径可断言
    expect(audit.saving!.perCall).toBeGreaterThan(0);
    expect(audit.saving!.currency).toBe("CNY");
    expect(audit.savingText.startsWith("单次投影")).toBe(true);
    // 面板与载荷都不得出现「累计」金额（复用次数没有实测来源）
    expect(audit.savingText.includes("累计")).toBe(false);
  });

  it("稳定前缀未达 provider 门槛 → belowMinTokens 为真（门槛大到必然不命中）", async () => {
    const { gateway, volumeId, chapterId } = await setupProject();
    await saveAiConfig(gateway, {
      providers:
        providersWith({
          pricing: { input: 2, output: 8 },
          cache: { mode: "explicit", min_tokens: 999_999, read_mult: 0.1 },
        }) as never,
    });

    const panel = await readCostPanel(gateway, { volumeId, chapterId });
    expect(panel.cache!.belowMinTokens).toBe(true);
    expect(panel.cache!.warnings.some((text) => text.includes("门槛"))).toBe(true);
  });

  it("未选定章纲 → 只聚合不核对（cache 为 null，不凭空推断编排）", async () => {
    const { gateway } = await setupProject();
    await saveAiConfig(gateway, { providers: providersWith({}) as never });
    await appendAiUsage(dir, {
      id: "ai-1",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "mock-model",
      status: "ok",
      tokens: { prompt: 10 },
    });

    const panel = await readCostPanel(gateway);
    expect(panel.cache).toBeNull();
    expect(panel.totals.entries).toBe(1);
  });

  it("口径说明随面板下发（notes 非空，边界如实标注）", async () => {
    const { gateway } = await setupProject();
    const panel = await readCostPanel(gateway);
    expect(panel.notes.length).toBeGreaterThanOrEqual(5);
    expect(panel.notes.some((note) => note.includes("未配置价格"))).toBe(true);
    expect(panel.notes.some((note) => note.includes("CJK"))).toBe(true);
    expect(panel.path).toBe(".yushu/ai-usage.jsonl");
  });

  it("章节维度：带 chapter_id 按章分行，缺标注者归一行而非丢弃（J09 四维）", async () => {
    const { gateway } = await setupProject();
    await saveAiConfig(gateway, {
      providers: providersWith({ pricing: { currency: "CNY", input: 12, output: 36 } }) as never,
    });
    await appendAiUsage(dir, {
      id: "ai-ch-1",
      type: "generate",
      task: "drafting",
      provider_id: "mock",
      model: "mock-model",
      status: "ok",
      chapter_id: "ch-aaa",
      tokens: { prompt: 1000, completion: 500 },
    });
    await appendAiUsage(dir, {
      id: "ai-ch-2",
      type: "generate",
      task: "continue",
      provider_id: "mock",
      model: "mock-model",
      status: "ok",
      chapter_id: "ch-bbb",
      tokens: { prompt: 2000, completion: 900 },
    });
    const panel = await readCostPanel(gateway, {});
    const keys = panel.byChapter.map((row) => row.key);
    expect(keys).toEqual(["ch-aaa", "ch-bbb"]); // 本用例两条都带章节；缺标注的归并行为在引擎侧断言（budget/cost 测试）
    const aaa = panel.byChapter.find((row) => row.key === "ch-aaa")!;
    expect(aaa.promptTokens).toBe(1000);
    expect(aaa.cost).not.toBeNull();
    expect(aaa.costText.startsWith("¥")).toBe(true);
  });
});
