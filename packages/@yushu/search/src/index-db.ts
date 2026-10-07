import { existsSync, mkdirSync, promises as fs } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { YushuError } from "@yushu/core";
import type {
  ChunkHit,
  EntityHit,
  IndexChunkRow,
  IndexEntityRow,
  IndexFileRow,
  IndexInput,
  IndexRefRow,
  IndexStats,
} from "./types.js";
import { embedText, vecToBlob } from "./vector.js";

/**
 * 索引库（docs/03 §6）：真源永不进 SQLite——所有表都是文件派生的可重建数据。
 * - 位置：`.yushu/index.db`（排除于 Git 与网盘，WAL 不支持网络文件系统）；
 * - FTS5 external content（content='chunks'），全量重建走官方
 *   `INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`（K03/K09）；
 * - 分词：M1 使用内置 unicode61（CJK 可按词/短语命中）；
 *   M2 换 wangfenjin/simple（中文分词 + 拼音，docs/03 §1.3）；
 * - 增量索引（保存即更新）留待 M2；M1 只交付全量 rebuild。
 * - **schema v2（T3-8）**：新增 `chunk_vectors`（正文块向量，RAG 向量路）——与正文块同事务写入；
 *   旧库（v1）经 `ensureChunkVectors` 在首个 RAG 查询时惰性补齐，无需全量重建。
 */

export const INDEX_SCHEMA_VERSION = 2;

