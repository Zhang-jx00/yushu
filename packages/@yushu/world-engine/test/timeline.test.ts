import { describe, expect, it } from "vitest";
import {
  buildTimelineView,
  formatCalendarYear,
  parseTimelineFile,
  serializeTimelineFile,
  checkTimelineConflicts,
  type TimelineFile,
} from "@yushu/world-engine";

/**
 * 时间线：统一数字刻度 + 锚定归零 + 多历法只在渲染层映射 + 冲突校验（M4 / T4-7 引擎侧，R67）。
 *
 * 四条口径：
 * ① **刻度只有一套**：`year` 是内部数字刻度，锚定事件 = Year 0。历法（帝国纪年 / 通纪）只是
 *    显示层的换算，**绝不回写进真源**——两套刻度同时存在就是第二真源。
 * ② **认不出就不判**：事件没写 `kind` 就不参与需要 kind 的判定，但**逐条进 `notEvaluated` 点名**，
 *    不静默放过（"没有结论"不等于"没有问题"，同 T4-2 的未参与规则口径）。
 * ③ **因果倒置按数字判**，不按数组顺序：作者把 effects 写在 causes 前面不代表时间倒流。
 * ④ 历法 id 认不出 ⇒ 显示年为 `null`，**不退回"就当 offset 0"**——那会把"我不知道"显示成"我确定"。
 */

const HEAD = "apiVersion: yushu.timeline/v1\nanchor_event: ev-found\n";

const CALENDARS = [
  "calendars:",
  "  - id: imperial",
  "    label: 帝国纪年",
  "    offset: 1204",
  "  - id: common",
  "    label: 通纪",
  "    offset: 0",
].join("\n");

const TIMELINES = [
  "timelines:",
  "  - id: tl-main",
  "    anchor_event: ev-found",
  "    calendar: imperial",
  "    scale: numeric",
  "    events: [ev-found, ev-war, ev-destroy, ev-born]",
].join("\n");

function eventBlock(lines: string[]): string {
  return ["events:", ...lines].join("\n");
}

const EVENTS = eventBlock([
  "  - id: ev-found",
  "    title: 建国",
  "    year: 0",
  "    timeline: tl-main",
  "    kind: founding",
  "    participants: [char-1]",
  "    location: geo-city",
  "    causes: []",
  "    effects: [ev-war]",
  "  - id: ev-war",
  "    title: 北伐",
  "    year: 12",
  "    timeline: tl-main",
  "    kind: battle",
  "    participants: [char-1]",
  "    causes: [ev-found]",
  "    effects: [ev-destroy]",
  "  - id: ev-destroy",
  "    title: 城破",
  "    year: 20",
  "    timeline: tl-main",
  "    kind: destruction",
  "    participants: []",
  "    location: geo-city",
  "    causes: [ev-war]",
  "    effects: []",
  "  - id: ev-born",
  "    title: 遗民生",
  "    year: 25",
  "    timeline: tl-main",
  "    kind: birth",
  "    participants: [char-2]",
  "    location: geo-city",
  "    causes: []",
  "    effects: []",
  "  - id: ev-feast",
  "    title: 无名宴",
  "    year: 30",
  "    timeline: tl-main",
  "    participants: [char-1]",
  "    causes: []",
  "    effects: []",
]);

const FULL = [HEAD, CALENDARS, TIMELINES, EVENTS].join("\n");

const doc = (text: string): TimelineFile => parseTimelineFile(text);

describe("parseTimelineFile（严格解析）", () => {
  it("完整文档解析成功并保留 kind 与可选字段", () => {
    const parsed = doc(FULL);
    expect(parsed.events.length).toBe(5);
    expect(parsed.events.find((e) => e.id === "ev-found")?.kind).toBe("founding");
    expect(parsed.events.find((e) => e.id === "ev-feast")?.kind).toBeUndefined();
  });

  it("未知键拒绝并点名（真源里写错字段名不能被当成没写）", () => {
    expect(() => doc(`${FULL}\nextra_key: 1\n`)).toThrow(/未知键|extra_key/);
  });

  it("year 非有限数字拒绝（刻度不是字符串也不是估算）", () => {
    expect(() => doc(FULL.replace("    year: 12", "    year: 大约十二"))).toThrow(/year/);
  });

  it("事件 id 重复拒绝；引用不存在的 timeline 拒绝", () => {
    expect(() => doc(FULL.replace("  - id: ev-war", "  - id: ev-found"))).toThrow(/重复/);
    expect(() => doc(FULL.replace("    timeline: tl-main\n    kind: battle", "    timeline: tl-other\n    kind: battle"))).toThrow(/tl-other/);
  });

  it("序列化↔解析逐字往返", () => {
    const parsed = doc(FULL);
    const text = serializeTimelineFile(parsed);
    expect(parseTimelineFile(text)).toEqual(parsed);
    expect(serializeTimelineFile(parseTimelineFile(text))).toBe(text);
  });
});

