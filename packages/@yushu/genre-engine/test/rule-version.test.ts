/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { mergeRuleSets, parseRuleDocument, type RuleSetGroup } from "../src/rule-dsl.js";

/**
 * 规则版本号 / 生效日期 / 跨包合并（M4 / T4-12 的机制部分，R85）。
 *
 * docs/03 §8.3 把这条挂在"待实现设计"上，R59 核对时的现状是：
 * **同 id 只点名不合并**（`duplicateRuleIds`），`priority` 解析了但没有消费者。
 * 本轮补的是"规则包有了版本与生效日期之后该怎么合"，平台包内容本身留 M5 填。
 *
 * 六条设计决定，每条都对应一个容易写错的现实场景：
 * ① `version` 按**数值段**比，不按字符串——`1.10 > 1.9`，字典序会把它判反；
 * ② 版本号**必须带引号**：YAML 把 `version: 1.10` 读成浮点 1.1，尾零在解析阶段就丢了，
 *    引擎再"顺手转字符串"等于把作者写的版本号悄悄换成另一个值 ⇒ 直接拒并说明原因；
 * ③ 没写 version 的按最旧算（老包没版本、新包写了 ⇒ 新的胜出），但**不报错**，
 *    因为现存两份内置包件都没写版本，报错等于把既有包全判死；
 * ④ 同版本同 id ⇒ **点名 ambiguous 交用户裁定**，胜出者只按确定性次序取一个，
 *    绝不"看起来合并了"（docs/03 §8.3：一切冲突显式提示，禁止静默覆盖）；
 * ⑤ 生效日期只在调用方**显式给了 asOf** 时才判。引擎里不许读 `Date.now()`——
 *    那是第二个状态源，同输入两次结果就不一样（红线：确定性优先）；
 * ⑥ 没给 asOf ⇒ `dateCheck: "skipped"` 且**一条都不剔除**：没判不等于没问题。
 */

const ruleYaml = (extra: string, id = "power-no-regress"): string =>
  `apiVersion: yushu.rules/v1\nid: set-${id}\ntitle: 测试集\nrules:\n  - id: ${id}\n    severity: error\n    scope: chapter\n    ${extra}\n    when: { "==": [1, 1] }\n    message: 命中了\n`;

function one(text: string): RuleSetGroup["rules"] {
  return parseRuleDocument(text);
}

describe("规则版本与生效日期字段（T4-12）", () => {
  it("RULE_KEYS 容纳 version / effective_from / effective_until（R84 台账点名的前置）", () => {
    const rules = one(
      ruleYaml('version: "2.1.0"\n    effective_from: 2026-01-01\n    effective_until: 2026-12-31'),
    );
    expect(rules[0]).toMatchObject({
      id: "power-no-regress",
      version: "2.1.0",
      effective_from: "2026-01-01",
      effective_until: "2026-12-31",
    });
  });

  it("没写版本与日期也照样合法（现存内置包件都没有，报错等于把包全判死）", () => {
    const rules = one(ruleYaml("priority: 3"));
    expect(rules[0]).toMatchObject({ id: "power-no-regress" });
    expect(rules[0]?.version).toBeUndefined();
  });

  it("裸数字版本号一律拒（YAML 已把 1.10 读成 1.1，静默接受就是换掉了作者写的值）", () => {
    let code = "";
    let message = "";
    try {
      one(ruleYaml("version: 1.10"));
    } catch (err) {
      code = err instanceof Error ? (err as { code?: string }).code ?? "" : "";
      message = err instanceof Error ? err.message : "";
    }
    expect(code).toBe("E_RULE_PARSE");
    // 光报错不够，得说清为什么不能"顺手转成字符串"——否则作者只会改成另一个裸数字再试一次
    expect(message).toContain("尾零");
  });

  it("坏格式一律拒：非数值段版本、带预发布后缀、日期不合 ISO、日期不存在于日历", () => {
    const bad = [
      ruleYaml('version: "v2"'),
      ruleYaml('version: "2.1.0-beta"'),
      ruleYaml("effective_from: 2026-1-1"),
      ruleYaml("effective_from: 2026/01/01"),
      ruleYaml("effective_until: 2026-02-30"),
      ruleYaml("effective_from: 2026-13-01"),
    ];
    for (const text of bad) {
      let code = "";
      let message = "";
      try {
        parseRuleDocument(text);
      } catch (err) {
        code = err instanceof Error ? (err as { code?: string }).code ?? "" : "";
        message = err instanceof Error ? err.message : "";
      }
      expect([code, message].join(" "), `这段本该被拒：${text.slice(-60)}`).toContain("E_RULE_PARSE");
    }
  });

  it("生效区间反了（from 晚于 until）当场拒，不等求值期发现「永远不生效」", () => {
    expect(() => one(ruleYaml("effective_from: 2026-06-01\n    effective_until: 2026-05-01"))).toThrow(
      /生效区间/,
    );
  });
});

