import { createHash } from "node:crypto";
import { parseOutline } from "./outline.js";
import { readCardFile } from "./cards.js";
import { readChapterFile } from "./chapters.js";

/**
 * 索引输入收集（T1-21 的生产侧）：真源文件 → 索引输入结构（entities / refs / chunks / file_index）。
 * - 只读调用方提供的读取接口（主进程走 FileGateway 适配器、CLI 走 fs 适配器），本包不直接碰 fs；
 * - 收集范围：设定卡（实体 + 引用 + 正文块）、章节正文（分块）、大纲文件（整文件单块）；
 * - chunk 内命中的实体名同时写入 entities 列（M2 提及追踪的基础）。
 */

/** 可索引文本扩展名（其余文件仅记录在 file_index 之外——M1 不索引二进制） */
export const INDEXABLE_EXT_RE = /\.(md|ya?ml|toml|txt)$/i;

export interface IndexSourceFile {
  path: string;
  size: number;
  /** 读取源未提供 stat 时可空 */
  mtime?: string;
}

/** 数据源读取接口（主进程 FileGateway / CLI fs 适配器各自实现） */
export interface IndexSourceReader {
  listFiles(): Promise<IndexSourceFile[]>;
  readText(path: string): Promise<string>;
}

export interface IndexFileRow {
  path: string;
  mtime?: string;
  hash: string;
  bytes: number;
}

export interface IndexEntityRow {
  id: string;
  type: string;
  layer: string;
  name: string;
  aliases: string[];
  visibility: string;
  filePath: string;
}

export interface IndexRefRow {
  referrer: string;
  relation: string;
  target: string;
}

export interface IndexChunkRow {
  id: string;
  path: string;
  chapterId?: string;
  volume?: string;
  kind: string;
  text: string;
  charStart: number;
  charEnd: number;
  textHash: string;
  entities: string[];
}

export interface IndexInput {
  files: IndexFileRow[];
  entities: IndexEntityRow[];
  refs: IndexRefRow[];
  chunks: IndexChunkRow[];
}

export interface CollectIndexOptions {
  /** 块目标大小（字符；按段落聚合，超长段落硬切） */
  chunkSize?: number;
  /** 排除路径前缀（默认排除导出产物与引擎目录） */
  excludePrefixes?: string[];
}

export const DEFAULT_INDEX_EXCLUDES = [".yushu/", ".git/", "node_modules/", "exports/"];

/**
 * 冲突旁路文件（T2-6：`<章节>.conflict-<时间戳>.md`，见 docs/04 T2-6）。
 * 旁路是人工处置中的临时产物、不是真源章节——若被当作章节收录，检索会出现"幻觉章节"
 * （同一 chapterId 的重复块）。此处统一排除，与导出（走大纲映射）保持同一口径。
 */
const CONFLICT_SIDECAR_RE = /\.conflict-\d{8}-\d{9}\.md$/;

/**
 * 该路径是否进入索引（扩展名 + 排除前缀 + 旁路文件；增量 diff 与收集两侧同口径）。
 * 增量重建的 diff 必须复用本判定——否则导出产物等被收集侧排除的文件会被误计为"变更"。
 */
