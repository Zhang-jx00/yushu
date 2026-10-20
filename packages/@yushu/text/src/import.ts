/* SPDX-License-Identifier: Apache-2.0 */
/**
 * 存量稿件导入的纯文本层（M5 / T5-7 引擎侧，R76；输入来源 I09-存量稿件迁移与冷启动）。
 *
 * 这一层**不碰磁盘**：调用点给字节，这里给"探测结论 + 解码结果 + 清洗报告 + 分章结果"。
 * 三条口径：
 * ① **探测不出就不猜**：BOM → 严格 UTF-8 → GB18030 兜底，走到兜底那一步时 `assumed: true`
 *    并写明"这是猜的"。把猜的当成确定的，等于用乱码覆盖作者的原稿。
 * ② **清洗必须留报告**：每条规则删了几行、留一个样例，密钥剔除单独计数。
 *    静默改稿是最坏的一种"帮忙"——作者核对不了，就只能整篇弃用。
 * ③ **切不出章就不切**：没有章节标题的稿子返回单篇并说明，绝不按字数硬切（那会切在句子中间，
 *    比不切更糟）。
 *
 * GB18030 解码依赖 Node 的完整 ICU（本机实测 `process.versions.icu = 78.2`），零新增依赖。
 */

export type SourceEncoding = "utf-8" | "utf-16le" | "utf-16be" | "gb18030" | "unknown";
export type BomKind = "utf-8" | "utf-16le" | "utf-16be" | null;

export interface EncodingProbe {
  encoding: SourceEncoding;
  bom: BomKind;
  /** true = 走到兜底分支，是猜的（调用点要在界面上说出来） */
  assumed: boolean;
  /** false = 连猜都不猜（空字节串等） */
  ok: boolean;
  note: string;
}

export interface CleanRule {
  id: string;
  /** 源正则文本（不用 RegExp 对象：IPC 载荷带不了 lastIndex 等状态） */
  pattern: string;
}

export interface CleanReport {
  lineEndingNormalized: number;
  blankLinesCollapsed: number;
  removed: Array<{ rule: string; count: number; sample: string }>;
  redacted: Array<{ kind: string; count: number }>;
}

export interface ImportedChapter {
  title: string;
  body: string;
}

export interface SplitResult {
  chapters: ImportedChapter[];
  /** 第一章之前的内容（楔子 / 序 / 简介）：不能丢，得单独交还给作者 */
  preamble: ImportedChapter | null;
  volumeHints: string[];
  /** false = 没按标题切开（整篇当一章），调用点必须把这句话显示出来 */
  hardSplit: boolean;
  note: string | null;
}

const BOMS: Array<{ bytes: number[]; encoding: Exclude<SourceEncoding, "gb18030" | "unknown"> }> = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: "utf-8" },
  { bytes: [0xff, 0xfe], encoding: "utf-16le" },
  { bytes: [0xfe, 0xff], encoding: "utf-16be" },
];

function startsWith(bytes: Uint8Array, prefix: number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((value, index) => bytes[index] === value);
}

/** 探测来源编码：BOM 优先，其次严格 UTF-8 试解码，最后才退 GB18030 并标注是猜的 */
export function detectSourceEncoding(bytes: Uint8Array): EncodingProbe {
  if (bytes.length === 0) {
    return { encoding: "unknown", bom: null, assumed: false, ok: false, note: "空文件：没有字节可判，不猜编码" };
  }
  for (const bom of BOMS) {
    if (startsWith(bytes, bom.bytes)) {
      return { encoding: bom.encoding, bom: bom.encoding, assumed: false, ok: true, note: `BOM 命中 ${bom.encoding}，导入时剥掉 BOM` };
    }
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { encoding: "utf-8", bom: null, assumed: false, ok: true, note: "字节流按 UTF-8 严格解码通过" };
  } catch {
    // 走到这里才允许兜底：UTF-8 已经用 fatal 模式证伪，不是"看起来像"
  }
  return {
    encoding: "gb18030",
    bom: null,
    assumed: true,
    ok: true,
    note: "UTF-8 严格解码失败，按 GB18030 兜底——这是猜的：导入后请抽查前几段，乱码就换 UTF-8 重试",
  };
}

