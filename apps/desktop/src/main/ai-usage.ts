import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { INDEX_DIR } from "@yushu/world-engine";
import type { AiUsageEntryPayload } from "../shared/ipc.js";

/**
 * AI 使用记录（T1-17 最小版）：append-only JSONL 写入项目侧 `.yushu/ai-usage.jsonl`。
 * - 生成与采纳各记一条事件（generate / adopt 通过 usage_id 关联），为 M6 的证据链与合规申报打底；
 * - `.yushu/` 在 .gitignore 内（本地运行期产物，可随项目迁移但不入库）。
 */

export const AI_USAGE_PATH = `${INDEX_DIR}/ai-usage.jsonl`;

export function newUsageId(): string {
  return `ai-${randomUUID().slice(0, 8)}`;
}

/** 追加一条使用记录（自动创建 .yushu 目录；自身失败不抛出，避免影响生成主流程） */
export async function appendAiUsage(
  rootDir: string,
  entry: Omit<AiUsageEntryPayload, "time"> & { time?: string },
): Promise<AiUsageEntryPayload> {
  const full: AiUsageEntryPayload = {
    ...entry,
    time: entry.time ?? new Date().toISOString(),
  };
  const abs = join(rootDir, ...AI_USAGE_PATH.split("/"));
  try {
    await fs.mkdir(dirname(abs), { recursive: true });
    await fs.appendFile(abs, `${JSON.stringify(full)}\n`, "utf8");
  } catch {
    // 记录失败不阻断生成（M6 会做记录完整性校验）
  }
  return full;
}

/** 读取最近 N 条记录（倒序返回；文件不存在返回空数组） */
export async function readAiUsage(rootDir: string, limit = 50): Promise<AiUsageEntryPayload[]> {
  const abs = join(rootDir, ...AI_USAGE_PATH.split("/"));
  const text = await fs.readFile(abs, "utf8").catch(() => "");
  if (text.trim() === "") return [];
  const entries: AiUsageEntryPayload[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      entries.push(JSON.parse(line) as AiUsageEntryPayload);
    } catch {
      // 跳过损坏行（append-only 写入理论上不会产生，留作外部编辑容错）
    }
  }
  return entries.reverse().slice(0, limit);
}