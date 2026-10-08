import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { evaluateRule, parseRuleDocument, type ConsistencyRule } from "../src/index.js";

/**
 * **拿仓库里真实的派系包规则件回归**（`packs/xuanhuan-xitong/rules/`）。
 *
 * 为什么单独要有这一份：R50 的解析器最初只按自己测试里假想的形状写（顶层 `rules:`），
 * 一碰到真实包文件（`apiVersion + id + title + source + rules` 信封、且两条规则的 `when`
 * 里塞了两个键）就全盘解析失败。引擎只对自己的测试数据正确，等于没接上真数据。
 */

const RULES_DIR = fileURLToPath(new URL("../../../../packs/xuanhuan-xitong/rules", import.meta.url));

function loadPackRules(): Array<{ file: string; rules: ConsistencyRule[] }> {
  return readdirSync(RULES_DIR)
    .filter((name) => name.endsWith(".yaml"))
    .sort()
    .map((name) => ({
      file: name,
      rules: parseRuleDocument(readFileSync(join(RULES_DIR, name), "utf8")),
    }));
}

/** 每条规则各自的求值数据（缺了哪条就补哪条；只求"能跑通沙箱"，不代表 T4-2 的真取数） */
const FIXTURES: Record<string, Record<string, unknown>> = {
  "power-no-regress": {
    a: { chapter: "第 3 章", realm: { tier: 3 }, combat_power: 100 },
    b: { chapter: "第 4 章", realm: { tier: 4 }, combat_power: 80 },
  },
  "power-ceiling-exceeded": { scene: { combat_power: 900 }, realm: { tier_next: { ceiling: 500 } } },
  "power-no-cost": { scene: { power_used: true, cost_recorded: false } },
  "realm-gap-too-large": { realm: { tier_delta: 3, from: "筑基", to: "元婴" } },
  "realm-lifespan-missing": { realm: { lifespan_defined: false } },
  "realm-breakthrough-uncelebrated": { chapter: { has_breakthrough: true, has_breakthrough_beat: false } },
};

describe("真实包规则件回归", () => {
  it("两件规则文件全部可解析，且逐条盖上出处", () => {
    const loaded = loadPackRules();
    expect(loaded.map((item) => item.file)).toEqual(["power-consistency.yaml", "realm-progress.yaml"]);
    expect(loaded[0]!.rules).toHaveLength(3);
    expect(loaded[1]!.rules).toHaveLength(3);
    expect(loaded[0]!.rules[0]).toMatchObject({
      id: "power-no-regress",
      severity: "error",
      scope: "cross_chapter",
      origin: { set: "power-consistency", title: "战力防崩塌", source: "D03-战力防崩塌规则" },
    });
  });

  it("跨件规则 id 唯一（同名要靠版本合并，不能靠加载顺序）", () => {
    const ids = loadPackRules().flatMap((item) => item.rules.map((rule) => rule.id));
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });

  it("每条规则都能在自己的夹具数据上跑通沙箱（不抛 E_RULE_*）", () => {
    for (const { rules } of loadPackRules()) {
      for (const rule of rules) {
        const data = FIXTURES[rule.id];
        expect(data, `夹具缺失：${rule.id}`).toBeDefined();
        const result = evaluateRule(rule, data!);
        expect(typeof result.matched).toBe("boolean");
        expect(result.ruleId).toBe(rule.id);
        expect(Object.keys(result.evidence).length).toBeGreaterThan(0);
      }
    }
  });

  it("夹具都是「该命中」的形状：六条规则逐条命中，结论文案已代入占位", () => {
    const matched: string[] = [];
    for (const { rules } of loadPackRules()) {
      for (const rule of rules) {
        if (evaluateRule(rule, FIXTURES[rule.id]!).matched) matched.push(rule.id);
      }
    }
    expect(matched.sort()).toEqual(Object.keys(FIXTURES).sort());
    const regress = evaluateRule(
      loadPackRules()[0]!.rules[0]!,
      FIXTURES["power-no-regress"]!,
    );
    expect(regress.message).toBe("境界提升但战力下降（第 3 章→第 4 章），疑似战力崩塌");
  });

  it("夹具反例：不越上限、记录了代价、跨级正常时不得命中（防误报侧）", () => {
    const byId = new Map(loadPackRules().flatMap((item) => item.rules.map((rule) => [rule.id, rule])));
    expect(evaluateRule(byId.get("power-ceiling-exceeded")!, { scene: { combat_power: 400 }, realm: { tier_next: { ceiling: 500 } } }).matched).toBe(false);
    expect(evaluateRule(byId.get("power-no-cost")!, { scene: { power_used: true, cost_recorded: true } }).matched).toBe(false);
    expect(evaluateRule(byId.get("realm-gap-too-large")!, { realm: { tier_delta: 2, from: "筑基", to: "金丹" } }).matched).toBe(false);
    expect(evaluateRule(byId.get("realm-lifespan-missing")!, { realm: { lifespan_defined: true } }).matched).toBe(false);
    expect(evaluateRule(byId.get("realm-breakthrough-uncelebrated")!, { chapter: { has_breakthrough: true, has_breakthrough_beat: true } }).matched).toBe(false);
  });
});
