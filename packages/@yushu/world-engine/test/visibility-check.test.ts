/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  checkVisibility,
  VISIBILITY_CHECK_ORIGIN,
  VISIBILITY_MAX_FIRST_APPEARANCES,
  VISIBILITY_RULE_IDS,
  type VisibilityCardRow,
} from "../src/visibility-check.js";

/**
 * 信息可见性核对（M4 / T4-2 第四批·第一段，R103）。
 *
 * 判据回源（不自己发明）：
 * - docs/01 §4.2 把「叙事可见性（冰山原则）+ 来源章节链接」并列为设定条目的 Must 级元数据；
 * - K05:80 的示例卡是 `source_chapters: [ch-003, ch-012]` + `visibility: written_unrevealed`
 *   ——**登记了出场章却仍是"已写未揭示"是合法的**，所以本轮不判"出场即揭示"；
 * - A08 §3.4 与 §5 的校验建议：单章新揭示数 >3 ⇒ 警告"设定轰炸"（阈值 3 就来自那句原文）；
 * - 界面（ArchiveView 的可见性下拉）对 `hidden` 的释义逐字写着「隐藏（未在正文出现）」
 *   ——所以 `hidden` + 非空 source_chapters 是**卡内自相矛盾**，与任何正文判断无关。
 *
 * 一条贯穿口径：**没登记就不判**。F07 的 `knows` 矩阵、A08 的 `reveal_chapter` / `knowable_by`
 * 在本项目里连字段都没有（grep 零命中），要判只能靠关键词猜正文——那是 R74 明令不走的路子。
 * 所以这里只判"作者自己登记的东西对不对得上自己"。
 */

function card(id: string, visibility: string, sourceChapters: string[] = [], name = id.replace("char-", "")): VisibilityCardRow {
  return { id, name, visibility, sourceChapters };
}

const ORDER = ["ch-000001", "ch-000002", "ch-000003", "ch-000004"];

