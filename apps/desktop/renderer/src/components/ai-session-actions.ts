/* SPDX-License-Identifier: Apache-2.0 */
import type { AiAdoptResult, AiFeedbackState } from "../../../src/shared/ipc.js";
import { api } from "../api.js";
import { markAiCandidateAdopted, markRejected, type BusCandidate } from "./ai-session-bus.js";

/**
 * **AI 会话的写动作**（R184）：采纳与拒绝——**写入口只有这一处**（R174 教训：
 * 另造一套写入点只会漂，漂出来的按钮点下去只会被引擎拒）。
 *
 * 为什么与状态容器（`ai-session-bus.ts`）分成两个模块：
 * 状态容器**不碰 API** ⇒ 能直接单测（纯状态判定）；这里才 import api
 * （api 依赖 window，单测环境里跑不了）。
 *
 * 两条红线（与 AI 副驾页逐字相同）：
 * ① **replace 且该章已有正文 ⇒ 必须显式确认**（覆盖前引擎会自动建破坏前快照）；
 * ② **拒绝只记反馈、不写正文**（落 `.yushu/ai-feedback.jsonl`，供提示词改进）。
 */

/**
 * **replace 的确认闸门**（confirm 文案只有这一处）：单候选采纳与多候选采纳
 * 都过它 ⇒ 同一句红线，不会两处各写一份然后漂掉。
 * 返回 true = 可以继续覆盖。
 */
export function confirmReplaceOverwrite(hasBody: boolean): boolean {
  if (!hasBody) return true;
  return globalThis.confirm("替换将覆盖该章节现有正文（覆盖前会自动创建「破坏前」快照，可整体回退），确定继续？");
}

/** 采纳一条候选；作者取消确认 ⇒ 返回 null（调用方据此不摆"已采纳"） */
export async function adoptAiCandidate(
  entry: BusCandidate,
  mode: "replace" | "append",
  options: { hasBody: boolean },
): Promise<AiAdoptResult | null> {
  if (mode === "replace" && !confirmReplaceOverwrite(options.hasBody)) {
    return null;
  }
  const adopted = await api().ai.adopt({
    usageId: entry.usageId,
    volumeId: entry.volumeId,
    chapterId: entry.chapterId,
    text: entry.text,
    mode,
  });
  markAiCandidateAdopted(entry.streamId, mode);
  return adopted;
}

/** 拒绝一条候选：落反馈台账 + 标记条目（不写正文） */
export async function rejectAiCandidate(entry: BusCandidate, reason: string, note: string): Promise<AiFeedbackState> {
  const state = await api().ai.reject({
    usageId: entry.usageId,
    task: "drafting",
    reason,
    excerpt: entry.text.slice(0, 200),
    ...(note.trim() ? { note: note.trim() } : {}),
  });
  markRejected(entry.streamId);
  return state;
}