export class IndexError extends YushuError {
  constructor(message: string, options?: ErrorOptions) {
    super("E_INDEX", message, options);
  }
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS index_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS file_index(
  path TEXT PRIMARY KEY, mtime TEXT, hash TEXT NOT NULL, bytes INTEGER, indexed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entities(
  id TEXT PRIMARY KEY, type TEXT, layer TEXT, name TEXT, aliases TEXT,
  visibility TEXT, file_path TEXT
);
CREATE TABLE IF NOT EXISTS refs(referrer TEXT, relation TEXT, target TEXT);
CREATE TABLE IF NOT EXISTS chunks(
  id TEXT PRIMARY KEY,
  path TEXT,
  chapter_id TEXT,
  volume TEXT,
  kind TEXT,
  text TEXT,
  text_fts TEXT,
  char_start INT,
  char_end INT,
  text_hash TEXT,
  entities TEXT,
  tokens INT
);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text_fts, entities UNINDEXED,
  content='chunks', content_rowid='rowid', tokenize='unicode61'
);
CREATE TABLE IF NOT EXISTS chunk_vectors(
  chunk_id TEXT PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_refs_target ON refs(target);
CREATE INDEX IF NOT EXISTS idx_chunks_chapter ON chunks(chapter_id);
`;

/**
 * FTS 索引文本预处理（M1 中文方案）：
 * unicode61 会把无空格中文整句当作单个 token，导致"林渊"查不到"林渊拔剑而起"。
 * 预处理为 CJK 逐字插空（unigram），查询侧同规则并以短语匹配 → 中文可命中；
 * M2 替换为 wangfenjin/simple 分词扩展后本函数退场（docs/03 §1.3）。
 */
function toFtsText(text: string): string {
  return text
    .replace(/([\u3400-\u9fff\uf900-\ufaff])/g, " $1 ")
    .replace(/\s+/g, " ")
    .trim();
}

/** snippet 还原：去掉"汉字 空格 汉字"中的人为分隔（保留【】高亮标记） */
export function unspaceCjk(snippet: string): string {
  return snippet.replace(/([\u3400-\u9fff\uf900-\ufaff]) (?=[\u3400-\u9fff\uf900-\ufaff])/g, "$1");
}

/** 查询串 → FTS5 表达式：按空格切词，剔除法操作符字符，每词内 CJK 逐字插空并以短语包裹（AND 语义） */
export function buildMatchQuery(query: string): string {
  return query
    .trim()
    .split(/\s+/)
    .map((word) => toFtsText(word).replace(/["*()^:]/g, "").trim())
    .filter(Boolean)
    .map((part) => `"${part}"`)
    .join(" ");
}

function count(row: Record<string, unknown> | undefined): number {
  const value = row?.["c"];
  return typeof value === "number" ? value : 0;
}

/**
 * 索引行 → ChunkHit（queryChunks / queryChunksBm25 共用同一映射，避免两处口径漂移）。
 * `snippetCleaner` 为 snippet 还原函数（缺省原样返回——非 FTS 路径取出的行没有高亮标记）。
 */
export function chunkHitFromRow(
  row: Record<string, unknown>,
  snippetCleaner: (snippet: string) => string = (snippet) => snippet,
): ChunkHit {
  return {
    chunkId: String(row["chunk_id"]),
    path: String(row["path"] ?? ""),
    kind: String(row["kind"] ?? ""),
    ...(row["chapter_id"] ? { chapterId: String(row["chapter_id"]) } : {}),
    ...(row["volume"] ? { volume: String(row["volume"]) } : {}),
    charStart: Number(row["char_start"] ?? 0),
    charEnd: Number(row["char_end"] ?? 0),
    textHash: String(row["text_hash"] ?? ""),
    entities: String(row["entities"] ?? "")
      .split("、")
      .filter(Boolean),
    snippet: snippetCleaner(String(row["snip"] ?? "")),
  };
}

/** 打开（必要时创建）索引库并确保 schema 就绪。
 * `allowExtension`（node:sqlite ≥ 22.13/23.5 支持）为 T3-8 的 sqlite-vec 扩展加载所必需；
 * 旧运行时忽略 / 拒绝该选项时回退默认构造——向量路自动降级为本地余弦兜底（功能不阻断）。 */
export function openIndex(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath, { allowExtension: true });
  } catch {
    db = new DatabaseSync(dbPath);
  }
  db.exec("PRAGMA journal_mode = WAL;");
  // 并发写健壮性（T2-5 切片 B）：后台自动增量与用户手动重建可能并发，
  // node:sqlite 默认 busy 超时为 0（锁冲突立即失败）——给 3s 重试窗口，避免无谓报错。
  db.exec("PRAGMA busy_timeout = 3000;");
  try {
    db.exec(SCHEMA_SQL);
  } catch (err) {
    db.close();
    throw new IndexError(`索引 schema 初始化失败：${dbPath}`, { cause: err });
  }
  return db;
}

function metaGet(db: DatabaseSync, key: string): string | null {
  const row = db.prepare("SELECT value FROM index_meta WHERE key = ?").get(key) as
    | { value?: string }
    | undefined;
  return typeof row?.value === "string" ? row.value : null;
}

function metaSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare(
    "INSERT INTO index_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** 触发词数粗估：CJK 字符 + 连续 ASCII 词（M1 用字符口径，M3 换 tokenizer 实测） */
export function estimateTokens(text: string): number {
  const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) ?? []).length;
  const asciiWords = (text.match(/[A-Za-z0-9]+/g) ?? []).length;
  return cjk + asciiWords;
}

/* ---------- 分片写入与进度（M2 / T2-5 切片 B） ---------- */

/** 重建进度事件（分片写入 / FTS 段合并的可观测口径；phase 含义见 rebuildIndex 注释） */
export interface RebuildProgress {
  /** files = 文件 / 实体 / 引用表；chunks = 正文块 + FTS 行级写入（每批一次）；merge = FTS 段合并 */
  phase: "files" | "chunks" | "merge";
  done: number;
  total: number;
  /** 当前批次末条记录所属文件（展示用，可空） */
  currentPath?: string;
}

export interface RebuildOptions {
  onProgress?: (progress: RebuildProgress) => void;
  /** 每批写入的正文块数（分片粒度；默认 128） */
  batchSize?: number;
}

/** 全文重建的默认分片粒度（正文块/批）：控制单次 FTS 写入事务内的段规模 */
export const DEFAULT_REBUILD_BATCH = 128;

/** 写入派生数据（全量重建与增量更新共用；调用方负责事务与旧数据清理）。
 * - 默认（增量路径）：仅写内容表，FTS 同步由调用方行级 delete/insert 完成；
 * - withFts = true（全量重建路径）：正文块与 FTS 行成批写入（分片），并回调进度；
 * - 返回本轮写入的正文块批次数（分片数，供回执展示）。 */
function insertRows(
  db: DatabaseSync,
  input: Pick<IndexInput, "files" | "entities" | "refs" | "chunks">,
  builtAt: string,
  hooks: { onProgress?: (progress: RebuildProgress) => void; batchSize?: number; withFts?: boolean } = {},
): number {
  const { onProgress, withFts = false } = hooks;
  const batchSize = Math.max(1, Math.floor(hooks.batchSize ?? DEFAULT_REBUILD_BATCH));
  const insertFile = db.prepare(
    "INSERT INTO file_index(path, mtime, hash, bytes, indexed_at) VALUES (?, ?, ?, ?, ?)",
  );
  let fileDone = 0;
  for (const file of input.files) {
    insertFile.run(file.path, file.mtime ?? null, file.hash, file.bytes, builtAt);
    fileDone += 1;
    if (onProgress && withFts && (fileDone % batchSize === 0 || fileDone === input.files.length)) {
      onProgress({ phase: "files", done: fileDone, total: input.files.length });
    }
  }
  if (onProgress && withFts && input.files.length === 0) {
    onProgress({ phase: "files", done: 0, total: 0 });
  }

  const insertEntity = db.prepare(
    "INSERT INTO entities(id, type, layer, name, aliases, visibility, file_path) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const entity of input.entities) {
    insertEntity.run(
      entity.id,
      entity.type,
      entity.layer,
      entity.name,
      entity.aliases.join("、"),
      entity.visibility,
      entity.filePath,
    );
  }

  const insertRef = db.prepare("INSERT INTO refs(referrer, relation, target) VALUES (?, ?, ?)");
  for (const ref of input.refs) {
    insertRef.run(ref.referrer, ref.relation, ref.target);
  }

  const insertChunk = db.prepare(
    `INSERT INTO chunks(id, path, chapter_id, volume, kind, text, text_fts, char_start, char_end, text_hash, entities, tokens)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertVector = db.prepare("INSERT OR REPLACE INTO chunk_vectors(chunk_id, dim, vec) VALUES (?, ?, ?)");
  const insertChunkFts = withFts
    ? db.prepare("INSERT INTO chunks_fts(rowid, text_fts, entities) VALUES (?, ?, ?)")
    : null;

  let shards = 0;
  const total = input.chunks.length;
  for (let offset = 0; offset < total; offset += batchSize) {
    const batch = input.chunks.slice(offset, offset + batchSize);
    for (const chunk of batch) {
      const result = insertChunk.run(
        chunk.id,
        chunk.path,
        chunk.chapterId ?? null,
        chunk.volume ?? null,
        chunk.kind,
        chunk.text,
        toFtsText(chunk.text),
        chunk.charStart,
        chunk.charEnd,
        chunk.textHash,
        chunk.entities.join("、"),
        estimateTokens(chunk.text),
      );
      // 向量与正文块同批写入（T3-8；派生数据，RAG 向量路数据源）
      const vector = embedText(chunk.text);
      insertVector.run(chunk.id, vector.length, vecToBlob(vector));
      // 分片路径：正文行与 FTS 行同批写入（external content 保持一致；旧索引已由 delete-all 清空）
      if (insertChunkFts) {
        insertChunkFts.run(result.lastInsertRowid, toFtsText(chunk.text), chunk.entities.join("、"));
      }
    }
    shards += 1;
    if (onProgress && withFts) {
      const last = batch[batch.length - 1]!;
      onProgress({
        phase: "chunks",
        done: Math.min(offset + batchSize, total),
        total,
        currentPath: last.path,
      });
    }
  }
  return shards;
}

/**
 * 全量重建：清空派生表 → 清空 FTS 索引段 → 分片写入（正文块 + FTS 行同批）→ 段合并（幂等，可反复执行）。
 * T2-5 切片 B：以行级分片写入替代一次性 `('rebuild')` 全库扫描——每批 batchSize 块（默认 128），
 * 批间回调进度（files → chunks → merge，`chunks` 事件数即分片数）；结束用官方 `('merge', 500)`
 * 把写入段合并到 500 页粒度（K09：控制段数量，兼顾查询性能与合并耗时）。`('delete-all')` 清空
 * 外部内容表的索引段，保证旧内容不残留（删除 content 行不会自动清 FTS 索引，不先清会导致索引与内容不一致）。
 */
export function rebuildIndex(
  db: DatabaseSync,
  input: IndexInput,
  builtAt = new Date().toISOString(),
  options: RebuildOptions = {},
): IndexStats {
  const { onProgress, batchSize } = options;
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM chunks; DELETE FROM entities; DELETE FROM refs; DELETE FROM file_index; DELETE FROM chunk_vectors;");
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('delete-all');");
    insertRows(db, input, builtAt, { onProgress, batchSize, withFts: true });
    // FTS5 特殊命令带参数时经 rank 列传入（与 checkIntegrity 的 integrity-check 同款语法）
    db.exec("INSERT INTO chunks_fts(chunks_fts, rank) VALUES('merge', 500);");
    onProgress?.({ phase: "merge", done: 1, total: 1 });
    metaSet(db, "schema_version", String(INDEX_SCHEMA_VERSION));
    metaSet(db, "built_at", builtAt);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw new IndexError("索引重建失败（已回滚，原索引保持不变）", { cause: err });
  }
  const stats = readStats(db);
  if (!stats) throw new IndexError("索引重建后读取统计失败");
  return stats;
}

