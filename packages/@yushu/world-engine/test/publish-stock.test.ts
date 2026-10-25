/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { publishAtDueMs, planPublishReminders, type PublishEvent } from "../src/publish";
import {
  STOCK_RATE_WINDOW_DAYS,
  STOCK_SOON_WINDOW_MS,
  STOCK_WARN_DAYS,
  planStockPool,
  type StockInputRow,
} from "../src/publish-stock";

/**
 * 存稿池与续航天数（R174 / M5 T5-6 剩余片之一，引擎侧）。
 *
 * 判据回源：
 * - **I01 §3.5**「存稿池与续航天数 → 存稿章数 ÷ 日更章数 = 可支撑天数；低于阈值（如 3 天 / 7 天）触发断更预警」；
 * - **I01 §5 功能建议**「章节列表按状态分组（草稿箱 / 存稿池 / 待发布 / 已发布），存稿池显示"可支撑 N 天"续航指标」；
 * - **I01 §3.7 / §5**「定时发布为本地提醒队列，不代替平台发布」。
 *
 * **三条本轮定死的口径**：
 * ① **不另造一套时间字段**——"什么时候能发"只有一个出处：章 frontmatter 的 `publish_at`。
 *    临期 / 到期都用它判，**且用的是引擎里同一个判定函数**（`publishAtDueMs`），
 *    不许存稿池自己再写一遍比较式（两处各写一遍，哪天改了一边就是两个数）。
 * ② **存稿池是 draft 的一个筛出来的子集，不是第四个状态**（docs/04 T5-6 注记原话）。
 *    筛的条件：还没发出去（`draft`）**且**已经写完（有字）——没写完的稿子不是"攒下的稿"，
 *    它在草稿箱里。这条是**本项目自定**（I01 §5 只给了四分组，没给"写完"的判据）。
 * ③ **日更章数只从发布台账实测**（`config/publish.yaml` 的 `to: published` 留痕）——
 *    **不新造一个"每天更几章"的字段**：那是另一个事实，而台账里已经有作者真实发过多少章。
 *    样本不足时**明写算不出**，不拿 0 充数。
 */

const NOW = "2026-10-25T20:00:00+08:00";
const NOW_MS = Date.parse(NOW);

function row(overrides: Partial<StockInputRow> = {}): StockInputRow {
  return { id: "ch-001", title: "第1章 夜探藏经阁", status: "draft", wordCount: 3120, ...overrides };
}

function publishedEvent(id: string, at: string): PublishEvent {
  return { chapterId: id, from: "draft", to: "published", at, wordCount: 3000, rollback: false };
}

/** 把「现在的时刻」往前挪 n 小时的 ISO 串（造临期 / 到期用） */
function hoursFromNow(hours: number): string {
  return new Date(NOW_MS + hours * 3600 * 1000).toISOString();
}