/** 按探测结论解码；BOM 不留在正文里 */
export function decodeImportedText(bytes: Uint8Array, probe: EncodingProbe): string {
  if (!probe.ok) return "";
  const text = new TextDecoder(probe.encoding === "unknown" ? "utf-8" : probe.encoding).decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 疑似密钥的形态（红线 3：明文密钥不落盘，导入外部稿时先就地剔除） */
const SECRET_KINDS: Array<{ kind: string; re: RegExp }> = [
  { kind: "openai 风格 sk-", re: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { kind: "github PAT", re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g },
  { kind: "Bearer 令牌", re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*\b/g },
];

/**
 * 清洗：行尾归一 → 按规则删行 → 剔除疑似密钥 → 压缩多余空行。
 * 规则正则读不懂就**抛错**，不静默跳过——静默跳过等于作者以为清洗过了。
 */
export function cleanImportedText(text: string, options: { rules: CleanRule[] }): { text: string; report: CleanReport } {
  const compiled = options.rules.map((rule) => {
    try {
      return { id: rule.id, re: new RegExp(rule.pattern, "g") };
    } catch (err) {
      throw new Error(`清洗规则「${rule.id}」的正则读不了：${err instanceof Error ? err.message : String(err)}`);
    }
  });

  const crlf = (text.match(/\r\n/g) ?? []).length;
  const loneCr = (text.replace(/\r\n/g, "").match(/\r/g) ?? []).length;
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  const removed = new Map<string, { count: number; sample: string }>();
  const redacted = new Map<string, number>();
  const kept: string[] = [];

  for (const line of normalized.split("\n")) {
    const hit = compiled.find((rule) => {
      rule.re.lastIndex = 0;
      return rule.re.test(line);
    });
    if (hit) {
      const entry = removed.get(hit.id) ?? { count: 0, sample: line.trim().slice(0, 60) };
      entry.count += 1;
      removed.set(hit.id, entry);
      continue;
    }
    let cleanLine = line;
    for (const secret of SECRET_KINDS) {
      secret.re.lastIndex = 0;
      const matches = cleanLine.match(secret.re);
      if (matches !== null && matches.length > 0) {
        redacted.set(secret.kind, (redacted.get(secret.kind) ?? 0) + matches.length);
        cleanLine = cleanLine.replace(secret.re, "[已剔除疑似密钥]");
      }
    }
    kept.push(cleanLine);
  }

  // 连续 3 行以上空白压成 1 行空白；正文段落之间的单个空行原样保留
  let collapsed = 0;
  const out: string[] = [];
  let blanks = 0;
  for (const line of kept) {
    if (line.trim() === "") {
      blanks += 1;
      continue;
    }
    if (blanks > 0) {
      const toEmit = blanks > 2 ? 1 : blanks;
      if (blanks > 2) collapsed += blanks - 1;
      for (let i = 0; i < toEmit; i += 1) out.push("");
      blanks = 0;
    }
    out.push(line);
  }
  if (blanks > 0) {
    const toEmit = blanks > 2 ? 1 : blanks;
    if (blanks > 2) collapsed += blanks - 1;
    for (let i = 0; i < toEmit; i += 1) out.push("");
  }

  return {
    text: out.join("\n"),
    report: {
      lineEndingNormalized: crlf + loneCr,
      blankLinesCollapsed: collapsed,
      removed: [...removed.entries()].map(([rule, entry]) => ({ rule, count: entry.count, sample: entry.sample })),
      redacted: [...redacted.entries()].map(([kind, count]) => ({ kind, count })),
    },
  };
}

const CN_NUM = "0〇零一二三四五六七八九十百千万两";
const VOLUME_RE = new RegExp(`^\\s*第\\s*[${CN_NUM}]+\\s*卷(?:\\s+\\S.{0,30})?\\s*$`);
const CHAPTER_RE = new RegExp(`^\\s*第\\s*[${CN_NUM}]+\\s*[章节回](?:\\s+\\S.{0,40})?\\s*$|^\\s*(?:Chapter|CHAPTER)\\s+\\d+.{0,40}$`);

/** 严筛：这一行是不是"确定的章标题"（窄正则；海选捞到的候选里，再用它分一次） */
export function isStrictChapterTitle(line: string): boolean {
  return CHAPTER_RE.test(line);
}

/**
 * 装配：给定"章标题行"与"卷标题行"，切出章 / 楔子 / 卷提示。
 *
 * 严筛（正则）与 AI 筛（模型指认的行）**共用这一套装配逻辑**——
 * 两处各写一遍，"预演看到的章"与"入库写出的章"就会对不上，而分章对账唯一的价值恰恰是拿两边比。
 */
function assembleSplit(text: string, titleLines: ReadonlySet<number>, volumeLines: ReadonlySet<number>): SplitResult {
  const lines = text.split("\n");
  if (text.trim() === "") {
    return { chapters: [], preamble: null, volumeHints: [], hardSplit: false, note: "空文本：没有可切的正文" };
  }
  const chapters: ImportedChapter[] = [];
  const volumeHints: string[] = [];
  const preambleLines: string[] = [];
  let current: { title: string; body: string[] } | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNo = index + 1;
    if (volumeLines.has(lineNo)) {
      // 卷标题先判：`卷` 不在章的字符类里，避免"第一卷 风起"被当成一章
      volumeHints.push(line.trim());
      continue;
    }
    if (titleLines.has(lineNo)) {
      if (current !== null) chapters.push({ title: current.title, body: current.body.join("\n").trim() });
      current = { title: line.trim(), body: [] };
      continue;
    }
    if (current === null) preambleLines.push(line);
    else current.body.push(line);
  }
  if (current !== null) chapters.push({ title: current.title, body: current.body.join("\n").trim() });

  if (chapters.length === 0) {
    return {
      chapters: [{ title: "", body: text.trim() }],
      preamble: null,
      volumeHints,
      hardSplit: false,
      note: "没找到章节标题（第 N 章 / 节 / 回 / Chapter N）：整篇作为一章导入，不按时长或字数硬切",
    };
  }
  const preambleText = preambleLines.join("\n").trim();
  return {
    chapters,
    preamble: preambleText === "" ? null : { title: "", body: preambleText },
    volumeHints,
    hardSplit: true,
    note: null,
  };
}

/** 按章节标题切分；认不出标题就整篇交回去，不按字数硬切 */
export function splitImportedChapters(text: string): SplitResult {
  const lines = text.split("\n");
  const titleLines = new Set<number>();
  const volumeLines = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineNo = index + 1;
    if (VOLUME_RE.test(line)) {
      volumeLines.add(lineNo);
      continue;
    }
    if (CHAPTER_RE.test(line)) titleLines.add(lineNo);
  }
  return assembleSplit(text, titleLines, volumeLines);
}

