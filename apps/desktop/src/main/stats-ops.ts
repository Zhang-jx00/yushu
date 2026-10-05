import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { YushuError } from "@yushu/core";
import type { StatsDailyEntryPayload, StatsStatePayload } from "../shared/ipc.js";
import { ProjectGateway } from "./file-gateway.js";

/**
 * 码字统计（M2 / T2-9 切片 A/B；docs/01 §4.6 作者刚需套件）：
 *
 * - 数据存 `.yushu/stats.json`（作者操作数据，与 `.yushu/ai-usage.jsonl` 同类：索引排除、不入 Git）；
 * - **口径**：章节保存（编辑器 writeChapterBody / AI 采纳 adoptDraft）时按「章节净增字数」记账
 *   （countWords 口径，与导出对账一致；删改可为负；delta=0 的保存不计入，避免"空保存"污染活跃日）；
 * - **切片 B**：同一挂点附加「平台口径有效字数」净增（`countEffectiveChars`：去空白 / 换行 / 格式符，
 *   参考番茄作家后台「有效更新字数」换算，I08 §3；档位参考 4,000 普通 / 6,000 进阶）与
 *   **速度曲线**（最近 30 天「7 日滑动平均净增」，字/天——识别产能节律；真实字/分钟速度属专注中心，后续切片）；
 * - 日键为**本地时区** YYYY-MM-DD（写作日历按本地日）；`updated_at` 供诊断；
 * - 读写原子（tmp → rename）；文件损坏时读取回退默认值（不静默删，下一次记账覆盖写）；
 * - 汇总：今日 / 最近 7 天 / 最近 30 天 / 全部 / 活跃天数 / 日均（活跃日）/ 最佳单日 / 断更天数 / 连续天数。
 *
 * 兼容：切片 A 时代的每日条目无 `effective` 字段——读取按缺失处理（有效字数从记账起累计），写回不补造历史。
 */

export const STATS_PATH = ".yushu/stats.json";
export const DEFAULT_DAILY_GOAL = 3000;
/** 返回给面板的最近天数（柱状图 / 热力图数据窗口；文件本身保留全部历史） */
export const STATS_WINDOW_DAYS = 90;
/** 速度曲线窗口（天）与滑动平均窗口（天） */
export const SPEED_WINDOW_DAYS = 30;
export const SPEED_AVG_DAYS = 7;
/** 平台档位参考（番茄全勤：普通 4,000 / 进阶 6,000；I08 §3） */
export const EFFECTIVE_TIERS = { basic: 4000, advanced: 6000 } as const;

/** 每日聚合（`effective` 为切片 B 新增：旧文件 / 旧条目可能缺失） */
type DailyAgg = { delta: number; saves: number; effective?: number };

