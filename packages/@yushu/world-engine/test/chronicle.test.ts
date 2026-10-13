import { describe, expect, it } from "vitest";
import { buildChronicle, parseTimelineFile, type TimelineFile } from "@yushu/world-engine";

/**
 * 编年史（M4 / T4-8 引擎侧，R70）：大事年表 + 同一事件的多文化"伪史书"。
 *
 * **刻度只复用不重造**：编年史吃的是 T4-7 的 `TimelineFile`，年份一律走 `formatCalendarYear`，
 * 本模块**没有自己的年表结构**——另起一套历法就是长出第二真源（红线 1）。
 *
 * 三条不猜：
 * ① 事件没有 `pov_viewpoints` ⇒ `culture: null` 一条中性记载，**不替作者编一个视角**；
 * ② 时代分段（eras）由调用方给（来自 era 设定卡），**引擎不猜年代边界**；
 *    落不进任何时代的事件进 `uneraled` 点名，不悄悄塞进最后一段；
 * ③ 多文化记载**完全相同**时 `differing: false` 并写明"一致"——一致与"只有一个视角"是两回事。
 */

const HEAD = "apiVersion: yushu.timeline/v1\nanchor_event: ev-a\n";
const CALENDARS = "calendars:\n  - id: common\n    label: 通纪\n    offset: 0\n";

function docOf(eventsYaml: string, timelines = "timelines:\n  - id: tl-main\n    anchor_event: ev-a\n    calendar: common\n    scale: numeric\n    events: [ev-a, ev-b]\n"): TimelineFile {
  return parseTimelineFile([HEAD, CALENDARS, timelines, `events:\n${eventsYaml}`].join("\n"));
}

const TWO_CULTURES = [
  "  - id: ev-a",
  "    title: 开国之役",
  "    year: 0",
  "    timeline: tl-main",
  "    participants: []",
  "    causes: []",
  "    effects: []",
  "    pov_viewpoints:",
  "      - culture: 官修史",
  "        account: 王师一战而定",
  "        source: 起居注",
  "      - culture: 边地谣",
  "        account: 冻死过半才破城",
  "        source: 采诗官",
  "  - id: ev-b",
  "    title: 立市",
  "    year: 12",
  "    timeline: tl-main",
  "    participants: []",
  "    causes: []",
  "    effects: []",
  "  - id: ev-orphan",
  "    title: 无归属的一战",
  "    year: 40",
  "    timeline: tl-main",
  "    participants: []",
  "    causes: []",
  "    effects: []",
].join("\n");

const ERAS = [
  { label: "建国", from: -10, to: 5 },
  { label: "治世", from: 5, to: 30 },
];

describe("buildChronicle（大事年表 + 伪史书）", () => {
  it("条目按 (year, id, culture) 稳定排列，同一事件多文化各成一行", () => {
    const out = buildChronicle(docOf(TWO_CULTURES), {});
    expect(out.entries.map((e) => `${e.eventId}/${e.culture ?? "-"}`)).toEqual([
      "ev-a/官修史",
      "ev-a/边地谣",
      "ev-b/-",
      "ev-orphan/-",
    ]);
  });

  it("年份复用时间线的历法换算，编年史不自建刻度", () => {
    const out = buildChronicle(docOf(TWO_CULTURES), { calendar: "common" });
    expect(out.entries[0]?.displayYear).toBe("通纪 元年");
    expect(out.entries.find((e) => e.eventId === "ev-b")?.displayYear).toBe("通纪 12 年");
  });

  it("认不出的历法 ⇒ displayYear 为 null，不退回 offset 0", () => {
    const out = buildChronicle(docOf(TWO_CULTURES), { calendar: "no-such" });
    expect(out.entries.every((e) => e.displayYear === null)).toBe(true);
  });

  it("没有 pov_viewpoints 的事件给一条中性记载（culture 为 null），不编视角", () => {
    const out = buildChronicle(docOf(TWO_CULTURES), {});
    const neutral = out.entries.find((e) => e.eventId === "ev-b");
    expect(neutral?.culture).toBeNull();
    expect(neutral?.account).toBeNull();
    expect(out.withoutViewpoints).toEqual(["ev-b", "ev-orphan"]);
  });

  it("多文化记载不同 ⇒ 分歧点名两种文化；完全相同 ⇒ differing=false 并写明一致", () => {
    const diverging = buildChronicle(docOf(TWO_CULTURES), {});
    const d = diverging.divergences.find((x) => x.eventId === "ev-a");
    expect(d?.differing).toBe(true);
    expect(d?.cultures).toEqual(["官修史", "边地谣"]);

    const sameText = TWO_CULTURES.replace("冻死过半才破城", "王师一战而定").replace("采诗官", "起居注");
    const same = buildChronicle(docOf(sameText), {});
    const s = same.divergences.find((x) => x.eventId === "ev-a");
    expect(s?.differing).toBe(false);
    expect(s?.note).toContain("一致");
  });

  it("给了时代就分段统计；落不进任何时代的事件进 uneraled 点名", () => {
    const out = buildChronicle(docOf(TWO_CULTURES), { eras: ERAS });
    expect(out.eras.map((e) => `${e.label}:${e.entries}`)).toEqual(["建国:2", "治世:1"]);
    expect(out.uneraled).toEqual(["ev-orphan"]);
  });

  it("没给时代 ⇒ 单段「全书」覆盖实际年份范围，uneraled 为空（不假装分过段）", () => {
    const out = buildChronicle(docOf(TWO_CULTURES), {});
    expect(out.eras.length).toBe(1);
    expect(out.eras[0]?.label).toBe("全书");
    expect(out.eras[0]?.from).toBe(0);
    expect(out.eras[0]?.to).toBe(40);
    expect(out.uneraled).toEqual([]);
  });

  it("事件没被任何时间线的 events[] 列出 ⇒ orphanEvents 点名（年份仍可用，但归属要说清）", () => {
    const out = buildChronicle(docOf(TWO_CULTURES), {});
    expect(out.orphanEvents).toEqual(["ev-orphan"]);
  });

  it("统计口径：事件数与记载行数分开（多文化会让行数大于事件数）", () => {
    const out = buildChronicle(docOf(TWO_CULTURES), {});
    expect(out.stats.events).toBe(3);
    expect(out.stats.entries).toBe(4);
    expect(out.stats.cultures).toBe(2);
  });

  it("确定性：同输入两次逐字一致；空事件表不报错", () => {
    const doc = docOf(TWO_CULTURES);
    expect(JSON.stringify(buildChronicle(doc, { eras: ERAS }))).toBe(JSON.stringify(buildChronicle(doc, { eras: ERAS })));
    const empty = buildChronicle(parseTimelineFile(`${HEAD}calendars: []\ntimelines: []\nevents: []\n`), {});
    expect(empty.entries).toEqual([]);
    expect(empty.eras).toEqual([]);
  });

  it("时代区间重叠时按给出顺序归入第一段，并计入 ambiguousEra 提示", () => {
    const out = buildChronicle(docOf(TWO_CULTURES), {
      eras: [
        { label: "A", from: 0, to: 20 },
        { label: "B", from: 0, to: 20 },
      ],
    });
    expect(out.ambiguousEra).toBe(true);
  });
});