describe("跨包同名规则合并（docs/03 §8.3「高版本胜出」）", () => {
  const groups = (a: string, b: string): RuleSetGroup[] => [
    { packId: "pack-a", file: "rules/a.yaml", rules: one(a) },
    { packId: "pack-b", file: "rules/b.yaml", rules: one(b) },
  ];

  it("版本按数值段比：1.10 胜过 1.9（字典序会判反）", () => {
    const result = mergeRuleSets(groups(ruleYaml('version: "1.9"'), ruleYaml('version: "1.10"')));
    expect(result.rules).toHaveLength(1);
    expect(result.winners[0]).toMatchObject({ id: "power-no-regress", version: "1.10", packId: "pack-b" });
    expect(result.overrides).toHaveLength(1);
    expect(result.overrides[0]).toMatchObject({
      id: "power-no-regress",
      winnerVersion: "1.10",
      loserVersion: "1.9",
      reason: "更高版本胜出",
    });
  });

  it("没写版本按最旧算：有版本的胜出，且这条覆盖被点名", () => {
    const result = mergeRuleSets(groups(ruleYaml("priority: 1"), ruleYaml('version: "1.0"')));
    expect(result.winners[0]?.packId).toBe("pack-b");
    expect(result.overrides[0]?.loserVersion).toBeNull();
  });

  it("同版本同 id ⇒ 点名 ambiguous（两份包各自维护同一条规则本身就是漂移，不静默合并）", () => {
    const result = mergeRuleSets(groups(ruleYaml('version: "1.0"'), ruleYaml('version: "1.0"')));
    expect(result.winners).toHaveLength(1);
    expect(result.ambiguous).toHaveLength(1);
    expect(result.ambiguous[0]).toMatchObject({
      id: "power-no-regress",
      versions: ["1.0", "1.0"],
      packs: ["pack-a", "pack-b"],
    });
    // 胜出者仍要确定性可复现：并列时按包 id 码点序
    expect(result.winners[0]?.packId).toBe("pack-a");
    // 并列不进 overrides——它不是"高版本盖掉低版本"，混在一起会让人以为已经裁定完了
    expect(result.overrides).toEqual([]);
  });

  it("不同 id 不互相影响，也不产生任何覆盖记录", () => {
    const result = mergeRuleSets([
      { packId: "pack-a", file: "rules/a.yaml", rules: one(ruleYaml('version: "1.0"', "rule-x")) },
      { packId: "pack-b", file: "rules/b.yaml", rules: one(ruleYaml('version: "2.0"', "rule-y")) },
    ]);
    expect(result.rules.map((rule) => rule.id)).toEqual(["rule-x", "rule-y"]);
    expect(result.overrides).toEqual([]);
    expect(result.ambiguous).toEqual([]);
  });

  it("给了 asOf 才判生效期：未到生效与已过期的都剔除并写明原因", () => {
    const result = mergeRuleSets(
      [
        {
          packId: "pack-a",
          file: "rules/a.yaml",
          rules: one(ruleYaml('version: "1.0"\n    effective_from: 2026-09-01', "rule-future")),
        },
        {
          packId: "pack-b",
          file: "rules/b.yaml",
          rules: one(ruleYaml('version: "1.0"\n    effective_until: 2026-01-31', "rule-past")),
        },
        {
          packId: "pack-c",
          file: "rules/c.yaml",
          rules: one(
            ruleYaml(
              'version: "1.0"\n    effective_from: 2026-01-01\n    effective_until: 2026-12-31',
              "rule-now",
            ),
          ),
        },
      ],
      { asOf: "2026-06-15" },
    );
    expect(result.rules.map((rule) => rule.id)).toEqual(["rule-now"]);
    expect(result.outOfDate.map((item) => [item.id, item.reason])).toEqual([
      ["rule-future", "未到生效日期（2026-09-01 起才生效，本次按 2026-06-15 判）"],
      ["rule-past", "已过生效期（至 2026-01-31，本次按 2026-06-15 判）"],
    ]);
    expect(result.dateCheck).toBe("applied");
  });

  it("没给 asOf ⇒ 一条都不剔除，但 dateCheck 标成 skipped（没判 ≠ 没问题）", () => {
    const result = mergeRuleSets([
      {
        packId: "pack-a",
        file: "rules/a.yaml",
        rules: one(ruleYaml('version: "1.0"\n    effective_from: 2099-01-01', "rule-future")),
      },
    ]);
    expect(result.rules.map((rule) => rule.id)).toEqual(["rule-future"]);
    expect(result.outOfDate).toEqual([]);
    expect(result.dateCheck).toBe("skipped");
  });

  it("确定性：同输入两次逐字一致，且输出顺序按 id 码点序（不随入参顺序漂移）", () => {
    const input = [
      { packId: "p2", file: "r/b.yaml", rules: one(ruleYaml('version: "1.0"', "b-rule")) },
      { packId: "p1", file: "r/a.yaml", rules: one(ruleYaml('version: "1.0"', "a-rule")) },
    ];
    const first = mergeRuleSets(input);
    const second = mergeRuleSets(input);
    expect(second).toEqual(first);
    expect(first.winners.map((item) => item.id)).toEqual(["a-rule", "b-rule"]);
  });

  it("空输入不炸，且各清单为空", () => {
    expect(mergeRuleSets([])).toEqual({
      rules: [],
      winners: [],
      overrides: [],
      ambiguous: [],
      outOfDate: [],
      dateCheck: "skipped",
    });
  });
});