/**
 * 按**指定行**切章（AI 筛选后用；行号来自海选候选，1 起）。
 *
 * 与严筛共用装配逻辑 ⇒ 同一份正文、同一份装配，预演与入库必然对得上。
 * 行号越界或倒序 ⇒ 一律忽略（模型给的行号不可信），不静默改切法。
 */
export function splitImportedChaptersAt(text: string, titleLines: readonly number[]): SplitResult {
  const total = text.split("\n").length;
  const valid = titleLines.filter((line) => Number.isInteger(line) && line >= 1 && line <= total);
  const ordered = [...new Set(valid)].sort((a, b) => a - b);
  const lines = text.split("\n");
  const volumeLines = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    if (VOLUME_RE.test(lines[index] ?? "")) volumeLines.add(index + 1);
  }
  return assembleSplit(text, new Set(ordered), volumeLines);
}

/* ---------------- 第二段：海选候选 / 误切检测 / 人工校正（R107，I09 §3.4 与 §3.5） ---------------- */

/**
 * **海选**（I09 §3.4 的前半段「规则海选」）：比严筛（上面的 `CHAPTER_RE`）宽一档的
 * "这行像不像章节标题"。宽出来的部分正是**严筛认不准**的地方——带方括号 / 冒号 / 全角空格
 * 的章标题、以及被误当成标题的一整段正文。
 *
 * 为什么要两段：正则一刀切下去，"认不准"与"真不是标题"分不开——
 * 直接按正则切，切错的地方作者只能整篇弃用；先海选、再让 AI（或作者）筛，
 * 切错的地方能逐条指出来。
 */
