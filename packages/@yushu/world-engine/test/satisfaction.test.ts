/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  SATISFACTION_API_VERSION,
  buildSatisfactionBoard,
  parseSatisfactionFile,
  serializeSatisfactionFile,
  type SatisfactionLedger,
} from "../src/satisfaction.js";

/**
 * T4-10 爽点与期待感管理·引擎侧（R72）。
 *
 * 判定口径来自 docs/research/I-网文连载工程/I03-爽点与期待感管理.md 与
 * I04-节奏与注水控制.md：爽点是曲线上的**释放点**，期待感是整条曲线；
 * 推进率 = 有 advances 的场景数 ÷ 总场景数（作者声明，引擎不猜"这段是不是水"）。
 */

const CHAPTERS = ["ch-1", "ch-2", "ch-3", "ch-4", "ch-5", "ch-6"];

function ledger(over: Partial<SatisfactionLedger> = {}): SatisfactionLedger {
  return {
    apiVersion: SATISFACTION_API_VERSION,
    hits: [],
    promises: [],
    curve: [],
    scenes: [],
    ...over,
  };
}

const hit = (id: string, chapter: string, type: "upgrade" | "face_slap" | "sweet", intensity: number, extra = {}) => ({
  id,
  chapter,
  type,
  intensity,
  beneficiary: "主角",
  ...extra,
});

const promise = (id: string, status: "open" | "paying" | "paid" | "deferred" | "dropped", extra = {}) => ({
  id,
  promise: `承诺${id}`,
  source: "简介",
  made_ch: "ch-1",
  status,
  ...extra,
});

const rules = (board: { findings: { rule: string }[] }) => board.findings.map((f) => f.rule);

describe("严格解析：坏数据当场拒绝并点名", () => {
  it("根级未知键被拒（不静默忽略）", () => {
    const text = `apiVersion: ${SATISFACTION_API_VERSION}\nhits: []\nwaterfall: 1\n`;
    expect(() => parseSatisfactionFile(text)).toThrow(/根级未知键「waterfall」/);
  });

  it("apiVersion 不对直接拒", () => {
    expect(() => parseSatisfactionFile("apiVersion: yushu.satisfaction/v99\n")).toThrow(/apiVersion 须为/);
  });

  it("非法爽点类型被拒并列出可选值", () => {
    const text = `apiVersion: ${SATISFACTION_API_VERSION}\nhits:\n  - id: h1\n    chapter: ch-1\n    type: 龙傲天\n    intensity: 4\n    beneficiary: 主角\n`;
    expect(() => parseSatisfactionFile(text)).toThrow(/type「龙傲天」非法值/);
  });

  it("intensity 越界与非整数都拒（-5~5 是量纲，不是装饰）", () => {
    const mk = (v: string) =>
      `apiVersion: ${SATISFACTION_API_VERSION}\nhits:\n  - id: h1\n    chapter: ch-1\n    type: upgrade\n    intensity: ${v}\n    beneficiary: 主角\n`;
    expect(() => parseSatisfactionFile(mk("6"))).toThrow(/intensity 须为 -5~5 的整数/);
    expect(() => parseSatisfactionFile(mk("2.5"))).toThrow(/intensity 须为 -5~5 的整数/);
  });

  it("id 重复被拒（撞号等于两条并成一条）", () => {
    const text = `apiVersion: ${SATISFACTION_API_VERSION}\nhits:\n  - {id: h1, chapter: ch-1, type: upgrade, intensity: 1, beneficiary: 主角}\n  - {id: h1, chapter: ch-2, type: upgrade, intensity: 2, beneficiary: 主角}\n`;
    expect(() => parseSatisfactionFile(text)).toThrow(/id 重复：h1/);
  });

  it("缺必填字段被拒并指出字段名", () => {
    const text = `apiVersion: ${SATISFACTION_API_VERSION}\nhits:\n  - {id: h1, chapter: ch-1, type: upgrade, beneficiary: 主角}\n`;
    expect(() => parseSatisfactionFile(text)).toThrow(/缺必填字段 intensity/);
  });

  it("advances 里的非法值被拒（main / sub-<id> / none 三种形态）", () => {
    const text = `apiVersion: ${SATISFACTION_API_VERSION}\nscenes:\n  - {id: sc1, chapter: ch-1, advances: [主线], outcome: yes}\n`;
    expect(() => parseSatisfactionFile(text)).toThrow(/advances\[0\]「主线」非法/);
  });
});

