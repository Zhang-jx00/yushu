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

/** 按章节标题切分；认不出标题就整篇交回去，不按字数硬切 */
export function splitImportedChapters(text: string): SplitResult {
  const lines = text.split("\n");
  if (text.trim() === "") {
    return { chapters: [], preamble: null, volumeHints: [], hardSplit: false, note: "空文本：没有可切的正文" };
  }
  const chapters: ImportedChapter[] = [];
  const volumeHints: string[] = [];
  const preambleLines: string[] = [];
  let current: { title: string; body: string[] } | null = null;

  for (const line of lines) {
    if (VOLUME_RE.test(line)) {
      // 卷标题先判：`卷` 不在章的字符类里，避免"第一卷 风起"被当成一章
      volumeHints.push(line.trim());
      continue;
    }
    if (CHAPTER_RE.test(line)) {
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
