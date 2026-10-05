/**
 * 关闭窗口前 flush 协调器（M2 / T2-6 完整版）：
 *
 * BrowserWindow 'close' 首次触发 → preventDefault + 请求渲染层落盘（app:beforeClose）；
 * 渲染层回执（app:flushDone）→ 真正关闭窗口（forceClose，主进程侧用 win.destroy() 跳过再次拦截）；
 * 超时兜底（默认 5s，渲染层无响应 / 崩溃）→ 强制关闭，不阻塞用户退出。
 *
 * 纯逻辑（回调注入、无 electron 依赖），假定时器可单测；窗口接线见 main.ts / ipc.ts。
 * 说明：macOS 的 Cmd+Q 退出语义未特殊处理（v1 目标平台为 Windows，平台适配在 M6 收敛）。
 */

export interface CloseRequestEvent {
  preventDefault: () => void;
}

export type CloseFlowEvent = "requested" | "flushed" | "timeout" | "skipped";

export interface CloseCoordinatorOptions {
  /**
   * 请求渲染层落盘（主进程侧：webContents.send("app:beforeClose")）。
   * 返回 false 表示无法请求（页面尚未加载完成 / 已销毁）——无需等待，立即放行。
   */
  requestFlush: () => boolean;
  /** 真正关闭窗口（主进程侧：win.destroy()，避免再次进入 close 拦截） */
  forceClose: () => void;
  /** 等待回执的超时兜底（默认 5000ms） */
  timeoutMs?: number;
  /** 流程观测（日志 / 测试） */
  onEvent?: (event: CloseFlowEvent) => void;
}

export class CloseCoordinator {
  private waiting = false;
  private done = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: CloseCoordinatorOptions) {}

  /** BrowserWindow 'close' 事件入口：flush 完成（或超时放行）前一律拦截 */
  handleClose(event: CloseRequestEvent): void {
    if (this.done) return; // 已进入最终关闭（destroy），不应再被调用
    event.preventDefault();
    if (this.waiting) return; // 已在等待回执：用户重复点击关闭不重复请求
    this.waiting = true;
    if (this.options.requestFlush()) {
      this.options.onEvent?.("requested");
      this.timer = setTimeout(() => {
        this.timer = null;
        this.finish("timeout");
      }, this.options.timeoutMs ?? 5000);
      this.timer.unref?.();
      return;
    }
    // 请求无法送达（渲染层未加载/已销毁）：无未落盘内容可言，直接放行
    this.finish("skipped");
  }

  /** 渲染层回执（app:flushDone）：仅在等待中有效，防止无请求的误触直接关窗 */
  handleFlushDone(): void {
    if (this.waiting) this.finish("flushed");
  }

  /** 状态（诊断 / 测试） */
  state(): { waiting: boolean; done: boolean } {
    return { waiting: this.waiting, done: this.done };
  }

  private finish(reason: "flushed" | "timeout" | "skipped"): void {
    this.done = true;
    this.waiting = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.options.onEvent?.(reason);
    this.options.forceClose();
  }
}

/**
 * 窗口协调器注册表：app:flushDone 是「渲染层 → 主进程」单向消息，
 * ipc.ts 经 event.sender.id 找到对应窗口的协调器（多窗口/预演复用窗口时按 id 隔离）。
 */
const coordinators = new Map<number, CloseCoordinator>();

export function registerCloseCoordinator(webContentsId: number, coordinator: CloseCoordinator): void {
  coordinators.set(webContentsId, coordinator);
}

export function unregisterCloseCoordinator(webContentsId: number): void {
  coordinators.delete(webContentsId);
}

export function closeCoordinatorFor(webContentsId: number): CloseCoordinator | undefined {
  return coordinators.get(webContentsId);
}