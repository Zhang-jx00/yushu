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