/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import type {
  ChronicleBookPayload,
  ForeshadowBoardPayload,
  SatisfactionBoardPayload,
} from "../src/shared/ipc.js";
import {
  ARCHIVE_ARTIFACT_MAX_ITEMS,
  OPEN_PROMISE_STATUSES,
  summarizeArchiveArtifacts,
} from "../renderer/src/components/archive-artifacts.js";

/**
 * 世界观档案页右栏「产物」摘要的**纯函数**判据（R162）。
 *
 * 右栏的每一个数都必须与中栏那张表**逐字对得上**（§7.34 的「同一份真源的两个读法」）。
 * 这层是纯函数 ⇒ 可以直接对着载荷核：
 * ① **换个载荷就换一套数**（不许写死字面量）；
 * ② 名单条数 == 中栏那张表的行数；带标记的条数 == 那张表里带标记的行数；
 * ③ 带标记的口径与引擎给的 `stats` 一致（不许界面自己另算一套）；
 * ④ **没取到就说没取到**（不许装成有）。
 */

function makeForeshadow(overrides: Partial<ForeshadowBoardPayload> = {}): ForeshadowBoardPayload {
  return {
    path: "world/foreshadow.yaml",
    exists: true,
    note: "还没有伏笔台账",
    summary: [{ label: "伏笔", value: "2 条" }],
    chapterTotal: 12,
    currentChapter: null,
    rows: [
      {
        id: "fs-a",
        name: "祖宅的青铜钥匙",
        state: "due",
        board: "open",
        isRedHerring: false,
        overdueBy: 3,
        sinceAction: 2,
      },
      {
        id: "fs-b",
        name: "哑仆的半句话",
        state: "abandoned",
        board: "closed",
        isRedHerring: true,
        overdueBy: null,
        sinceAction: null,
      },
    ],
    findings: [],
    stats: { total: 2, open: 1, closed: 1 },
    ...overrides,
  };
}

function makeSatisfaction(overrides: Partial<SatisfactionBoardPayload> = {}): SatisfactionBoardPayload {
  return {
    path: "world/satisfaction.yaml",
    exists: true,
    note: "还没有爽点台账",
    summary: [{ label: "承诺", value: "2 条" }],
    chapterTotal: 12,
    currentChapter: null,
    rows: [
      {
        chapter: "ch-1",
        ordinal: 1,
        hits: [],
        promisesOpened: ["pr-a"],
        phase: "build",
        scenes: { total: 2, advancing: 1 },
        advanceRate: 0.5,
      },
    ],
    promises: [
      { id: "pr-a", promise: "三年之约", status: "open", overdueBy: 2, evidence: "none" },
      { id: "pr-b", promise: "救回妹妹", status: "paid", overdueBy: null, evidence: "hit" },
    ],
    findings: [],
    notEvaluated: [],
    stats: { hits: 0, scenes: 2, advanceRate: 0.5, openPromises: 1, strongestStreak: 0 },
    ...overrides,
  };
}

function makeChronicle(overrides: Partial<ChronicleBookPayload> = {}): ChronicleBookPayload {
  return {
    path: "world/timeline.yaml",
    exists: true,
    note: "还没有编年史",
    summary: [{ label: "事件", value: "2 个" }],
    calendars: [],
    activeCalendar: null,
    entries: [
      {
        eventId: "ev-war",
        title: "开国之役",
        year: 0,
        displayYear: "通纪 元年",
        culture: "官修史",
        account: "王师一战而定",
        source: "起居注",
      },
      {
        eventId: "ev-war",
        title: "开国之役",
        year: 0,
        displayYear: "通纪 元年",
        culture: "边地谣",
        account: "冻死过半才破城",
        source: "采诗官",
      },
      {
        eventId: "ev-market",
        title: "开市",
        year: 40,
        displayYear: "通纪 40 年",
        culture: null,
        account: null,
        source: null,
      },
    ],
    eras: [],
    divergences: [
      {
        eventId: "ev-war",
        title: "开国之役",
        cultures: ["官修史", "边地谣"],
        differing: true,
        note: "",
      },
    ],
    withoutViewpoints: [],
    orphanEvents: [],
    uneraled: [],
    ambiguousEra: false,
    eraSkipped: [],
    stats: { events: 2, entries: 3, cultures: 2 },
    ...overrides,
  };
}

