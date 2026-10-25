/* SPDX-License-Identifier: Apache-2.0 */
import { publishAtDueMs, type PublishEvent, type PublishStatus } from "./publish.js";

/**
 * 存稿池与续航天数（R174 / M5 T5-6 剩余片之一，引擎侧）。
 *
 * 判据回源（不是这里发明的）：
 * - **I01 §3.5**「存稿池与续航天数 → 存稿章数 ÷ 日更章数 = 可支撑天数；低于阈值（如 3 天 / 7 天）
 *   触发断更预警，与 I08 统计模块共用日历」——分子分母与"预警"这条都出自这里；
 * - **I01 §5 功能建议**「章节列表按状态分组（草稿箱 / 存稿池 / 待发布 / 已发布），存稿池显示
 *   "可支撑 N 天"续航指标」；
 * - **I01 §3.7 / §5**「定时发布为本地提醒队列，不代替平台发布」——本模块只管"什么时候能发"的账，
 *   不碰平台，也不替作者发。
 *
 * **四条本轮定死的口径**：
 * ① **不另造一套时间字段**：「什么时候能发」只有一个出处 —— 章 frontmatter 的 `publish_at`。
 *    到期判定调的是引擎里**同一个**函数（`publishAtDueMs`，R174 从 `planPublishReminders` 里拎出来的），
 *    不许这里再写一遍比较式：两处各写一遍，哪天改了一边就是两个数。
 * ② **存稿池是 draft 的一个筛出来的子集，不是第四个状态**（docs/04 T5-6 注记原话）。
 *    筛的条件：还没发出去（`draft`）**且**已经写完（有字）——没写完的稿子不是"攒下的稿"，
 *    它在草稿箱里。**这条是本项目自定**（I01 §5 只给了四分组，没给"写完"的判据）。
 * ③ **日更章数只从发布台账实测**（`config/publish.yaml` 的 `to: published` 留痕）——
 *    **不新造一个"每天更几章"的字段**：那是另一个事实，而台账里已经记着作者真实发过多少章。
 *    样本不足时**明写算不出**，不拿 0 充数（"没查过"与"查过没问题"必须分得开）。
 * ④ **不读墙钟**：时刻一律由调用方给（同输入必得同输出，与导出装配同一条口径）。
 */

/** 临期窗口：48 小时（**本项目自定** —— I01 §2.4 的真实更新时间是"午间 12 点 / 晚间 8 点双更"，48 小时 ≈ 下一个更新日之前） */
export const STOCK_SOON_WINDOW_MS = 48 * 60 * 60 * 1000;

/** 断更预警阈值：可撑天数低于它就报（**本项目自定** —— I01 §3.5 原文给的是"如 3 天 / 7 天"） */
export const STOCK_WARN_DAYS = 3;

/** 日更速率的观察窗：最近 30 天（**本项目自定**） */
export const STOCK_RATE_WINDOW_DAYS = 30;

/** 判据出处（面板上要能点名"这是哪条规则判的"） */
export const PUBLISH_STOCK_ORIGIN =
  "御书存稿池与续航（I01 §3.5 存稿池与续航天数 · §5 章节列表按状态分组）";

/** 一章在存稿池里的四种处境 */
export type StockDueState =
  /** 到期：publish_at 已过点 */
  | "due"
  /** 临期：publish_at 在临期窗口内（还没到点） */
  | "soon"
  /** 已定时：publish_at 设了，但还没进临期窗口 */
  | "scheduled"
  /** 存稿：没定什么时候发 */
  | "stock";

export interface StockInputRow {
  id: string;
  title: string;
  status: PublishStatus;
  wordCount: number;
  /** 计划发布时刻（ISO 串）；没设 = 不参与定时 */
  publishAt?: string;
}

export interface StockRow {
  id: string;
  title: string;
  wordCount: number;
  /** 计划发布时刻；空串 = 没定时 */
  publishAt: string;
  dueState: StockDueState;
  /** 到期时长（毫秒）：正 = 已过点；soon / scheduled 为负（还差这么多） */
  dueMs: number;
}

export interface StockEndurance {
  /** 待发稿池章数（写完还没发出去的） */
  poolCount: number;
  /** 其中：没定时的（纯存稿） */
  stockCount: number;
  /** 其中：定了时的（待发布） */
  scheduledCount: number;
  /** 到期条数 */
  dueCount: number;
  /** 临期条数 */
  soonCount: number;
  /** 观察窗天数（算日更速率用的） */
  windowDays: number;
  /** 实测日更章数；样本不足为 null（不拿 0 充数） */
  dailyChapters: number | null;
  /** 可支撑天数；样本不足为 null */
  days: number | null;
  /** 断更预警；空串 = 不预警 */
  warning: string;
  /** 这几个数是怎么来的（面板上要写出来，不让作者对着一个数猜） */
  note: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** 码点序比较（红线 5：不用 localeCompare，同输入必得同输出） */
function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * "YYYY-MM-DD" → 该日的日序号（按 UTC 算，避开时区与夏令时）。
 *
 * 台账时刻由 `localIsoNow` 写（带本地偏移），所以 `at` 的日期部分**就是作者的本地日期**，
 * 直接取前 10 位即可，不需要再做时区换算。
 */
function dayNumber(date: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(date.trim());
  if (m === null) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const ms = Date.UTC(year, month - 1, day);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
    return null;
  }
  return Math.floor(ms / DAY_MS);
}

