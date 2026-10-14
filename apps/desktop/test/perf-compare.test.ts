/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  comparePerfMetrics,
  summarizePerfGate,
  DEFAULT_REGRESSION_THRESHOLD,
} from "../src/main/perf-compare.js";

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

/**
 * 性能门禁汇总（R83）。
 *
 * 立这条的起因是本轮实测撞到的事实：报告里 `checks.cold_to_editable:false`、终端也打了 ❌，
 * **而探针仍以 `app.exit(0)` 收工**——结论算出来了却没人消费它，等于一条永远不会红的门禁
 * （与第 59 轮"预演抖动不进退出码"、第 81 轮"自己写的假锁"同族）。
 *
 * 同一轮的另一组实测决定了这个函数的形状：同一份构建、同一个夹具连跑两遍，
 * `cold_to_editable` 是 **3160ms（夹具刚生成）→ 1434ms（夹具已就位）**，
 * 而 `keystroke_mega_p95` 2.8→3.6ms（+28.6%）、`chapter_write_ms` 13→16ms（+23.1%）
 * 被 20% 阈值判成"回退"。**个位数毫秒上的相对波动没有含义**，拿它翻退出码就是造一台假红机器。
 * 所以三条：① 门禁只看**绝对预算**；② 相对回退只报告、不翻红；
 * ③ 不参与门禁的项必须带理由外显，不能悄悄少查一项（"没判的"不许看起来像"没问题"）。
 */
describe("性能门禁汇总（R83：绝对预算进退出码，相对波动不进）", () => {
  const allPass = {
    cold_to_editable: true,
    hot_to_editable: true,
    keystroke_p95: true,
    idle_rss: true,
  };
  const noRegression = { regressions: [] as Array<{ metric: string }> };

  it("预算全达标 ⇒ ok=true，三个清单都空", () => {
    expect(summarizePerfGate(allPass, noRegression)).toEqual({
      ok: true,
      failedBudgets: [],
      regressions: [],
      excluded: [],
    });
  });

  it("本轮实测的那种形态：只有 cold_to_editable 一条不达标 ⇒ ok=false 并点名它", () => {
    const gate = summarizePerfGate({ ...allPass, cold_to_editable: false }, noRegression);
    expect(gate.ok).toBe(false);
    expect(gate.failedBudgets).toEqual(["cold_to_editable"]);
  });

  it("无基线（comparison 全绿）也不放行：预算红就是红", () => {
    // comparePerfMetrics 首次运行无基线时 ok=true 只是"没比过"，与本函数是两件事
    const gate = summarizePerfGate({ cold_to_editable: false }, { regressions: [] });
    expect(gate.ok).toBe(false);
    expect(gate.failedBudgets).toEqual(["cold_to_editable"]);
  });

  it("相对基线回退超阈 ⇒ 点名但**不翻红**（同机两遍可差 2 倍，见上方注释）", () => {
    const gate = summarizePerfGate(allPass, {
      regressions: [{ metric: "keystroke_mega_p95_ms" }, { metric: "chapter_write_ms" }],
    });
    expect(gate.ok).toBe(true);
    expect(gate.regressions).toEqual(["keystroke_mega_p95_ms", "chapter_write_ms"]);
  });

  it("回退与预算失败同时存在 ⇒ 因预算翻红，回退项照样列出（两件事都看得见）", () => {
    const gate = summarizePerfGate(
      { ...allPass, idle_rss: false },
      { regressions: [{ metric: "query_p95_ms" }] },
    );
    expect(gate.ok).toBe(false);
    expect(gate.failedBudgets).toEqual(["idle_rss"]);
    expect(gate.regressions).toEqual(["query_p95_ms"]);
  });

  it("排除项带理由外显且不参与判定；其余项照常判", () => {
    const gate = summarizePerfGate(
      { cold_to_editable: false, hot_to_editable: true },
      noRegression,
      { excluded: [{ name: "cold_to_editable", reason: "夹具刚生成（冷盘首跑）" }] },
    );
    expect(gate.ok).toBe(true);
    expect(gate.failedBudgets).toEqual([]);
    expect(gate.excluded).toEqual([{ name: "cold_to_editable", reason: "夹具刚生成（冷盘首跑）" }]);
  });

  it("多条不达标时按传入键序点名（清单要能逐条核对，不靠计数）", () => {
    const gate = summarizePerfGate({ a: false, b: true, c: false, d: true }, noRegression);
    expect(gate.failedBudgets).toEqual(["a", "c"]);
  });

  it("非布尔值一律按未达标处理（防「缺一条」被当成「过了」）", () => {
    const gate = summarizePerfGate(
      { a: true, b: undefined, c: null, d: 1 } as unknown as Record<string, boolean>,
      noRegression,
    );
    expect(gate.failedBudgets).toEqual(["b", "c", "d"]);
  });

  it("排除项写了不存在的检查项 ⇒ 照样如实列出，不静默丢弃", () => {
    const gate = summarizePerfGate(allPass, noRegression, {
      excluded: [{ name: "不存在的项", reason: "手误" }],
    });
    expect(gate.ok).toBe(true);
    expect(gate.excluded).toEqual([{ name: "不存在的项", reason: "手误" }]);
  });
});