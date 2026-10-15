/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  BIBLE_UNREVEALED_VISIBILITIES,
  BIBLE_VISIBILITY_LEAK_RULE,
  assembleWorldBible,
  type BibleCard,
} from "../src/bible.js";

/**
 * 世界圣经（设定集）自动汇编（M5 / T5-5，R98）。
 *
 * 判据出处是 docs/research/K11 §2.5 / §3.6 与其规则草案，不是我自己发明的：
 * 「把设定卡汇编为设定集：**按世界构建金字塔层级编排目录**、实体卡转章节、**按叙事可见性脱敏**」，
 * 规则 `export-bible-visibility-leak`＝"设定集导出含『叙事可见性=未揭示』条目且未勾选脱敏 → warn"。
 *
 * 三条口径是我自己裁的，写在这里以免被读成 K11 的规定：
 * ① 层内顺序取**码点序**（不是 zh 显示序）——设定集是落盘复跑的工件，重跑逐字一致比"按拼音好看"重要；
 * ② 脱敏＝**整条不进**，连名字都不出（"这里有 1 条隐藏设定"这句话本身就是剧透），
 *    被剔除的清单只回到应用里，不写进产物；
 * ③ 除 revealed 外一律算未揭示（含 foreshadowed：埋伏笔 ≠ 已揭示）。
 */

function card(overrides: Partial<BibleCard> = {}): BibleCard {
  return {
    path: "world/cards/char-linyuan.md",
    id: "char-linyuan",
    type: "character",
    name: "林渊",
    layer: "characters",
    visibility: "revealed",
    aliases: [],
    sourceChapters: [],
    body: "青云宗外门弟子，左手经脉曾裂。",
    ...overrides,
  };
}

describe("层级编排目录（K11：按金字塔层级）", () => {
  it("层的先后按 LAYER_KEYS 走，与传入顺序无关", () => {
    const result = assembleWorldBible([
      card({ layer: "characters" }),
      card({ layer: "laws", id: "law-tian", type: "law", name: "灵脉法则", path: "world/cards/law-tian.md" }),
      card({ layer: "genesis", id: "ev-kaitian", type: "event", name: "开天", path: "world/cards/ev-kaitian.md" }),
    ]);
    expect(result.error).toBeNull();
    expect(result.sections.map((section) => section.layer)).toEqual(["genesis", "laws", "characters"]);
  });

  it("层级标题由调用方给；没给就回退层键（引擎不发明中文名）", () => {
    const titled = assembleWorldBible([card()], { layerTitles: { characters: "人物" } });
    expect(titled.sections[0]?.heading).toBe("人物");
    const bare = assembleWorldBible([card()]);
    expect(bare.sections[0]?.heading).toBe("characters");
  });

  it("同一层内按码点序（类型→名称→ID），打乱输入产物逐字不变", () => {
    const a = card({ name: "甲", id: "char-a" });
    const b = card({ name: "乙", id: "char-b", type: "event", path: "world/cards/ev-b.md" });
    const c = card({ name: "丙", id: "char-c" });
    const forward = assembleWorldBible([a, b, c], { title: "设定集" });
    const shuffled = assembleWorldBible([c, b, a], { title: "设定集" });
    expect(forward.error).toBeNull();
    expect(shuffled.markdown).toBe(forward.markdown);
    // 先按类型分组（"character" < "event"），组内按名称**码点**序：
    // 丙(U+4E19) < 甲(U+7532)——这不是拼音序，是故意的：设定集要落盘复跑，重跑逐字一致比"看着顺"重要。
    expect(forward.sections[0]?.entries.map((entry) => entry.id)).toEqual(["char-c", "char-a", "char-b"]);
  });

  it("只选取部分层级时，其余层计入 skipped 而不是悄悄不见", () => {
    const result = assembleWorldBible(
      [
        card(),
        card({ layer: "laws", id: "law-1", type: "law", name: "法则一", path: "world/cards/law-1.md" }),
      ],
      { layers: ["characters"] },
    );
    expect(result.sections.map((section) => section.layer)).toEqual(["characters"]);
    expect(result.included).toBe(1);
    expect(result.excludedByLayer).toBe(1);
    expect(result.markdown).not.toContain("法则一");
  });

  it("选了项目里一条都没有的层级 ⇒ 不生成空章节（目录不留空壳）", () => {
    const result = assembleWorldBible([card()], { layers: ["characters", "ecology"] });
    expect(result.sections.map((section) => section.layer)).toEqual(["characters"]);
  });
});

