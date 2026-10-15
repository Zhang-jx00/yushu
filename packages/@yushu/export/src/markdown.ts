/* SPDX-License-Identifier: Apache-2.0 */
import { formatChapterHead, withSequence } from "./assemble.js";
import { stripInternalMarkers } from "./clean.js";
import type { ExportChapter } from "./types.js";

/**
 * Pandoc 源装配（M5 / T5-4 第二段，R89）：把已装配的章节写成一份 **pandoc 吃得下的 Markdown**。
 *
 * 这一层的价值全在"不做什么"：
 * ① **不重排正文**——真源本来就是 Markdown，导出层再加工一遍等于把作者的排版换掉；
 * ② **不手搓目录**——目录交给 pandoc 的 `--toc`（宿主那边还会带 `--toc-depth=2`，因为卷是一级、
 *    章是二级），这里再写一份就会产出两份目录；
 * ③ **不读墙钟**——纯函数，日期由调用方给，同样输入必得同样输出（与"可复现快照"同一口径）。
 *
 * 标题层级是有意选的：EPUB / DOCX 阅读器按标题切章与建目录，
 * 卷 `#` + 章 `##` 正好对上"卷—章"两级，不必把书名也做成标题（书名走元数据）。
 */

/**
 * YAML 流式标量。用 `JSON.stringify` 不是偷懒：**JSON 的双引号字符串本身就是合法的 YAML 标量**，
 * 于是书名里的 `:`（会被当成键值分隔）、`#`（会被当成注释起点）、引号、反斜杠、换行全被安全包住。
 * 元数据块被书名撑坏是那种"平时不出错、换个书名就废"的缺陷。
 */
export function yamlScalar(value: string): string {
  return JSON.stringify(value);
}

export interface BuildMarkdownOptions {
  /** 书名（进 `title`） */
  bookTitle: string;
  /** 作者（进 `author`）；不传或空串 ⇒ 不写这一行，而不是写个空值 */
  author?: string;
  /** 成稿日期（进 `date`），由调用方给（纯函数不读墙钟） */
  date?: string;
  /** 默认剥离内部标记（HTML 注释 / AI 标识）；显式传 false 才原样保留 */
  stripMarkers?: boolean;
  /** 平台章节标题模板（K11）；`##` 行按它渲染，占位符不认识时当场抛，不留半成品 */
  titleFormat?: string;
}

/** 元数据块（含首尾 `---` 与结尾换行）；pandoc 要求它在文件最前面 */
export function buildPandocMetadata(options: BuildMarkdownOptions): string {
  const meta: string[] = [`title: ${yamlScalar(options.bookTitle)}`];
  if (options.author !== undefined && options.author !== "") {
    meta.push(`author: ${yamlScalar(options.author)}`);
  }
  if (options.date !== undefined && options.date !== "") {
    meta.push(`date: ${yamlScalar(options.date)}`);
  }
  return `---\n${meta.join("\n")}\n---\n`;
}

/** 装配 pandoc 输入：元数据块 + 「卷 `#` / 章 `##` / 正文原样」 */
export function buildMarkdown(chapters: ExportChapter[], options: BuildMarkdownOptions): string {
  const head = buildPandocMetadata(options);
  const sorted = withSequence(chapters);
  const blocks: string[] = [];
  let currentVolume = "";
  for (const chapter of sorted) {
    const parts: string[] = [];
    // 同一卷只在第一次出现时落一级标题（pandoc 靠它分卷）
    if (chapter.volumeId !== currentVolume) {
      currentVolume = chapter.volumeId;
      parts.push(`# ${chapter.volumeTitle}`, "");
    }
    parts.push(`## ${formatChapterHead(chapter, options.titleFormat)}`, "");
    const body = options.stripMarkers === false ? chapter.body : stripInternalMarkers(chapter.body);
    parts.push(body.trim(), "");
    blocks.push(parts.join("\n"));
  }
  if (blocks.length === 0) return head;
  return `${head}\n${blocks.join("\n")}`.replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