export interface ChapterCandidate {
  /** 行号（1 起）：AI 只能指认这些行，别的行一律丢弃 */
  line: number;
  /** 该行原文（trim 后） */
  text: string;
  /** 命中的规则 id（便于报告"这行是被哪条规则捞出来的"） */
  rule: string;
}

/** 海选规则包：逐条放宽，**命中第一条就停**（规则有先后，宽的在前） */
const CANDIDATE_RULES: Array<{ id: string; re: RegExp }> = [
  // 【第一章 起】/ [第二章 承] / 《第三章 转》——书名号与方括号里也是章标题
  { id: "cn-chapter-bracket", re: /^\s*[【\[《]\s*第\s*[0-9〇零一二三四五六七八九十百千万两]+\s*[章节回]/ },
  // 第一章 / 第 3 章 / 第十二章 夜探藏经阁 / 第二章：承
  { id: "cn-chapter", re: /^\s*第\s*[0-9〇零一二三四五六七八九十百千万两]+\s*[章节回]/ },
  // Chapter 7 / CHAPTER 8
  { id: "en-chapter", re: /^\s*(?:Chapter|CHAPTER)\s+\d+/ },
];

export function findChapterCandidates(text: string): ChapterCandidate[] {
  const out: ChapterCandidate[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "") continue;
    for (const rule of CANDIDATE_RULES) {
      if (rule.re.test(line)) {
        out.push({ line: index + 1, text: line.trim(), rule: rule.id });
        break;
      }
    }
  }
  return out;
}

