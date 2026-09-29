/**
 * 自动保存调度器（M2 / T2-6 切片）：
 * - 防抖 800ms 落盘；连续输入超过 5s 强制保存一次（docs/04 T2-6 的口径）；
 * - flush()：失焦 / 切换章节 / 关闭前立即保存（把"杀进程丢稿"窗口压到最短）；
 * - 保存失败（如 baseHash 冲突）进入冻结态 error：不自动重试，由 UI 引导人工处理（旁路文件 / 重新载入）。
 * 纯逻辑实现（回调注入），便于用假定时器单测。
 */

export type AutosaveState = "idle" | "pending" | "saving" | "saved" | "error";

export interface AutosaveDetail {
  savedAt?: number;
  error?: string;
}

export interface AutosaveSchedulerOptions {
  /** 防抖窗口（默认 800ms） */
  delayMs?: number;
  /** 高频强制上限（默认 5000ms） */
  maxDelayMs?: number;
  save: () => Promise<void>;
  onChange?: (state: AutosaveState, detail?: AutosaveDetail) => void;
}

export interface AutosaveScheduler {
  schedule(): void;
  flush(): Promise<void>;
  cancel(): void;
  state(): AutosaveState;
}

export function createAutosaveScheduler(options: AutosaveSchedulerOptions): AutosaveScheduler {
  const delayMs = options.delayMs ?? 800;
  const maxDelayMs = options.maxDelayMs ?? 5000;

  let state: AutosaveState = "idle";
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  let dirty = false;
  let inFlight: Promise<void> | null = null;

  const emit = (next: AutosaveState, detail?: AutosaveDetail) => {
    state = next;
    options.onChange?.(next, detail);
  };

  const clearTimers = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    debounceTimer = null;
    deadlineTimer = null;
  };

  const run = async (): Promise<void> => {
    if (!dirty || state === "error") return;
    clearTimers();
    dirty = false;
    emit("saving");
    try {
      await options.save();
      emit("saved", { savedAt: Date.now() });
      // 保存期间又有变更：继续下一轮防抖
      if (dirty) scheduleInternal();
    } catch (err) {
      emit("error", { error: err instanceof Error ? err.message : String(err) });
    }
  };

  const scheduleInternal = () => {
    if (state === "error") return;
    emit("pending");
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void run(), delayMs);
    if (!deadlineTimer) {
      deadlineTimer = setTimeout(() => void run(), maxDelayMs);
    }
  };

  return {
    schedule() {
      if (state === "error") return;
      dirty = true;
      scheduleInternal();
    },
    async flush() {
      if (state === "error") return;
      // 若已有保存在途，等待其完成后处理残留变更
      if (inFlight) await inFlight;
      if (!dirty) return;
      inFlight = run();
      await inFlight;
      inFlight = null;
    },
    cancel() {
      clearTimers();
      dirty = false;
      // 无条件回到 idle：cancel 的语义是「文档已重置为磁盘态」（切换/重新载入），
      // 冻结态（error）也必须解除，否则冲突后「重新载入」将永远无法恢复自动保存。
      emit("idle");
    },
    state() {
      return state;
    },
  };
}