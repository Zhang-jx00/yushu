import { describe, expect, it, vi } from "vitest";
import { EventBus } from "@yushu/core";

interface TestEvents extends Record<string, unknown> {
  "project:opened": { id: string };
  "doc:changed": { path: string };
}

describe("EventBus", () => {
  it("订阅与派发", () => {
    const bus = new EventBus<TestEvents>();
    const fn = vi.fn();
    bus.on("project:opened", fn);
    bus.emit("project:opened", { id: "world-tianqi" });
    expect(fn).toHaveBeenCalledWith({ id: "world-tianqi" });
    expect(bus.listenerCount("project:opened")).toBe(1);
  });

  it("退订后不再收到事件", () => {
    const bus = new EventBus<TestEvents>();
    const fn = vi.fn();
    const off = bus.on("doc:changed", fn);
    off();
    bus.emit("doc:changed", { path: "ch-001.md" });
    expect(fn).not.toHaveBeenCalled();
    expect(bus.listenerCount("doc:changed")).toBe(0);
  });

  it("once 只触发一次", () => {
    const bus = new EventBus<TestEvents>();
    const fn = vi.fn();
    bus.once("doc:changed", fn);
    bus.emit("doc:changed", { path: "a" });
    bus.emit("doc:changed", { path: "b" });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("回调中退订在下一轮生效，不影响本轮派发", () => {
    const bus = new EventBus<TestEvents>();
    const calls: string[] = [];
    let offSecond: () => void = () => undefined;
    bus.on("doc:changed", () => {
      calls.push("first");
      offSecond();
    });
    offSecond = bus.on("doc:changed", () => calls.push("second"));
    bus.emit("doc:changed", { path: "x" });
    expect(calls).toEqual(["first", "second"]);
    // 下一轮派发时，已退订的监听器不再触发
    bus.emit("doc:changed", { path: "y" });
    expect(calls).toEqual(["first", "second", "first"]);
  });

  it("clear 清空监听", () => {
    const bus = new EventBus<TestEvents>();
    bus.on("doc:changed", () => undefined);
    bus.clear();
    expect(bus.listenerCount("doc:changed")).toBe(0);
  });
});