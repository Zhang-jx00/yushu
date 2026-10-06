import { existsSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { YushuError } from "@yushu/core";
import {
  INDEX_SCHEMA_VERSION,
  applyIndexDelta,
  checkIntegrity,
  closeIndex,
  lookupEntities,
  openIndex,
  queryChunks,
  readFileIndex,
  readStats,
  rebuildIndex,
  type ChunkHit,
  type EntityHit,
  type IndexStats,
} from "@yushu/search";
import {
  INDEX_DIR,
  collectIndexInput,
  diffIndexSources,
  isIndexablePath,
  type IndexSourceFile,
  type IndexSourceReader,
} from "@yushu/world-engine";
import type {
  IndexProgressPayload,
  IndexRebuildResultPayload,
  IndexSearchResultPayload,
  IndexStatusPayload,
} from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";
import { collectInWorker, incrementalInWorker } from "./repo-worker.js";

/**
 * 桌面端索引操作（T1-21；T2-5 切片 A：增量与自愈）：
 * - 数据源适配器：一切读取走 FileGateway（路径防护与遍历口径统一）；
 * - 重建：全量（默认）或增量（mtime+size 快速跳过 → hash 确认 → 只解析变更文件）；
 * - 自愈：增量前做完整性校验，失败自动回退全量重建并回报问题项；
 * - 检索：全文块（FTS5）+ 实体（名称/别名）。
 * 索引库位于 `.yushu/index.db`（真源永不进 SQLite）。
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
        .map((entry) => ({
          path: entry.path,
          size: entry.size ?? 0,
          ...(entry.mtime ? { mtime: entry.mtime } : {}),
        })),
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

/**
 * 进度包装读取器（T2-5 切片 B）：统计"读取/解析真源文件"进度。
 * listFiles 时按与收集侧同口径（isIndexablePath）确定总数；readText 成功一次回调一次。
 * 注：incremental 场景中未变文件走快速跳过不读取，进度总数是"可索引文件数"的上限。
 */
function progressReader(
  reader: IndexSourceReader,
  onProgress?: (progress: IndexProgressPayload) => void,
): IndexSourceReader {
  let total = 0;
  let done = 0;
  return {
    listFiles: async () => {
      const files = await reader.listFiles();
      total = files.filter((file) => isIndexablePath(file.path)).length;
      return files;
    },
    readText: async (path) => {
      const text = await reader.readText(path);
      if (onProgress && isIndexablePath(path)) {
        done += 1;
        onProgress({ phase: "parse", done, total, currentPath: path });
      }
      return text;
    },
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

interface IncrementalOutcome {
  stats: IndexStats;
  skipped: { path: string; error: string }[];
  reusedFiles: number;
  updatedFiles: number;
  removedFiles: number;
}

/**
 * 增量重建（T2-5 切片 A；T2-11 切片 B 起为**回退路径**）：主进程内完成 diff + 定向解析。
 * 1. 与 file_index 逐文件比对：mtime 与大小都未变 → 直接复用（不读内容）；
 * 2. 疑似变化 → 读内容算 hash：相同则只刷新 mtime 记录（touch），不同才重新解析；
 * 3. 真源已删除的路径 → 从索引移除；变更文件定向走 collectIndexInput（wrapper reader）。
 *
 * diff 语义（含 racy 防护）已下沉 @yushu/world-engine 的 diffIndexSources，与 utilityProcess 共用。
 */
async function applyIncremental(
  reader: IndexSourceReader,
  files: IndexSourceFile[],
  db: DatabaseSync,
  builtAt: string,
): Promise<IncrementalOutcome> {
  const diff = await diffIndexSources(files, readFileIndex(db), builtAt, (path) => reader.readText(path));

  const scopedReader: IndexSourceReader = {
    listFiles: async () => diff.changed,
    readText: (path) => reader.readText(path),
  };
  const deltaInput = diff.changed.length > 0 ? await collectIndexInput(scopedReader) : null;
  const stats = applyIndexDelta(db, {
    removedPaths: diff.removedPaths,
    files: deltaInput?.files ?? [],
    touchedFiles: diff.touchedFiles,
    entities: deltaInput?.entities ?? [],
    refs: deltaInput?.refs ?? [],
    chunks: deltaInput?.chunks ?? [],
  });
  return {
    stats,
    skipped: deltaInput?.skipped ?? [],
    reusedFiles: diff.reusedFiles,
    updatedFiles: diff.changed.length,
    removedFiles: diff.removedPaths.length,
  };
}

/**
 * 增量重建（T2-11 切片 B）：diff 与定向解析整体下沉 utilityProcess（只读文件），
 * 主进程仅从索引库读基线（readFileIndex）并应用 delta 写库（写库独占不变，docs/04 §5.6）。
 */
async function applyIncrementalInWorker(
  gateway: ProjectGateway,
  files: IndexSourceFile[],
  db: DatabaseSync,
  builtAt: string,
  onProgress?: (progress: IndexProgressPayload) => void,
): Promise<IncrementalOutcome> {
  const prev = readFileIndex(db);
  const delta = await incrementalInWorker(
    gateway.root,
    files,
    prev,
    builtAt,
    (done, total, currentPath) => onProgress?.({ phase: "parse", done, total, currentPath }),
  );
  const stats = applyIndexDelta(db, {
    removedPaths: delta.removedPaths,
    files: delta.input?.files ?? [],
    touchedFiles: delta.touchedFiles,
    entities: delta.input?.entities ?? [],
    refs: delta.input?.refs ?? [],
    chunks: delta.input?.chunks ?? [],
  });
  return {
    stats,
    skipped: delta.input?.skipped ?? [],
    reusedFiles: delta.reusedFiles,
    updatedFiles: delta.updatedFiles,
    removedFiles: delta.removedFiles,
  };
}

export interface RebuildIndexOptions {
  /** true = 增量（复用未变文件）；索引缺失或完整性校验失败时自动回退全量 */
  incremental?: boolean;
  /** 进度回调（T2-5 切片 B）：parse = 读取真源；files / chunks / merge = 分片写入与段合并 */
  onProgress?: (progress: IndexProgressPayload) => void;
}

export async function rebuildProjectIndex(
  gateway: ProjectGateway,
  options: RebuildIndexOptions = {},
): Promise<IndexRebuildResultPayload> {
  // 全量重建（默认；幂等——删除 .yushu/index.db 后可重跑，零丢失）
  const reader = gatewayReader(gateway);
  const dbPath = resolveDbPath(gateway);
  const db = openIndex(dbPath);
  try {
    const existingStats = readStats(db);
    let integrityIssues: string[] = [];
    if (options.incremental && existingStats) {
      const integrity = checkIntegrity(db);
      if (integrity.ok) {
        // 增量 diff 与收集侧同口径过滤（导出产物 / 引擎目录 / 旁路文件不参与，避免"伪变更"）
        const files = (await reader.listFiles()).filter((file) => isIndexablePath(file.path));
        // T2-11 切片 B：diff 与定向解析优先走 utilityProcess（只读；写库仍由主进程独占）；
        // 不可用 / 超时 / 越界拒绝 → 回退主进程内增量（功能不受影响），回执注明解析进程
        let outcome: IncrementalOutcome;
        let parseVia: "utility" | "main" = "utility";
        try {
          outcome = await applyIncrementalInWorker(gateway, files, db, existingStats.builtAt, options.onProgress);
        } catch (err) {
          console.warn(
            `[index] utilityProcess 增量解析不可用，回退主进程：${err instanceof Error ? err.message : String(err)}`,
          );
          parseVia = "main";
          outcome = await applyIncremental(
            progressReader(reader, options.onProgress),
            files,
            db,
            existingStats.builtAt,
          );
        }
        return {
          path: INDEX_DB_RELATIVE,
          exists: true,
          stats: outcome.stats,
          schemaVersion: INDEX_SCHEMA_VERSION,
          skipped: outcome.skipped,
          mode: "incremental",
          reusedFiles: outcome.reusedFiles,
          updatedFiles: outcome.updatedFiles,
          removedFiles: outcome.removedFiles,
          integrityIssues: [],
          shards: 0,
          parseVia,
        };
      }
      // 自愈（T2-5）：索引损坏 → 放弃增量，回退全量重建（问题项回报给 UI）
      integrityIssues = integrity.issues;
    }
    // 全量：解析与写入两段均回报进度；chunks 事件数即分片批次数（与写入循环同源）
    let shards = 0;
    const onProgress = options.onProgress;
    const forward = (progress: IndexProgressPayload) => {
      if (progress.phase === "chunks") shards += 1;
      onProgress?.(progress);
    };
    // T2-11 切片 A：全量解析优先走 utilityProcess（只读解析；索引库写入仍由主进程独占）；
    // 不可用 / 超时 / 越界拒绝 → 回退主进程解析（功能不受影响），回执注明解析进程
    let input: Awaited<ReturnType<typeof collectIndexInput>>;
    let parseVia: "utility" | "main" = "utility";
    try {
      const files = await reader.listFiles();
      input = await collectInWorker(gateway.root, files, (done, total, currentPath) =>
        forward({ phase: "parse", done, total, currentPath }),
      );
    } catch (err) {
      console.warn(
        `[index] utilityProcess 解析不可用，回退主进程：${err instanceof Error ? err.message : String(err)}`,
      );
      parseVia = "main";
      input = await collectIndexInput(progressReader(reader, forward));
    }
    const stats = rebuildIndex(db, input, undefined, { onProgress: forward });
    return {
      path: INDEX_DB_RELATIVE,
      exists: true,
      stats,
      schemaVersion: INDEX_SCHEMA_VERSION,
      skipped: input.skipped,
      mode: "full",
      reusedFiles: 0,
      updatedFiles: input.files.length,
      removedFiles: 0,
      integrityIssues,
      shards,
      parseVia,
    };
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