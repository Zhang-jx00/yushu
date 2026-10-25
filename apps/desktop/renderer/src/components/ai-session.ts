/* SPDX-License-Identifier: Apache-2.0 */
import type { AiUsageEntryPayload } from "../../../src/shared/ipc.js";

/**
 * AI 副驾页右栏「本次会话的产物」摘要（R163）。
 *
 * 为什么是**纯函数**：右栏的每一个数都必须与中栏**逐字对得上**
 * （§7.34 的「同一份真源的两个读法」⇒ 预演可以对账）。
 * 只要右栏自己数一遍，就会有两个数可能对不上 ⇒ 这一层必须是**同一份状态 + 同一套算法**。
 *
 * 三条口径：
 * ① **一个数一个出处**：候选 / 采纳 / 拒绝都从**同一份候选数组**现算（界面不自己数）；
 * ② **候选化不变**：AI 的输出**永远是候选** —— 作者显式采纳才写库。
 *    这一层只**报数**（已采纳 / 已拒绝 / 还没处置），**不提供任何采纳入口**
 *    （右栏不许出现能写库的按钮 ⇒ 采纳这一步不许被省掉）。
 * ③ **没取到就说没取到**（不许装成有）：没有候选就写「还没有候选」。
 *
 * 纯函数：只读入参，不碰 fs、不碰 React、不读墙钟 ⇒ 可单测。
 */

/** 候选条目（只取这一层要用的那几样 ⇒ 界面那边怎么改都不影响这个函数） */
export interface AiSessionCandidateInput {
  /** 候选的稳定标识（生成那次的 streamId） */
  streamId: string;
  /** 候选序号（1 起） */
  index: number;
  /** 候选正文的字数 */
  chars: number;
  /** 已显式采纳（替换 / 追加）—— 没有这一项就是**还没处置** */
  adopted?: "replace" | "append";
  /** 已显式拒绝 */
  rejected?: boolean;
}

export interface AiSessionSummary {
  /** 候选数（== 中栏「多候选对比」写的那个数） */
  candidates: number;
  /** 已显式采纳的候选数 */
  adopted: number;
  /** 已显式拒绝的候选数 */
  rejected: number;
  /** 还没处置的候选数（**候选化**：没处置就不写库） */
  pending: number;
  /** 候选字数合计 */
  chars: number;
  /** 用量：使用记录里的条数 / 生成 / 采纳 */
  usage: { entries: number; generate: number; adopt: number };
  /** 没有候选时的如实说明（空串 = 有候选） */
  note: string;
}

export function summarizeAiSession(input: {
  candidates: AiSessionCandidateInput[];
  usage: AiUsageEntryPayload[];
}): AiSessionSummary {
  const candidates = input.candidates;
  const adopted = candidates.filter((item) => item.adopted !== undefined).length;
  const rejected = candidates.filter((item) => item.rejected === true).length;
  // 「还没处置」= 既没采纳也没拒绝 ⇒ 它**仍然是候选**，正文一个字都没动
  const pending = candidates.filter(
    (item) => item.adopted === undefined && item.rejected !== true,
  ).length;
  return {
    candidates: candidates.length,
    adopted,
    rejected,
    pending,
    chars: candidates.reduce((sum, item) => sum + item.chars, 0),
    usage: {
      entries: input.usage.length,
      generate: input.usage.filter((item) => item.type === "generate").length,
      adopt: input.usage.filter((item) => item.type === "adopt").length,
    },
    note: candidates.length === 0 ? "还没有候选（生成一次才会有；候选不采纳就不写正文）" : "",
  };
}
