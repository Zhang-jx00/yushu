import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { YushuError } from "@yushu/core";
import type { StatsDailyEntryPayload, StatsStatePayload } from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";

/**
 * 码字统计（M2 / T2-9 切片 A；docs/01 §4.6 作者刚需套件）：
 *
 * - 数据存 `.yushu/stats.json`（作者操作数据，与 `.yushu/ai-usage.jsonl` 同类：索引排除、不入 Git）；
 * - **口径**：章节保存（编辑器 writeChapterBody / AI 采纳 adoptDraft）时按「章节净增字数」记账
 *   （countWords 口径，与导出对账一致；删改可为负；delta=0 的保存不计入，避免"空保存"污染活跃日）；
 * - 日键为**本地时区** YYYY-MM-DD（写作日历按本地日）；`updated_at` 供诊断；
 * - 读写原子（tmp → rename）；文件损坏时读取回退默认值（不静默删，下一次记账覆盖写）；
 * - 汇总：今日 / 最近 7 天 / 最近 30 天 / 全部 / 活跃天数 / 日均（活跃日）/ 最佳单日 / 断更天数 / 连续天数。
 *
 * 明确不在此切片：速度曲线、按平台口径的「当日有效字数」（切片 B）。
 */

export const STATS_PATH = ".yushu/stats.json";
export const DEFAULT_DAILY_GOAL = 3000;
/** 返回给面板的最近天数（柱状图数据窗口；文件本身保留全部历史） */
export const STATS_WINDOW_DAYS = 90;

interface StatsFile {
  schema_version: number;
  goal: { daily: number };
  updated_at: string;
  /** date(YYYY-MM-DD) → 当日聚合 */
  daily: Record<string, { delta: number; saves: number }>;
}

function defaultStatsFile(): StatsFile {
  return { schema_version: 1, goal: { daily: DEFAULT_DAILY_GOAL }, updated_at: "", daily: {} };
}

/** 本地时区日期键（YYYY-MM-DD） */
export function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 两日期键之间的整天差（to - from；按 UTC 解析避免夏令时误差） */
export function diffDays(from: string, to: string): number {
  const parse = (key: string) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

async function readStatsFile(gateway: ProjectGateway): Promise<StatsFile> {
  try {
    const raw = await fs.readFile(join(gateway.root, STATS_PATH), "utf8");
    const data = JSON.parse(raw) as StatsFile;
    if (data && typeof data === "object" && data.daily && typeof data.daily === "object") {
      return {
        schema_version: typeof data.schema_version === "number" ? data.schema_version : 1,
        goal: {
          daily:
            typeof data.goal?.daily === "number" && Number.isFinite(data.goal.daily) && data.goal.daily >= 0
              ? Math.floor(data.goal.daily)
              : DEFAULT_DAILY_GOAL,
        },
        updated_at: typeof data.updated_at === "string" ? data.updated_at : "",
        daily: data.daily,
      };
    }
  } catch {
    /* 缺失 / 损坏：回退默认值（不静默删文件） */
  }
  return defaultStatsFile();
}

async function writeStatsFile(gateway: ProjectGateway, file: StatsFile): Promise<void> {
  const abs = join(gateway.root, STATS_PATH);
  await fs.mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
  await fs.rename(tmp, abs);
}

/**
 * 记账一次章节保存（净增字数；delta=0 不计入）。
 * 实现内部不吞异常（便于单测断言）；调用方须以 `.catch(() => undefined)` 兜底——
 * 统计失败绝不能阻断保存（统计是辅助数据，非真源）。
 */
export async function recordChapterDelta(
  gateway: ProjectGateway,
  payload: { path: string; oldWords: number; newWords: number; now?: Date },
): Promise<boolean> {
  const delta = payload.newWords - payload.oldWords;
  if (delta === 0) return false;
  const file = await readStatsFile(gateway);
  const key = localDateKey(payload.now ?? new Date());
  const entry = file.daily[key] ?? { delta: 0, saves: 0 };
  entry.delta += delta;
  entry.saves += 1;
  file.daily[key] = entry;
  file.updated_at = (payload.now ?? new Date()).toISOString();
  await writeStatsFile(gateway, file);
  return true;
}

/** 设置每日目标（0 = 清除目标） */
export async function setStatsGoal(gateway: ProjectGateway, daily: number): Promise<{ daily: number }> {
  if (!Number.isInteger(daily) || daily < 0) {
    throw new YushuError("E_INVALID_INPUT", "每日目标必须为 ≥0 的整数（0 表示不设目标）");
  }
  const file = await readStatsFile(gateway);
  file.goal = { daily };
  file.updated_at = new Date().toISOString();
  await writeStatsFile(gateway, file);
  return file.goal;
}

function toEntry(date: string, value: { delta: number; saves: number }): StatsDailyEntryPayload {
  return { date, delta: value.delta, saves: value.saves };
}

/** 汇总统计（now 可注入：单测与"写作日历"按调用方时间口径） */
export async function readStatsState(gateway: ProjectGateway, now?: Date): Promise<StatsStatePayload> {
  const file = await readStatsFile(gateway);
  const todayKey = localDateKey(now ?? new Date());
  const dates = Object.keys(file.daily)
    .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .sort();
  const entries = dates.map((date) => toEntry(date, file.daily[date]!));
  const today = entries.find((entry) => entry.date === todayKey) ?? { date: todayKey, delta: 0, saves: 0 };

  const inWindow = (entry: StatsDailyEntryPayload, days: number) =>
    diffDays(entry.date, todayKey) >= 0 && diffDays(entry.date, todayKey) < days;

  const total = entries.reduce((sum, entry) => sum + entry.delta, 0);
  const week = entries.filter((entry) => inWindow(entry, 7)).reduce((sum, entry) => sum + entry.delta, 0);
  const month = entries.filter((entry) => inWindow(entry, 30)).reduce((sum, entry) => sum + entry.delta, 0);
  const activeDays = entries.length;
  const avgActiveDay = activeDays > 0 ? Math.round(total / activeDays) : 0;
  const bestDay = entries.reduce<StatsDailyEntryPayload | null>(
    (best, entry) => (best === null || entry.delta > best.delta ? entry : best),
    null,
  );

  // 断更与连续天数：以「最后活跃日」为锚（未来日期（改系统时间等）按今天截断处理避免负数）
  const lastActive = entries.length > 0 ? entries[entries.length - 1]!.date : null;
  const rawGap = lastActive === null ? null : diffDays(lastActive, todayKey);
  const daysSinceLastWriting = rawGap === null ? null : Math.max(0, rawGap);
  let streakDays = 0;
  if (lastActive !== null && rawGap !== null && rawGap <= 1) {
    // 从最后活跃日向前回推连续天数（今天未写但昨天写了也不断）
    let cursor = lastActive;
    while (file.daily[cursor]) {
      streakDays += 1;
      const prev = new Date(Date.UTC(Number(cursor.slice(0, 4)), Number(cursor.slice(5, 7)) - 1, Number(cursor.slice(8, 10)) - 1));
      const pad = (value: number) => String(value).padStart(2, "0");
      cursor = `${prev.getUTCFullYear()}-${pad(prev.getUTCMonth() + 1)}-${pad(prev.getUTCDate())}`;
    }
  }

  return {
    goal: file.goal,
    today,
    daily: entries.slice(-STATS_WINDOW_DAYS),
    summary: { week, month, total, activeDays, avgActiveDay, bestDay },
    daysSinceLastWriting,
    streakDays,
  };
}