import { describe, expect, it } from "vitest";
import { ACTIVITY_PING_INTERVAL_MS, createActivityPing } from "../renderer/src/activity-ping";

describe("写作活动心跳节流（T2-9 切片 C）", () => {
  it("首次输入立即发送；间隔内忽略；超过间隔再次发送", () => {
    let clock = 1_000_000;
    const sent: number[] = [];
    const ping = createActivityPing({
      send: async () => {
        sent.push(clock);
      },
      intervalMs: 20_000,
      now: () => clock,
    });

    expect(ping.ping()).toBe(true);
    clock += 5_000;
    expect(ping.ping()).toBe(false); // 间隔内忽略
    clock += 15_000;
    expect(ping.ping()).toBe(true); // 恰好满间隔
    clock += 19_999;
    expect(ping.ping()).toBe(false);
    clock += 1; // 20s
    expect(ping.ping()).toBe(true);
    expect(sent).toHaveLength(3);
  });

  it("发送失败：静默（不抛出）且重置窗口——下一次输入可立即重试", async () => {
    let clock = 0;
    let rejectNext = true;
    const sent: number[] = [];
    const ping = createActivityPing({
      send: () => {
        sent.push(clock);
        return rejectNext ? Promise.reject(new Error("network")) : Promise.resolve();
      },
      intervalMs: 20_000,
      now: () => clock,
    });

    expect(ping.ping()).toBe(true); // 失败（异步拒绝被静默）
    await Promise.resolve(); // 让 catch 执行
    rejectNext = false;
    expect(ping.ping()).toBe(true); // 失败后窗口已重置 → 立即重试成功
    clock += 1_000;
    expect(ping.ping()).toBe(false); // 成功后回到节流
    expect(sent).toHaveLength(2); // 首次（失败）+ 重试（成功）各尝试发送一次
  });

  it("dispose 重置窗口；默认间隔常量为 20s", () => {
    const ping = createActivityPing({ send: async () => undefined });
    expect(ACTIVITY_PING_INTERVAL_MS).toBe(20_000);
    expect(ping.ping()).toBe(true);
    ping.dispose();
    expect(ping.ping()).toBe(true); // 重置后立即发送
  });
});