/** 中文数字 → 阿拉伯数字（认不出的字返回 null，不硬编一个号出来） */
function cnNumber(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  const digits: Record<string, number> = {
    〇: 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  let total = 0;
  let section = 0;
  let current = 0;
  let seen = false;
  for (const ch of text) {
    if (ch in digits) {
      current = digits[ch] ?? 0;
      seen = true;
      continue;
    }
    if (ch === "十") {
      section += (current === 0 ? 1 : current) * 10;
      current = 0;
      seen = true;
      continue;
    }
    if (ch === "百") {
      section += (current === 0 ? 1 : current) * 100;
      current = 0;
      seen = true;
      continue;
    }
    if (ch === "千") {
      section += (current === 0 ? 1 : current) * 1000;
      current = 0;
      seen = true;
      continue;
    }
    if (ch === "万") {
      total += (section + current) * 10000;
      section = 0;
      current = 0;
      seen = true;
      continue;
    }
    return null;
  }
  if (!seen) return null;
  return total + section + current;
}

/** 从标题里解析章号（"第十二章 夜探藏经阁" → 12）；不是章标题返回 null */
export function chapterTitleNumber(title: string): number | null {
  const text = title.trim();
  const cn = /第\s*([0-9〇零一二三四五六七八九十百千万两]+)\s*[章节回]/.exec(text);
  if (cn !== null) return cnNumber(cn[1] ?? "");
  const en = /(?:Chapter|CHAPTER)\s+(\d+)/.exec(text);
  if (en !== null) return Number(en[1]);
  return null;
}

/** 误切的三类校验（I09 §3.5） */
export type MiscutCode = "chapter-index-gap" | "chapter-title-too-long" | "chapter-length-outlier";

export interface MiscutIssue {
  code: MiscutCode;
  message: string;
}

export interface MiscutRow {
  /** 章在预演清单里的序号（0 起，与界面列表一致） */
  index: number;
  title: string;
  chars: number;
  issues: MiscutIssue[];
}

/** 标题长度上限：与严筛自己的 40 字上限同档（超过就"像是一段正文被当成了标题"） */
const TITLE_LENGTH_LIMIT = 40;
/** 字数离群的倍数（中位数的 1/5 与 5 倍之外） */
const LENGTH_OUTLIER_FACTOR = 5;
/** 字数离群判定所需的最小样本数（章太少时不下结论——两章时必然"异常"） */
const LENGTH_OUTLIER_MIN_SAMPLES = 3;

/**
 * 误切检测（I09 §3.5）：章号连续性 / 标题长度 / 章节字数分布三类校验。
 *
 * 三条口径：
 * ① **章号连续性按"上一条解析出的号"比**，不按位置比——从第 5 章开始的节选不是错切，
 *    位置比对会把它误报成"断号"；
 * ② **字数离群在样本不足时不下结论**（少于 3 章不比）——两章时必然有一章"异常"；
 * ③ **只报不改**：校正由作者显式做（合并 / 拆分 / 重排），工具不替作者改他的稿子。
 */
export function detectMiscuts(chapters: ReadonlyArray<{ title: string; chars: number }>): MiscutRow[] {
  const rows: MiscutRow[] = [];
  let previousNumber: number | null = null;
  const counts = chapters.map((item) => item.chars).sort((a, b) => a - b);
  const median =
    counts.length === 0
      ? 0
      : counts.length % 2 === 1
        ? (counts[(counts.length - 1) / 2] ?? 0)
        : ((counts[counts.length / 2 - 1] ?? 0) + (counts[counts.length / 2] ?? 0)) / 2;

  for (let index = 0; index < chapters.length; index += 1) {
    const item = chapters[index];
    if (item === undefined) continue;
    const issues: MiscutIssue[] = [];
    const number = chapterTitleNumber(item.title);
    if (number !== null) {
      if (previousNumber !== null && number !== previousNumber + 1) {
        issues.push({
          code: "chapter-index-gap",
          message:
            number === previousNumber
              ? `章号重复：上一章是第 ${String(previousNumber)} 章，这章又是第 ${String(number)} 章（可能同一章被切了两次）`
              : `章号不连续：上一章是第 ${String(previousNumber)} 章，这章是第 ${String(number)} 章（中间少了章，或顺序错了）`,
        });
      }
      previousNumber = number;
    }
    if (item.title.length > TITLE_LENGTH_LIMIT) {
      issues.push({
        code: "chapter-title-too-long",
        message: `标题 ${String(item.title.length)} 字，超过 ${String(TITLE_LENGTH_LIMIT)} 字：像是一段正文被当成了标题`,
      });
    }
    if (counts.length >= LENGTH_OUTLIER_MIN_SAMPLES && median > 0) {
      const low = median / LENGTH_OUTLIER_FACTOR;
      const high = median * LENGTH_OUTLIER_FACTOR;
      if (item.chars < low || item.chars > high) {
        issues.push({
          code: "chapter-length-outlier",
          message: `本章 ${String(item.chars)} 字，与全书中位数 ${String(median)} 字差了一个量级：可能切错了`,
        });
      }
    }
    if (issues.length > 0) rows.push({ index, title: item.title, chars: item.chars, issues });
  }
  return rows;
}

/** 人工校正的四种动作（I09 §3.5 的「合并 / 拆分 / 重排」） */
export type ImportCorrection =
  | { kind: "merge"; at: number }
  /**
   * `line` 是**该章正文里**的行号（1 起），不是原稿行号——两者差着一个首尾空行的偏移。
   *
   * `title` 是新章的标题（作者点的那一行本身）——不给就退回「（续）」。
   */
  | { kind: "split"; at: number; line: number; title?: string }
  | { kind: "move"; from: number; to: number };

/**
 * 把**原稿行号**解析成「第几章 + 该章正文里的第几行」。
 *
 * 为什么要换算：章正文在装配时 trim 过（首尾空行被去掉），原稿行号与正文行号差着一个偏移；
 * 直接拿原稿行号当正文行号切，切点会落在**错误的句子上**——切错的地方作者最难发现
 * （章还在、字数还对，只有内容错位）。
 *
 * 三条口径：
 * ① 切点**不能是章标题本身**（那已经是边界了，再切一刀等于多出一个空章）；
 * ② 切点**必须在第一章之后**（第一章之前是楔子，不属于任何一章）；
 * ③ 切点**必须前后都留得住**：章正文的第一行切了前半章是空的、最后一行切了后半章是空的
 *    ⇒ 一律返回 null，由调用点如实说"切不开"，不硬切一刀。
 */
export function resolveSourceLine(
  text: string,
  boundaries: readonly number[],
  line: number,
): { chapterIndex: number; bodyLine: number } | null {
  const lines = text.split("\n");
  const sorted = [...new Set(boundaries)].sort((a, b) => a - b);
  if (sorted.length === 0 || !Number.isInteger(line) || line < 1) return null;
  let chapterIndex = -1;
  for (let index = 0; index < sorted.length; index += 1) {
    const boundary = sorted[index];
    if (boundary !== undefined && boundary <= line) chapterIndex = index;
  }
  if (chapterIndex < 0) return null; // 楔子里：不属于任何一章
  const start = sorted[chapterIndex] ?? 0;
  if (start === line) return null; // 这一行就是章标题：已经是边界了
  const end = sorted[chapterIndex + 1] ?? lines.length + 1;
  // 首尾空行在装配时被 trim 掉了：先数掉首部空行，正文行号才与原稿行号对得上
  let leading = 0;
  for (let probe = start + 1; probe < end; probe += 1) {
    if ((lines[probe - 1] ?? "").trim() === "") leading += 1;
    else break;
  }
  let trailing = 0;
  for (let probe = end - 1; probe > start; probe -= 1) {
    if ((lines[probe - 1] ?? "").trim() === "") trailing += 1;
    else break;
  }
  const bodyCount = end - start - 1 - leading - trailing;
  const bodyLine = line - start - leading;
  // 切点那一行要**当新章的标题**（不留在正文里），所以它前面得留得住一行、后头也得留得住一行
  if (bodyLine < 2 || bodyLine >= bodyCount) return null;
  return { chapterIndex, bodyLine };
}

/**
 * 按作者的校正改切分结果。
 *
 * 四条口径：
 * ① **不合入参**：返回新数组，原数组原样（作者可以撤销重来）；
 * ② **越界的指令被忽略**，不炸也不改内容——作者点了不该点的按钮不该毁掉整篇预演；
 * ③ **拆分的那一行成为新章的标题**（作者点的是"这行其实是章标题"）：
 *    给的 `title` 就是它；没给才退回「（续）」——章号本来就不可靠
 *    （这正是误切检测要报的东西），标出来让作者看见。
 */
export function applyImportCorrections(
  chapters: readonly ImportedChapter[],
  corrections: readonly ImportCorrection[],
): ImportedChapter[] {
  let current = chapters.map((item) => ({ title: item.title, body: item.body }));
  for (const correction of corrections) {
    if (correction.kind === "merge") {
      const at = correction.at;
      if (!Number.isInteger(at) || at < 0 || at + 1 >= current.length) continue;
      const first = current[at];
      const second = current[at + 1];
      if (first === undefined || second === undefined) continue;
      const merged: ImportedChapter = {
        title: first.title,
        body: second.body === "" ? first.body : `${first.body}\n${second.body}`,
      };
      current = [...current.slice(0, at), merged, ...current.slice(at + 2)];
      continue;
    }
    if (correction.kind === "split") {
      const at = correction.at;
      if (!Number.isInteger(at) || at < 0 || at >= current.length) continue;
      const target = current[at];
      if (target === undefined) continue;
      const lines = target.body.split("\n");
      // `line` 是**该章正文内**的行号（1 起）：原稿行号要先过 `resolveSourceLine` 换算，
      // 拿原稿行号直接切会切在错误的句子上。
      const line = correction.line;
      if (!Number.isInteger(line) || line < 1 || line > lines.length) continue;
      // 切点那一行**当新章的标题**（不留在正文里），前后的正文各归各的
      const head = lines.slice(0, line - 1).join("\n").trim();
      const tail = lines.slice(line).join("\n").trim();
      if (head === "" || tail === "") continue;
      const title = correction.title !== undefined && correction.title.trim() !== ""
        ? correction.title.trim()
        : `${target.title}（续）`;
      current = [
        ...current.slice(0, at),
        { title: target.title, body: head },
        { title, body: tail },
        ...current.slice(at + 1),
      ];
      continue;
    }
    if (correction.kind === "move") {
      const from = correction.from;
      const to = correction.to;
      if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
      if (from < 0 || from >= current.length || to < 0 || to >= current.length) continue;
      const [moved] = current.splice(from, 1);
      if (moved === undefined) continue;
      current.splice(to, 0, moved);
    }
  }
  return current;
}
