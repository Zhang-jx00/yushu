import { existsSync } from "node:fs";
import { join } from "node:path";
import { YushuError } from "@yushu/core";
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
import { INDEX_DIR, collectIndexInput, type IndexSourceReader } from "@yushu/world-engine";
import type { IndexRebuildResultPayload, IndexSearchResultPayload, IndexStatusPayload } from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";

/**
 * 桌面端索引操作（T1-21）：
 * - 数据源适配器：一切读取走 FileGateway（路径防护与遍历口径统一）；
 * - 重建：世界引擎收集 → @yushu/search 全量重建（可反复执行、删库可重建）；
 * - 检索：全文块（FTS5）+ 实体（名称/别名）。
 * 索引库位于 `.yushu/index.db`（真源永不进 SQLite；增量索引留待 M2）。
 */

export const INDEX_DB_RELATIVE = `${INDEX_DIR}/index.db`;

function resolveDbPath(gateway: ProjectGateway): string {
  return join(gateway.root, ".yushu", "index.db");
}

/** 主进程数据源适配器（与 CLI 的 fs 适配器同构） */
export function gatewayReader(gateway: ProjectGateway): IndexSourceReader {
  return {
    listFiles: async () =>
      (await gateway.listTree())
        .filter((entry) => entry.type === "file")
        .map((entry) => ({ path: entry.path, size: entry.size ?? 0 })),
    readText: async (path) => (await gateway.readDoc(path)).content,
  };
}

function toStatusPayload(stats: IndexStats | null): IndexStatusPayload {
  return {
    path: INDEX_DB_RELATIVE,
    exists: stats !== null,
    stats,
    schemaVersion: INDEX_SCHEMA_VERSION,
  };
}

/** 索引状态（未构建时 exists=false） */
export async function readIndexStatus(gateway: ProjectGateway): Promise<IndexStatusPayload> {
  const dbPath = resolveDbPath(gateway);
  if (!existsSync(dbPath)) return toStatusPayload(null);
  const db = openIndex(dbPath);
  try {
    const stats = readStats(db);
    return { ...toStatusPayload(stats), exists: true };
  } finally {
    closeIndex(db);
  }
}

/** 全量重建（幂等；删除 .yushu/index.db 后可重跑——零丢失） */
export async function rebuildProjectIndex(gateway: ProjectGateway): Promise<IndexRebuildResultPayload> {
  const input = await collectIndexInput(gatewayReader(gateway));
  const dbPath = resolveDbPath(gateway);
  const db = openIndex(dbPath);
  try {
    const stats = rebuildIndex(db, input);
    return { path: INDEX_DB_RELATIVE, exists: true, stats, schemaVersion: INDEX_SCHEMA_VERSION, skipped: input.skipped };
  } finally {
    closeIndex(db);
  }
}

/** 检索（全文块 + 实体）；索引缺失时给出可操作错误 */
export async function searchProjectIndex(
  gateway: ProjectGateway,
  keyword: string,
  limit = 20,
): Promise<IndexSearchResultPayload> {
  const dbPath = resolveDbPath(gateway);
  if (!existsSync(dbPath)) {
    throw new YushuError("E_INDEX_MISSING", "索引尚未构建：请先点击「重建索引」");
  }
  const db = openIndex(dbPath);
  try {
    const chunks: ChunkHit[] = queryChunks(db, keyword, limit);
    const entities: EntityHit[] = lookupEntities(db, keyword, limit);
    return { keyword, chunks, entities };
  } finally {
    closeIndex(db);
  }
}