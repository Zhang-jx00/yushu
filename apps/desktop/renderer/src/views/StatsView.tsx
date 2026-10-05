import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  StatsDailyEntryPayload,
  StatsSpeedPointPayload,
  StatsStatePayload,
} from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 码字统计（T2-9 切片 A/B）：
 * - 切片 A：今日目标进度 / 断更与连续天数 / 周月汇总 / 最近 30 天柱状图 / 目标设置；
 * - 切片 B：平台口径有效字数与档位（去空白换算，参考番茄 4,000 / 6,000，I08）、
 *   节奏曲线（最近 30 天 7 日滑动平均，字/天）、写作日历热力图（最近 12 周，档位配色 + 点击查看单日）。
 * 口径：章节净增字数（编辑器保存与 AI 采纳均计；本地时区日）；统计失败不影响写作（辅助数据）。
 */

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

/** 最近 N 个自然日补齐（缺失日为 0）——柱状图 / 热力图按日连续排列，直观反映写作节奏 */
function fillDays(daily: StatsDailyEntryPayload[], days: number, todayKey: string): StatsDailyEntryPayload[] {
  const byDate = new Map(daily.map((entry) => [entry.date, entry]));
  const out: StatsDailyEntryPayload[] = [];
  const base = new Date(`${todayKey}T00:00:00`);
  const pad = (value: number) => String(value).padStart(2, "0");
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(base);
    day.setDate(day.getDate() - i);
    const key = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    out.push(byDate.get(key) ?? { date: key, delta: 0, saves: 0, effective: 0 });
  }
  return out;
}

/** 速度曲线（切片 B）：纯 SVG 折线（7 日滑动平均，字/天）+ 目标参考虚线；无第三方依赖 */
function SpeedChart({ points, goal }: { points: StatsSpeedPointPayload[]; goal: number }) {
  const W = 600;
  const H = 96;
  const PAD = 6;
  const max = Math.max(1, goal > 0 ? goal : 0, ...points.map((point) => point.avg));
  const x = (index: number) => PAD + (index * (W - PAD * 2)) / Math.max(1, points.length - 1);
  const y = (value: number) => H - PAD - (Math.max(0, value) / max) * (H - PAD * 2);
  const line = points.map((point, index) => `${x(index).toFixed(1)},${y(point.avg).toFixed(1)}`).join(" ");
  const current = points.length > 0 ? points[points.length - 1]!.avg : 0;
  return (
    <div className="stats-speed">
      <div className="muted">
        节奏曲线：最近 30 天 7 日滑动平均（字/天）｜ 当前 {formatNumber(current)}
        {goal > 0 && ` ｜ 目标线 ${formatNumber(goal)}`}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="写作节奏曲线（7 日滑动平均）">
        {goal > 0 && <line className="speed-goal" x1={PAD} x2={W - PAD} y1={y(goal)} y2={y(goal)} />}
        <polyline className="speed-line" points={line} />
      </svg>
    </div>
  );
}

/** 热力图窗口（天）：12 周整，周一为列顶（84 = 12 × 7） */
const HEAT_DAYS = 84;