export function isIndexablePath(path: string, excludes: string[] = DEFAULT_INDEX_EXCLUDES): boolean {
  return (
    INDEXABLE_EXT_RE.test(path) &&
    !excludes.some((prefix) => path.startsWith(prefix)) &&
    !CONFLICT_SIDECAR_RE.test(path)
  );
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 增量 diff 结果（T2-5 切片 A；语义见 diffIndexSources） */
export interface IndexSourceDiff {
  /** 基线中存在、当前文件列表中已消失的路径（需清理派生数据） */
  removedPaths: string[];
  /** 新增或内容变更、需重新解析的文件 */
  changed: IndexSourceFile[];
  /** 内容未变、仅需刷新 mtime 记录的文件（不触碰派生数据） */
  touchedFiles: IndexFileRow[];
  /** 直接复用的文件数（= 文件总数 - changed；含快速跳过、touch 与读取失败保留旧记录） */
  reusedFiles: number;
}

/**
 * 增量 diff（T2-5 切片 A 引入；T2-11 切片 B 下沉 utilityProcess 后主进程与 worker 共用同一实现）：
 * 与 file_index 基线逐文件比对，把"当前文件列表"分成 changed / touched / removed 三类。
 *
 * racy 防护：mtime+size 快速跳过仅在 mtime **早于**上次索引写入（builtAt）时可信——
 * mtime 与索引写入同刻或更晚时，无法排除"与索引写入并发发生的同刻改写（mtime 未变）"，
 * 此时退回 hash 确认（借鉴 Git index 的 racy timestamp 处理）。
 *
 * 读取失败的文件保留旧记录（不计入 changed / touched，下次增量再试），不阻断整体。
 * 注：`files` 应为已按 isIndexablePath 过滤的列表（与收集侧同口径）。
 */
export async function diffIndexSources(
  files: IndexSourceFile[],
  prev: IndexFileRow[],
  builtAt: string,
  readText: (path: string) => Promise<string>,
): Promise<IndexSourceDiff> {
  const prevMap = new Map(prev.map((row) => [row.path, row]));
  const currentPaths = new Set(files.map((file) => file.path));
  const removedPaths = [...prevMap.keys()].filter((path) => !currentPaths.has(path));
  const changed: IndexSourceFile[] = [];
  const touchedFiles: IndexFileRow[] = [];

  for (const file of files) {
    const old = prevMap.get(file.path);
    if (!old) {
      changed.push(file);
      continue;
    }
    if (
      old.mtime &&
      file.mtime &&
      old.mtime === file.mtime &&
      old.bytes === file.size &&
      old.mtime < builtAt
    ) {
      continue;
    }
    let text: string;
    try {
      text = await readText(file.path);
    } catch {
      continue; // 读取失败：保留旧记录（下次增量再试），不阻断整体
    }
    const hash = sha256(text);
    if (hash === old.hash) {
      touchedFiles.push({ path: file.path, ...(file.mtime ? { mtime: file.mtime } : {}), hash, bytes: file.size });
      continue;
    }
    changed.push(file);
  }

  return { removedPaths, changed, touchedFiles, reusedFiles: files.length - changed.length };
}

/** 按段落聚合切块：保留字符区间（M3 事实级记忆定位用） */
export function chunkText(
  text: string,
  size = 400,
): { start: number; end: number; text: string }[] {
  const normalized = text.replace(/\r\n/g, "\n");
  const chunks: { start: number; end: number; text: string }[] = [];
  if (normalized.trim() === "") return chunks;

  const paragraphRe = /[^\n]*(?:\n|$)/g;
  let bufferStart = -1;
  let bufferEnd = -1;

  const flush = () => {
    if (bufferStart < 0) return;
    const slice = normalized.slice(bufferStart, bufferEnd);
    if (slice.trim() !== "") {
      chunks.push({ start: bufferStart, end: bufferEnd, text: slice.trim() });
    }
    bufferStart = -1;
    bufferEnd = -1;
  };

  for (const match of normalized.matchAll(paragraphRe)) {
    const line = match[0];
    if (line === "") continue;
    const lineStart = match.index ?? 0;
    const lineEnd = lineStart + line.length;

    // 超长单段（无换行）：硬切
    if (bufferStart < 0 && line.length > size * 2) {
      let cursor = lineStart;
      while (cursor < lineEnd) {
        const end = Math.min(cursor + size, lineEnd);
        const slice = normalized.slice(cursor, end);
        if (slice.trim() !== "") chunks.push({ start: cursor, end, text: slice.trim() });
        cursor = end;
      }
      continue;
    }

    if (bufferStart < 0) {
      bufferStart = lineStart;
      bufferEnd = lineEnd;
      continue;
    }
    if (lineEnd - bufferStart > size) {
      flush();
      bufferStart = lineStart;
      bufferEnd = lineEnd;
    } else {
      bufferEnd = lineEnd;
    }
  }
  flush();
  return chunks;
}

function chunkId(path: string, index: number): string {
  return `chk-${sha256(path).slice(0, 8)}-${String(index + 1).padStart(3, "0")}`;
}

/** 实体名/别名在块文本中的提及（M2 会升级为别名触发与消歧） */
function mentions(text: string, names: { name: string; aliases: string[] }[]): string[] {
  const found: string[] = [];
  for (const entity of names) {
    const candidates = [entity.name, ...entity.aliases].filter((item) => item.trim() !== "");
    if (candidates.some((item) => text.includes(item))) found.push(entity.name);
  }
  return found;
}

interface CardDetail {
  id: string;
  type: string;
  layer: string;
  name: string;
  aliases: string[];
  visibility: string;
  filePath: string;
  refs: { relation: string; target: string }[];
  body: string;
}

/**
 * 收集索引输入（纯读取；解析失败的单文件跳过并记入 skipped，不阻断整体重建）。
 */
export async function collectIndexInput(
  reader: IndexSourceReader,
  options: CollectIndexOptions = {},
): Promise<IndexInput & { skipped: { path: string; error: string }[] }> {
  const chunkSize = options.chunkSize ?? 400;
  const excludes = options.excludePrefixes ?? DEFAULT_INDEX_EXCLUDES;
  const files: IndexFileRow[] = [];
  const entities: IndexEntityRow[] = [];
  const refs: IndexRefRow[] = [];
  const chunks: IndexChunkRow[] = [];
  const skipped: { path: string; error: string }[] = [];

  const list = (await reader.listFiles())
    .filter((file) => isIndexablePath(file.path, excludes))
    .sort((a, b) => a.path.localeCompare(b.path));

  const texts = new Map<string, string>();
  for (const file of list) {
    try {
      const text = await reader.readText(file.path);
      texts.set(file.path, text);
      files.push({
        path: file.path,
        ...(file.mtime ? { mtime: file.mtime } : {}),
        hash: sha256(text),
        bytes: file.size,
      });
    } catch (err) {
      skipped.push({ path: file.path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 1) 设定卡 → 实体 + 引用 + 正文块
  const cards: CardDetail[] = [];
  for (const [path, text] of texts) {
    if (!path.startsWith("world/cards/")) continue;
    try {
      const { card, body } = readCardFile(text);
      cards.push({
        id: card.id,
        type: card.type,
        layer: card.layer,
        name: card.name,
        aliases: card.aliases,
        visibility: card.visibility,
        filePath: path,
        refs: card.refs.map((ref) => ({ relation: ref.relation, target: ref.target })),
        body,
      });
    } catch (err) {
      skipped.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const card of cards) {
    entities.push({
      id: card.id,
      type: card.type,
      layer: card.layer,
      name: card.name,
      aliases: card.aliases,
      visibility: card.visibility,
      filePath: card.filePath,
    });
    for (const ref of card.refs) {
      refs.push({ referrer: card.id, relation: ref.relation, target: ref.target });
    }
  }

  const cardNames = cards.map((card) => ({ name: card.name, aliases: card.aliases }));
  let chunkSeq = 0;
  const pushChunks = (
    path: string,
    body: string,
    meta: { kind: string; chapterId?: string; volume?: string },
  ) => {
    for (const piece of chunkText(body, chunkSize)) {
      chunks.push({
        id: chunkId(path, chunkSeq++),
        path,
        ...(meta.chapterId ? { chapterId: meta.chapterId } : {}),
        ...(meta.volume ? { volume: meta.volume } : {}),
        kind: meta.kind,
        text: piece.text,
        charStart: piece.start,
        charEnd: piece.end,
        textHash: sha256(piece.text),
        entities: mentions(piece.text, cardNames),
      });
    }
  };

  for (const card of cards) {
    pushChunks(card.filePath, card.body, { kind: "card" });
  }

  // 2) 章节正文 → 分块（带 chapterId / volume）
  for (const [path, text] of texts) {
    if (!path.startsWith("chapters/")) continue;
    const segments = path.split("/");
    const volume = segments[1] ?? "";
    try {
      const { chapter, body } = readChapterFile(text);
      pushChunks(path, body, { kind: "chapter", chapterId: chapter.id, volume });
    } catch (err) {
      skipped.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // 3) 大纲 → 整文件单块（可按章纲检索）
  for (const [path, text] of texts) {
    if (path !== "outline/outline.yaml") continue;
    try {
      parseOutline(text);
      chunks.push({
        id: chunkId(path, 0),
        path,
        kind: "outline",
        text,
        charStart: 0,
        charEnd: text.length,
        textHash: sha256(text),
        entities: mentions(text, cardNames),
      });
    } catch (err) {
      skipped.push({ path, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { files, entities, refs, chunks, skipped };
}