describe("可见性核对：只判卡自己对不对得起自己", () => {
  it("阈值与规则清单和判据同源（3 条/章来自 A08 §3.4，五条 id 不许虚报）", () => {
    expect(VISIBILITY_MAX_FIRST_APPEARANCES).toBe(3);
    expect([...VISIBILITY_RULE_IDS].sort()).toEqual(
      [
        "vis-first-appearance-overload",
        "vis-hidden-but-sourced",
        "vis-no-source-registered",
        "vis-revealed-no-source",
        "vis-source-chapter-unknown",
      ].sort(),
    );
    expect(VISIBILITY_CHECK_ORIGIN).toContain("A08");
  });

  it("一张卡都没有 ⇒ 零结论（不拿「还没开始写」发警告）", () => {
    expect(checkVisibility({ cards: [], chapterOrder: ORDER })).toEqual([]);
  });

  it("hidden（界面释义：未在正文出现）却登记了来源章节 ⇒ 逐卡 warn 并点名首个来源章", () => {
    const rows = checkVisibility({
      cards: [card("char-linyuan", "hidden", ["ch-000002", "ch-000001"], "林渊")],
      chapterOrder: ORDER,
    });
    expect(rows.map((row) => [row.rule, row.severity])).toEqual([["vis-hidden-but-sourced", "warn"]]);
    expect(rows[0]?.subject).toBe("char-linyuan");
    expect(rows[0]?.message).toContain("未在正文出现");
    expect(rows[0]?.related).toBe("ch-000001");
  });

  it("已写未揭示 / 已埋伏笔带来源章节是合法的（K05 示例就是这个形状）⇒ 不报", () => {
    const rows = checkVisibility({
      cards: [
        card("law-qi", "written_unrevealed", ["ch-000001"], "灵气"),
        card("ev-war", "foreshadowed", ["ch-000002"], "宗门之战"),
      ],
      chapterOrder: ORDER,
    });
    expect(rows).toEqual([]);
  });

  it("全项目一条出处都没登记 ⇒ 只有一条 info 总述，且不逐卡发「查无出处」", () => {
    const rows = checkVisibility({
      cards: [card("char-a", "revealed"), card("char-b", "hidden"), card("law-c", "written_unrevealed")],
      chapterOrder: ORDER,
    });
    expect(rows.map((row) => [row.rule, row.severity])).toEqual([["vis-no-source-registered", "info"]]);
    // 关键是这句：没核对过 ≠ 没问题
    expect(rows[0]?.message).toContain("不等于");
    expect(rows[0]?.subject).toBe("source_chapters");
  });

  it("别的卡登记了出处 ⇒「已揭示却查无出处」逐卡 warn", () => {
    const rows = checkVisibility({
      cards: [card("char-a", "revealed"), card("char-b", "revealed", ["ch-000003"], "B")],
      chapterOrder: ORDER,
    });
    expect(rows.filter((row) => row.rule === "vis-revealed-no-source").map((row) => row.subject)).toEqual(["char-a"]);
  });

  it("来源章节不在章序里 ⇒ 点名悬空 id，且这张卡不参与「首次出现」计数（不猜它在第几章）", () => {
    const rows = checkVisibility({
      cards: [card("char-ghost", "revealed", ["ch-999999"], "幽灵")],
      chapterOrder: ORDER,
    });
    expect(rows.map((row) => row.rule)).toEqual(["vis-source-chapter-unknown"]);
    expect(rows[0]?.related).toBe("ch-999999");
    expect(rows[0]?.evidence).toContain("ch-999999");
    expect(rows[0]?.evidence).toContain("不在大纲章序里");
  });

  it("同一章首次出现 4 张 ⇒ 一条 warn 报数；3 张 ⇒ 不报（判据要能绿）", () => {
    const four = checkVisibility({
      cards: [
        card("char-a", "revealed", ["ch-000001"]),
        card("char-b", "revealed", ["ch-000001"]),
        card("char-c", "revealed", ["ch-000001"]),
        card("char-d", "revealed", ["ch-000001", "ch-000002"]),
      ],
      chapterOrder: ORDER,
    });
    expect(four.map((row) => [row.rule, row.severity, row.subject])).toEqual([
      ["vis-first-appearance-overload", "warn", "ch-000001"],
    ]);
    expect(four[0]?.message).toContain("4");
    const three = checkVisibility({
      cards: [
        card("char-a", "revealed", ["ch-000001"]),
        card("char-b", "revealed", ["ch-000001"]),
        card("char-c", "revealed", ["ch-000001"]),
      ],
      chapterOrder: ORDER,
    });
    expect(three).toEqual([]);
  });

  it("阈值可覆盖（作者自己的书自己定节奏）", () => {
    const rows = checkVisibility({
      cards: [card("char-a", "revealed", ["ch-000001"]), card("char-b", "revealed", ["ch-000001"])],
      chapterOrder: ORDER,
      maxFirstAppearancesPerChapter: 1,
    });
    expect(rows.map((row) => row.rule)).toEqual(["vis-first-appearance-overload"]);
  });

  it("「首次出现」按章序取最早那个已登记来源章（登记顺序颠倒不影响结论）", () => {
    const rows = checkVisibility({
      cards: [
        card("char-a", "revealed", ["ch-000003", "ch-000002"]),
        card("char-b", "revealed", ["ch-000002", "ch-000003"]),
        card("char-c", "revealed", ["ch-000002"]),
        card("char-d", "revealed", ["ch-000002"]),
      ],
      chapterOrder: ORDER,
      maxFirstAppearancesPerChapter: 3,
    });
    expect(rows.map((row) => row.subject)).toEqual(["ch-000002"]);
    expect(rows[0]?.message).toContain("首次出现 4 张");
  });

  it("结论顺序与输入顺序无关（红线 5：卡按 id 码点在前、章按章序在后）", () => {
    const cards = [
      card("char-b", "hidden", ["ch-000001"]),
      card("char-a", "hidden", ["ch-000001"]),
      card("char-c", "revealed", ["ch-000001"]),
    ];
    // 阈值压到 2：三张卡同章首次出现才会出那条章级结论（char-c 有出处，所以不报"查无出处"）
    const forward = checkVisibility({ cards, chapterOrder: ORDER, maxFirstAppearancesPerChapter: 2 });
    const reversed = checkVisibility({ cards: [...cards].reverse(), chapterOrder: ORDER, maxFirstAppearancesPerChapter: 2 });
    expect(reversed.map((row) => `${row.rule}:${row.subject}`)).toEqual(
      forward.map((row) => `${row.rule}:${row.subject}`),
    );
    expect(forward.map((row) => row.subject)).toEqual(["char-a", "char-b", "ch-000001"]);
  });

  it("每条结论都带证据与修法（体检表按这两列渲染，缺一列面板就是空白）", () => {
    const rows = checkVisibility({
      cards: [card("char-a", "hidden", ["ch-000001"]), card("char-b", "revealed", ["ch-000009"])],
      chapterOrder: ORDER,
    });
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) {
      expect(row.evidence.length).toBeGreaterThan(8);
      expect(row.fix.length).toBeGreaterThan(8);
      expect(row.origin).toBe(VISIBILITY_CHECK_ORIGIN);
    }
  });
});