/** 定小数位（四舍五入到 1e-N，避免 1/3 这种除不尽的浮点尾巴漏到界面上） */
function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/**
 * 一章处在哪种处境。
 *
 * **到期判定调 `publishAtDueMs`**（与定时提醒队列同一个函数）⇒ 面板上的"到期 N 条"
 * 与"定时提醒 N 条"永远是同一个口径，不会出现两个数。
 */
function classify(publishAt: string | undefined, nowMs: number): { dueState: StockDueState; dueMs: number } {
  const due = publishAtDueMs(publishAt, nowMs);
  if (due !== null) return { dueState: "due", dueMs: due };
  if (publishAt === undefined || publishAt.trim() === "") return { dueState: "stock", dueMs: 0 };
  const atMs = Date.parse(publishAt);
  // 时刻读不出来 ⇒ 当作没定时（不编一个到期出来，也不假装它还在未来）
  if (Number.isNaN(atMs)) return { dueState: "stock", dueMs: 0 };
  const remaining = atMs - nowMs;
  if (remaining <= STOCK_SOON_WINDOW_MS) return { dueState: "soon", dueMs: -remaining };
  return { dueState: "scheduled", dueMs: -remaining };
}

const STATE_RANK: Record<StockDueState, number> = { due: 0, soon: 1, scheduled: 2, stock: 3 };

/**
 * 存稿池 + 续航。**纯函数、零 fs、不读墙钟**（时刻由调用方给）。
 *
 * 三段口径：
 * ① **池子 = 还没发出去且已经写完的章**（`draft` + 有字）——published / revised 的章不在池里
 *    （它们已经发出去过，或正在改已发出去的稿）；
 * ② **到期 / 临期只看 `publish_at`**：到期 = 已过点；临期 = 未来 48 小时内到点；
 * ③ **续航 = 池子章数 ÷ 实测日更章数**：日更章数从发布台账的 `to: published` 留痕里数，
 *    观察窗 = 最早那次发布到今天（含），最长 30 天。
 */
export function planStockPool(input: {
  rows: readonly StockInputRow[];
  events: readonly PublishEvent[];
  now: string;
}): { rows: StockRow[]; endurance: StockEndurance } {
  const nowMs = Date.parse(input.now);
  const nowDay = dayNumber(input.now);
  if (Number.isNaN(nowMs) || nowDay === null) {
    return {
      rows: [],
      endurance: {
        poolCount: 0,
        stockCount: 0,
        scheduledCount: 0,
        dueCount: 0,
        soonCount: 0,
        windowDays: 0,
        dailyChapters: null,
        days: null,
        warning: "",
        note: "时刻读不出来，本轮不列存稿池、不判续航",
      },
    };
  }

  const rows: StockRow[] = [];
  for (const row of input.rows) {
    if (row.status !== "draft") continue;
    if (row.wordCount <= 0) continue;
    const { dueState, dueMs } = classify(row.publishAt, nowMs);
    rows.push({
      id: row.id,
      title: row.title,
      wordCount: row.wordCount,
      publishAt: row.publishAt ?? "",
      dueState,
      dueMs,
    });
  }
  rows.sort((a, b) => {
    const rank = STATE_RANK[a.dueState] - STATE_RANK[b.dueState];
    if (rank !== 0) return rank;
    const byTime = byCodePoint(a.publishAt, b.publishAt);
    if (byTime !== 0) return byTime;
    return byCodePoint(a.id, b.id);
  });

  const dueCount = rows.filter((row) => row.dueState === "due").length;
  const soonCount = rows.filter((row) => row.dueState === "soon").length;
  const stockCount = rows.filter((row) => row.dueState === "stock").length;
  const scheduledCount = rows.length - stockCount;

  // 日更速率：只数台账里"发出去过"的留痕（to: published），同一章发多次只算一章
  const windowStartDay = nowDay - (STOCK_RATE_WINDOW_DAYS - 1);
  const chapters = new Set<string>();
  let earliestDay: number | null = null;
  for (const event of input.events) {
    if (event.to !== "published") continue;
    const day = dayNumber(event.at);
    if (day === null) continue;
    if (day < windowStartDay || day > nowDay) continue;
    chapters.add(event.chapterId);
    if (earliestDay === null || day < earliestDay) earliestDay = day;
  }

  const poolCount = rows.length;
  if (chapters.size === 0 || earliestDay === null) {
    return {
      rows,
      endurance: {
        poolCount,
        stockCount,
        scheduledCount,
        dueCount,
        soonCount,
        windowDays: 0,
        dailyChapters: null,
        days: null,
        warning: "",
        note: `还没有发布记录，算不出日更章数（不拿 0 充数）；池子里有 ${String(poolCount)} 章`,
      },
    };
  }

  const windowDays = Math.min(STOCK_RATE_WINDOW_DAYS, nowDay - earliestDay + 1);
  const dailyChapters = round(chapters.size / windowDays, 2);
  const days = dailyChapters > 0 ? round(poolCount / dailyChapters, 1) : 0;
  const warning =
    days < STOCK_WARN_DAYS
      ? `存稿只够撑 ${String(days)} 天（阈值 ${String(STOCK_WARN_DAYS)} 天）：先把稿子发出去，或补写存稿`
      : "";

  return {
    rows,
    endurance: {
      poolCount,
      stockCount,
      scheduledCount,
      dueCount,
      soonCount,
      windowDays,
      dailyChapters,
      days,
      warning,
      note:
        `日更章数取发布台账实测：最近 ${String(windowDays)} 天共发 ${String(chapters.size)} 章` +
        ` ⇒ 日均 ${String(dailyChapters)} 章；池子 ${String(poolCount)} 章 ⇒ 可撑 ${String(days)} 天`,
    },
  };
}