describe("按叙事可见性脱敏（K11 规则 export-bible-visibility-leak）", () => {
  it("未勾选脱敏 ⇒ 未揭示条目照样进设定集，但逐条 warn 点名", () => {
    const hidden = card({ id: "char-secret", visibility: "hidden", name: "林渊身世", path: "world/cards/char-secret.md" });
    const result = assembleWorldBible([card(), hidden]);
    expect(result.error).toBeNull();
    expect(result.findings.map((row) => [row.rule, row.severity])).toEqual([
      [BIBLE_VISIBILITY_LEAK_RULE, "warn"],
    ]);
    expect(result.findings[0]?.related).toBe("world/cards/char-secret.md");
    expect(result.findings[0]?.message).toContain("林渊身世");
    expect(result.markdown).toContain("林渊身世");
    expect(result.masked).toEqual([]);
  });

  it("勾选脱敏 ⇒ 整条不进，连名字都不出；剔除清单只回给应用", () => {
    const hidden = card({ id: "char-secret", visibility: "hidden", name: "林渊身世", path: "world/cards/char-secret.md" });
    const result = assembleWorldBible([card(), hidden], { maskUnrevealed: true });
    expect(result.error).toBeNull();
    expect(result.markdown).not.toContain("林渊身世");
    expect(result.included).toBe(1);
    expect(result.masked.map((entry) => entry.id)).toEqual(["char-secret"]);
    // 产物里也不许写"略过 N 条"——数量本身会告诉读者"这里有东西"
    expect(result.markdown).not.toContain("略过");
    expect(result.findings).toEqual([]);
  });

  it("已揭示的条目一条都不报（判据要能绿，不是永远亮）", () => {
    const result = assembleWorldBible([card(), card({ id: "char-b", name: "乙" })]);
    // 先确认它真的编出来了：否则"没报 warn"可能是因为整本被拒（假绿）
    expect(result.error).toBeNull();
    expect(result.included).toBe(2);
    expect(result.findings).toEqual([]);
  });

  it("埋伏笔也算未揭示：foreshadowed 一样被 warn 点名、一样会被脱敏剔除", () => {
    const fs = card({ visibility: "foreshadowed", name: "半遮设定" });
    const warned = assembleWorldBible([fs]);
    expect(warned.error).toBeNull();
    expect(warned.findings.map((row) => row.rule)).toEqual([BIBLE_VISIBILITY_LEAK_RULE]);
    const masked = assembleWorldBible([fs], { maskUnrevealed: true });
    expect(masked.error).toBeNull();
    expect(masked.included).toBe(0);
    expect(masked.masked.map((entry) => entry.id)).toEqual(["char-linyuan"]);
  });

  it("未揭示的取值集合与 core 的可见性枚举对齐（多一个少一个都要红）", () => {
    expect([...BIBLE_UNREVEALED_VISIBILITIES].sort()).toEqual(["foreshadowed", "hidden", "written_unrevealed"]);
  });
});

describe("拒绝含糊：读不懂就不产出", () => {
  it("层级不在 LAYER_KEYS 里 ⇒ 整本拒编（不猜它该排哪儿）", () => {
    const result = assembleWorldBible([card(), card({ layer: "feelings" })]);
    expect(result.error).toContain("feelings");
    expect(result.markdown).toBe("");
    expect(result.sections).toEqual([]);
    expect(result.included).toBe(0);
  });

  it("可见性不是四种之一 ⇒ 整本拒编（脱敏判定靠这个字段，不能默认放行）", () => {
    const result = assembleWorldBible([card({ visibility: "secret" })]);
    expect(result.error).toContain("secret");
    expect(result.sections).toEqual([]);
  });

  it("选取清单里写了不存在的层级 ⇒ 拒编（多半是手滑，静默忽略等于少导一层）", () => {
    const result = assembleWorldBible([card()], { layers: ["characterss"] });
    expect(result.error).toContain("characterss");
    expect(result.markdown).toBe("");
  });

  it("同一张卡出现两次 ⇒ 拒编并点名（重复条目会被读者当成两处设定）", () => {
    const result = assembleWorldBible([card(), card({ body: "另一份正文" })]);
    expect(result.error).toContain("char-linyuan");
    expect(result.markdown).toBe("");
  });
});

describe("如实的空与缺（不把「没有」写成「没问题」）", () => {
  it("一张卡都没有 ⇒ 不报错，但目录为空并写明无卡", () => {
    const result = assembleWorldBible([], { title: "天启界设定集" });
    expect(result.error).toBeNull();
    expect(result.sections).toEqual([]);
    expect(result.included).toBe(0);
    expect(result.markdown).toContain("天启界设定集");
    expect(result.markdown).toContain("无设定卡");
    expect(result.markdown).not.toContain("## ");
  });

  it("卡没有正文 ⇒ 条目保留并标注无正文（不是把卡藏起来）", () => {
    const result = assembleWorldBible([card({ body: "   " })]);
    expect(result.included).toBe(1);
    expect(result.markdown).toContain("林渊");
    expect(result.markdown).toContain("（本卡无正文）");
    expect(result.wordCount).toBe(0);
  });

  it("标题缺省用「设定集」，别名与出场章节有就写、没有就不占行", () => {
    const result = assembleWorldBible([card({ aliases: ["小渊"], body: "正文一。" })]);
    expect(result.markdown).toContain("# 设定集");
    expect(result.markdown).toContain("别名：小渊");
    expect(result.markdown).not.toContain("出场：");
    const withSources = assembleWorldBible([card({ sourceChapters: ["第1章"] })]);
    expect(withSources.markdown).toContain("出场：第1章");
  });

  it("正文原样进产物（引擎不做二次排版，也不给标题加编号）", () => {
    const result = assembleWorldBible([card({ body: "第一行。\n第二行。" })]);
    expect(result.markdown).toContain("第一行。\n第二行。");
    expect(result.markdown).toContain("### 林渊");
    expect(result.wordCount).toBeGreaterThan(0);
  });
});
