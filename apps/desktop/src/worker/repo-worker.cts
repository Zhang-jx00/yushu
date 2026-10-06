/**
 * 仓库解析 utilityProcess 入口（M2 / T2-11）。
 * 以 CJS（.cts）构建：utilityProcess.fork 对 CJS 入口最稳；解析逻辑（ESM）经动态 import 载入。
 * 协议（主进程 ↔ 本进程，结构化克隆）：
 * - ← { type: "collect", id, root, files }                     全量收集索引输入（只读）
 * - ← { type: "incremental", id, root, files, prev, builtAt }  增量 diff + 定向解析（只读，切片 B）
 * - → { type: "progress", id, done, total, currentPath }
 * - → { type: "result", id, input }                            collect 的返回（IndexInput + skipped）
 * - → { type: "result", id, delta }                            incremental 的返回（delta + input）
 * - → { type: "error", id, message }
 */
interface ParentPortLike {
  on(event: "message", listener: (event: unknown) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPortLike }).parentPort;

interface CollectMessage {
  type: "collect";
  id: number;
  root: string;
  files: { path: string; size: number; mtime?: string }[];
}

interface IncrementalMessage {
  type: "incremental";
  id: number;
  root: string;
  files: { path: string; size: number; mtime?: string }[];
  /** file_index 基线（主进程从索引库读出后传入；worker 不碰 SQLite） */
  prev: { path: string; mtime?: string; hash: string; bytes: number }[];
  /** 上次索引写入时刻（快速跳过的 racy 防护基准） */
  builtAt: string;
}

async function handle(raw: unknown): Promise<void> {
  const message = raw as CollectMessage | IncrementalMessage | undefined;
  if (!parentPort || !message) return;
  const { id } = message;
  const sendProgress = (done: number, total: number, currentPath: string) => {
    parentPort.postMessage({ type: "progress", id, done, total, currentPath });
  };
  try {
    // 动态 import ESM 解析逻辑（CJS 入口内可用；世界引擎包为 ESM）
    const { collectWithFs, incrementalWithFs } = await import("./repo-collect.js");
    if (message.type === "collect") {
      const input = await collectWithFs(message.root, message.files, sendProgress);
      parentPort.postMessage({ type: "result", id, input });
      return;
    }
    if (message.type === "incremental") {
      const delta = await incrementalWithFs(
        message.root,
        message.files,
        message.prev,
        message.builtAt,
        sendProgress,
      );
      parentPort.postMessage({ type: "result", id, delta });
    }
  } catch (err) {
    parentPort.postMessage({
      type: "error",
      id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

if (parentPort) {
  parentPort.on("message", (event) => {
    // utilityProcess 的 message 事件形如 MessageEvent（数据在 .data）；兼容直接传对象
    const data =
      event && typeof event === "object" && "data" in (event as Record<string, unknown>)
        ? (event as { data: unknown }).data
        : event;
    void handle(data);
  });
}