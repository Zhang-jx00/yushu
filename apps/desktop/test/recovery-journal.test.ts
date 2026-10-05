import { describe, expect, it, vi } from "vitest";
import { createRecoveryJournalScheduler } from "../renderer/src/recovery-journal";

/** 编辑日志调度器（T2-8 切片 A）：固定间隔快照 / 合并 / 重试 / cancel 语义 */
describe("编辑日志调度器（T2-8 切片 A）", () => {
  it("固定间隔快照：连续 note 合并为一次写入（自首次触发计时，不因新输入无限推迟）", async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const scheduler = createRecoveryJournalScheduler({
        write: (text) => {
          writes.push(text);
        },
      });
      scheduler.note("a");
      await vi.advanceTimersByTimeAsync(300);
      scheduler.note("ab");
      await vi.advanceTimersByTimeAsync(199);
      expect(writes).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(writes).toEqual(["ab"]); // 写的是最新文本
      expect(scheduler.state()).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("写入期间的新输入进入下一轮（不丢最新文本）", async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      let release: (() => void) | null = null;
      const scheduler = createRecoveryJournalScheduler({
        write: async (text) => {
          writes.push(text);
          if (writes.length === 1) {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
        },
      });
      scheduler.note("v1");
      await vi.advanceTimersByTimeAsync(500); // 第一轮写入挂起中
      scheduler.note("v2");
      release!();
      await vi.advanceTimersByTimeAsync(0);
      expect(writes).toEqual(["v1"]);
      await vi.advanceTimersByTimeAsync(500);
      expect(writes).toEqual(["v1", "v2"]);
      expect(scheduler.state()).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("写失败不打断编辑：保留最新文本并自动重试", async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const writes: string[] = [];
      const scheduler = createRecoveryJournalScheduler({
        write: (text) => {
          if (fail) return Promise.reject(new Error("E_IO"));
          writes.push(text);
          return Promise.resolve();
        },
      });
      scheduler.note("v1");
      await vi.advanceTimersByTimeAsync(500);
      expect(writes).toEqual([]);
      expect(scheduler.state()).toBe("pending"); // 仍待写
      fail = false;
      await vi.advanceTimersByTimeAsync(500); // 自动重试
      expect(writes).toEqual(["v1"]);
      expect(scheduler.state()).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel（已保存）与 dispose（卸载）均取消待发写入", async () => {
    vi.useFakeTimers();
    try {
      const writes: string[] = [];
      const scheduler = createRecoveryJournalScheduler({
        write: (text) => {
          writes.push(text);
        },
      });
      scheduler.note("v1");
      scheduler.cancel();
      expect(scheduler.state()).toBe("idle");
      await vi.advanceTimersByTimeAsync(1000);
      expect(writes).toEqual([]);

      scheduler.note("v2");
      scheduler.dispose();
      await vi.advanceTimersByTimeAsync(1000);
      expect(writes).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});