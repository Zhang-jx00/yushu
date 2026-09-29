import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  INDEX_SCHEMA_VERSION,
  closeIndex,
  lookupEntities,
  openIndex,
  queryChunks,
  readStats,
  rebuildIndex,
  type ChunkHit,
  type EntityHit,
  type IndexStats,
} from "@yushu/search";
import { collectIndexInput, type IndexSourceReader } from "@yushu/world-engine";
import { createFsReader } from "./fs-reader.js";

/**
 * CLI 命令实现（T1-21）：无头索引重建 / 状态 / 检索。
 * 与桌面端共用 world-engine 的收集器与 @yushu/search 的引擎，保证两侧索引口径一致。
 */

export const INDEX_DB_RELATIVE = ".yushu/index.db";

export function indexDbPath(rootDir: string): string {
  return join(resolve(rootDir), ".yushu", "index.db");
}

export interface RebuildResult {
  dbPath: string;
  stats: IndexStats;
  skipped: { path: string; error: string }[];
}

/** 全量重建索引（删除索引库后可重跑——零丢失） */
export async function runRebuild(rootDir: string, reader?: IndexSourceReader): Promise<RebuildResult> {
  const dbPath = indexDbPath(rootDir);
  const input = await collectIndexInput(reader ?? createFsReader(rootDir));
  const db = openIndex(dbPath);
  try {
    const stats = rebuildIndex(db, input);
    return { dbPath, stats, skipped: input.skipped };
  } finally {
    closeIndex(db);
  }
}

export interface StatusResult {
  dbPath: string;
  exists: boolean;
  stats: IndexStats | null;
  schemaVersionExpected: number;
}

/** 索引状态（库不存在时 exists=false） */
export function runStatus(rootDir: string): StatusResult {
  const dbPath = indexDbPath(rootDir);
  if (!existsSync(dbPath)) {
    return { dbPath, exists: false, stats: null, schemaVersionExpected: INDEX_SCHEMA_VERSION };
  }
  const db = openIndex(dbPath);
  try {
    return {
      dbPath,
      exists: true,
      stats: readStats(db),
      schemaVersionExpected: INDEX_SCHEMA_VERSION,
    };
  } finally {
    closeIndex(db);
  }
}

export interface SearchResult {
  chunks: ChunkHit[];
  entities: EntityHit[];
}

/** 检索（全文块 + 实体） */
export function runSearch(rootDir: string, keyword: string, limit = 10): SearchResult {
  const dbPath = indexDbPath(rootDir);
  if (!existsSync(dbPath)) {
    throw new Error(`索引库不存在：${dbPath}（请先执行 rebuild）`);
  }
  const db = openIndex(dbPath);
  try {
    return { chunks: queryChunks(db, keyword, limit), entities: lookupEntities(db, keyword, limit) };
  } finally {
    closeIndex(db);
  }
}