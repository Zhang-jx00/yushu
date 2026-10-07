import { resolveCapabilities } from "./types.js";
import type { LlmProviderSpec } from "./types.js";

/**
 * 批量任务与半价通道（T3-11，J08 实践 6 / J09 实践 5）：
 * - `batch_eligible` 任务（大纲候选 / 摘要回填 / 实体抽取）适合离线批量——provider 声明 `batch`
 *   能力时走 Batch 半价通道（输入输出各省 50%）；交互任务（正文生成 / 润色）保持同步流式；
 * - **如实标注**：真 Batch 为异步批处理（24h 内完成），交互链路不直接提交；本规划给出「通道归属」
 *   与提示（含未声明 batch 时的保守回执），供 UI 展示与用法记账（`channel`）。
 */

export const BATCH_ELIGIBLE_TASKS = ["outline", "summarize", "extract"] as const;
export type BatchEligibleTask = (typeof BATCH_ELIGIBLE_TASKS)[number];

export interface ChannelPlan {
  task: string;
  /** 是否属批量候选任务（batch_eligible） */
  eligible: boolean;
  channel: "batch" | "sync";
  note: string;
}

export function isBatchEligible(task: string): boolean {
  return (BATCH_ELIGIBLE_TASKS as readonly string[]).includes(task);
}

/** 选择通道：批量任务 + 任一 provider 默认模型声明 batch → batch（半价）；否则 sync（如实标注原因） */
export function planChannel(providers: LlmProviderSpec[], task: string): ChannelPlan {
  if (!isBatchEligible(task)) {
    return { task, eligible: false, channel: "sync", note: "交互任务：标准通道（保持同步流式，不排队）" };
  }
  const batchProvider = providers.find((provider) =>
    provider.models.some((model) => resolveCapabilities(model).batch === true),
  );
  if (!batchProvider) {
    return {
      task,
      eligible: true,
      channel: "sync",
      note: "批量任务：provider 未声明 batch 能力 → 按标准通道计价（接入支持 Batch 的端点可省 50%）",
    };
  }
  return {
    task,
    eligible: true,
    channel: "batch",
    note: `批量任务：provider「${batchProvider.id}」声明 batch 能力 → 半价通道（Batch 异步批处理；交互链路不排队，此处为通道归属提示）`,
  };
}

/** 全部 batch_eligible 任务的通道规划（AI 副驾展示） */
export function planChannels(providers: LlmProviderSpec[]): ChannelPlan[] {
  return BATCH_ELIGIBLE_TASKS.map((task) => planChannel(providers, task));
}