import { describe, expect, it, vi } from "vitest";
import { createAutosaveScheduler, type AutosaveState } from "../renderer/src/autosave";

describe("自动保存调度器（T2-6 切片）", () => {
  it("防抖 800ms：连续输入只保存一次，且发生在最后一次输入之后", async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async () => undefined);
      const states: AutosaveState[] = [];
      const scheduler = createAutosaveScheduler({ save, onChange: (state) => states.push(state) });

      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(300);
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(300);
      scheduler.schedule();
      expect(save).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(800);
      expect(save).toHaveBeenCalledTimes(1);
      expect(states).toContain("pending");
      expect(states).toContain("saving");
      expect(states.at(-1)).toBe("saved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("高频输入超过 5s 上限时强制保存一次", async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async () => undefined);
      const scheduler = createAutosaveScheduler({ save });

      // 每 300ms 输入一次，持续 6s（防抖窗口一直被打断，但 5s 上限应触发保存）
      for (let elapsed = 0; elapsed < 5100; elapsed += 300) {
        scheduler.schedule();
        await vi.advanceTimersByTimeAsync(300);
      }
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("flush：立即保存（失焦/切换章节路径），无未决变更时不重复保存", async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async () => undefined);
      const scheduler = createAutosaveScheduler({ save });

      scheduler.schedule();
      await scheduler.flush();
      expect(save).toHaveBeenCalledTimes(1);

      await scheduler.flush();
      expect(save).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("保存失败进入冻结态：不自动重试，schedule 被忽略", async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async () => {
        throw new Error("E_DOC_CONFLICT");
      });
      const states: AutosaveState[] = [];
      const scheduler = createAutosaveScheduler({ save, onChange: (state) => states.push(state) });

      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(800);
      expect(save).toHaveBeenCalledTimes(1);
      expect(states.at(-1)).toBe("error");

      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(3000);
      expect(save).toHaveBeenCalledTimes(1); // 冻结后不再重试
      expect(scheduler.state()).toBe("error");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel：撤销回原样后不再触发保存", async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async () => undefined);
      const scheduler = createAutosaveScheduler({ save });
      scheduler.schedule();
      scheduler.cancel();
      await vi.advanceTimersByTimeAsync(3000);
      expect(save).not.toHaveBeenCalled();
      expect(scheduler.state()).toBe("idle");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel 可解除冻结：冲突后重新载入（磁盘态）恢复自动保存", async () => {
    vi.useFakeTimers();
    try {
      const save = vi.fn(async () => {
        throw new Error("E_DOC_CONFLICT");
      });
      const scheduler = createAutosaveScheduler({ save });
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(800);
      expect(scheduler.state()).toBe("error");

      scheduler.cancel(); // 用户「重新载入」最新版本 → 文档 = 磁盘态
      expect(scheduler.state()).toBe("idle");

      save.mockImplementation(async () => undefined); // 冲突解除后的再次编辑
      scheduler.schedule();
      await vi.advanceTimersByTimeAsync(800);
      expect(save).toHaveBeenCalledTimes(2);
      expect(scheduler.state()).toBe("saved");
    } finally {
      vi.useRealTimers();
    }
  });
});