/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import type { PackRuleSet } from "@yushu/genre-engine";
import { applyRuleMerge } from "../src/main/rule-findings.js";

/**
 * 跨包同名规则在桌面端怎么落地（T4-12 / R85）。
 *
 * 引擎侧 `mergeRuleSets` 已经管"谁胜出"（13 例）；这里管的是**桌面端拿到合并结果后还认不认得
 * 每条规则的出处**：结论行要写"派系包 X（rules/y.yaml）"，所以合并必须把胜出者的
 * packId + file 一路带到面板。合并算法对了、出处丢了，面板就会指着错误的包说"这条是你该改的"。
 *
 * 三条断言各挡一种真实事故：
 * ① 高版本胜出**且出处跟着换成胜者**（不是第一个文件的）；
 * ② 解析失败的文件不进合并，但必须原样出现在 `failed` 里——
 *    悄悄丢掉等于"这个包没有规则"，而真相是"这个文件读不了"（沉默的校验器同族）；
 * ③ 没给 asOf 时 `dateCheck: "skipped"`，带生效日期的规则**照样参与**（不判 ≠ 判过了）。
 */

const setOf = (packId: string, file: string, version: string | undefined, message = "命中了"): PackRuleSet => ({
  file,
  packId,
  rules: [
    {
      id: "power-no-regress",
      severity: "error",
      scope: "chapter",
      when: { "==": [1, 1] },
      message,
      ...(version === undefined ? {} : { version }),
    },
  ],
  error: null,
  expressionIssues: {},
});

const brokenSet: PackRuleSet = {
  file: "rules/broken.yaml",
  packId: "pack-broken",
  rules: [],
  error: "信封未知键「author」",
  expressionIssues: {},
};

describe("桌面端跨包规则合并（T4-12）", () => {
  it("高版本胜出，且出处跟着换成胜者所在包与文件", () => {
    const view = applyRuleMerge([
      setOf("pack-old", "rules/a.yaml", "1.0", "旧结论"),
      setOf("pack-new", "rules/b.yaml", "1.10", "新结论"),
    ]);
    expect(view.runnable).toHaveLength(1);
    expect(view.runnable[0]).toMatchObject({
      rule: { message: "新结论" },
      origin: "派系包 pack-new（rules/b.yaml）",
    });
    expect(view.overrides).toMatchObject([
      { id: "power-no-regress", winner: "pack-new", loser: "pack-old", reason: "更高版本胜出" },
    ]);
    expect(view.ambiguous).toEqual([]);
  });

  it("解析失败的文件不进合并，但原样列在 failed 与 errorLines（不许看起来像「这个包没有规则」）", () => {
    const view = applyRuleMerge([brokenSet, setOf("pack-a", "rules/a.yaml", "1.0")]);
    expect(view.failed).toEqual([{ packId: "pack-broken", file: "rules/broken.yaml", error: "信封未知键「author」" }]);
    // 面板与 errors 用的那行文案也归本函数产出：调用方只负责把它并进 errors，
    // 拼装在别处做的话，这条断言就管不到"到底有没有外显"（R82 第 7 条：变异点名的文件要自己持有断言）
    expect(view.errorLines).toEqual(["派系包 pack-broken（rules/broken.yaml）：信封未知键「author」"]);
    expect(view.runnable).toHaveLength(1);
  });

  it("没给 asOf ⇒ dateCheck=skipped，带生效日期的规则照样参与（不判不等于判过了）", () => {
    const withDate: PackRuleSet = {
      ...setOf("pack-a", "rules/a.yaml", "1.0"),
      rules: [{ ...setOf("pack-a", "rules/a.yaml", "1.0").rules[0]!, effective_from: "2099-01-01" }],
    };
    const view = applyRuleMerge([withDate]);
    expect(view.dateCheck).toBe("skipped");
    expect(view.runnable).toHaveLength(1);
    expect(view.outOfDate).toEqual([]);
  });

  it("给了 asOf 且未到生效期 ⇒ 剔除并点名，runnable 里不留半条", () => {
    const withDate: PackRuleSet = {
      ...setOf("pack-a", "rules/a.yaml", "1.0"),
      rules: [{ ...setOf("pack-a", "rules/a.yaml", "1.0").rules[0]!, effective_from: "2027-01-01" }],
    };
    const view = applyRuleMerge([withDate], { asOf: "2026-06-15" });
    expect(view.dateCheck).toBe("applied");
    expect(view.runnable).toEqual([]);
    expect(view.outOfDate.map((item) => item.id)).toEqual(["power-no-regress"]);
  });

  it("同版本并列 ⇒ ambiguous 点名两个包，出处仍取确定性胜者", () => {
    const view = applyRuleMerge([
      setOf("pack-b", "rules/b.yaml", "1.0"),
      setOf("pack-a", "rules/a.yaml", "1.0"),
    ]);
    expect(view.ambiguous).toHaveLength(1);
    expect(view.ambiguous[0]?.packs).toEqual(["pack-a", "pack-b"]);
    expect(view.runnable[0]?.origin).toBe("派系包 pack-a（rules/a.yaml）");
  });

  it("空清单不炸：runnable 与各清单都空", () => {
    expect(applyRuleMerge([])).toEqual({
      runnable: [],
      failed: [],
      errorLines: [],
      overrides: [],
      ambiguous: [],
      outOfDate: [],
      dateCheck: "skipped",
    });
  });
});
