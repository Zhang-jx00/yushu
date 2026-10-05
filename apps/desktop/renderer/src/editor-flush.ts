/**
 * 编辑器 flush 注册表（M2 / T2-6 完整版·关闭前 flush）：
 * 编辑器视图挂载时注册「把待发改动立即落盘」的异步函数；
 * App 收到主进程的关闭请求（app:beforeClose）时调用，完成后回执 app:flushDone。
 *
 * 同一时刻只挂载一个编辑器视图（切页即卸载）：后注册覆盖先注册；
 * 注销时仅当仍是自己才清空，避免旧组件的清理误删新组件的注册。
 */
export type EditorFlusher = () => Promise<string | void>;

export interface FlushOutcome {
  /** 是否有编辑器视图在挂载（false = 未在编辑，无落盘内容） */
  hadEditor: boolean;
  /** 编辑器回传的细节（调度器状态等，供主进程日志诊断） */
  detail: string;
}

let current: EditorFlusher | null = null;

export function registerEditorFlusher(flusher: EditorFlusher): () => void {
  current = flusher;
  return () => {
    if (current === flusher) current = null;
  };
}

/** 编辑器已挂载则 flush 并返回结果；未在编辑（无编辑器视图）返回 hadEditor=false */
export async function flushEditorIfAny(): Promise<FlushOutcome> {
  if (!current) return { hadEditor: false, detail: "" };
  const detail = await current();
  return { hadEditor: true, detail: typeof detail === "string" ? detail : "" };
}