describe("刻度与历法映射（渲染层的事不回写真源）", () => {
  it("锚定事件 year=0 时归零成立；不为 0 时给 finding 而不擅自平移", () => {
    const clean = checkTimelineConflicts(doc(FULL));
    expect(clean.findings.some((f) => f.rule === "tl-anchor-not-zero")).toBe(false);
    const shifted = doc(FULL.replace("    title: 建国\n    year: 0", "    title: 建国\n    year: 5"));
    const out = checkTimelineConflicts(shifted);
    const finding = out.findings.find((f) => f.rule === "tl-anchor-not-zero");
    expect(finding?.message).toContain("5");
    expect(shifted.events.find((e) => e.id === "ev-found")?.year).toBe(5);
  });

  it("显示年 = 内部年 + offset；负数年给「前 N 年」而不是 -N", () => {
    const parsed = doc(FULL);
    expect(formatCalendarYear(12, { offset: 1204, label: "帝国纪年" })).toBe("帝国纪年 1216 年");
    expect(formatCalendarYear(-3, { offset: 0, label: "通纪" })).toBe("通纪 前 3 年");
    expect(formatCalendarYear(0, { offset: 0, label: "通纪" })).toBe("通纪 元年");
  });

  it("历法 id 认不出 ⇒ 显示年为 null，不退回 offset 0", () => {
    const view = buildTimelineView(doc(FULL), { calendar: "no-such" });
    expect(view.rows.every((r) => r.displayYear === null)).toBe(true);
    expect(view.findings.some((f) => f.rule === "tl-calendar-unknown")).toBe(true);
  });
});

describe("checkTimelineConflicts（冲突校验与不判的口径）", () => {
  it("因果倒置 ⇒ error（按 year 比较，不看数组顺序）", () => {
    const bad = doc(FULL.replace("    title: 北伐\n    year: 12", "    title: 北伐\n    year: -50"));
    const out = checkTimelineConflicts(bad);
    const finding = out.findings.find((f) => f.rule === "tl-cause-after-effect" && f.severity === "error");
    expect(finding?.message).toContain("ev-war");
  });

  it("出生发生在城破之后 ⇒ error（docs/04 的例子：角色出身于已被灭亡的国度）", () => {
    const out = checkTimelineConflicts(doc(FULL));
    const finding = out.findings.find((f) => f.rule === "tl-born-after-destruction");
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("ev-born");
    expect(finding?.message).toContain("geo-city");
  });

  it("参与者在死后仍出场 ⇒ error；没有生死标记时不判并进 notEvaluated", () => {
    const withDeath = `${FULL.replace("    title: 无名宴\n    year: 30", "    title: 无名宴\n    year: 30\n    kind: other")}\n  - id: ev-die\n    title: 身死\n    year: 28\n    timeline: tl-main\n    kind: death\n    participants: [char-1]\n    causes: []\n    effects: []\n`;
    const out = checkTimelineConflicts(doc(withDeath));
    expect(out.findings.some((f) => f.rule === "tl-participant-after-death" && /char-1/.test(f.message))).toBe(true);

    const noMarks = doc(FULL.replace("    kind: founding\n", "").replace("    kind: destruction\n", ""));
    const out2 = checkTimelineConflicts(noMarks);
    expect(out2.findings.some((f) => f.rule === "tl-participant-after-death")).toBe(false);
    expect(out2.notEvaluated.some((n) => n.rule === "tl-participant-after-death")).toBe(true);
  });

  it("kind 缺失的事件逐条点名进 notEvaluated，不算通过也不算失败", () => {
    const out = checkTimelineConflicts(doc(FULL));
    const skipped = out.notEvaluated.find((n) => n.rule === "tl-kind-required");
    expect(skipped?.ids).toContain("ev-feast");
    expect(out.findings.filter((f) => f.rule === "tl-kind-required")).toEqual([]);
  });

  it("锚定事件不存在 ⇒ error；时间线里的事件不存在 ⇒ error", () => {
    const out = checkTimelineConflicts(doc(FULL.replace("anchor_event: ev-found", "anchor_event: ev-nope")));
    expect(out.findings.some((f) => f.rule === "tl-anchor-missing" && f.severity === "error")).toBe(true);
  });

  it("视图按 (year, id) 码点序排列，同输入两次逐字一致", () => {
    const parsed = doc(FULL);
    const first = buildTimelineView(parsed, { calendar: "imperial" });
    const second = buildTimelineView(parsed, { calendar: "imperial" });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.rows.map((r) => r.id)).toEqual(["ev-found", "ev-war", "ev-destroy", "ev-born", "ev-feast"]);
    expect(first.rows[1]?.displayYear).toBe("帝国纪年 1216 年");
  });

  it("合法时间线（无城破、无倒置）⇒ 0 条 error/warn，只有 info 级提示", () => {
    const text = [
      "apiVersion: yushu.timeline/v1",
      "anchor_event: ev-a",
      CALENDARS,
      "timelines:",
      "  - id: tl-main",
      "    anchor_event: ev-a",
      "    calendar: common",
      "    scale: numeric",
      "    events: [ev-a, ev-b]",
      eventBlock([
        "  - id: ev-a",
        "    title: 立约",
        "    year: 0",
        "    timeline: tl-main",
        "    kind: treaty",
        "    participants: []",
        "    causes: []",
        "    effects: [ev-b]",
        "  - id: ev-b",
        "    title: 开市",
        "    year: 3",
        "    timeline: tl-main",
        "    kind: other",
        "    participants: []",
        "    causes: [ev-a]",
        "    effects: []",
      ]),
    ].join("\n");
    const out = checkTimelineConflicts(doc(text));
    expect(out.findings.filter((f) => f.severity !== "info")).toEqual([]);
  });
});