export function StatsView() {
  const [state, setState] = useState<StatsStatePayload | null>(null);
  const [goalInput, setGoalInput] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [heatPick, setHeatPick] = useState<StatsDailyEntryPayload | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const next = await api().stats.read();
      setState(next);
      setGoalInput(String(next.goal.daily));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveGoal = async () => {
    const value = Number(goalInput.trim());
    if (!Number.isInteger(value) || value < 0) {
      setError("目标必须为 ≥0 的整数（0 表示不设目标）");
      return;
    }
    try {
      setError(null);
      const goal = await api().stats.setGoal({ daily: value });
      setStatus(goal.daily > 0 ? `已设置每日目标 ${formatNumber(goal.daily)} 字` : "已清除每日目标");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const chart = state ? fillDays(state.daily, 30, state.today.date) : [];
  const maxAbs = Math.max(1, ...chart.map((entry) => Math.abs(entry.delta)));
  const goal = state?.goal.daily ?? 0;
  const todayDelta = state?.today.delta ?? 0;
  const todayEffective = state?.today.effective ?? 0;
  const tiers = state?.tiers ?? { basic: 4000, advanced: 6000 };
  const progress = goal > 0 ? Math.max(0, Math.min(100, Math.round((todayDelta / goal) * 100))) : 0;
  const tierLabel =
    todayEffective >= tiers.advanced ? "进阶档" : todayEffective >= tiers.basic ? "普通档" : "未达标";
  const tierClass =
    todayEffective >= tiers.advanced ? "is-advanced" : todayEffective >= tiers.basic ? "is-basic" : "is-none";

  const heat = useMemo(() => {
    if (!state) return { lead: 0, cells: [] as StatsDailyEntryPayload[] };
    const cells = fillDays(state.daily, HEAT_DAYS, state.today.date);
    const first = cells[0];
    // 周一为列顶（getDay: 0=周日 → 周一偏移 0）
    const lead = first ? (new Date(`${first.date}T00:00:00`).getDay() + 6) % 7 : 0;
    return { lead, cells };
  }, [state]);

  /** 热力强度：对齐平台档位（4,000 / 6,000 深色分界）；净删为红色警示 */
  const heatLevel = (entry: StatsDailyEntryPayload): string => {
    if (entry.saves === 0) return "l0";
    if (entry.delta < 0) return "lneg";
    if (entry.delta >= tiers.advanced) return "l4";
    if (entry.delta >= tiers.basic) return "l3";
    if (entry.delta >= 1000) return "l2";
    return "l1";
  };

  return (
    <div className="stats">
      <div className="panel">
        <div className="panel-title">
          <span className="muted">码字统计（.yushu/stats.json · 章节净增字数口径）</span>
          <button type="button" className="link" onClick={() => void refresh()}>
            刷新
          </button>
        </div>
        {state ? (
          <>
            <div className="stats-today">
              <div className="stats-today-main">
                今日 <strong>{formatNumber(todayDelta)}</strong> 字
                {goal > 0 && <span className="muted"> / 目标 {formatNumber(goal)} 字</span>}
              </div>
              {goal > 0 && (
                <div className="stats-progress" title={`完成 ${progress}%`}>
                  <div className="stats-progress-bar" style={{ width: `${progress}%` }} />
                </div>
              )}
              <div className="stats-effective">
                <span className="muted">有效字数（去空白口径）</span>
                <strong>{formatNumber(todayEffective)}</strong>
                <span className={`stats-tier ${tierClass}`}>{tierLabel}</span>
                <span className="muted">
                  档位参考：{formatNumber(tiers.basic)} 普通 / {formatNumber(tiers.advanced)} 进阶（本地估算，以后台为准）
                </span>
              </div>
              <div className="muted">
                {state.streakDays > 0 ? `连续写作 ${state.streakDays} 天` : "尚无连续写作记录"}
                {state.daysSinceLastWriting === null
                  ? " · 尚未开始写作"
                  : state.daysSinceLastWriting === 0
                    ? " · 今日已写作"
                    : ` · 距上次写作 ${state.daysSinceLastWriting} 天`}
              </div>
              {state.daysSinceLastWriting !== null && state.daysSinceLastWriting >= 2 && (
                <div className="stats-warn">断更预警：已连续 {state.daysSinceLastWriting} 天没有码字记录</div>
              )}
            </div>
            <div className="stats-grid">
              <div>
                <span className="muted">最近 7 天</span>
                <strong>{formatNumber(state.summary.week)}</strong>
              </div>
              <div>
                <span className="muted">最近 30 天</span>
                <strong>{formatNumber(state.summary.month)}</strong>
              </div>
              <div>
                <span className="muted">30 天有效字数</span>
                <strong>{formatNumber(state.summary.monthEffective)}</strong>
              </div>
              <div>
                <span className="muted">累计</span>
                <strong>{formatNumber(state.summary.total)}</strong>
              </div>
              <div>
                <span className="muted">活跃天数</span>
                <strong>{state.summary.activeDays}</strong>
              </div>
              <div>
                <span className="muted">日均（活跃日）</span>
                <strong>{formatNumber(state.summary.avgActiveDay)}</strong>
              </div>
              <div>
                <span className="muted">最佳单日</span>
                <strong>
                  {state.summary.bestDay
                    ? `${formatNumber(state.summary.bestDay.delta)}（${state.summary.bestDay.date}）`
                    : "—"}
                </strong>
              </div>
            </div>
            <div className="stats-goal">
              <span className="muted">每日目标</span>
              <input
                value={goalInput}
                inputMode="numeric"
                aria-label="每日目标字数"
                onChange={(event) => setGoalInput(event.target.value)}
              />
              <button type="button" onClick={() => void saveGoal()}>
                保存目标
              </button>
              {status && <span className="muted">{status}</span>}
            </div>
            <div className="stats-chart">
              <div className="muted">最近 30 天（柱高 = 当日净增字数；空日为 0，负值为红色标记）</div>
              <div className="stats-bars">
                {chart.map((entry) => {
                  const posHeight = Math.round((Math.max(0, entry.delta) / maxAbs) * 100);
                  const height = entry.delta < 0 ? 4 : Math.max(entry.delta > 0 ? 3 : 0, posHeight);
                  return (
                    <div
                      key={entry.date}
                      className={entry.delta < 0 ? "stats-bar neg" : "stats-bar"}
                      style={{ height: `${height}%` }}
                      title={`${entry.date} · ${entry.delta >= 0 ? "+" : ""}${entry.delta} 字`}
                    />
                  );
                })}
              </div>
            </div>
            <SpeedChart points={state.speed} goal={goal} />
            <div className="stats-heatmap">
              <div className="muted">
                写作日历（最近 12 周；颜色越深当日净增越多，深色分界对齐 {formatNumber(tiers.basic)} /{" "}
                {formatNumber(tiers.advanced)} 档位；红色 = 净删）
              </div>
              <div className="stats-heat-grid">
                {Array.from({ length: heat.lead }, (_, index) => (
                  <div key={`pad-${index}`} className="heat-pad" />
                ))}
                {heat.cells.map((entry) => (
                  <button
                    key={entry.date}
                    type="button"
                    className={`heat-cell ${heatLevel(entry)}${heatPick?.date === entry.date ? " on" : ""}`}
                    title={`${entry.date} · ${entry.delta >= 0 ? "+" : ""}${entry.delta} 字 · 保存 ${entry.saves} 次`}
                    aria-label={`${entry.date}：${entry.delta} 字`}
                    onClick={() => setHeatPick(entry)}
                  />
                ))}
              </div>
              <div className="heat-foot">
                <span className="heat-legend">
                  <span>少</span>
                  <span className="heat-cell l0" />
                  <span className="heat-cell l1" />
                  <span className="heat-cell l2" />
                  <span className="heat-cell l3" />
                  <span className="heat-cell l4" />
                  <span>多</span>
                  <span className="heat-cell lneg" />
                  <span>净删</span>
                </span>
                {heatPick && (
                  <span className="muted">
                    {heatPick.date}：净增 {formatNumber(heatPick.delta)} 字 · 保存 {heatPick.saves} 次 · 有效{" "}
                    {formatNumber(heatPick.effective)} 字
                  </span>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="muted">加载中…</div>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
    </div>
  );
}