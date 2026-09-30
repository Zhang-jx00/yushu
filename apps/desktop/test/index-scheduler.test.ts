import { describe, expect, it, vi } from "vitest";
import { IndexRefreshScheduler } from "../src/main/index-scheduler.js";

/** 保存即增量调度器（T2-5 切片 B）：防抖 / 单飞脏补跑 / 失败不抛出 / reset 语义 */
describe("IndexRefreshScheduler（保存即增量）", () => {
  it("防抖合并：窗口内连续 schedule 只触发一次刷新", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const scheduler = new IndexRefreshScheduler(async () => {
        calls += 1;
      }, 2000);
      scheduler.schedule();
      scheduler.schedule();
      expect(scheduler.state().pending).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      scheduler.schedule(); // 窗口内再次保存：沿用首个计时（避免高频保存无限推迟）
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(1);
      expect(scheduler.state().pending).toBe(false);
      expect(scheduler.state().running).toBe(false);
      expect(scheduler.state().lastRunAt).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("单飞 + 脏补跑：刷新进行中的触发合并为结束后补跑一次（不并发、不丢失）", async () => {
    vi.useFakeTimers();
    try {
      let release: (() => void) | null = null;
      let calls = 0;
      const scheduler = new IndexRefreshScheduler(async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      }, 1000);
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(1);
      expect(scheduler.state().running).toBe(true);
      scheduler.schedule();
      scheduler.schedule(); // 两次触发合并为一次补跑
      release!();
      await vi.advanceTimersByTimeAsync(0);
      expect(scheduler.state().pending).toBe(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      expect(scheduler.state().running).toBe(false);
      expect(scheduler.state().pending).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("失败不抛出：记录 lastError，下次保存重试成功后清除", async () => {
    vi.useFakeTimers();
    try {
      let fail = true;
      const scheduler = new IndexRefreshScheduler(async () => {
        if (fail) throw new Error("索引增量更新失败（已回滚）");
      }, 500);
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(500);
      expect(scheduler.state().lastError).toContain("已回滚");
      expect(scheduler.state().lastRunAt).toBeNull();
      expect(scheduler.state().running).toBe(false);

      fail = false;
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(500);
      expect(scheduler.state().lastError).toBeNull();
      expect(scheduler.state().lastRunAt).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reset（项目关闭/切换）：取消待命刷新并清空状态", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const scheduler = new IndexRefreshScheduler(async () => {
        calls += 1;
      }, 500);
      scheduler.schedule();
      expect(scheduler.state().pending).toBe(true);
      scheduler.reset();
      expect(scheduler.state()).toEqual({ pending: false, running: false, lastRunAt: null, lastError: null });
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});