describe("序列化：同内容同字节，且能往返", () => {
  it("parse → serialize → parse 结果一致，且键序稳定", () => {
    const text = [
      `apiVersion: ${SATISFACTION_API_VERSION}`,
      "thresholds:",
      "  release_interval_max: 3",
      "hits:",
      "  - id: h1",
      "    chapter: ch-2",
      "    type: face_slap",
      "    intensity: 4",
      "    beneficiary: 主角",
      "    promise_id: pr-1",
      "promises:",
      "  - id: pr-1",
      '    promise: "三年之约"',
      "    source: 简介",
      "    made_ch: ch-1",
      "    due_ch: ch-6",
      "    status: open",
      "curve:",
      "  - phase: suppress",
      "    from_ch: ch-1",
      "    to_ch: ch-3",
      "scenes:",
      "  - id: sc-1",
      "    chapter: ch-2",
      "    advances:",
      "      - main",
      "    outcome: yes",
      "    tension_delta: 2",
      "",
    ].join("\n");
    const first = parseSatisfactionFile(text);
    const out = serializeSatisfactionFile(first);
    expect(out).toBe(text);
    expect(parseSatisfactionFile(out)).toEqual(first);
  });
});

describe("承诺清单：状态与证据要自洽", () => {
  it("爽点引用不存在的承诺 ⇒ error 并点名", () => {
    const board = buildSatisfactionBoard(
      ledger({ hits: [hit("h1", "ch-1", "upgrade", 4, { promise_id: "pr-none" })] }),
      { chapters: CHAPTERS },
    );
    expect(rules(board)).toContain("sf-promise-dangling");
    expect(board.findings.find((f) => f.rule === "sf-promise-dangling")?.severity).toBe("error");
  });

  it("dropped 是合法终态，但必须带理由", () => {
    const noReason = buildSatisfactionBoard(ledger({ promises: [promise("pr-1", "dropped")] }), { chapters: CHAPTERS });
    expect(rules(noReason)).toContain("sf-dropped-without-reason");
    const withReason = buildSatisfactionBoard(
      ledger({ promises: [promise("pr-1", "dropped", { drop_reason: "改线，另起一卷重写" })] }),
      { chapters: CHAPTERS },
    );
    expect(rules(withReason)).not.toContain("sf-dropped-without-reason");
  });

  it("paid 却没有任何证据（无爽点引用、也无伏笔交叉引用）⇒ warn", () => {
    const bare = buildSatisfactionBoard(ledger({ promises: [promise("pr-1", "paid")] }), { chapters: CHAPTERS });
    expect(rules(bare)).toContain("sf-paid-without-evidence");
    const byHit = buildSatisfactionBoard(
      ledger({
        promises: [promise("pr-1", "paid")],
        hits: [hit("h1", "ch-3", "harvest", 4, { promise_id: "pr-1" })],
      }),
      { chapters: CHAPTERS },
    );
    expect(rules(byHit)).not.toContain("sf-paid-without-evidence");
    const byForeshadow = buildSatisfactionBoard(
      ledger({ promises: [promise("pr-1", "paid", { foreshadow_id: "fs-1" })] }),
      { chapters: CHAPTERS },
    );
    expect(rules(byForeshadow)).not.toContain("sf-paid-without-evidence");
  });

  it("逾期未兑现按章序算，认不出的章号不猜位置", () => {
    const late = buildSatisfactionBoard(
      ledger({ promises: [promise("pr-1", "open", { due_ch: "ch-2" })] }),
      { chapters: CHAPTERS, currentChapter: "ch-5" },
    );
    expect(late.promises.find((p) => p.id === "pr-1")?.overdueBy).toBe(3);
    const unknown = buildSatisfactionBoard(
      ledger({ promises: [promise("pr-1", "open", { due_ch: "第99章" })] }),
      { chapters: CHAPTERS },
    );
    expect(unknown.promises.find((p) => p.id === "pr-1")?.overdueBy).toBeNull();
    expect(rules(unknown)).toContain("sf-chapter-unknown");
  });

  it("deferred 不算逾期，但没写新到期章要提示", () => {
    const deferred = buildSatisfactionBoard(
      ledger({ promises: [promise("pr-1", "deferred", { due_ch: "ch-2" })] }),
      { chapters: CHAPTERS, currentChapter: "ch-5" },
    );
    expect(rules(deferred)).not.toContain("sf-promise-overdue");
    expect(rules(deferred)).toContain("sf-deferred-without-new-due");
  });
});

