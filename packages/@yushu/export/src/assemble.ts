/* SPDX-License-Identifier: Apache-2.0 */
import { countWords, codePointCompare } from "@yushu/core";
import type {
  BuildTxtOptions,
  ExportChapter,
  ExportStats,
  ReconcileRow,
  TessembleResult,
} from "./types.js";
import { stripInternalMarkers } from "./clean.js";
import { renderChapterTitle, stripLeadingChapterPrefix, templateAddsChapterPrefix } from "./platform-format.js";

/**
 * TXT 导出最小管线（T1-18）：
 * 章节顺序装配（按卷序 → 卷内章序）→ 目录与分章 → TXT 全文；字数与正文对账。
 * 顺序以三级大纲为准（作者重排大纲后导出顺序随之变化），而不是文件系统顺序。
 */

/** 大纲序（卷序 → 卷内序号 → 章 id）；导出侧只认这一把尺（TXT / Markdown 共用） */
export function byOutlineOrder(a: ExportChapter, b: ExportChapter): number {
  return (
    a.volumeIndex - b.volumeIndex || a.idx - b.idx || codePointCompare(a.chapterId, b.chapterId)
  );
}

/**
 * 排序 + 注入**全书连续序号** `seq`（R94）。
 *
 * 为什么必须有它：大纲里的 `idx` 是**卷内序号**，每一卷都从 1 开始。
 * 拿它编导出章头，两卷的书会得到"卷一 第1/2 章、卷二又回到第1 章"——
 * 作者拿去投稿，章节号直接对不上平台的连续编号。这个缺陷是 K11 要求把 `{index}`
 * 落到实际产物上时才被查出来的：R94 之前，仓库里没有任何东西需要"全书第几章"这个数。
 */
export function withSequence(chapters: ExportChapter[]): ExportChapter[] {
  const sorted = [...chapters].sort(byOutlineOrder);
  // 调用方（主进程按三级大纲）已经给了完整序号就照它——那是作者在大纲里的真实章序，
  // 未创建草稿的章也算在内；缺任何一章的 seq 就整体按导出位置重数，避免一半信一半数导致重号。
  const injected = sorted.every((chapter) => typeof chapter.seq === "number" && chapter.seq > 0);
  if (injected) return sorted;
  return sorted.map((chapter, index) => ({ ...chapter, seq: index + 1 }));
}

export interface AssembleInput {
  /** 来自三级大纲的章节（同卷内可乱序，装配时按 idx 重排） */
  chapters: ExportChapter[];
}

/** 装配：排序 + 字数对账 + 统计（供导出预览与导出执行共用） */
export function assembleExport(input: AssembleInput): TessembleResult {
  const sorted = withSequence(input.chapters);
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

/**
 * 章节标题行：默认与章纲标题一致；给了 `titleFormat`（K11 的平台模板）就按模板渲染。
 *
 * 编号用**全书序号** `seq`，未注入时回退卷内 `idx`（单卷书两者相同，旧行为逐字不变）。
 * 标题自带"第N章"时**不悄悄删作者的字数**——照原文输出，重复前缀交给平台核对的 warn 行提示；
 * 改写正文不是导出层能替作者做的决定。
 */
export function formatChapterHead(chapter: ExportChapter, titleFormat?: string): string {
  const index = chapter.seq ?? chapter.idx;
  if (titleFormat !== undefined && titleFormat !== "") {
    // 模板要补"第N章"而标题自己也带了一个 ⇒ 导出副本里让模板赢（真源不动，
    // 这件事由预览样例与 warn 行明说，不做静默改写）。
    const base = templateAddsChapterPrefix(titleFormat)
      ? stripLeadingChapterPrefix(chapter.title)
      : chapter.title;
    return renderChapterTitle(titleFormat, { index, title: base }).trim();
  }
  const head = `第${index}章 ${chapter.title}`.trim();
  // 章标题已含"第N章"，避免重复前缀
  return /^第[0-9一二三四五六七八九十百千]+章/.test(chapter.title)
    ? chapter.title
    : head;
}

/** 目录（卷 → 章两级） */
export function buildToc(chapters: ExportChapter[], titleFormat?: string): string {
  const lines: string[] = [];
  let currentVolume = "";
  for (const chapter of chapters) {
    if (chapter.volumeId !== currentVolume) {
      currentVolume = chapter.volumeId;
      lines.push(`${chapter.volumeTitle}${chapter.act ? `（${chapter.act}）` : ""}`);
    }
    lines.push(`　　${formatChapterHead(chapter, titleFormat)}`);
  }
  return lines.join("\n");
}

/** 正文（卷标题 + 分章），逐章之间用分隔线 */
export function buildBody(
  chapters: ExportChapter[],
  stripMarkers: boolean,
  titleFormat?: string,
): string {
  const blocks: string[] = [];
  let currentVolume = "";
  for (const chapter of chapters) {
    const parts: string[] = [];
    if (chapter.volumeId !== currentVolume) {
      currentVolume = chapter.volumeId;
      parts.push(`【${chapter.volumeTitle}】`, "");
    }
    parts.push(formatChapterHead(chapter, titleFormat), RULE, "");
    const body = stripMarkers ? stripInternalMarkers(chapter.body) : chapter.body;
    parts.push(body.trim(), "");
    blocks.push(parts.join("\n"));
  }
  return blocks.join("\n");
}

/** 构建完整 TXT（头部元信息 + 可选目录 + 正文） */
export function buildTxt(chapters: ExportChapter[], options: BuildTxtOptions): string {
  // 顺序在这里就定死，不指望调用方记得先排序：`assembleExport` 排过一遍，
  // 但 `buildTxt` 是导出的出口，出口自己认得"卷序 → 卷内序号"这把尺，
  // Markdown 出口（R89 `buildMarkdown`）用的也是同一把——两边不会因输入顺序不同而分叉。
  const ordered = withSequence(chapters);
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const total = ordered.reduce((sum, chapter) => sum + countWords(chapter.body), 0);
  const head = [
    `《${options.bookTitle}》`,
    `导出时间：${generatedAt.replace("T", " ").slice(0, 19)}`,
    `共 ${ordered.length} 章 · ${total} 字（去空白字符数）`,
    "",
  ].join("\n");

  const sections = [head];
  if (options.includeToc) {
    sections.push("═ 目录 ═", "", buildToc(ordered, options.titleFormat), "", "");
  }
  sections.push("═ 正文 ═", "", buildBody(ordered, options.stripMarkers ?? true, options.titleFormat));
  return `${sections.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd()}\n`;
}

/** 干净剪贴板正文（T1-20）：无目录/无头部元信息/无内部标记，逐章段落式拼接 */
export function buildClipboardText(
  chapters: ExportChapter[],
  options: { stripComments?: boolean; stripAiMarks?: boolean; titleFormat?: string } = {},
): string {
  const sorted = withSequence(chapters);
  return sorted
    .map((chapter) => {
      const body = stripInternalMarkers(chapter.body, options).trim();
      return `${formatChapterHead(chapter, options.titleFormat)}\n\n${body}`;
    })
    .join("\n\n\n")
    .trimEnd();
}