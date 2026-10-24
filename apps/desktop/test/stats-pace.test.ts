/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { buildStatsPace, PACE_WINDOW_DAYS } from "../src/main/stats-pace.js";

/**
 * 近 30 天节奏（R158：码字统计页右栏那一列的纯函数）。
 *
 * 这一层之所以要有单测：右栏摆的每一个数都由它算出来 ⇒ 它算错，页面上就是错的，
 * 而页面上"看起来合理"没人会去核。判据盯四件事：
 * ① **逐日序列是连续 30 个自然日**（缺失日补 0，不是"少一天"）；
 * ② **日均 = 合计 ÷ 30**（每个自然日，不是"有产出的那天"）；
 * ③ **有产出的天数**只数净增为正的天；
 * ④ **最好的一天**只认净增为正的那天；一段日子没有产出时如实给 null（界面显示「—」）。
 */

const TODAY = "2026-10-24";

describe("近 30 天的节奏（R158）", () => {
  it("窗口是**连续 30 个自然日**（含今天，往前 29 天；缺失日补 0）", () => {
    const pace = buildStatsPace([{ date: TODAY, delta: 500 }], TODAY, 3000);
    expect(pace.days).toBe(30);
    expect(PACE_WINDOW_DAYS).toBe(30);
    expect(pace.calendar.length).toBe(30);
    // 升序 + 最后一天是今天 + 第一天是 29 天前
    expect(pace.calendar[0]?.date).toBe("2026-09-25");
    expect(pace.calendar[29]?.date).toBe(TODAY);
    const dates = pace.calendar.map((day) => day.date);
    expect([...dates].sort()).toEqual(dates);
    // 缺失日补 0（不是"不出现"）
    expect(pace.calendar[0]?.delta).toBe(0);
    expect(pace.calendar[29]?.delta).toBe(500);
    // 跨月跨年都算得对
    const cross = buildStatsPace([], "2026-01-05", 0);
    expect(cross.calendar[0]?.date).toBe("2025-12-07");
    expect(cross.calendar[29]?.date).toBe("2026-01-05");
  });

  it("窗口**外面**的记录不进来（只数这 30 天）", () => {
    const pace = buildStatsPace(
      [
        { date: "2026-09-20", delta: 9999 }, // 窗口外（早于 09-25）
        { date: "2026-10-24", delta: 100 },
      ],
      TODAY,
      0,
    );
    expect(pace.total).toBe(100);
    expect(pace.calendar.some((day) => day.delta === 9999)).toBe(false);
  });

  it("合计 / 日均 / 有产出的天数 / 最好的一天都从这一份序列算", () => {
    const pace = buildStatsPace(
      [
        { date: "2026-10-20", delta: 1000 },
        { date: "2026-10-21", delta: 2000 },
        { date: "2026-10-22", delta: -500 }, // 净删：不算"有产出"
        { date: "2026-10-23", delta: 0 }, // 净增为 0：也不算"有产出"
        { date: "2026-10-24", delta: 500 },
      ],
      TODAY,
      3000,
    );
    expect(pace.total).toBe(3000);
    // 日均 = 合计 ÷ 30（**每个自然日**），不是 ÷ 有产出的天数
    expect(pace.avgPerDay).toBe(100);
    expect(pace.activeDays).toBe(3);
    expect(pace.bestDay).toEqual({ date: "2026-10-21", delta: 2000 });
    expect(pace.todayWritten).toBe(500);
  });

  it("**一段日子没有产出**时最好的一天给 null（界面显示「—」，不许装成有）", () => {
    const pace = buildStatsPace([{ date: "2026-10-22", delta: -300 }], TODAY, 3000);
    expect(pace.bestDay).toBeNull();
    expect(pace.activeDays).toBe(0);
    expect(pace.total).toBe(-300);
    expect(pace.avgPerDay).toBe(-10);
  });

  it("完成比例 = 今日已写 ÷ 目标（封顶 100；没设目标时给 0，不假装有进度）", () => {
    expect(buildStatsPace([{ date: TODAY, delta: 1500 }], TODAY, 3000).progressPercent).toBe(50);
    expect(buildStatsPace([{ date: TODAY, delta: 9000 }], TODAY, 3000).progressPercent).toBe(100);
    expect(buildStatsPace([{ date: TODAY, delta: 1500 }], TODAY, 0).progressPercent).toBe(0);
    expect(buildStatsPace([{ date: TODAY, delta: 1500 }], TODAY, 0).goal).toBe(0);
  });
});
