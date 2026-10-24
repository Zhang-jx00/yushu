/* SPDX-License-Identifier: Apache-2.0 */
import type { StatsPacePayload } from "../shared/ipc.js";
import { shiftDateKey } from "./stats-days.js";

/**
 * 近 30 天的节奏（R158：码字统计页右栏那一列）。
 *
 * 这一层是**纯函数**：给一份逐日记录，它算出一段连续 30 天的序列与三项节奏数。
 * 为什么必须在主进程算：
 * - **逐日序列**（缺失日补 0）在渲染层算过一次了——同一份序列在页面上出现两处
 *   （中栏的柱状图、右栏的逐日日历）时，两处必须读**同一个**数 ⇒ 补零这件事
 *   只能做一次，做在主进程，序列进载荷（`pace.calendar`）；
 * - **完成比例**（今日已写 ÷ 目标）与**日均**（近 30 天合计 ÷ 30）也是同理：
 *   界面自己算就会出现"页面上两处比例不一样"。
 *
 * 口径三条：
 * ① 窗口是**自然日**（含今天，往前 29 天），缺失日按 0 计（不是"没写"而是"那天没有净增"）；
 * ② 日均 = 近 30 天合计 ÷ 30（**每个自然日**，不是"有产出的那天"）——
 *    界面上要把分母写出来，否则作者会当成"日均（活跃日）"；
 * ③ 最好的一天只认**净增为正**的那天；近 30 天没有产出时如实给 `null`（界面显示「—」）。
 */

/** 节奏窗口（天）：右栏「近 30 天」这一段的宽度 */
export const PACE_WINDOW_DAYS = 30;

/** 逐日记录（只要日期与净增；其余字段与节奏无关） */
export interface StatsPaceInput {
  date: string;
  delta: number;
}

/**
 * 算近 30 天的节奏结构。
 *
 * @param entries 逐日记录（可以多于 30 天，也可以少于；窗口外的会被忽略）
 * @param todayKey 今天（本地时区日键 YYYY-MM-DD）
 * @param goal 每日目标字数（0 = 未设目标 ⇒ 完成比例给 0，不假装有进度）
 */
export function buildStatsPace(
  entries: readonly StatsPaceInput[],
  todayKey: string,
  goal: number,
): StatsPacePayload {
  const byDate = new Map<string, number>();
  for (const entry of entries) byDate.set(entry.date, entry.delta);

  // 连续 30 个自然日（含今天），缺失日补 0
  const calendar: StatsPacePayload["calendar"] = [];
  for (let i = PACE_WINDOW_DAYS - 1; i >= 0; i -= 1) {
    const date = shiftDateKey(todayKey, -i);
    calendar.push({ date, delta: byDate.get(date) ?? 0 });
  }

  const total = calendar.reduce((sum, day) => sum + day.delta, 0);
  const activeDays = calendar.filter((day) => day.delta > 0).length;
  let bestDay: StatsPacePayload["bestDay"] = null;
  for (const day of calendar) {
    if (day.delta <= 0) continue;
    if (bestDay === null || day.delta > bestDay.delta) bestDay = { date: day.date, delta: day.delta };
  }

  const todayWritten = byDate.get(todayKey) ?? 0;
  const progressPercent =
    goal > 0 ? Math.max(0, Math.min(100, Math.round((todayWritten / goal) * 100))) : 0;

  return {
    days: PACE_WINDOW_DAYS,
    goal,
    todayWritten,
    progressPercent,
    calendar,
    total,
    avgPerDay: Math.round(total / PACE_WINDOW_DAYS),
    activeDays,
    bestDay,
  };
}
