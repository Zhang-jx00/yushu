/* SPDX-License-Identifier: Apache-2.0 */
/**
 * 性能回归对比（M2 / T2-10 遗留：报告 diff 防退化）：
 * 把本次 PERF_RESULT 指标与「上一次同夹具报告」逐项对比——变差超过阈值（默认 20%）标记回退，
 * 显著变好标记改善（rebuild_cpm 为吞吐、越高越好，方向取反）。
 *
 * 纯逻辑（报告对象注入，不碰 fs / Electron），vitest 直接单测；
 * perf runner 在写入报告前读取夹具目录中的上一份报告并调用本模块，把结果并入 PERF_RESULT 输出。
 * 无基线（首次运行）→ ok=true 且如实标注，不制造伪回退。
 */

export interface PerfMetricRow {
  metric: string;
  previous: number;
  current: number;
  /** 相对变化（正 = 变差；百分数保留 1 位） */
  deltaPct: number;
  status: "regression" | "improved" | "stable";
}

export interface PerfComparisonResult {
  /** 无超过阈值的回退（无基线视为 ok，见 baselineDate=null） */
  ok: boolean;
  thresholdRatio: number;
  /** 基线报告时间（无基线为 null） */
  baselineDate: string | null;
  rows: PerfMetricRow[];
  regressions: PerfMetricRow[];
}

/** 越高越好的指标（其余按越低越好） */
export const HIGHER_IS_BETTER_METRICS: readonly string[] = ["rebuild_cpm"];

/** 默认回退阈值（变差超过 20% 视为回退） */
export const DEFAULT_REGRESSION_THRESHOLD = 0.2;

export interface PerfReportLike {
  date?: string;
  metrics?: Record<string, unknown>;
}

export function comparePerfMetrics(
  previous: PerfReportLike | null,
  current: { metrics: Record<string, unknown> },
  options: { thresholdRatio?: number } = {},
): PerfComparisonResult {
  const thresholdRatio = options.thresholdRatio ?? DEFAULT_REGRESSION_THRESHOLD;
  const prevMetrics = previous?.metrics ?? {};
  const rows: PerfMetricRow[] = [];

  for (const [metric, value] of Object.entries(current.metrics)) {
    if (typeof value !== "number" || !Number.isFinite(value)) continue; // 参考项（如大章缺失）不参与
    const prev = prevMetrics[metric];
    if (typeof prev !== "number" || !Number.isFinite(prev) || prev === 0) continue;
    const higherBetter = HIGHER_IS_BETTER_METRICS.includes(metric);
    // 统一成「变差比例」：越低越好 → (current - prev) / |prev|；越高越好 → 取反
    const worseRatio = higherBetter ? (prev - value) / Math.abs(prev) : (value - prev) / Math.abs(prev);
    const deltaPct = Math.round(worseRatio * 1000) / 10;
    const status: PerfMetricRow["status"] =
      worseRatio > thresholdRatio ? "regression" : worseRatio < -thresholdRatio ? "improved" : "stable";
    rows.push({ metric, previous: prev, current: value, deltaPct, status });
  }

  const regressions = rows.filter((row) => row.status === "regression");
  return {
    ok: regressions.length === 0,
    thresholdRatio,
    baselineDate: previous?.date ?? null,
    rows,
    regressions,
  };
}

export interface PerfGateExclusion {
  name: string;
  reason: string;
}

export interface PerfGateResult {
  /** **只看绝对预算**：参与门禁的检查项全部达标 */
  ok: boolean;
  /** 未达预算的项名（按传入键序，排除项不计入） */
  failedBudgets: string[];
  /** 相对基线回退超阈的指标名——只报告，不翻红 */
  regressions: string[];
  /** 本轮不参与门禁的项与理由（原样带出，不静默丢弃） */
  excluded: PerfGateExclusion[];
}

/**
 * 把「逐项预算是否达标」与「相对基线是否回退」汇总成一个**能红的门禁结论**（R83）。
 *
 * 为什么要单独抽这个函数：实测撞到 `checks.cold_to_editable:false`、终端也打了 ❌，
 * 探针却仍 `app.exit(0)`——结论算出来了但没人消费它，等于一条永远不会红的门禁。
 * 一条不会红的断言比没有更危险：它让"这轮跑过 perf 了"听起来覆盖了性能回退。
 *
 * 三条刻意的口径（都有本轮实测支撑，不是为了让门禁变绿）：
 * ① **绝对预算翻红、相对回退不翻红**：同一份构建连跑两遍，`cold_to_editable` 3160→1434ms、
 *    `keystroke_mega_p95` 2.8→3.6ms（+28.6%）、`chapter_write_ms` 13→16ms（+23.1%）。
 *    个位数毫秒上的相对波动没有含义，拿 20% 阈值翻退出码就是造一台假红机器；
 *    但回退项必须原样列出，让人看得见（只是不当结论）。
 * ② **非 `true` 一律算未达标**：`undefined` / `null` / 真值 1 都不放行——"缺一条检查"
 *    不能冒充"这条过了"。
 * ③ **排除项必须带理由并原样外显**：写错名字（不存在的检查项）也照样列出，不静默丢弃。
 *    "没判的"永远不许看起来像"没问题"。
 */
export function summarizePerfGate(
  checks: Record<string, boolean>,
  comparison: { regressions: readonly { metric: string }[] },
  options: { excluded?: readonly PerfGateExclusion[] } = {},
): PerfGateResult {
  const excluded: PerfGateExclusion[] = (options.excluded ?? []).map((item) => ({ ...item }));
  const skipped = new Set(excluded.map((item) => item.name));
  const failedBudgets = Object.entries(checks)
    .filter(([name, passed]) => passed !== true && !skipped.has(name))
    .map(([name]) => name);
  return {
    ok: failedBudgets.length === 0,
    failedBudgets,
    regressions: comparison.regressions.map((row) => row.metric),
    excluded,
  };
}