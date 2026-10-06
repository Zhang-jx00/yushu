import { app, utilityProcess, type UtilityProcess } from "electron";
import { fileURLToPath } from "node:url";
import type { IndexFileRow, IndexInput, IndexSourceFile } from "@yushu/world-engine";

/**
 * 仓库解析 utilityProcess 管理（M2 / T2-11）：
 * - 切片 A：全量只读解析（collectInWorker）；
 * - 切片 B：增量 diff + 定向只读解析（incrementalInWorker）。
 * 只读解析（收集索引输入 / 增量 delta）移出主进程（K13：主进程只做窗口 / IPC / 索引库写入）；
 * 主进程独占写库不变——worker 产出结构化行经消息回传，由主进程写 SQLite（docs/04 §5.6）；
 * 失败语义：spawn 失败 / 超时 / 异常退出 / 越界拒绝 → Promise 拒绝，调用方回退主进程解析。
 */

const WORKER_TIMEOUT_MS = 120_000;

export type CollectedIndexInput = IndexInput & { skipped: { path: string; error: string }[] };

/** 增量 delta（与 worker 侧 IncrementalWithFsResult 同形；input=null 表示无变更文件） */
export interface IncrementalDeltaPayload {
  removedPaths: string[];
  touchedFiles: IndexFileRow[];
  reusedFiles: number;
  updatedFiles: number;
  removedFiles: number;
  input: CollectedIndexInput | null;
}

type WorkerResult = CollectedIndexInput | IncrementalDeltaPayload;

interface PendingRequest {
  resolve: (payload: WorkerResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  kind: "collect" | "incremental";
  onProgress?: (done: number, total: number, currentPath: string) => void;
}

let child: UtilityProcess | null = null;
let requestSeq = 1;
const pending = new Map<number, PendingRequest>();

/** utility 入口（本文件位于 dist/main/，worker 位于 dist/worker/repo-worker.cjs） */
function workerEntryPath(): string {
  return fileURLToPath(new URL("../worker/repo-worker.cjs", import.meta.url));
}

function ensureChild(): UtilityProcess {
  if (child) return child;
  const spawned = utilityProcess.fork(workerEntryPath(), [], { serviceName: "yushu-repo-worker" });
  spawned.on("message", (message: unknown) => {
    const msg = message as
      | {
          type?: string;
          id?: number;
          input?: CollectedIndexInput;
          delta?: IncrementalDeltaPayload;
          message?: string;
          done?: number;
          total?: number;
          currentPath?: string;
        }
      | undefined;
    if (!msg || typeof msg.id !== "number") return;
    const entry = pending.get(msg.id);
    if (!entry) return;
    if (msg.type === "progress") {
      entry.onProgress?.(msg.done ?? 0, msg.total ?? 0, msg.currentPath ?? "");
      return;
    }
    pending.delete(msg.id);
    clearTimeout(entry.timer);
    if (msg.type === "result") {
      entry.resolve(entry.kind === "collect" ? (msg.input as CollectedIndexInput) : (msg.delta as IncrementalDeltaPayload));
    } else {
      entry.reject(new Error(String(msg.message ?? "utility 解析失败")));
    }
  });
  spawned.on("exit", (code) => {
    const error = new Error(`repo worker 退出（code=${code}）`);
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    pending.clear();
    child = null;
  });
  app.once("will-quit", () => {
    try {
      spawned.kill();
    } catch {
      /* 已退出 */
    }
  });
  child = spawned;
  return spawned;
}

function request(
  kind: "collect" | "incremental",
  message: Record<string, unknown>,
  onProgress?: (done: number, total: number, currentPath: string) => void,
): Promise<WorkerResult> {
  const proc = ensureChild();
  const id = requestSeq;
  requestSeq += 1;
  return new Promise<WorkerResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`repo worker 超时（${WORKER_TIMEOUT_MS}ms）`));
    }, WORKER_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, kind, onProgress });
    proc.postMessage({ ...message, id });
  });
}

/** 经 utilityProcess 收集索引输入（只读解析）；失败即拒绝，由调用方回退主进程解析 */
export async function collectInWorker(
  root: string,
  files: IndexSourceFile[],
  onProgress?: (done: number, total: number, currentPath: string) => void,
): Promise<CollectedIndexInput> {
  return (await request("collect", { type: "collect", root, files }, onProgress)) as CollectedIndexInput;
}

/**
 * 经 utilityProcess 做增量 diff + 定向解析（T2-11 切片 B；只读）；
 * prev 为 file_index 基线（由主进程从索引库读出），builtAt 为快速跳过的 racy 防护基准。
 * 失败即拒绝，由调用方回退主进程增量解析。
 */
export async function incrementalInWorker(
  root: string,
  files: IndexSourceFile[],
  prev: IndexFileRow[],
  builtAt: string,
  onProgress?: (done: number, total: number, currentPath: string) => void,
): Promise<IncrementalDeltaPayload> {
  return (await request(
    "incremental",
    { type: "incremental", root, files, prev, builtAt },
    onProgress,
  )) as IncrementalDeltaPayload;
}

/** 停止 utility 进程（测试 / 退出；下次请求自动重建） */
export function stopRepoWorker(): void {
  const proc = child;
  child = null;
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    /* 已退出 */
  }
}