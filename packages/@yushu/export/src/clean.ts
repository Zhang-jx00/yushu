import type { StripMarkerOptions } from "./types.js";

/**
 * 内部标记清洗（T1-20）：导出/复制前的"干净剪贴板"。
 * 清除对象：
 * - HTML 注释 `<!-- … -->` 与 Markdown 注释行 `[//]: # (…)`（编辑器/教程遗留，不该进投稿稿）；
 * - AI 生成标识（`（AI 生成）` / `【AI】` / `[AI]` 等，投稿前"输出可标识"的可选清洗）；
 * - 行尾多余空白与三连以上空行。
 * 只做机械清洗，不改动任何正文措辞。
 */

const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;
const MD_COMMENT_LINE_RE = /^[ \t]*\[\\?\/\/\]:[ \t]*#.*$/gm;
const AI_MARK_RE = /[（(【\[][ \t]*AI[ \t]*[)）】\]]|（AI 生成）|\(AI[- ]generated\)/gi;

export function stripInternalMarkers(text: string, options: StripMarkerOptions = {}): string {
  const { stripComments = true, stripAiMarks = false } = options;
  let result = text;
  if (stripComments) {
    result = result.replace(HTML_COMMENT_RE, "").replace(MD_COMMENT_LINE_RE, "");
  }
  if (stripAiMarks) {
    result = result.replace(AI_MARK_RE, "");
  }
  return result
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}