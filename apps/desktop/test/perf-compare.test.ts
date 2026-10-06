import { describe, expect, it } from "vitest";
import { comparePerfMetrics, DEFAULT_REGRESSION_THRESHOLD } from "../src/main/perf-compare.js";

/**
 * 性能回归对比（T2-10 遗留）：超阈值回退 / 阈值内稳定 / 显著改善；越高越好指标方向取反；
 * 无基线与非数值项如实跳过（不制造伪回退）。
 */
describe("性能回归对比（T2-10 遗留）", () => {
  const previous = {
    date: "2026-10-06T00:00:00.000Z",
    metrics: { cold: 1500, query: 10, rebuild_cpm: 30_000_000, mega: 4 },
  };

  it("超阈值回退（默认 20%）/ 阈值内稳定 / 显著改善（越低越好）", () => {
    const result = comparePerfMetrics(previous, { metrics: { cold: 1875, query: 11, mega: 2 } });
    expect(result.thresholdRatio).toBe(DEFAULT_REGRESSION_THRESHOLD);
    expect(result.baselineDate).toBe(previous.date);
    expect(result.rows.find((row) => row.metric === "cold")).toMatchObject({ deltaPct: 25, status: "regression" });
    expect(result.rows.find((row) => row.metric === "query")).toMatchObject({ deltaPct: 10, status: "stable" });
    expect(result.rows.find((row) => row.metric === "mega")).toMatchObject({ deltaPct: -50, status: "improved" });
    expect(result.ok).toBe(false);
    expect(result.regressions.map((row) => row.metric)).toEqual(["cold"]);
  });

  it("rebuild_cpm（越高越好）方向取反：下降超阈值判回退、上升判改善", () => {
    const worse = comparePerfMetrics(previous, { metrics: { rebuild_cpm: 21_000_000 } });
    expect(worse.rows[0]).toMatchObject({ deltaPct: 30, status: "regression" });
    expect(worse.ok).toBe(false);

    const better = comparePerfMetrics(previous, { metrics: { rebuild_cpm: 39_000_000 } });
    expect(better.rows[0]).toMatchObject({ deltaPct: -30, status: "improved" });
    expect(better.ok).toBe(true);
  });

  it("自定义阈值 / 无基线 / 非数值与缺失指标：跳过且不判回退", () => {
    const relaxed = comparePerfMetrics(previous, { metrics: { cold: 1900 } }, { thresholdRatio: 0.3 });
    expect(relaxed.rows[0]).toMatchObject({ deltaPct: 26.7, status: "stable" }); // +26.7% 未过 30% 阈值
    expect(relaxed.ok).toBe(true);

    const noBaseline = comparePerfMetrics(null, { metrics: { cold: 9999 } });
    expect(noBaseline).toMatchObject({ ok: true, baselineDate: null, rows: [], regressions: [] });

    // 本次为 null（如大章缺失）/ 基线缺失该指标 → 不产生对比行
    const skipped = comparePerfMetrics(previous, { metrics: { cold: 1500, mega: null, brandNew: 5 } });
    expect(skipped.rows.map((row) => row.metric)).toEqual(["cold"]);
    expect(skipped.ok).toBe(true);
  });
});