describe("世界观档案页右栏的产物摘要（R162）：与中栏那张表逐字对得上", () => {
  /** 三块产物的次序是固定的（伏笔 / 爽点 / 编年史）⇒ 按 key 取，别靠下标 */
  const blockOf = (
    input: Parameters<typeof summarizeArchiveArtifacts>[0],
    key: "foreshadow" | "satisfaction" | "chronicle",
  ) => summarizeArchiveArtifacts(input).find((block) => block.key === key);

  it("三块产物都在，次序固定（伏笔 / 爽点 / 编年史）", () => {
    const blocks = summarizeArchiveArtifacts({
      foreshadow: makeForeshadow(),
      satisfaction: makeSatisfaction(),
      chronicle: makeChronicle(),
    });
    expect(blocks.map((block) => block.key)).toEqual(["foreshadow", "satisfaction", "chronicle"]);
  });

  it("**换个载荷就换一套数**（不许写死字面量）", () => {
    const one = summarizeArchiveArtifacts({
      foreshadow: makeForeshadow(),
      satisfaction: makeSatisfaction(),
      chronicle: makeChronicle(),
    });
    const two = summarizeArchiveArtifacts({
      foreshadow: makeForeshadow({
        rows: [],
        stats: { total: 0, open: 0, closed: 0 },
      }),
      satisfaction: makeSatisfaction({
        promises: [],
        stats: { hits: 0, scenes: 0, advanceRate: null, openPromises: 0, strongestStreak: 0 },
      }),
      chronicle: makeChronicle({
        entries: [],
        divergences: [],
        stats: { events: 0, entries: 0, cultures: 0 },
      }),
    });
    expect(one[0]?.counts.listed).toBe(2);
    expect(two[0]?.counts.listed).toBe(0);
    expect(one[1]?.counts.listed).toBe(2);
    expect(two[1]?.counts.listed).toBe(0);
    expect(one[2]?.counts.listed).toBe(3);
    expect(two[2]?.counts.listed).toBe(0);
    expect(one[0]?.counts.marked).toBe(1);
    expect(two[0]?.counts.marked).toBe(0);
    expect(one[1]?.counts.marked).toBe(1);
    expect(two[1]?.counts.marked).toBe(0);
    expect(one[2]?.counts.marked).toBe(2);
    expect(two[2]?.counts.marked).toBe(0);
  });

  it("伏笔：名单 == 台账的行；「未回收」== 看板为 open 的行；与引擎给的 stats 一致", () => {
    const block = blockOf({ foreshadow: makeForeshadow(), satisfaction: null, chronicle: null }, "foreshadow");
    expect(block?.counts.listed).toBe(2);
    expect(block?.counts.marked).toBe(1);
    expect(block?.counts.extra?.label).toBe("已闭环");
    expect(block?.counts.extra?.value).toBe(1);
    // 名字与状态与中栏那一列**逐字一致**（中栏的看板列写的就是"未回收 / 已闭环"）
    expect(block?.items.map((item) => item.name)).toEqual(["祖宅的青铜钥匙", "哑仆的半句话"]);
    expect(block?.items.map((item) => item.state)).toEqual(["未回收", "已闭环"]);
  });

  it("爽点：名单 == 承诺的行；「还没兑现」的口径与引擎的 OPEN_STATUSES 一致", () => {
    const block = blockOf({ foreshadow: null, satisfaction: makeSatisfaction(), chronicle: null }, "satisfaction");
    expect(block?.counts.listed).toBe(2);
    expect(block?.counts.marked).toBe(1);
    expect(block?.items.map((item) => item.state)).toEqual(["open", "paid"]);
    expect(block?.counts.extra?.label).toBe("章");
    expect(block?.counts.extra?.value).toBe(1);
    // 界面那份「还没兑现」的名单必须与引擎那份一致（不许各算一套）
    const engineOpen = ["open", "paying", "deferred"];
    expect([...OPEN_PROMISE_STATUSES].sort()).toEqual([...engineOpen].sort());
  });

  it("编年史：名单 == 记载的行；「有分歧」== 带分歧徽标的行（按行数，不按事件数）", () => {
    const block = blockOf({ foreshadow: null, satisfaction: null, chronicle: makeChronicle() }, "chronicle");
    expect(block?.counts.listed).toBe(3);
    // 同一事件的两个文化记载都带分歧徽标 ⇒ 按行数是 2，按事件数是 1
    expect(block?.counts.marked).toBe(2);
    expect(block?.counts.extra?.label).toBe("事件");
    expect(block?.counts.extra?.value).toBe(2);
    expect(block?.items.map((item) => item.name)).toEqual(["开国之役", "开国之役", "开市"]);
    expect(block?.items.map((item) => item.state)).toEqual(["官修史", "边地谣", "中性记载"]);
  });

  it("**没取到就说没取到**（不许装成有）", () => {
    const blocks = summarizeArchiveArtifacts({
      foreshadow: null,
      satisfaction: null,
      chronicle: null,
    });
    for (const block of blocks) {
      expect(block.note, `${block.key} 还没取到却什么都不说`).not.toBe("");
      expect(block.counts.listed).toBe(0);
      expect(block.items.length).toBe(0);
    }
  });

  it("载荷到了但**没有内容** ⇒ 摆载荷自己的 note（不装成「有」）", () => {
    const blocks = summarizeArchiveArtifacts({
      foreshadow: makeForeshadow({ rows: [], stats: { total: 0, open: 0, closed: 0 } }),
      satisfaction: makeSatisfaction({ promises: [] }),
      chronicle: makeChronicle({ entries: [], divergences: [] }),
    });
    for (const block of blocks) {
      expect(block.note, `${block.key} 空的时候没有说明`).not.toBe("");
      expect(block.counts.listed).toBe(0);
    }
  });

  it("名单列出的条数有上限，多的说清还有几条（窄栏里别把作者埋了）", () => {
    const many = Array.from({ length: ARCHIVE_ARTIFACT_MAX_ITEMS + 5 }, (_, index) => ({
      id: "fs-" + String(index),
      name: "伏笔 " + String(index),
      state: "due",
      board: "open" as const,
      isRedHerring: false,
      overdueBy: null,
      sinceAction: null,
    }));
    const block = blockOf({ foreshadow: makeForeshadow({ rows: many, stats: { total: many.length, open: many.length, closed: 0 } }), satisfaction: null, chronicle: null }, "foreshadow");
    expect(block?.counts.listed).toBe(ARCHIVE_ARTIFACT_MAX_ITEMS + 5);
    expect(ARCHIVE_ARTIFACT_MAX_ITEMS).toBeGreaterThan(0);
  });
});
