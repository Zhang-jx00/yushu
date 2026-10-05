import { afterEach, describe, expect, it, vi } from "vitest";
import { createMentionThrottle } from "../renderer/src/mention-throttle";

afterEach(() => {
  vi.useRealTimers();
});

describe("提及重算节流（T2-4 切片 B：大章性能）", () => {
  it("小文档立即重算（不走节流路径）", () => {
    const seen: string[] = [];
    const throttle = createMentionThrottle({ threshold: 100, delayMs: 250, run: (t) => seen.push(t) });
    expect(throttle.push("短文本")).toBe(false);
    expect(seen).toEqual(["短文本"]);
  });

  it("大文档节流合并：连续输入只算最后一次（防抖）", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const throttle = createMentionThrottle({ threshold: 10, delayMs: 250, run: (t) => seen.push(t) });
    expect(throttle.push("一二三四五六七八九十甲")).toBe(true);
    expect(throttle.push("一二三四五六七八九十甲乙")).toBe(true);
    expect(seen).toEqual([]); // 250ms 内不重算
    vi.advanceTimersByTime(250);
    expect(seen).toEqual(["一二三四五六七八九十甲乙"]);
  });

  it("大文档中途变小：立即重算并取消待发任务", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const throttle = createMentionThrottle({ threshold: 10, delayMs: 250, run: (t) => seen.push(t) });
    throttle.push("一二三四五六七八九十甲");
    expect(throttle.push("短")).toBe(false);
    expect(seen).toEqual(["短"]);
    vi.advanceTimersByTime(500);
    expect(seen).toEqual(["短"]); // 待发已被取消，不会重复
  });

  it("flush 立即执行待发；dispose 丢弃未执行任务", () => {
    vi.useFakeTimers();
    const seen: string[] = [];
    const throttle = createMentionThrottle({ threshold: 1, delayMs: 250, run: (t) => seen.push(t) });
    throttle.push("大文档待发");
    throttle.flush();
    expect(seen).toEqual(["大文档待发"]);
    throttle.push("大文档待发2");
    throttle.dispose();
    vi.advanceTimersByTime(500);
    expect(seen).toEqual(["大文档待发"]);
  });
});