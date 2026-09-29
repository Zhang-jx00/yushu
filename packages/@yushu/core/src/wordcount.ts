/**
 * 字数统计（跨包唯一口径）：去空白后的字符数。
 * M1 粗口径；M2 码字统计将细化到中文/英文混排与平台"有效字数"口径。
 */
export function countWords(text: string): number {
  return text.replace(/\s+/g, "").length;
}