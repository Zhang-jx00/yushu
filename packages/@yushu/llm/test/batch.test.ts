import { describe, expect, it } from "vitest";
import {
  BATCH_ELIGIBLE_TASKS,
  isBatchEligible,
  planChannel,
  planChannels,
  type LlmProviderSpec,
} from "@yushu/llm";

/**
 * T3-11 半价通道规划（J08/J09）：batch_eligible 任务 + provider batch 能力 → batch；否则 sync 如实标注。
 */

function provider(extra: Partial<LlmProviderSpec> = {}): LlmProviderSpec {
  return {
    id: "mock",
    kind: "local",
    protocol: "openai_chat",
    base_url: "http://127.0.0.1:1/v1",
    models: [{ name: "mock-model", tier: "small" }],
    ...extra,
  };
}

describe("批量任务与半价通道（T3-11）", () => {
  it("batch_eligible 任务清单与判定", () => {
    expect([...BATCH_ELIGIBLE_TASKS]).toEqual(["outline", "summarize", "extract"]);
    expect(isBatchEligible("extract")).toBe(true);
    expect(isBatchEligible("drafting")).toBe(false);
  });

  it("交互任务恒为 sync（保持同步流式）", () => {
    const plan = planChannel([provider({ models: [{ name: "m", tier: "flagship", capabilities: { batch: true } }] })], "drafting");
    expect(plan.channel).toBe("sync");
    expect(plan.eligible).toBe(false);
    expect(plan.note).toContain("交互任务");
  });

  it("批量任务：provider 未声明 batch → sync 且如实标注原因", () => {
    const plan = planChannel([provider()], "extract");
    expect(plan.eligible).toBe(true);
    expect(plan.channel).toBe("sync");
    expect(plan.note).toContain("未声明 batch");
    expect(plan.note).toContain("50%");
  });

  it("批量任务：任一 provider 声明 batch → batch（半价通道）", () => {
    const plans = planChannels([
      provider(),
      provider({ id: "cloud", models: [{ name: "m", tier: "small", capabilities: { batch: true } }] }),
    ]);
    expect(plans.map((plan) => plan.task)).toEqual(["outline", "summarize", "extract"]);
    expect(plans.every((plan) => plan.channel === "batch")).toBe(true);
    expect(plans[0]!.note).toContain("cloud");
    expect(plans[0]!.note).toContain("半价通道");
  });
});