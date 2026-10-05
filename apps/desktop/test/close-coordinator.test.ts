import { describe, expect, it, vi } from "vitest";
import { CloseCoordinator, type CloseFlowEvent } from "../src/main/close-coordinator.js";

/** 关闭窗口前 flush 协调器（T2-6 完整版）：拦截 / 回执放行 / 重复点击 / 超时兜底 / 无法请求放行 */
function makeEvent() {
  let prevented = 0;
  return {
    event: { preventDefault: () => (prevented += 1) },
    prevented: () => prevented,
  };
}

describe("CloseCoordinator（关闭前 flush）", () => {
  it("首次 close：拦截并请求落盘；回执后强关一次、超时清空；关后不再拦截", () => {
    vi.useFakeTimers();
    try {
      const requests: number[] = [];
      const closes: number[] = [];
      const flows: CloseFlowEvent[] = [];
      const coordinator = new CloseCoordinator({
        requestFlush: () => {
          requests.push(1);
          return true;
        },
        forceClose: () => closes.push(1),
        timeoutMs: 5000,
        onEvent: (event) => flows.push(event),
      });

      const first = makeEvent();
      coordinator.handleClose(first.event);
      expect(first.prevented()).toBe(1);
      expect(requests).toHaveLength(1);
      expect(closes).toHaveLength(0);
      expect(coordinator.state()).toEqual({ waiting: true, done: false });

      coordinator.handleFlushDone();
      expect(closes).toHaveLength(1);
      expect(coordinator.state()).toEqual({ waiting: false, done: true });
      expect(flows).toEqual(["requested", "flushed"]);

      // 超时定时器已清空：推进时间不产生二次强关
      vi.advanceTimersByTime(10_000);
      expect(closes).toHaveLength(1);

      // 已放行后再次收到 close：不再拦截（正常路径下 destroy 后不会再触发，纯防御）
      const again = makeEvent();
      coordinator.handleClose(again.event);
      expect(again.prevented()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("重复点击关闭：仍拦截（窗口不关）但不重复请求落盘", () => {
    const requests: number[] = [];
    const coordinator = new CloseCoordinator({
      requestFlush: () => {
        requests.push(1);
        return true;
      },
      forceClose: () => undefined,
      timeoutMs: 60_000,
    });
    const first = makeEvent();
    const second = makeEvent();
    coordinator.handleClose(first.event);
    coordinator.handleClose(second.event);
    expect(first.prevented()).toBe(1);
    expect(second.prevented()).toBe(1);
    expect(requests).toHaveLength(1);
    coordinator.handleFlushDone();
  });

  it("超时兜底：回执未到达时强制关闭，之后的迟到回执不重复强关", () => {
    vi.useFakeTimers();
    try {
      const closes: number[] = [];
      const flows: CloseFlowEvent[] = [];
      const coordinator = new CloseCoordinator({
        requestFlush: () => true,
        forceClose: () => closes.push(1),
        timeoutMs: 5000,
        onEvent: (event) => flows.push(event),
      });
      const event = makeEvent();
      coordinator.handleClose(event.event);
      vi.advanceTimersByTime(5000);
      expect(closes).toHaveLength(1);
      expect(flows).toEqual(["requested", "timeout"]);

      coordinator.handleFlushDone(); // 迟到回执（渲染层此前无响应）
      expect(closes).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("无法请求（页面未加载 / 已销毁）：不等待，立即放行", () => {
    const closes: number[] = [];
    const flows: CloseFlowEvent[] = [];
    const coordinator = new CloseCoordinator({
      requestFlush: () => false,
      forceClose: () => closes.push(1),
      onEvent: (event) => flows.push(event),
    });
    const event = makeEvent();
    coordinator.handleClose(event.event);
    expect(event.prevented()).toBe(1);
    expect(closes).toHaveLength(1);
    expect(flows).toEqual(["skipped"]);
    expect(coordinator.state()).toEqual({ waiting: false, done: true });
  });

  it("无请求的误触回执：忽略（不关闭窗口）", () => {
    const closes: number[] = [];
    const coordinator = new CloseCoordinator({
      requestFlush: () => true,
      forceClose: () => closes.push(1),
    });
    coordinator.handleFlushDone();
    expect(closes).toHaveLength(0);
    expect(coordinator.state()).toEqual({ waiting: false, done: false });
  });
});