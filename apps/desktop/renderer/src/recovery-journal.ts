/**
 * 编辑日志调度器（M2 / T2-8 切片 A）：
 *
 * 编辑器输入期间以固定间隔（默认 500ms）把「最新正文快照」写入 `.yushu/recovery/`——
 * 进程被杀 / 崩溃时最多丢失该间隔内的输入；保存成功后调用 cancel()（并清除 journal 文件）。
 *
 * 语义：
 * - note(text)：登记最新文本并（若未排程）安排一次写入；写入完成后若期间又有新文本 → 进入下一轮；
 * - cancel()：内容已持久化——取消待发写入（调用方同时清除 journal 文件）；
 * - dispose()：组件卸载——仅清定时器（journal 保留，供异常终止场景恢复）；
 * - 写日志失败不打断编辑：保留待写文本，下一轮 / 下次输入自动重试。
 *
 * 纯逻辑（回调注入），假定时器可单测。
 */

export interface RecoveryJournalScheduler {
  /** 登记最新文本（每次编辑调用） */
  note(text: string): void;
  /** 内容已落盘：取消待发写入 */
  cancel(): void;
  /** 组件卸载：清定时器（不清 pending 语义，journal 文件保留） */
  dispose(): void;
  state(): "idle" | "pending";
}

export interface RecoveryJournalOptions {
  /** 写入快照（渲染层注入：api().recovery.writeJournal） */
  write: (text: string) => void | Promise<void>;
  /** 写入间隔（默认 500ms） */
  delayMs?: number;
}

export function createRecoveryJournalScheduler(options: RecoveryJournalOptions): RecoveryJournalScheduler {
  const delayMs = options.delayMs ?? 500;
  /** 尚未成功写盘的最新文本（null = 已同步） */
  let latest: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing = false;

  const arm = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void writePending();
    }, delayMs);
  };

  const writePending = async (): Promise<void> => {
    if (writing || latest === null) return;
    const text = latest;
    writing = true;
    try {
      await options.write(text);
      // 写入成功：仅当期间没有更新的文本时才视为已同步
      if (latest === text) latest = null;
    } catch {
      // 写日志失败不打断编辑：保留 latest，下一轮 / 下次输入自动重试
    } finally {
      writing = false;
      if (latest !== null) arm();
    }
  };

  return {
    note(text: string): void {
      latest = text;
      arm();
    },
    cancel(): void {
      latest = null;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    dispose(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    state: () => (latest === null ? "idle" : "pending"),
  };
}