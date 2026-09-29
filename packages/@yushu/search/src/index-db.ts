import { existsSync, mkdirSync, promises as fs } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { YushuError } from "@yushu/core";
import type { ChunkHit, EntityHit, IndexInput, IndexStats } from "./types.js";

/**
 * 索引库（docs/03 §6）：真源永不进 SQLite——所有表都是文件派生的可重建数据。
 * - 位置：`.yushu/index.db`（排除于 Git 与网盘，WAL 不支持网络文件系统）；
 * - FTS5 external content（content='chunks'），全量重建走官方
 *   `INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')`（K03/K09）；
 * - 分词：M1 使用内置 unicode61（CJK 可按词/短语命中）；
 *   M2 换 wangfenjin/simple（中文分词 + 拼音，docs/03 §1.3）；
 * - 增量索引（保存即更新）留待 M2；M1 只交付全量 rebuild。
 */

export const INDEX_SCHEMA_VERSION = 1;

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
function unspaceCjk(snippet: string): string {
  return snippet.replace(/([\u3400-\u9fff\uf900-\ufaff]) (?=[\u3400-\u9fff\uf900-\ufaff])/g, "$1");
}

/** 查询串 → FTS5 表达式：按空格切词，剔除法操作符字符，每词内 CJK 逐字插空并以短语包裹（AND 语义） */
function buildMatchQuery(query: string): string {
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

/** 打开（必要时创建）索引库并确保 schema 就绪 */
export function openIndex(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
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

/** 全量重建：清空派生表 → 写入输入 → FTS5 external content 重建（幂等，可反复执行） */
export function rebuildIndex(db: DatabaseSync, input: IndexInput, builtAt = new Date().toISOString()): IndexStats {
  db.exec("BEGIN");
  try {
    db.exec("DELETE FROM chunks; DELETE FROM entities; DELETE FROM refs; DELETE FROM file_index;");

    const insertFile = db.prepare(
      "INSERT INTO file_index(path, mtime, hash, bytes, indexed_at) VALUES (?, ?, ?, ?, ?)",
    );
    for (const file of input.files) {
      insertFile.run(file.path, file.mtime ?? null, file.hash, file.bytes, builtAt);
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
    for (const chunk of input.chunks) {
      insertChunk.run(
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
    }

    // 官方全量重建命令（docs/03 §6：external content 可随时 rebuild）
    db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild');");
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
    ftsRows: count(db.prepare("SELECT count(*) AS c FROM chunks_fts").get() as Record<string, unknown>),
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

  return rows.map((row) => ({
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
    snippet: unspaceCjk(String(row["snip"] ?? "")),
  }));
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