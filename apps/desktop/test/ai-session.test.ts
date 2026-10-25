/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import type { AiUsageEntryPayload } from "../src/shared/ipc.js";
import { summarizeAiSession } from "../renderer/src/components/ai-session.js";

/**
 * AI 副驾页右栏「本次会话的产物」摘要的**纯函数**判据（R163）。
 *
 * 右栏的每一个数都必须与中栏**逐字对得上**（§7.34 的「同一份真源的两个读法」）。
 * 这层是纯函数 ⇒ 可以直接对着状态核：
 * ① **换个状态就换一套数**（不许写死字面量）；
 * ② 候选 / 已采纳 / 已拒绝 / 还没处置四个数**互相对得上**（没处置的那些既没采纳也没拒绝）；
 * ③ **候选化不变**：这一层只报数，不提供任何采纳入口；
 * ④ **没取到就说没取到**（不许装成有）。
 */

function candidate(
  index: number,
  overrides: Partial<Parameters<typeof summarizeAiSession>[0]["candidates"][number]> = {},
): Parameters<typeof summarizeAiSession>[0]["candidates"][number] {
  return {
    streamId: "stream-" + String(index),
    index,
    chars: 100 * index,
    ...overrides,
  };
}

function usage(type: "generate" | "adopt"): AiUsageEntryPayload {
  return {
    id: type + "-" + String(Math.random()),
    time: "2026-10-25T12:00:00.000Z",
    type,
  };
}

describe("AI 副驾页右栏的本次会话产物摘要（R163）：与中栏逐字对得上", () => {
  it("**换个状态就换一套数**（不许写死字面量）", () => {
    const one = summarizeAiSession({
      candidates: [candidate(1), candidate(2, { adopted: "replace" })],
      usage: [usage("generate"), usage("adopt")],
    });
    const two = summarizeAiSession({ candidates: [], usage: [] });
    expect(one.candidates).toBe(2);
    expect(two.candidates).toBe(0);
    expect(one.adopted).toBe(1);
    expect(two.adopted).toBe(0);
    expect(one.pending).toBe(1);
    expect(two.pending).toBe(0);
    expect(one.chars).toBe(300);
    expect(two.chars).toBe(0);
    expect(one.usage.entries).toBe(2);
    expect(two.usage.entries).toBe(0);
  });

  it("候选 / 已采纳 / 已拒绝 / 还没处置**互相对得上**", () => {
    const summary = summarizeAiSession({
      candidates: [
        candidate(1, { adopted: "replace" }),
        candidate(2, { rejected: true }),
        candidate(3),
        candidate(4),
      ],
      usage: [],
    });
    expect(summary.candidates).toBe(4);
    expect(summary.adopted).toBe(1);
    expect(summary.rejected).toBe(1);
    // 还没处置 = 既没采纳也没拒绝 ⇒ 那两个候选**仍然是候选**，正文一个字都没动
    expect(summary.pending).toBe(2);
    expect(summary.adopted + summary.rejected + summary.pending).toBe(summary.candidates);
  });

  it("**局部采纳**也算采纳（追加与替换一样算处置过）", () => {
    const summary = summarizeAiSession({
      candidates: [candidate(1, { adopted: "append" })],
      usage: [],
    });
    expect(summary.adopted).toBe(1);
    expect(summary.pending).toBe(0);
  });

  it("用量：生成与采纳**分开数**（使用记录里那两类事件）", () => {
    const summary = summarizeAiSession({
      candidates: [],
      usage: [usage("generate"), usage("generate"), usage("adopt")],
    });
    expect(summary.usage.entries).toBe(3);
    expect(summary.usage.generate).toBe(2);
    expect(summary.usage.adopt).toBe(1);
  });

  it("**没取到就说没取到**（不许装成有）", () => {
    const summary = summarizeAiSession({ candidates: [], usage: [] });
    expect(summary.note, "没有候选却什么都不说").not.toBe("");
    expect(summary.candidates).toBe(0);
    expect(summary.adopted).toBe(0);
  });

  it("**候选化不变**：这一层只报数，不给任何采纳入口", () => {
    // 判据盯的是"函数本身"：它只吐数，不吐任何能写库的回调 / 按钮 / 副作用
    const summary = summarizeAiSession({
      candidates: [candidate(1, { adopted: "replace" })],
      usage: [],
    });
    expect(Object.keys(summary).sort()).toEqual([
      "adopted",
      "candidates",
      "chars",
      "note",
      "pending",
      "rejected",
      "usage",
    ]);
    expect(summary.note).toBe("");
  });
});
