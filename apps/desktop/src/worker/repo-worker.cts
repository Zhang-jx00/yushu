/**
 * 仓库解析 utilityProcess 入口（M2 / T2-11 切片 A）。
 * 以 CJS（.cts）构建：utilityProcess.fork 对 CJS 入口最稳；解析逻辑（ESM）经动态 import 载入。
 * 协议（主进程 ↔ 本进程，结构化克隆）：
 * - ← { type: "collect", id, root, files }          收集索引输入（只读）
 * - → { type: "progress", id, done, total, currentPath }
 * - → { type: "result", id, input }                  input = IndexInput + skipped
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

async function handle(raw: unknown): Promise<void> {
  const message = raw as CollectMessage | undefined;
  if (!parentPort || !message || message.type !== "collect") return;
  const { id } = message;
  try {
    // 动态 import ESM 解析逻辑（CJS 入口内可用；世界引擎包为 ESM）
    const { collectWithFs } = await import("./repo-collect.js");
    const input = await collectWithFs(message.root, message.files, (done, total, currentPath) => {
      parentPort.postMessage({ type: "progress", id, done, total, currentPath });
    });
    parentPort.postMessage({ type: "result", id, input });
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