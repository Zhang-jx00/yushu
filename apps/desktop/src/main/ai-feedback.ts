import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { INDEX_DIR } from "@yushu/world-engine";
import type { AiFeedbackEntryPayload, AiFeedbackState, AiRejectPayload } from "../shared/ipc.js";

/**
 * 候选拒绝原因记录（T3-11，J15 实践 6）：append-only JSONL 写入 `.yushu/ai-feedback.jsonl`。
 * - 预置标签（太水 / 跑偏 / 人设不符 / OOC / 风格不符 / 战力崩）+ 自由文本；
 * - 沉淀为风格偏好与提示词改进数据（回流 J02 的原料；本机留痕，不入真源、不入 Git）；
 * - 与 ai-usage.jsonl 同款：记录失败不阻断交互（返回现状统计）。
 */

export const AI_FEEDBACK_PATH = `${INDEX_DIR}/ai-feedback.jsonl`;

function feedbackFile(rootDir: string): string {
  return join(rootDir, ...AI_FEEDBACK_PATH.split("/"));
}

/** 追加一条拒绝记录（自身失败不抛出——统计按现值返回，不打断写作流） */
export async function appendAiFeedback(rootDir: string, payload: AiRejectPayload): Promise<void> {
  const entry: AiFeedbackEntryPayload = {
    time: new Date().toISOString(),
    ...(payload.task ? { task: payload.task } : {}),
    reason: payload.reason.trim() || "未注明",
    ...(payload.note?.trim() ? { note: payload.note.trim() } : {}),
    excerpt: payload.excerpt.slice(0, 200),
    ...(payload.usageId ? { usage_id: payload.usageId } : {}),
  };
  const abs = feedbackFile(rootDir);
  try {
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.appendFile(abs, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // 记录失败不阻断（面板回执按现有统计展示）
  }
}

/** 读取拒绝原因统计（计数降序 → 原因字典序；条目倒序最近 limit 条） */
export async function readAiFeedbackState(rootDir: string, limit = 30): Promise<AiFeedbackState> {
  const text = await fs.readFile(feedbackFile(rootDir), "utf8").catch(() => "");
  const entries: AiFeedbackEntryPayload[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as AiFeedbackEntryPayload);
    } catch {
      // 跳过损坏行（append-only 写入理论上不会产生，留作外部编辑容错）
    }
  }
  const counter = new Map<string, number>();
  for (const entry of entries) counter.set(entry.reason, (counter.get(entry.reason) ?? 0) + 1);
  const counts = [...counter.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
  return {
    path: AI_FEEDBACK_PATH,
    total: entries.length,
    counts,
    entries: entries.reverse().slice(0, limit),
  };
}