describe("存稿池 — 它是 draft 的子集，不是第四个状态（I01 §3.5 / docs/04 T5-6 注记）", () => {
  it("只收「还没发出去」且「已经写完」的章：已发布 / 修订中 / 0 字都不收", () => {
    const { rows } = planStockPool({
      rows: [
        row({ id: "ch-draft", wordCount: 2000 }),
        row({ id: "ch-empty", wordCount: 0 }),
        row({ id: "ch-published", status: "published", wordCount: 2000 }),
        row({ id: "ch-revised", status: "revised", wordCount: 2000 }),
      ],
      events: [],
      now: NOW,
    });
    expect(rows.map((item) => item.id)).toEqual(["ch-draft"]);
  });

  it("没设 publish_at 的算「存稿」（还没定什么时候发）", () => {
    const { rows } = planStockPool({ rows: [row()], events: [], now: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.dueState).toBe("stock");
    expect(rows[0]?.publishAt).toBe("");
  });

  it("已定时的章算「待发布」：到点前是 scheduled，到点是 due，快到点是 soon", () => {
    const { rows } = planStockPool({
      rows: [
        row({ id: "ch-late", publishAt: hoursFromNow(72) }),
        row({ id: "ch-soon", publishAt: hoursFromNow(10) }),
        row({ id: "ch-due", publishAt: hoursFromNow(-5) }),
      ],
      events: [],
      now: NOW,
    });
    const state = Object.fromEntries(rows.map((item) => [item.id, item.dueState]));
    expect(state).toEqual({ "ch-late": "scheduled", "ch-soon": "soon", "ch-due": "due" });
  });
});

describe("存稿池 — 到期 / 临期判定与 publish_at 一致（不许各写一遍比较式）", () => {
  it("到期集合 = 用引擎同一个判定函数（publishAtDueMs）算出来的集合", () => {
    const input = [
      row({ id: "ch-due", publishAt: hoursFromNow(-1) }),
      row({ id: "ch-not-yet", publishAt: hoursFromNow(3) }),
      row({ id: "ch-none" }),
      row({ id: "ch-bad", publishAt: "不是时刻" }),
    ];
    const { rows } = planStockPool({ rows: input, events: [], now: NOW });
    const expected = input
      .filter((item) => publishAtDueMs(item.publishAt, NOW_MS) !== null)
      .map((item) => item.id)
      .sort();
    const actual = rows.filter((item) => item.dueState === "due").map((item) => item.id).sort();
    expect(actual).toEqual(expected);
  });

  it("存稿池里的到期章一定也在提醒队列里（同一个口径，两边不会打架）", () => {
    const input = [
      row({ id: "ch-due", publishAt: hoursFromNow(-2) }),
      row({ id: "ch-soon", publishAt: hoursFromNow(2) }),
    ];
    const { rows } = planStockPool({ rows: input, events: [], now: NOW });
    const reminders = planPublishReminders(
      input.map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        wordCount: item.wordCount,
        ...(item.publishAt === undefined ? {} : { publishAt: item.publishAt }),
      })),
      NOW,
    );
    const dueIds = rows.filter((item) => item.dueState === "due").map((item) => item.id);
    expect(dueIds.length).toBeGreaterThan(0);
    for (const id of dueIds) expect(reminders.map((item) => item.id)).toContain(id);
  });

  it("临期窗口的边界：正好 48 小时算临期，超过就是已定时（窗口 48 小时 = 本项目自定）", () => {
    const { rows } = planStockPool({
      rows: [
        row({ id: "ch-edge", publishAt: new Date(NOW_MS + STOCK_SOON_WINDOW_MS).toISOString() }),
        row({ id: "ch-over", publishAt: new Date(NOW_MS + STOCK_SOON_WINDOW_MS + 1).toISOString() }),
      ],
      events: [],
      now: NOW,
    });
    const state = Object.fromEntries(rows.map((item) => [item.id, item.dueState]));
    expect(state["ch-edge"]).toBe("soon");
    expect(state["ch-over"]).toBe("scheduled");
  });

  it("publish_at 读不出来（不是时刻）就当没定时，不编一个到期出来", () => {
    const { rows } = planStockPool({ rows: [row({ publishAt: "下周三" })], events: [], now: NOW });
    expect(rows[0]?.dueState).toBe("stock");
  });

  it("排序确定：到期 → 临期 → 已定时 → 存稿，同组按 publish_at 再按 id 码点序", () => {
    const { rows } = planStockPool({
      rows: [
        row({ id: "ch-stock" }),
        row({ id: "ch-b", publishAt: hoursFromNow(200) }),
        row({ id: "ch-a", publishAt: hoursFromNow(200) }),
        row({ id: "ch-soon", publishAt: hoursFromNow(5) }),
        row({ id: "ch-due", publishAt: hoursFromNow(-1) }),
      ],
      events: [],
      now: NOW,
    });
    expect(rows.map((item) => item.id)).toEqual(["ch-due", "ch-soon", "ch-a", "ch-b", "ch-stock"]);
  });
});

