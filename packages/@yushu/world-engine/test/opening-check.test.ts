/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  OPENING_CHECK_ORIGIN,
  OPENING_MAX_NAMED_CHARACTERS,
  OPENING_RULE_IDS,
  checkOpening,
  type OpeningChapterRow,
  type OpeningMentionRow,
} from "../src/opening-check";

/**
 * 黄金三章里**能判的那部分**（R104 / M4 T4-2 第五批）。
 *
 * 判据逐条回源，不是这里发明的：
 * - **F02-网文连载结构.md:76**：「第 1 章：…具名角色 ≤3；新设定名词 ≤3」——
 *   具名角色这一半用**提及扫描的结果**数（调用方扫正文喂进来），不靠词表猜；
 *   "新设定名词"那一半**不在这里重复发**：R103 的 `vis-first-appearance-overload`
 *   已经在按同一套章序数单章首次出现，阈值同样是 3，再发一条就是同一件事两个 id（同行重复点名）。
 * - **F02:79**：「前三章禁区：…POV 切换…」——开局窗口内任何视角换成都点名，
 *   与 R102 的 `pov-switch-gap`（管切换**速度**）不是一条：ch1→ch3 在 min_gap=2 下不犯速度，但犯开局禁区。
 * - **F11-开篇设计.md:21**：「黄金三章检查清单 → 开局模板内置逐章必填项（schema 见 §5），缺项黄牌」——
 *   七要素（`chapterBriefSchema` 的 required）有没有空项是纯数据判断。
 * - **F02:76**「主角登场且给出代入锚点」：项目里**没有** protagonist/主角 这个字段（core 的 EntityBase 只有
 *   type/layer/aliases），所以这条退而判"章上登记的视角角色在不在本章正文里露过面"，
 *   且只给 info——它是提示不是缺陷。
 *
 * **明写不做的部分**（缺数据就少判，不假装能判）：前 300 字内出现冲突或悬念、大段设定说明、
 * 闪回开局、主角纯被动挨打超过 1 章、金手指亮相、长线期待、第一个压抑→释放闭环、章末钩子的**强度分级**
 * ——这些要么要读正文语义（AI），要么字段根本不存在，用关键词猜是 R74 明令不走的路子。
 */

/** 前三章的骨架：章纲三条，第 1、2 条已建草稿（有 chapter_id） */
function skeleton(overrides: Partial<OpeningChapterRow> = {}): OpeningChapterRow {
  return {
    outlineId: "co-c1",
    title: "第一章",
    order: 1,
    ...overrides,
  };
}

const FULL_BRIEF = { who: "林渊", where: "青云宗", goal: "活下来", obstacle: "追杀", turn: "反杀", result: "入门", hook: "令牌" };

