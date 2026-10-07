import { createHash } from "node:crypto";
import type { FactSource } from "./types.js";

/**
 * 事实级记忆的出处链（T3-5）：`chapter_id + 字符区间 + 摘录 sha256`。
 * 正文改动后 hash 不再匹配 → 出处失效可检出（绝不静默沿用）。
 */

export function hashExcerpt(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 由章节正文与字符区间构造出处（越界 / 空区间直接拒绝——出处链必须可验证） */
export function buildFactSource(
  chapterId: string,
  chapterBody: string,
  start: number,
  end: number,
): FactSource {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) {
    throw new Error(`非法字符区间：[${start}, ${end})`);
  }
  if (end > chapterBody.length) {
    throw new Error(`字符区间超出章节正文长度（end=${end} > ${chapterBody.length}）`);
  }
  return { chapter_id: chapterId, start, end, hash: hashExcerpt(chapterBody.slice(start, end)) };
}

export type ProvenanceCheck = { ok: true } | { ok: false; reason: string };

/** 校验出处：区间合法且摘录 hash 与正文一致（正文被改动 → 失效） */
export function verifyFactSource(source: FactSource, chapterBody: string): ProvenanceCheck {
  if (source.start < 0 || source.end <= source.start) {
    return { ok: false, reason: `字符区间非法：[${source.start}, ${source.end})` };
  }
  if (source.end > chapterBody.length) {
    return {
      ok: false,
      reason: `字符区间超出正文长度（end=${source.end} > ${chapterBody.length}）：章节可能被大改`,
    };
  }
  const actual = hashExcerpt(chapterBody.slice(source.start, source.end));
  if (actual !== source.hash) {
    return { ok: false, reason: "摘录 hash 不匹配：出处对应正文已被改动（事实可能已失效）" };
  }
  return { ok: true };
}