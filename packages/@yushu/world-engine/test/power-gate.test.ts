/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { checkPowerGate, type PowerLogEntry } from "../src/power-gate.js";
import { parsePowerLog } from "../src/power-log.js";
import { POWER_GATE_RULE_IDS } from "../src/power-gate.js";
import { readFile } from "node:fs/promises";

/**
 * 升级门槛与临时增益的台账核对（M4 / T4-2 第二批，R97）。
 *
 * 判据来源是 D03 §5 的规则草案，不是我自己发明的：
 * `powerup_gate`（R3 新能力三件套：`evidence_ref / cost / reuse_record`，on_missing: warning）与
 * `buff_ttl`（R5「临时增益必须带 expiry，逾期自动回落」）。
 *
 * 为什么这两条写在御书、而"战力崩没崩"写在派系包（R57 的分工要在这里再划一次）：
 * 崩塌与否是**流派判断**（换个流派门槛就不同），归包；而"作者自己声明了升级，却没记代价"
 * 是**我们自己那份台账的完整性**，跟流派无关，归御书——同 R75 的 `fs-ledger-unreadable`、
 * 也同 `lintMemory` 一类。规则 DSL 也写不了它：缺字段在 DSL 里是求值失败（`E_RULE_UNORDERABLE`），
 * 不是"报一条缺项"。
 */

function entry(overrides: Partial<PowerLogEntry> = {}): PowerLogEntry {
  return {
    chapter: "第1章",
    chapterNo: 1,
    tier: 1,
    combatPower: 100,
    ...overrides,
  };
}

const GAIN_COMPLETE = { evidenceRef: "第12章地宫血脉觉醒", cost: "左手经脉裂，三个月不能握剑", reuseRecord: "第18、31章同价使用" };

describe("升级门槛（D03 R3 三件套）", () => {
  it("境界没升 ⇒ 一条都不报（门槛只管「新能力」，不管数值波动）", () => {
    const rows = checkPowerGate({
      subject: "char-a",
      entries: [entry(), entry({ chapter: "第3章", chapterNo: 3, tier: 1, combatPower: 120 })],
    });
    expect(rows).toEqual([]);
  });

  it("台账里一条代价记录都没有 ⇒ 只发一条 info 总述，不给每次升级刷一行 warn", () => {
    const rows = checkPowerGate({
      subject: "char-a",
      entries: [
        entry(),
        entry({ chapter: "第12章", chapterNo: 12, tier: 2, combatPower: 400 }),
        entry({ chapter: "第30章", chapterNo: 30, tier: 3, combatPower: 800 }),
      ],
    });
    expect(rows.map((row) => row.rule)).toEqual(["powerup-gate-no-data"]);
    expect(rows[0]?.severity).toBe("info");
    // 关键是这句：没核对过 ≠ 没问题（不写出来，作者就会把"安静"读成"干净"）
    expect(rows[0]?.message).toContain("不等于");
  });

  it("作者开始记代价了 ⇒ 缺哪件点哪件（这就是 warn 级：他显然打算记，只是漏了）", () => {
    const rows = checkPowerGate({
      subject: "char-a",
      entries: [
        entry(),
        entry({ chapter: "第12章", chapterNo: 12, tier: 2, combatPower: 400, gain: GAIN_COMPLETE }),
        entry({
          chapter: "第30章",
          chapterNo: 30,
          tier: 3,
          combatPower: 800,
          gain: { evidenceRef: "第29章师承", cost: "寿命十年" },
        }),
      ],
    });
    const gate = rows.filter((row) => row.rule === "powerup-gate");
    expect(gate).toHaveLength(1);
    expect(gate[0]?.related).toBe("第30章");
    expect(gate[0]?.severity).toBe("warn");
    expect(gate[0]?.message).toContain("复用记录");
    expect(gate[0]?.message).not.toContain("代价");
    // 已经在核对就不许再来一条"没法核对"的总述（两条同时出现会互相打脸）
    expect(rows.some((row) => row.rule === "powerup-gate-no-data")).toBe(false);
  });

  it("三件套齐了 ⇒ 不报（判据要能绿，不是永远亮）", () => {
    const rows = checkPowerGate({
      subject: "char-a",
      entries: [entry(), entry({ chapter: "第12章", chapterNo: 12, tier: 2, combatPower: 400, gain: GAIN_COMPLETE })],
    });
    expect(rows.filter((row) => row.rule === "powerup-gate")).toEqual([]);
  });
});