describe("checkOpening — 具名角色过载（F02:76）", () => {
  it("第 1 章点到 4 个具名角色 ⇒ 一条 warn，证据带显示名", () => {
    const rows = checkOpening({
      chapters: [
        skeleton({
          chapterId: "ch-001",
          mentionedCharacters: [
            { id: "char-a", name: "林渊" },
            { id: "char-b", name: "苏婉" },
            { id: "char-c", name: "陈长老" },
            { id: "char-d", name: "魔头" },
          ],
        }),
      ],
    });
    expect(rows.map((row) => row.rule)).toEqual(["open-cast-overload"]);
    expect(rows[0]).toMatchObject({ severity: "warn", subject: "co-c1" });
    expect(rows[0]?.message).toContain("4");
    expect(rows[0]?.evidence).toContain("林渊");
    expect(rows[0]?.evidence).toContain("魔头");
    expect(rows[0]?.origin).toBe(OPENING_CHECK_ORIGIN);
  });

  it("恰好等于阈值（3 个）不报——阈值是上限不是目标", () => {
    const three = [
      { id: "char-a", name: "林渊" },
      { id: "char-b", name: "苏婉" },
      { id: "char-c", name: "陈长老" },
    ];
    expect(checkOpening({ chapters: [skeleton({ chapterId: "ch-001", mentionedCharacters: three })] })).toEqual([]);
  });

  it("默认阈值就是 F02 写的那个 3，改阈值要显式传", () => {
    expect(OPENING_MAX_NAMED_CHARACTERS).toBe(3);
    const four = [
      { id: "char-a", name: "林渊" },
      { id: "char-b", name: "苏婉" },
      { id: "char-c", name: "陈长老" },
      { id: "char-d", name: "魔头" },
    ];
    const stricter = checkOpening({ chapters: [skeleton({ chapterId: "ch-001", mentionedCharacters: four })], maxNamedCharacters: 2 });
    const looser = checkOpening({ chapters: [skeleton({ chapterId: "ch-001", mentionedCharacters: four })], maxNamedCharacters: 5 });
    expect(stricter.map((row) => row.rule)).toEqual(["open-cast-overload"]);
    expect(looser).toEqual([]);
  });

  it("第 2、3 章角色再多也不报——这条只管第 1 章（F02 原文只给第 1 章设了数）", () => {
    const many = Array.from({ length: 6 }, (_, index) => ({ id: `char-${String(index)}`, name: `角色${String(index)}` }));
    const rows = checkOpening({
      chapters: [
        skeleton(),
        skeleton({ outlineId: "co-c2", title: "第二章", order: 2, chapterId: "ch-002", mentionedCharacters: many }),
      ],
    });
    expect(rows.filter((row) => row.rule === "open-cast-overload")).toEqual([]);
  });

  it("章纲还没建草稿（没有 chapter_id）⇒ 不判正文类结论，不拿「零角色」当过载", () => {
    const rows = checkOpening({
      chapters: [skeleton({ mentionedCharacters: [] })],
    });
    expect(rows.filter((row) => row.rule === "open-cast-overload")).toEqual([]);
  });
});

describe("checkOpening — 章纲缺项（F11 §3.1 缺项黄牌）", () => {
  it("第 1 章七要素里「阻碍/钩子」空着 ⇒ 一条 info，点名缺的是哪几项", () => {
    const rows = checkOpening({
      chapters: [skeleton({ brief: { ...FULL_BRIEF, obstacle: "", hook: "   " } })],
    });
    expect(rows.map((row) => row.rule)).toEqual(["open-brief-incomplete"]);
    expect(rows[0]?.severity).toBe("info");
    expect(rows[0]?.evidence).toContain("阻碍");
    expect(rows[0]?.evidence).toContain("钩子");
    /** 填着的那些项不许被一起点名：结论要说"缺什么"，不是"你都没写"（七要素图例只出现在证据里） */
    expect(rows[0]?.message).not.toContain("目标");
    expect(rows[0]?.message).toContain("2 项");
  });

  it("七要素填全了 ⇒ 不报", () => {
    expect(checkOpening({ chapters: [skeleton({ brief: FULL_BRIEF })] })).toEqual([]);
  });

  it("只判前三章窗口内的章：第 4 章空着不报", () => {
    const rows = checkOpening({
      chapters: [
        skeleton({ brief: FULL_BRIEF }),
        skeleton({ outlineId: "co-c2", title: "第二章", order: 2, brief: FULL_BRIEF }),
        skeleton({ outlineId: "co-c3", title: "第三章", order: 3, brief: FULL_BRIEF }),
        skeleton({ outlineId: "co-c4", title: "第四章", order: 4, brief: { ...FULL_BRIEF, goal: "", turn: "" } }),
      ],
    });
    expect(rows).toEqual([]);
  });

  it("窗口可覆盖：window=4 时第 4 章的缺项也要被看见", () => {
    const rows = checkOpening({
      chapters: [
        skeleton({ brief: FULL_BRIEF }),
        skeleton({ outlineId: "co-c4", title: "第四章", order: 4, brief: { ...FULL_BRIEF, goal: "" } }),
      ],
      window: 4,
    });
    expect(rows.map((row) => `${String(row.rule)}:${String(row.subject)}`)).toEqual(["open-brief-incomplete:co-c4"]);
  });

  it("没给章纲（brief undefined）⇒ 不判缺项：大纲还没写是另一件事，不在这里当缺陷报", () => {
    expect(checkOpening({ chapters: [skeleton()] })).toEqual([]);
  });
});