describe("期待感曲线：相位区间不重叠、不断档", () => {
  it("区间重叠 ⇒ warn（同两章落在两个相位里，曲线就没有唯一解释）", () => {
    const board = buildSatisfactionBoard(
      ledger({
        curve: [
          { phase: "suppress", from_ch: "ch-1", to_ch: "ch-4" },
          { phase: "release", from_ch: "ch-3", to_ch: "ch-5" },
        ],
      }),
      { chapters: CHAPTERS },
    );
    expect(rules(board)).toContain("sf-curve-overlap");
  });

  it("区间之间有缺口 ⇒ warn 并点名缺的章", () => {
    const board = buildSatisfactionBoard(
      ledger({
        curve: [
          { phase: "suppress", from_ch: "ch-1", to_ch: "ch-2" },
          { phase: "release", from_ch: "ch-4", to_ch: "ch-5" },
        ],
      }),
      { chapters: CHAPTERS },
    );
    const gap = board.findings.find((f) => f.rule === "sf-curve-gap");
    expect(gap?.message).toContain("ch-3");
  });
});

describe("阈值类判定：没设旋钮就不报，也不假装通过", () => {
  const hits = [
    hit("h1", "ch-1", "upgrade", 4),
    hit("h2", "ch-2", "upgrade", 4),
    hit("h3", "ch-3", "upgrade", 4),
    hit("h4", "ch-4", "upgrade", 1),
    hit("h5", "ch-5", "upgrade", 1),
    hit("h6", "ch-6", "upgrade", 1),
  ];

  it("未设阈值 ⇒ 三条阈值规则全部进 notEvaluated 并写明缺哪个旋钮", () => {
    const board = buildSatisfactionBoard(ledger({ hits }), { chapters: CHAPTERS });
    expect(rules(board)).not.toContain("sf-same-type-streak");
    expect(board.notEvaluated.map((n) => n.rule)).toEqual(
      expect.arrayContaining(["sf-same-type-streak", "sf-release-gap", "sf-suppress-streak"]),
    );
    expect(board.notEvaluated.find((n) => n.rule === "sf-same-type-streak")?.reason).toContain("same_type_streak_max");
  });

  it("设了阈值才报：连续同类型与长时间无强释放各命中一次", () => {
    const board = buildSatisfactionBoard(ledger({ hits }), {
      chapters: CHAPTERS,
      thresholds: { same_type_streak_max: 3, strong_intensity: 3, release_interval_max: 2 },
    });
    expect(rules(board)).toContain("sf-same-type-streak");
    expect(rules(board)).toContain("sf-release-gap");
  });

  it("压抑相位连续超上限 ⇒ 憋屈欠账；上限未设则不判定", () => {
    const curve = [{ phase: "suppress" as const, from_ch: "ch-1", to_ch: "ch-4" }];
    const on = buildSatisfactionBoard(ledger({ curve }), {
      chapters: CHAPTERS,
      thresholds: { suppress_streak_max: 3 },
    });
    expect(rules(on)).toContain("sf-suppress-streak");
    const off = buildSatisfactionBoard(ledger({ curve }), { chapters: CHAPTERS });
    expect(rules(off)).not.toContain("sf-suppress-streak");
  });

  it("未决承诺数超上限 ⇒ warn（数量口径，不看内容）", () => {
    const board = buildSatisfactionBoard(
      ledger({ promises: [promise("pr-1", "open"), promise("pr-2", "paying"), promise("pr-3", "open")] }),
      { chapters: CHAPTERS, thresholds: { promise_open_max: 2 } },
    );
    expect(rules(board)).toContain("sf-promise-overload");
  });
});