/**
 * FTS 真实索引行数（T2-5 复核修正）：`count(*) FROM chunks_fts` 走 external content 的
 * content 表，恒等于 chunks，无法暴露"索引缺行"；FTS5 影子表 `chunks_fts_docsize`
 * 每个已索引文档一行，可作为真实对齐指标（与 chunks 不等即缺行 / 滞后）。
 * 影子表不可用（未来 SQLite 变更）时回退 content 表口径，仅降级不报错。
 */
function countFtsIndexRows(db: DatabaseSync): number {
  try {
    return count(db.prepare("SELECT count(*) AS c FROM chunks_fts_docsize").get() as Record<string, unknown>);
  } catch {
    return count(db.prepare("SELECT count(*) AS c FROM chunks_fts").get() as Record<string, unknown>);
  }
}

/** 读取统计（未初始化时返回 null） */
export function readStats(db: DatabaseSync): IndexStats | null {
  const builtAt = metaGet(db, "built_at");
  if (!builtAt) return null;
  const schemaVersion = Number.parseInt(metaGet(db, "schema_version") ?? "0", 10);
  return {
    schemaVersion: Number.isNaN(schemaVersion) ? 0 : schemaVersion,
    builtAt,
    files: count(db.prepare("SELECT count(*) AS c FROM file_index").get() as Record<string, unknown>),
    entities: count(db.prepare("SELECT count(*) AS c FROM entities").get() as Record<string, unknown>),
    refs: count(db.prepare("SELECT count(*) AS c FROM refs").get() as Record<string, unknown>),
    chunks: count(db.prepare("SELECT count(*) AS c FROM chunks").get() as Record<string, unknown>),
    ftsRows: countFtsIndexRows(db),
  };
}