describe("checkOpening — 开局窗口内的视角换出（F02:79 禁区）", () => {
  const LIN: OpeningMentionRow = { id: "char-a", name: "林渊" };
  const SU: OpeningMentionRow = { id: "char-b", name: "苏婉" };

  it("前三章出现两个不同视角 ⇒ 只在「换过来那一章」报一条 warn", () => {
    const rows = checkOpening({
      chapters: [
        skeleton({ chapterId: "ch-001", pov: "char-a", povName: "林渊", mentionedCharacters: [LIN] }),
        skeleton({ outlineId: "co-c2", title: "第二章", order: 2, chapterId: "ch-002", pov: "char-b", povName: "苏婉", mentionedCharacters: [SU] }),
        skeleton({ outlineId: "co-c3", title: "第三章", order: 3, chapterId: "ch-003", pov: "char-b", povName: "苏婉", mentionedCharacters: [SU] }),
      ],
    });
    const switches = rows.filter((row) => row.rule === "open-pov-switch-early");
    expect(switches.map((row) => row.subject)).toEqual(["co-c2"]);
    expect(switches[0]?.severity).toBe("warn");
    expect(switches[0]?.message).toContain("苏婉");
    expect(switches[0]?.evidence).toContain("林渊");
  });

  it("全程同一视角 ⇒ 不报", () => {
    const rows = checkOpening({
      chapters: [
        skeleton({ chapterId: "ch-001", pov: "char-a", mentionedCharacters: [LIN] }),
        skeleton({ outlineId: "co-c2", title: "第二章", order: 2, chapterId: "ch-002", pov: "char-a", mentionedCharacters: [LIN] }),
      ],
    });
    expect(rows.filter((row) => row.rule === "open-pov-switch-early")).toEqual([]);
  });

  it("视角没登记 ⇒ 这里不报（`pov-missing` 那条 R102 已经在管，不重复点名）", () => {
    const rows = checkOpening({
      chapters: [
        skeleton({ chapterId: "ch-001", pov: "", mentionedCharacters: [LIN] }),
        skeleton({ outlineId: "co-c2", title: "第二章", order: 2, chapterId: "ch-002", pov: "char-b", mentionedCharacters: [SU] }),
      ],
    });
    expect(rows.filter((row) => row.rule === "open-pov-switch-early")).toEqual([]);
  });

  it("第 4 章才换视角 ⇒ 不在开局窗口里，这条不报", () => {
    const rows = checkOpening({
      chapters: [
        skeleton({ chapterId: "ch-001", pov: "char-a", mentionedCharacters: [LIN] }),
        skeleton({ outlineId: "co-c2", title: "第二章", order: 2, chapterId: "ch-002", pov: "char-a", mentionedCharacters: [LIN] }),
        skeleton({ outlineId: "co-c3", title: "第三章", order: 3, chapterId: "ch-003", pov: "char-a", mentionedCharacters: [LIN] }),
        skeleton({ outlineId: "co-c4", title: "第四章", order: 4, chapterId: "ch-004", pov: "char-b", mentionedCharacters: [SU] }),
      ],
    });
    expect(rows.filter((row) => row.rule === "open-pov-switch-early")).toEqual([]);
  });
});