interface StatsFile {
  schema_version: number;
  goal: { daily: number };
  updated_at: string;
  /** date(YYYY-MM-DD) → 当日聚合 */
  daily: Record<string, DailyAgg>;
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

/** 日期键平移 N 天（UTC 算术，跨月 / 跨年安全） */
export function shiftDateKey(key: string, deltaDays: number): string {
  const parse = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
  const shifted = new Date(parse(key) + deltaDays * 86_400_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/**
 * 平台口径「有效字数」（切片 B；I08 §3：番茄后台打卡字数按「去空白 / 格式符」换算）：
 * 去除全部空白（含全角空格与换行），其余可见字符（汉字 / 字母 / 数字 / 标点）计数。
 * 注意：这是**本地估算口径**，平台最终以后台打卡日历为准（UI 如实标注）。
 */
export function countEffectiveChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

/**
 * daily 逐条清洗（第 16 轮复核修复）：只保留 { delta, saves } 均为有限数字的条目；
 * `effective`（切片 B）可选——为有限数字时保留（可为负），否则按缺失处理（不补造）。
 * 部分损坏（如 `"2026-10-05": null` 或字符串）此前会让汇总抛错 / NaN——按「保守丢弃坏条目」处理，
 * 与顶层损坏回退默认值同一策略（不静默删文件）。
 */
function sanitizeDaily(raw: unknown): Record<string, DailyAgg> {
  const out: Record<string, DailyAgg> = {};
  if (raw && typeof raw === "object") {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const entry = value as { delta?: unknown; saves?: unknown; effective?: unknown };
      const delta = typeof entry.delta === "number" && Number.isFinite(entry.delta) ? Math.trunc(entry.delta) : null;
      const saves =
        typeof entry.saves === "number" && Number.isFinite(entry.saves) && entry.saves >= 0 ? Math.trunc(entry.saves) : null;
      if (delta === null || saves === null) continue;
      const effective =
        typeof entry.effective === "number" && Number.isFinite(entry.effective) ? Math.trunc(entry.effective) : undefined;
      out[key] = effective === undefined ? { delta, saves } : { delta, saves, effective };
    }
  }
  return out;
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
        daily: sanitizeDaily(data.daily),
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
 * 记账 / 目标设置的串行队列（第 16 轮复核修复）：两者都是对 stats.json 的「读-改-写」，
 * 并发（如自动保存 flush 与 AI 采纳同时落盘、面板保存目标与记账重叠）会互相覆盖丢记账。
 * 与快照存储同一处理（snapshot-ops withSnapshotLock）：主进程内串行，不跨进程。
 */
let statsQueue: Promise<unknown> = Promise.resolve();
function withStatsLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = statsQueue.then(fn, fn);
  statsQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 记账一次章节保存（净增字数；delta=0 不计入）。
 * 切片 B：可附带平台口径有效字数净增（oldEffective / newEffective，两值都给出才累计；
 * 只加标点导致 words 净增为 0 的保存仍按「空保存」处理、不计入）。
 * 实现内部不吞异常（便于单测断言）；调用方须以 `.catch(() => undefined)` 兜底——
 * 统计失败绝不能阻断保存（统计是辅助数据，非真源）。
 */
export function recordChapterDelta(
  gateway: ProjectGateway,
  payload: {
    path: string;
    oldWords: number;
    newWords: number;
    oldEffective?: number;
    newEffective?: number;
    now?: Date;
  },
): Promise<boolean> {
  return withStatsLock(() => recordChapterDeltaLocked(gateway, payload));
}

async function recordChapterDeltaLocked(
  gateway: ProjectGateway,
  payload: {
    path: string;
    oldWords: number;
    newWords: number;
    oldEffective?: number;
    newEffective?: number;
    now?: Date;
  },
): Promise<boolean> {
  const delta = payload.newWords - payload.oldWords;
  if (delta === 0) return false;
  const file = await readStatsFile(gateway);
  const key = localDateKey(payload.now ?? new Date());
  const entry: DailyAgg = file.daily[key] ?? { delta: 0, saves: 0 };
  entry.delta += delta;
  entry.saves += 1;
  if (payload.oldEffective !== undefined && payload.newEffective !== undefined) {
    entry.effective = (entry.effective ?? 0) + (payload.newEffective - payload.oldEffective);
  }
  file.daily[key] = entry;
  file.updated_at = (payload.now ?? new Date()).toISOString();
  await writeStatsFile(gateway, file);
  return true;
}

/** 设置每日目标（0 = 清除目标） */
export function setStatsGoal(gateway: ProjectGateway, daily: number): Promise<{ daily: number }> {
  if (!Number.isInteger(daily) || daily < 0) {
    return Promise.reject(new YushuError("E_INVALID_INPUT", "每日目标必须为 ≥0 的整数（0 表示不设目标）"));
  }
  return withStatsLock(() => setStatsGoalLocked(gateway, daily));
}

async function setStatsGoalLocked(gateway: ProjectGateway, daily: number): Promise<{ daily: number }> {
  const file = await readStatsFile(gateway);
  file.goal = { daily };
  file.updated_at = new Date().toISOString();
  await writeStatsFile(gateway, file);
  return file.goal;
}

function toEntry(date: string, value: DailyAgg): StatsDailyEntryPayload {
  return value.effective === undefined
    ? { date, delta: value.delta, saves: value.saves, effective: 0 }
    : { date, delta: value.delta, saves: value.saves, effective: value.effective };
}

/**
 * 速度序列（切片 B）：最近 30 天连续日（缺失补 0）的净增与「7 日滑动平均」。
 * 窗口起点不足 7 天时按实际可得天数平均——避免开窗首日出现虚低的均值。
 */
function buildSpeedSeries(entries: StatsDailyEntryPayload[], todayKey: string): StatsStatePayload["speed"] {
  const deltaOf = new Map(entries.map((entry) => [entry.date, entry.delta]));
  const keys: string[] = [];
  for (let i = SPEED_WINDOW_DAYS - 1; i >= 0; i -= 1) keys.push(shiftDateKey(todayKey, -i));
  return keys.map((date, index) => {
    const windowStart = Math.max(0, index - (SPEED_AVG_DAYS - 1));
    let sum = 0;
    for (let j = windowStart; j <= index; j += 1) sum += deltaOf.get(keys[j]!) ?? 0;
    return {
      date,
      delta: deltaOf.get(date) ?? 0,
      avg: Math.round(sum / (index - windowStart + 1)),
    };
  });
}

/** 汇总统计（now 可注入：单测与"写作日历"按调用方时间口径） */
export async function readStatsState(gateway: ProjectGateway, now?: Date): Promise<StatsStatePayload> {
  const file = await readStatsFile(gateway);
  const todayKey = localDateKey(now ?? new Date());
  const dates = Object.keys(file.daily)
    .filter((key) => /^\d{4}-\d{2}-\d{2}$/.test(key))
    .sort();
  const entries = dates.map((date) => toEntry(date, file.daily[date]!));
  const today = entries.find((entry) => entry.date === todayKey) ?? { date: todayKey, delta: 0, saves: 0, effective: 0 };

  const inWindow = (entry: StatsDailyEntryPayload, days: number) =>
    diffDays(entry.date, todayKey) >= 0 && diffDays(entry.date, todayKey) < days;

  const total = entries.reduce((sum, entry) => sum + entry.delta, 0);
  const week = entries.filter((entry) => inWindow(entry, 7)).reduce((sum, entry) => sum + entry.delta, 0);
  const month = entries.filter((entry) => inWindow(entry, 30)).reduce((sum, entry) => sum + entry.delta, 0);
  const monthEffective = entries
    .filter((entry) => inWindow(entry, 30))
    .reduce((sum, entry) => sum + (entry.effective ?? 0), 0);
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
    speed: buildSpeedSeries(entries, todayKey),
    tiers: { ...EFFECTIVE_TIERS },
    summary: { week, month, total, monthEffective, activeDays, avgActiveDay, bestDay },
    daysSinceLastWriting,
    streakDays,
  };
}