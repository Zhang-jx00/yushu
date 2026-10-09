import { describe, expect, it } from "vitest";
import { pairPowerLog, parsePowerLog } from "@yushu/world-engine";

/**
 * 战力台账（M4 / T4-2 第一条语义规则的数据面，R57）。
 *
 * 判定本身不在这里——战力规则由派系包 DSL（`power-no-regress`）承载，御书只负责
 * **把作者写的结构化台账拼成规则要的 `{a, b}` 相邻对**。因此这一层的硬要求是：
 * 拼不出可信顺序时**如实报错**，而不是"按书写顺序凑一对"或"丢掉说不清的那条"。
 */

const cardWith = (log: string) =>
  `---\nid: char-linyuan\ntype: character\nname: 林渊\nlayer: characters\naliases: []\nrefs: []\nsource_chapters: []\nvisibility: hidden\nformat_version: 1\nextensions:\n  power_log:\n${log}\n---\n\n正文。\n`;

describe("战力台账解析", () => {
  it("合法两条：解析出字段并按章号升序配成一对", () => {
    const parsed = parsePowerLog(
      cardWith(`    - chapter: "第 3 章"\n      tier: 3\n      combat_power: 100\n    - chapter: "第 4 章"\n      tier: 4\n      combat_power: 80\n`),
    );
    expect(parsed.error).toBeNull();
    expect(parsed.entries.map((e) => e.chapterNo)).toEqual([3, 4]);
    const pairs = pairPowerLog(parsed.entries);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.a.combatPower).toBe(100);
    expect(pairs[0]!.b.combatPower).toBe(80);
  });

  it("书写顺序乱也要按章号排：配对不依赖作者把哪条写在前面", () => {
    const parsed = parsePowerLog(
      cardWith(`    - chapter: "第 9 章"\n      tier: 5\n      combat_power: 300\n    - chapter: "第 3 章"\n      tier: 3\n      combat_power: 100\n`),
    );
    expect(parsed.error).toBeNull();
    const pairs = pairPowerLog(parsed.entries);
    expect(pairs.map((p) => [p.a.chapterNo, p.b.chapterNo])).toEqual([[3, 9]]);
  });

  it("三条给两组相邻对（1-2 / 2-3），不制造跨章的组合爆炸", () => {
    const parsed = parsePowerLog(
      cardWith(
        `    - chapter: "第 1 章"\n      tier: 1\n      combat_power: 10\n    - chapter: "第 2 章"\n      tier: 2\n      combat_power: 20\n    - chapter: "第 3 章"\n      tier: 3\n      combat_power: 30\n`,
      ),
    );
    expect(pairPowerLog(parsed.entries).map((p) => [p.a.chapterNo, p.b.chapterNo])).toEqual([
      [1, 2],
      [2, 3],
    ]);
  });

  it("章号取不出来就报错：不猜顺序，也不悄悄丢掉那一条", () => {
    const parsed = parsePowerLog(cardWith(`    - chapter: "序章"\n      tier: 1\n      combat_power: 10\n`));
    expect(parsed.entries).toEqual([]);
    expect(parsed.error).toContain("序章");
    expect(parsed.error).toContain("章号");
  });

  it("字段类型不对（战力写成字符串）逐条点名，不整段静默失败", () => {
    const parsed = parsePowerLog(cardWith(`    - chapter: "第 3 章"\n      tier: 3\n      combat_power: "一百"\n`));
    expect(parsed.entries).toEqual([]);
    expect(parsed.error).toContain("combat_power");
  });

  it("同章号重复也报错：谁在前不可定，静默丢一条就是假干净", () => {
    const parsed = parsePowerLog(
      cardWith(`    - chapter: "第 3 章"\n      tier: 3\n      combat_power: 100\n    - chapter: "第 3 章"\n      tier: 3\n      combat_power: 90\n`),
    );
    expect(parsed.entries).toEqual([]);
    expect(parsed.error).toContain("重复");
  });

  it("没有 power_log 不算坏：台账是可选字段", () => {
    const parsed = parsePowerLog(cardWith(`    []\n`));
    expect(parsed.error).toBeNull();
    expect(parsed.entries).toEqual([]);
    const none = parsePowerLog(
      `---\nid: char-a\ntype: character\nname: A\nlayer: characters\naliases: []\nrefs: []\nsource_chapters: []\nvisibility: hidden\nformat_version: 1\n---\n\n正文。\n`,
    );
    expect(none.error).toBeNull();
    expect(none.entries).toEqual([]);
  });
});
