import { app, utilityProcess, type UtilityProcess } from "electron";
import { fileURLToPath } from "node:url";
import type { IndexInput, IndexSourceFile } from "@yushu/world-engine";

/**
 * 仓库解析 utilityProcess 管理（M2 / T2-11 切片 A）：
 * - 只读解析（收集索引输入）移出主进程（K13：主进程只做窗口 / IPC / 索引库写入）；
 * - 主进程独占写库不变——worker 产出结构化行经消息回传，由主进程写 SQLite（docs/04 §5.6）；
 * - 失败语义：spawn 失败 / 超时 / 异常退出 / 越界拒绝 → Promise 拒绝，调用方回退主进程解析。
 */

const WORKER_TIMEOUT_MS = 120_000;

export type CollectedIndexInput = IndexInput & { skipped: { path: string; error: string }[] };

interface PendingRequest {
  resolve: (input: CollectedIndexInput) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
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
    if (msg.type === "result" && msg.input) entry.resolve(msg.input);
    else entry.reject(new Error(String(msg.message ?? "utility 解析失败")));
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

/** 经 utilityProcess 收集索引输入（只读解析）；失败即拒绝，由调用方回退主进程解析 */
export function collectInWorker(
  root: string,
  files: IndexSourceFile[],
  onProgress?: (done: number, total: number, currentPath: string) => void,
): Promise<CollectedIndexInput> {
  const proc = ensureChild();
  const id = requestSeq;
  requestSeq += 1;
  return new Promise<CollectedIndexInput>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`repo worker 超时（${WORKER_TIMEOUT_MS}ms）`));
    }, WORKER_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, onProgress });
    proc.postMessage({ type: "collect", id, root, files });
  });
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