describe("场景推进率：只算作者声明的账", () => {
  it("推进率 = advances 非 none 的场景数 ÷ 总场景数", () => {
    const board = buildSatisfactionBoard(
      ledger({
        scenes: [
          { id: "sc-1", chapter: "ch-1", advances: ["main"], outcome: "yes" },
          { id: "sc-2", chapter: "ch-1", advances: ["none"], outcome: "no" },
          { id: "sc-3", chapter: "ch-2", advances: ["sub-side-a"], outcome: "partial" },
        ],
      }),
      { chapters: CHAPTERS },
    );
    expect(board.stats.scenes).toBe(3);
    expect(board.stats.advanceRate).toBeCloseTo(2 / 3, 6);
    const row1 = board.rows.find((r) => r.chapter === "ch-1");
    expect(row1?.scenes.advancing).toBe(1);
    expect(row1?.scenes.total).toBe(2);
    // 行级推进率也要断言：面板画的是"这一章推进了几成"，只测全书均值等于这个字段没人用过
    expect(row1?.advanceRate).toBeCloseTo(0.5, 6);
    const row3 = board.rows.find((r) => r.chapter === "ch-3");
    expect(row3?.advanceRate).toBeNull();
  });

  it("没有任何场景声明 ⇒ 推进率为 null 并进 notEvaluated（没数据不等于没问题）", () => {
    const board = buildSatisfactionBoard(ledger(), { chapters: CHAPTERS });
    expect(board.stats.advanceRate).toBeNull();
    expect(board.notEvaluated.map((n) => n.rule)).toContain("sf-scene-no-advance");
  });

  it("advances 同时写 none 和别的 ⇒ 报矛盾，不自行取舍", () => {
    const board = buildSatisfactionBoard(
      ledger({ scenes: [{ id: "sc-1", chapter: "ch-1", advances: ["none", "main"], outcome: "yes" }] }),
      { chapters: CHAPTERS },
    );
    expect(rules(board)).toContain("sf-scene-contradiction");
  });

  it("outcome=no 且 advances=none ⇒ 给可删建议（info，不是 error）", () => {
    const board = buildSatisfactionBoard(
      ledger({ scenes: [{ id: "sc-1", chapter: "ch-1", advances: ["none"], outcome: "no" }] }),
      { chapters: CHAPTERS },
    );
    const f = board.findings.find((x) => x.rule === "sf-scene-deletable");
    expect(f?.severity).toBe("info");
  });

  it("连续多场景无推进 ⇒ 设了阈值才报", () => {
    const scenes = [1, 2, 3].map((i) => ({
      id: `sc-${i}`,
      chapter: `ch-${i}`,
      advances: ["none"],
      outcome: "no" as const,
    }));
    const on = buildSatisfactionBoard(ledger({ scenes }), {
      chapters: CHAPTERS,
      thresholds: { no_advance_streak: 3 },
    });
    expect(rules(on)).toContain("sf-scene-no-advance");
    const off = buildSatisfactionBoard(ledger({ scenes }), { chapters: CHAPTERS });
    expect(rules(off)).not.toContain("sf-scene-no-advance");
  });
});

describe("看板行与确定性", () => {
  it("行按章序排列，爽点/承诺变动/相位各自归位", () => {
    const board = buildSatisfactionBoard(
      ledger({
        hits: [hit("h2", "ch-2", "face_slap", 5), hit("h1", "ch-1", "upgrade", 3)],
        promises: [promise("pr-1", "open", { due_ch: "ch-4" })],
        curve: [{ phase: "build", from_ch: "ch-1", to_ch: "ch-2" }],
        scenes: [{ id: "sc-1", chapter: "ch-1", advances: ["main"], outcome: "yes" }],
      }),
      { chapters: CHAPTERS },
    );
    expect(board.rows.map((r) => r.chapter)).toEqual(CHAPTERS);
    expect(board.rows[0]?.hits.map((h) => h.id)).toEqual(["h1"]);
    expect(board.rows[1]?.hits.map((h) => h.id)).toEqual(["h2"]);
    expect(board.rows[0]?.phase).toBe("build");
    expect(board.rows[2]?.phase).toBeNull();
    expect(board.rows[0]?.promisesOpened).toEqual(["pr-1"]);
  });

  it("同一份输入两次求值逐字一致（确定性红线）", () => {
    const l = ledger({
      hits: [hit("h1", "ch-3", "sweet", 2), hit("h2", "ch-1", "upgrade", 4)],
      promises: [promise("pr-b", "open"), promise("pr-a", "paid")],
    });
    const a = buildSatisfactionBoard(l, { chapters: CHAPTERS });
    const b = buildSatisfactionBoard(l, { chapters: CHAPTERS });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("空清单不编造进度：chapters 为空 ⇒ 行表为空且章序判定不生效", () => {
    const board = buildSatisfactionBoard(ledger({ hits: [hit("h1", "ch-1", "upgrade", 3)] }), { chapters: [] });
    expect(board.rows).toEqual([]);
    expect(board.current).toBeNull();
  });
});
