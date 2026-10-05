import { useCallback, useEffect, useState } from "react";
import type { StatsDailyEntryPayload, StatsStatePayload } from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 码字统计（T2-9 切片 A）：今日目标进度 / 断更与连续天数 / 周月汇总 / 最近 30 天柱状图 / 目标设置。
 * 口径：章节净增字数（编辑器保存与 AI 采纳均计；本地时区日）；统计失败不影响写作（辅助数据）。
 */

function formatNumber(value: number): string {
  return value.toLocaleString("zh-CN");
}

/** 最近 N 个自然日补齐（缺失日为 0）——柱状图按日连续排列，直观反映写作节奏 */
function fillDays(daily: StatsDailyEntryPayload[], days: number, todayKey: string): StatsDailyEntryPayload[] {
  const byDate = new Map(daily.map((entry) => [entry.date, entry]));
  const out: StatsDailyEntryPayload[] = [];
  const base = new Date(`${todayKey}T00:00:00`);
  const pad = (value: number) => String(value).padStart(2, "0");
  for (let i = days - 1; i >= 0; i -= 1) {
    const day = new Date(base);
    day.setDate(day.getDate() - i);
    const key = `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
    out.push(byDate.get(key) ?? { date: key, delta: 0, saves: 0 });
  }
  return out;
}

export function StatsView() {
  const [state, setState] = useState<StatsStatePayload | null>(null);
  const [goalInput, setGoalInput] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);

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
  const progress = goal > 0 ? Math.max(0, Math.min(100, Math.round((todayDelta / goal) * 100))) : 0;

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
          </>
        ) : (
          <div className="muted">加载中…</div>
        )}
        {error && <div className="error-text">{error}</div>}
      </div>
    </div>
  );
}