/** 全文检索（FTS5 + snippet 高亮）；中文按 CJK unigram 短语匹配（见 toFtsText） */
export function queryChunks(db: DatabaseSync, query: string, limit = 20): ChunkHit[] {
  if (query.trim() === "") return [];
  const match = buildMatchQuery(query);
  if (match === "") return [];
  const rows = db
    .prepare(
      `SELECT c.id AS chunk_id, c.path, c.kind, c.chapter_id, c.volume, c.char_start, c.char_end,
              c.text_hash, c.entities,
              snippet(chunks_fts, 0, '【', '】', '…', 12) AS snip
       FROM chunks_fts
       JOIN chunks c ON c.rowid = chunks_fts.rowid
       WHERE chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(match, limit) as Record<string, unknown>[];

  return rows.map((row) => chunkHitFromRow(row, unspaceCjk));
}

/** 实体检索（名称 / 别名包含匹配；M1 用 LIKE，M3 换别名触发索引） */
export function lookupEntities(db: DatabaseSync, keyword: string, limit = 20): EntityHit[] {
  const needle = `%${keyword.trim()}%`;
  if (keyword.trim() === "") return [];
  const rows = db
    .prepare(
      `SELECT id, type, layer, name, aliases, file_path FROM entities
       WHERE name LIKE ? OR aliases LIKE ?
       ORDER BY name LIMIT ?`,
    )
    .all(needle, needle, limit) as Record<string, unknown>[];
  return rows.map((row) => ({
    id: String(row["id"]),
    type: String(row["type"] ?? ""),
    layer: String(row["layer"] ?? ""),
    name: String(row["name"] ?? ""),
    aliases: String(row["aliases"] ?? "")
      .split("、")
      .filter(Boolean),
    filePath: String(row["file_path"] ?? ""),
  }));
}

/* ---------- 增量更新与完整性自愈（M2 / T2-5 切片 A） ---------- */

/** 增量输入：与 IndexInput 同形，语义为"差异"（只含变更 / 移除文件） */
export interface IndexDelta {
  /** 已从真源删除的文件路径（清空其全部派生数据） */
  removedPaths: string[];
  /** 内容变更或新增的文件（先清旧数据再写入） */
  files: IndexFileRow[];
  /** 内容未变、仅刷新 mtime/indexed_at 的文件（不触碰派生数据） */
  touchedFiles: IndexFileRow[];
  entities: IndexEntityRow[];
  refs: IndexRefRow[];
  chunks: IndexChunkRow[];
}

/** 读取 file_index（增量 diff 基线） */
export function readFileIndex(db: DatabaseSync): IndexFileRow[] {
  const rows = db.prepare("SELECT path, mtime, hash, bytes FROM file_index").all() as Record<string, unknown>[];
  return rows.map((row) => ({
    path: String(row["path"] ?? ""),
    ...(typeof row["mtime"] === "string" && row["mtime"] ? { mtime: row["mtime"] } : {}),
    hash: String(row["hash"] ?? ""),
    bytes: Number(row["bytes"] ?? 0),
  }));
}

/**
 * 完整性校验（T2-5 自愈前置）：PRAGMA integrity_check + FTS5 完整检查（rank=1）。
 * 注：external content 表的 `count(*)` 走 content 表，无法用于「索引缺行」判定；
 * FTS5 的 `('integrity-check', 1)` 才会连同 external content 一起校验（缺行即抛错）。
 * 失败时调用方应放弃增量、回退全量重建（K09：索引损坏不得阻断日更）。
 */
export function checkIntegrity(db: DatabaseSync): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Record<string, unknown>[];
    for (const row of rows) {
      const value = String(Object.values(row)[0] ?? "");
      if (value !== "" && value !== "ok") issues.push(`integrity_check：${value}`);
    }
  } catch (err) {
    issues.push(`integrity_check 执行失败：${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    db.exec("INSERT INTO chunks_fts(chunks_fts, rank) VALUES('integrity-check', 1);");
  } catch (err) {
    issues.push(`FTS integrity-check 失败：${err instanceof Error ? err.message : String(err)}`);
  }
  return { ok: issues.length === 0, issues };
}

/**
 * 增量应用（T2-5）：按文件清理旧派生数据 → 写入变更数据 → FTS5 **行级** delete/insert 同步。
 * 不用全库 `rebuild`（大库为 O(全量)）；external content 表的行级命令要求提供与索引一致的旧值，
 * 这里从 chunks 表（持久化的 text_fts/entities）取值，保证与 FTS 索引一致。
 */
export function applyIndexDelta(
  db: DatabaseSync,
  delta: IndexDelta,
  builtAt = new Date().toISOString(),
): IndexStats {
  const changedPaths = [...delta.removedPaths, ...delta.files.map((file) => file.path)];
  const ftsDelete = db.prepare(
    "INSERT INTO chunks_fts(chunks_fts, rowid, text_fts, entities) SELECT 'delete', rowid, text_fts, entities FROM chunks WHERE path = ?",
  );
  const ftsInsert = db.prepare(
    "INSERT INTO chunks_fts(rowid, text_fts, entities) SELECT rowid, text_fts, entities FROM chunks WHERE path = ?",
  );
  const entityIdsOf = db.prepare("SELECT id FROM entities WHERE file_path = ?");
  const deleteRefs = db.prepare("DELETE FROM refs WHERE referrer = ?");
  const deleteEntities = db.prepare("DELETE FROM entities WHERE file_path = ?");
  const deleteChunks = db.prepare("DELETE FROM chunks WHERE path = ?");
  const deleteVectors = db.prepare(
    "DELETE FROM chunk_vectors WHERE chunk_id IN (SELECT id FROM chunks WHERE path = ?)",
  );
  const deleteFileRow = db.prepare("DELETE FROM file_index WHERE path = ?");
  const touchFileRow = db.prepare("UPDATE file_index SET mtime = ?, indexed_at = ? WHERE path = ?");

  db.exec("BEGIN");
  try {
    for (const path of changedPaths) {
      ftsDelete.run(path);
      deleteVectors.run(path); // 向量先于正文块删除（子查询依赖 chunks 行）
      deleteChunks.run(path);
      const ids = (entityIdsOf.all(path) as Record<string, unknown>[]).map((row) => String(row["id"] ?? ""));
      for (const id of ids) deleteRefs.run(id);
      deleteEntities.run(path);
      deleteFileRow.run(path);
    }
    for (const file of delta.touchedFiles) {
      touchFileRow.run(file.mtime ?? null, builtAt, file.path);
    }
    insertRows(db, delta, builtAt);
    for (const file of delta.files) {
      ftsInsert.run(file.path);
    }
    metaSet(db, "schema_version", String(INDEX_SCHEMA_VERSION));
    metaSet(db, "built_at", builtAt);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw new IndexError("索引增量更新失败（已回滚，原索引保持不变）", { cause: err });
  }
  const stats = readStats(db);
  if (!stats) throw new IndexError("索引增量更新后读取统计失败");
  return stats;
}

export function closeIndex(db: DatabaseSync): void {
  db.close();
}

/**
 * 删除索引文件（index.db / -wal / -shm）——"删索引零丢失"实测与用户手动清理共用。
 * WAL 模式在 Windows 上句柄释放有延迟：先切回 rollback journal（合并并回收 -wal/-shm），
 * 再删除并对 EBUSY 做有限重试。
 */
export async function removeIndexFiles(dbPath: string): Promise<void> {
  if (existsSync(dbPath)) {
    try {
      const db = new DatabaseSync(dbPath);
      db.exec("PRAGMA journal_mode = DELETE;");
      db.close();
    } catch {
      // 打不开也继续尝试删除（可能已是残留文件）
    }
  }
  for (const target of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.rm(target, { force: true });
        break;
      } catch (err) {
        if (attempt === 4) {
          throw new IndexError(`删除索引文件失败：${target}`, { cause: err });
        }
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
    }
  }
}