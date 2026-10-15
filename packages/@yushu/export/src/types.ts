/* SPDX-License-Identifier: Apache-2.0 */
/** 导出管线类型（M1 TXT 最小版；EPUB/DOCX/PDF 与 EPUBCheck 留待 M5） */

/** 装配输入：一章（由项目数据层读出，正文已剥离 frontmatter） */
export interface ExportChapter {
  /** 章纲 ID（co-*） */
  outlineRef: string;
  /** 章节实体 ID（ch-*） */
  chapterId: string;
  volumeId: string;
  volumeTitle: string;
  /** 所属幕（起/承/合，来自卷纲） */
  act: string;
  /** 卷在全书的序号（装配时按大纲卷序注入；仅用于排序） */
  volumeIndex: number;
  /** 卷内序号 */
  idx: number;
  /**
   * 全书连续序号（1 起，跨卷不重置）。
   * 由 `withSequence` / `assembleExport` 注入——**投稿要的是它，不是 `idx`**：
   * 大纲里每卷的 `idx` 都从 1 开始，直接拿去编号会让卷二重新出现"第1章"。
   * 未注入时章头回退用 `idx`（单卷书两者相同）。
   */
  seq?: number;
  title: string;
  body: string;
  /** frontmatter 中记录的字数（对账用） */
  statedWordCount: number;
}

export interface ReconcileRow {
  chapterId: string;
  title: string;
  volumeTitle: string;
  /** frontmatter 记录 */
  stated: number;
  /** 正文实际（去空白字符数） */
  actual: number;
  matched: boolean;
}

export interface ExportStats {
  volumes: number;
  chapters: number;
  totalWords: number;
  matched: number;
  mismatched: number;
}

export interface TessembleResult {
  chapters: ExportChapter[];
  reconcile: ReconcileRow[];
  stats: ExportStats;
}

export type SensitiveSeverity = "error" | "warn" | "info";

export interface WordlistEntry {
  word: string;
  severity: SensitiveSeverity;
  /** 替换建议（可空；T1-19 只给建议，不自动改写正文） */
  suggestion?: string;
  note?: string;
  /** 平台标注（取值来自词库文件本身；M5 平台规则包接入后细化） */
  platforms?: string[];
}

/** 外置词库（带来源与版本号，可整文件替换更新） */
export interface Wordlist {
  apiVersion: "yushu.wordlist/v1";
  id: string;
  version: string;
  /** 来源说明（内置/平台规则包/作者自建） */
  source?: string;
  updated_at?: string;
  title?: string;
  entries: WordlistEntry[];
}

/** 参与扫描的词条（携带来源词库，便于命中溯源） */
export interface MergedWordlistEntry extends WordlistEntry {
  wordlistId: string;
  wordlistVersion: string;
  wordlistSource?: string;
}

export interface SensitiveHit {
  word: string;
  severity: SensitiveSeverity;
  suggestion?: string;
  note?: string;
  platforms?: string[];
  wordlistId: string;
  wordlistVersion: string;
  chapterId: string;
  chapterTitle: string;
  volumeTitle: string;
  /** 命中位置（章内正文字符下标） */
  index: number;
  /** 上下文片段（命中词两侧各截取若干字） */
  context: string;
}

export interface SensitiveScanSummary {
  totalHits: number;
  bySeverity: Record<SensitiveSeverity, number>;
  /** 参与扫描的词条数与词库 */
  wordCount: number;
  wordlists: { id: string; version: string; source?: string; entries: number }[];
}

export interface SensitiveScanResult {
  hits: SensitiveHit[];
  summary: SensitiveScanSummary;
}

export interface BuildTxtOptions {
  bookTitle: string;
  /** 目录页 */
  includeToc: boolean;
  /** 去除内部标记（HTML 注释 / AI 标识等） */
  stripMarkers?: boolean;
  /** 导出时间（ISO；仅写入头部元信息，便于对账） */
  generatedAt?: string;
  /**
   * 平台章节标题模板（K11：来自平台导出包的 `chapter_title_format`，**不硬编码平台名**）。
   * 传了就取代内置的"第N章 标题"，`{index}` 用全书序号；占位符不认识时 `renderChapterTitle` 当场抛，
   * 不会把 `{num}` 原样吐进作者书稿。
   */
  titleFormat?: string;
}

export interface StripMarkerOptions {
  /** 去除 HTML 注释与 Markdown 注释行（默认 true） */
  stripComments?: boolean;
  /** 去除 AI 生成标识（如「（AI 生成）」/【AI】）——投稿前"输出可标识"的可选清洗 */
  stripAiMarks?: boolean;
}