describe("存稿池 — 续航：存稿章数 ÷ 日更章数（I01 §3.5）", () => {
  it("还没有任何发布记录 ⇒ 算不出日更章数，明写原因，不拿 0 充数", () => {
    const { endurance } = planStockPool({ rows: [row()], events: [], now: NOW });
    expect(endurance.poolCount).toBe(1);
    expect(endurance.dailyChapters).toBeNull();
    expect(endurance.days).toBeNull();
    expect(endurance.warning).toBe("");
    expect(endurance.note).toContain("发布记录");
  });

  it("日更章数从台账实测：观察窗 = 最早发布日到今天（含），上限 30 天", () => {
    // 3 天里发了 6 章 ⇒ 日均 2 章；池子里 10 章 ⇒ 可撑 5 天
    const events = [
      publishedEvent("ch-1", "2026-10-23T09:00:00+08:00"),
      publishedEvent("ch-2", "2026-10-23T20:00:00+08:00"),
      publishedEvent("ch-3", "2026-10-24T09:00:00+08:00"),
      publishedEvent("ch-4", "2026-10-24T20:00:00+08:00"),
      publishedEvent("ch-5", "2026-10-25T09:00:00+08:00"),
      publishedEvent("ch-6", "2026-10-25T20:00:00+08:00"),
    ];
    const pool = Array.from({ length: 10 }, (_unused, index) => row({ id: `ch-pool-${String(index)}` }));
    const { endurance } = planStockPool({ rows: pool, events, now: NOW });
    expect(endurance.windowDays).toBe(3);
    expect(endurance.dailyChapters).toBe(2);
    expect(endurance.days).toBe(5);
    expect(endurance.warning).toBe("");
  });

  it("观察窗最长 30 天：40 天前发的那几章不计入速率", () => {
    const events = [publishedEvent("ch-old", "2026-08-01T09:00:00+08:00")];
    const { endurance } = planStockPool({ rows: [row()], events, now: NOW });
    expect(endurance.dailyChapters).toBeNull();
    expect(endurance.note).toContain("发布记录");
    expect(STOCK_RATE_WINDOW_DAYS).toBe(30);
  });

  it("同一章改完再发（两次 published）只算一章，不重复充数", () => {
    const events = [
      publishedEvent("ch-1", "2026-10-25T09:00:00+08:00"),
      publishedEvent("ch-1", "2026-10-25T20:00:00+08:00"),
    ];
    const { endurance } = planStockPool({ rows: [row()], events, now: NOW });
    expect(endurance.dailyChapters).toBe(1);
    expect(endurance.windowDays).toBe(1);
    expect(endurance.days).toBe(1);
  });

  it("可撑天数低于阈值就报断更预警（阈值 3 天）", () => {
    const events = [
      publishedEvent("ch-1", "2026-10-25T09:00:00+08:00"),
      publishedEvent("ch-2", "2026-10-25T20:00:00+08:00"),
    ];
    const { endurance } = planStockPool({ rows: [row()], events, now: NOW });
    expect(endurance.days).toBe(0.5);
    expect(endurance.warning).not.toBe("");
    expect(endurance.warning).toContain(String(STOCK_WARN_DAYS));
  });

  it("池子里一章都没有时：数字如实是 0，不报「稿子够了」这种假安心", () => {
    const events = [publishedEvent("ch-1", "2026-10-25T09:00:00+08:00")];
    const { rows, endurance } = planStockPool({ rows: [row({ wordCount: 0 })], events, now: NOW });
    expect(rows).toHaveLength(0);
    expect(endurance.poolCount).toBe(0);
    expect(endurance.days).toBe(0);
    expect(endurance.warning).not.toBe("");
  });

  it("时刻读不出来就不给续航，也不编一个天数", () => {
    const { rows, endurance } = planStockPool({ rows: [row()], events: [], now: "不是时刻" });
    expect(rows).toHaveLength(0);
    expect(endurance.days).toBeNull();
    expect(endurance.note).not.toBe("");
  });
});
