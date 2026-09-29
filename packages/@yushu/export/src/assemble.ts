import { countWords } from "@yushu/core";
import type {
  BuildTxtOptions,
  ExportChapter,
  ExportStats,
  ReconcileRow,
  TessembleResult,
} from "./types.js";
import { stripInternalMarkers } from "./clean.js";

/**
 * TXT 导出最小管线（T1-18）：
 * 章节顺序装配（按卷序 → 卷内章序）→ 目录与分章 → TXT 全文；字数与正文对账。
 * 顺序以三级大纲为准（作者重排大纲后导出顺序随之变化），而不是文件系统顺序。
 */

function byOutlineOrder(a: ExportChapter, b: ExportChapter): number {
  return (
    a.volumeIndex - b.volumeIndex || a.idx - b.idx || a.chapterId.localeCompare(b.chapterId)
  );
}

export interface AssembleInput {
  /** 来自三级大纲的章节（同卷内可乱序，装配时按 idx 重排） */
  chapters: ExportChapter[];
}

/** 装配：排序 + 字数对账 + 统计（供导出预览与导出执行共用） */
export function assembleExport(input: AssembleInput): TessembleResult {
  const sorted = [...input.chapters].sort(byOutlineOrder);
  const reconcile: ReconcileRow[] = sorted.map((chapter) => {
    const actual = countWords(chapter.body);
    return {
      chapterId: chapter.chapterId,
      title: chapter.title,
      volumeTitle: chapter.volumeTitle,
      stated: chapter.statedWordCount,
      actual,
      // frontmatter 未记录字数（0）时以正文为准，不算失配
      matched: chapter.statedWordCount === 0 || chapter.statedWordCount === actual,
    };
  });
  const volumeKeys = new Set(sorted.map((chapter) => chapter.volumeId));
  const stats: ExportStats = {
    volumes: volumeKeys.size,
    chapters: sorted.length,
    totalWords: reconcile.reduce((sum, row) => sum + row.actual, 0),
    matched: reconcile.filter((row) => row.matched).length,
    mismatched: reconcile.filter((row) => !row.matched).length,
  };
  return { chapters: sorted, reconcile, stats };
}

const RULE = "────────────────────────";

/** 章节标题行（与章纲标题一致） */
export function formatChapterHead(chapter: ExportChapter): string {
  const head = `第${chapter.idx}章 ${chapter.title}`.trim();
  // 章纲标题常已含"第N章"，避免重复前缀
  return /^第[0-9一二三四五六七八九十百千]+章/.test(chapter.title)
    ? chapter.title
    : head;
}

/** 目录（卷 → 章两级） */
export function buildToc(chapters: ExportChapter[]): string {
  const lines: string[] = [];
  let currentVolume = "";
  for (const chapter of chapters) {
    if (chapter.volumeId !== currentVolume) {
      currentVolume = chapter.volumeId;
      lines.push(`${chapter.volumeTitle}${chapter.act ? `（${chapter.act}）` : ""}`);
    }
    lines.push(`　　${formatChapterHead(chapter)}`);
  }
  return lines.join("\n");
}

/** 正文（卷标题 + 分章），逐章之间用分隔线 */
export function buildBody(chapters: ExportChapter[], stripMarkers: boolean): string {
  const blocks: string[] = [];
  let currentVolume = "";
  for (const chapter of chapters) {
    const parts: string[] = [];
    if (chapter.volumeId !== currentVolume) {
      currentVolume = chapter.volumeId;
      parts.push(`【${chapter.volumeTitle}】`, "");
    }
    parts.push(formatChapterHead(chapter), RULE, "");
    const body = stripMarkers ? stripInternalMarkers(chapter.body) : chapter.body;
    parts.push(body.trim(), "");
    blocks.push(parts.join("\n"));
  }
  return blocks.join("\n");
}

/** 构建完整 TXT（头部元信息 + 可选目录 + 正文） */
export function buildTxt(chapters: ExportChapter[], options: BuildTxtOptions): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const total = chapters.reduce((sum, chapter) => sum + countWords(chapter.body), 0);
  const head = [
    `《${options.bookTitle}》`,
    `导出时间：${generatedAt.replace("T", " ").slice(0, 19)}`,
    `共 ${chapters.length} 章 · ${total} 字（去空白字符数）`,
    "",
  ].join("\n");

  const sections = [head];
  if (options.includeToc) {
    sections.push("═ 目录 ═", "", buildToc(chapters), "", "");
  }
  sections.push("═ 正文 ═", "", buildBody(chapters, options.stripMarkers ?? true));
  return `${sections.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** 干净剪贴板正文（T1-20）：无目录/无头部元信息/无内部标记，逐章段落式拼接 */
export function buildClipboardText(
  chapters: ExportChapter[],
  options: { stripComments?: boolean; stripAiMarks?: boolean } = {},
): string {
  const sorted = [...chapters].sort(byOutlineOrder);
  return sorted
    .map((chapter) => {
      const body = stripInternalMarkers(chapter.body, options).trim();
      return `${formatChapterHead(chapter)}\n\n${body}`;
    })
    .join("\n\n\n")
    .trimEnd();
}