describe("checkOpening — 第 1 章的视角角色没露面（F02:76 代入锚点）", () => {
  it("登记了视角角色却整章没点到他 ⇒ 一条 info，并说清这可能是第一人称", () => {
    const rows = checkOpening({
      chapters: [
        skeleton({
          chapterId: "ch-001",
          pov: "char-a",
          povName: "林渊",
          mentionedCharacters: [{ id: "char-b", name: "苏婉" }],
        }),
      ],
    });
    expect(rows.map((row) => row.rule)).toEqual(["open-protagonist-absent"]);
    expect(rows[0]?.severity).toBe("info");
    expect(rows[0]?.message).toContain("林渊");
    expect(rows[0]?.origin).toBe(OPENING_CHECK_ORIGIN);
  });

  it("点到了 ⇒ 不报", () => {
    const rows = checkOpening({
      chapters: [
        skeleton({
          chapterId: "ch-001",
          pov: "char-a",
          mentionedCharacters: [{ id: "char-a", name: "林渊" }],
        }),
      ],
    });
    expect(rows.filter((row) => row.rule === "open-protagonist-absent")).toEqual([]);
  });

  it("正文一个名字都没有（还没写/纯第一人称）⇒ 不报：拿「没扫到」当「没登场」是假红灯", () => {
    const rows = checkOpening({
      chapters: [skeleton({ chapterId: "ch-001", pov: "char-a", mentionedCharacters: [] })],
    });
    expect(rows.filter((row) => row.rule === "open-protagonist-absent")).toEqual([]);
  });
});

describe("checkOpening — 口径与确定性", () => {
  const allFour = [
    { id: "char-1", name: "甲" },
    { id: "char-2", name: "乙" },
    { id: "char-3", name: "丙" },
    { id: "char-4", name: "丁" },
  ];

  it("空项目（没有章纲）⇒ 零结论", () => {
    expect(checkOpening({ chapters: [] })).toEqual([]);
  });

  it("输入顺序打乱 ⇒ 输出逐字一致（红线 5：码点序，不用 localeCompare）", () => {
    const chapters: OpeningChapterRow[] = [
      skeleton({
        chapterId: "ch-001",
        brief: { ...FULL_BRIEF, goal: "" },
        pov: "char-a",
        povName: "林渊",
        mentionedCharacters: allFour,
      }),
      skeleton({ outlineId: "co-c2", title: "第二章", order: 2, chapterId: "ch-002", brief: FULL_BRIEF, pov: "char-b", povName: "苏婉", mentionedCharacters: [] }),
      skeleton({ outlineId: "co-c3", title: "第三章", order: 3, chapterId: "ch-003", brief: { ...FULL_BRIEF, hook: "" }, pov: "char-b", povName: "苏婉", mentionedCharacters: [] }),
    ];
    const forward = checkOpening({ chapters });
    const reversed = checkOpening({ chapters: [...chapters].reverse() });
    expect(forward.length).toBeGreaterThan(0);
    expect(reversed).toEqual(forward);
    expect(forward.map((row) => `${String(row.rule)}:${String(row.subject)}`)).toEqual([
      "open-cast-overload:co-c1",
      "open-brief-incomplete:co-c1",
      "open-protagonist-absent:co-c1",
      "open-pov-switch-early:co-c2",
      "open-brief-incomplete:co-c3",
    ]);
  });

  it("四条 id 都在清单里，且每条都有结论用得上（防「清单里躺着一条没人发的规则」）", () => {
    expect([...OPENING_RULE_IDS].sort()).toEqual(
      ["open-brief-incomplete", "open-cast-overload", "open-protagonist-absent", "open-pov-switch-early"].sort(),
    );
    const chapters: OpeningChapterRow[] = [
      skeleton({ chapterId: "ch-001", brief: { ...FULL_BRIEF, goal: "" }, pov: "char-a", mentionedCharacters: allFour }),
      skeleton({ outlineId: "co-c2", title: "第二章", order: 2, chapterId: "ch-002", pov: "char-b", mentionedCharacters: [] }),
    ];
    const fired = new Set(checkOpening({ chapters }).map((row) => row.rule));
    for (const id of OPENING_RULE_IDS) {
      expect(fired.has(id), `${String(id)} 从没被任何结论发过`).toBe(true);
    }
  });
});