describe("临时增益必须有回落（D03 R5 buff_ttl）", () => {
  it("声明 kind=buff 却没写 expiry ⇒ 一条 warn；写了 expiry 就放行", () => {
    const missing = checkPowerGate({
      subject: "char-a",
      entries: [entry(), entry({ chapter: "第5章", chapterNo: 5, tier: 1, combatPower: 300, kind: "buff" })],
    });
    expect(missing.map((row) => [row.rule, row.related])).toEqual([["buff-ttl", "第5章"]]);
    const withExpiry = checkPowerGate({
      subject: "char-a",
      entries: [
        entry(),
        entry({ chapter: "第5章", chapterNo: 5, tier: 1, combatPower: 300, kind: "buff", expiry: "第7章" }),
      ],
    });
    expect(withExpiry.filter((row) => row.rule === "buff-ttl")).toEqual([]);
  });
});

describe("台账字段的严格解析（新字段不许被静默忽略）", () => {
  const card = (log: string) =>
    `---
id: char-linyuan
type: character
name: 林渊
layer: characters
aliases: []
refs: []
` +
    `source_chapters: []
visibility: hidden
format_version: 1
extensions:
  power_log:
${log}---

正文。
`;

  it("gain 块里的未知键 ⇒ 整卡读错，不静默丢掉那个键", () => {
    const result = parsePowerLog(
      card('    - chapter: "第 12 章"\n      tier: 2\n      combat_power: 400\n      gain:\n        evidence_ref: 地宫\n        price: 十年\n'),
    );
    expect(result.error).toContain("price");
    expect(result.entries).toEqual([]);
  });

  it("kind 不在 D03 那六种事件类型里 ⇒ 报错并列出允许值（不猜他想写什么）", () => {
    const result = parsePowerLog(
      card('    - chapter: "第 12 章"\n      tier: 2\n      combat_power: 400\n      kind: 开挂\n'),
    );
    expect(result.error).toContain("开挂");
    expect(result.error).toContain("breakthrough");
  });

  it("不写新字段时与 R57 的解析逐字一致（向后兼容，老项目不受影响）", () => {
    const result = parsePowerLog(
      card('    - chapter: "第 1 章"\n      tier: 1\n      combat_power: 100\n      event: 起点\n'),
    );
    expect(result.error).toBeNull();
    expect(result.entries).toEqual([entry({ chapter: "第 1 章", event: "起点" })]);
  });

  it("写了 gain 就逐字段收下：空串当作没记，缺项要被点出来", () => {
    // 门槛管的是**境界上升那次过渡**，所以台账要有基线条目（只有一条时前后无从比较，不判）
    const result = parsePowerLog(
      card(
        '    - chapter: "第 1 章"\n      tier: 1\n      combat_power: 100\n' +
          '    - chapter: "第 12 章"\n      tier: 2\n      combat_power: 400\n' +
          '      gain:\n        evidence_ref: 地宫\n        cost: ""\n',
      ),
    );
    expect(result.error).toBeNull();
    expect(result.entries[1]?.gain).toEqual({ evidenceRef: "地宫" });
    const rows = checkPowerGate({ subject: "char-linyuan", entries: result.entries });
    expect(rows.map((row) => row.rule)).toEqual(["powerup-gate"]);
    expect(rows[0]?.message).toContain("代价");
    expect(rows[0]?.message).toContain("复用记录");
    expect(checkPowerGate({ subject: "char-linyuan", entries: [entry({ chapter: "第 12 章", chapterNo: 12, tier: 5 })] })).toEqual([]);
  });
});
describe("规则 id 清单与源码同源（豁免清单不许漏一条）", () => {
  it("POWER_GATE_RULE_IDS 覆盖源码里每一条 rule 字面量", async () => {
    const src = await readFile(new URL("../src/power-gate.ts", import.meta.url), "utf8");
    const literals = [...src.matchAll(/rule: "([a-z-]+)"/g)].map((m) => m[1] as string);
    const declared = new Set<string>(POWER_GATE_RULE_IDS);
    expect(literals.length).toBeGreaterThanOrEqual(3);
    for (const id of new Set(literals)) expect(declared.has(id), `清单里没有 ${id}`).toBe(true);
    for (const id of POWER_GATE_RULE_IDS) expect(literals).toContain(id);
  });
});
