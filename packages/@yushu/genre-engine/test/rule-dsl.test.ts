import { describe, expect, it } from "vitest";
import {
  RULE_MAX_DEPTH,
  RULE_MAX_NODES,
  evaluateRule,
  parseRuleDocument,
  readPath,
  renderMessage,
  type ConsistencyRule,
} from "../src/index.js";

/**
 * 规则 DSL 求值层（M4 / T4-1，docs/03 §8.2 + G06 §3）。
 * 沙箱类判定最怕"看起来在拦、其实放行"，所以**每道闸门都要有"该拦"与"不该拦"两侧**：
 * 只测拒绝会漏掉误杀（正常规则写不出来），只测放行会漏掉绕过（禁循环形同虚设）。
 */

const POWER_RULE = [
  "rule:",
  "  id: power-no-regress",
  "  severity: error",
  "  scope: cross_chapter",
  "  when:",
  "    and:",
  '      - {">=": [{var: "b.realm.tier"}, {var: "a.realm.tier"}]}',
  '      - {"<": [{var: "b.combat_power"}, {var: "a.combat_power"}]}',
  '  message: "境界提升但战力下降（{a.chapter}→{b.chapter}），疑似战力崩塌"',
].join("\n");

const pair = (over: Record<string, unknown> = {}) => ({
  a: { chapter: "第 3 章", realm: { tier: 3 }, combat_power: 100 },
  b: { chapter: "第 4 章", realm: { tier: 4 }, combat_power: 80 },
  ...over,
});

function parseOne(text: string): ConsistencyRule {
  const rules = parseRuleDocument(text);
  expect(rules).toHaveLength(1);
  return rules[0]!;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "(无 code)";
  }
  return "(未抛错)";
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "(未抛错)";
}

describe("parseRuleDocument：规则形状与加载期闸门", () => {
  it("G06 示例文件可解析（and + >= + < + var 全在原语内）", () => {
    const rule = parseOne(POWER_RULE);
    expect(rule.id).toBe("power-no-regress");
    expect(rule.severity).toBe("error");
    expect(rule.scope).toBe("cross_chapter");
    expect(rule.message).toContain("疑似战力崩塌");
  });

  it("规则件信封（apiVersion + id + title + source + rules）逐条盖上出处", () => {
    const text = [
      "apiVersion: yushu.rules/v1",
      "id: power-consistency",
      "title: 战力防崩塌",
      "source: D03-战力防崩塌规则",
      "rules:",
      "  - {id: r1, severity: warn, scope: chapter, when: {\"!\": {var: \"x\"}}, message: m1}",
      "  - {id: r2, severity: info, scope: project, when: {\"!\": {var: \"y\"}}, message: m2, priority: 5}",
    ].join("\n");
    const rules = parseRuleDocument(text);
    expect(rules.map((r) => r.id)).toEqual(["r1", "r2"]);
    expect(rules[1]!.priority).toBe(5);
    expect(rules[0]!.priority).toBeUndefined();
    expect(rules[0]!.origin).toEqual({ set: "power-consistency", title: "战力防崩塌", source: "D03-战力防崩塌规则" });

    const dup = ["apiVersion: yushu.rules/v1", "id: s", "rules:", "  - {id: r1, severity: warn, scope: chapter, when: {\"!\": {var: \"x\"}}, message: m}", "  - {id: r1, severity: info, scope: chapter, when: {\"!\": {var: \"y\"}}, message: m}"].join("\n");
    expect(codeOf(() => parseRuleDocument(dup))).toBe("E_RULE_PARSE");

    // 信封层的拼错键（如生效日期写成 date）：静默忽略等于把"带来源带版本"的要求悄悄丢掉
    const typo = ["apiVersion: yushu.rules/v1", "id: s", "date: 2026-01-01", "rules: [{id: r1, severity: warn, scope: chapter, when: {\"!\": {var: \"x\"}}, message: m}]"].join("\n");
    expect(codeOf(() => parseRuleDocument(typo))).toBe("E_RULE_PARSE");
    expect(messageOf(() => parseRuleDocument(typo))).toContain("date");
  });

  it("未知键拒绝：拼错的 severity 不得被静默忽略", () => {
    const text = POWER_RULE.replace("  severity: error", "  severiy: error");
    expect(codeOf(() => parseRuleDocument(text))).toBe("E_RULE_PARSE");
    expect(messageOf(() => parseRuleDocument(text))).toContain("severiy");
  });

  it("severity 只认三档：warning 一律拒绝（与 T3-13 同口径）", () => {
    const text = POWER_RULE.replace("severity: error", "severity: warning");
    expect(codeOf(() => parseRuleDocument(text))).toBe("E_RULE_PARSE");
    expect(messageOf(() => parseRuleDocument(text))).toContain("不是 warning");
  });

  it("scope 必须是四档之一", () => {
    const text = POWER_RULE.replace("scope: cross_chapter", "scope: whole_book");
    expect(codeOf(() => parseRuleDocument(text))).toBe("E_RULE_PARSE");
  });

  it("when 为标量 / 裸数组、message 缺失：都在解析期拒绝", () => {
    expect(codeOf(() => parseRuleDocument('rule:\n  id: r\n  severity: warn\n  scope: chapter\n  when: true\n  message: m'))).toBe("E_RULE_PARSE");
    expect(codeOf(() => parseRuleDocument('rule:\n  id: r\n  severity: warn\n  scope: chapter\n  when: [{var: "x"}]\n  message: m'))).toBe("E_RULE_PARSE");
    expect(codeOf(() => parseRuleDocument('rule:\n  id: r\n  severity: warn\n  scope: chapter\n  when: {"!": {"var": "x"}}'))).toBe("E_RULE_PARSE");
  });

  it("过深表达式在加载期就拒绝（不留到求值跑一半才失败）", () => {
    let deep: unknown = { var: "x" };
    for (let i = 0; i < RULE_MAX_DEPTH + 4; i += 1) deep = { "!": deep };
    const text = `rule:\n  id: deep\n  severity: warn\n  scope: scene\n  when: ${JSON.stringify(deep)}\n  message: m`;
    expect(codeOf(() => parseRuleDocument(text))).toBe("E_RULE_DEPTH");
  });

  it("不该拒绝：恰好到深度上限的表达式可以加载", () => {
    let atLimit: unknown = { var: "x" };
    for (let i = 0; i < RULE_MAX_DEPTH - 2; i += 1) atLimit = { "!": atLimit };
    const text = `rule:\n  id: ok-deep\n  severity: warn\n  scope: scene\n  when: ${JSON.stringify(atLimit)}\n  message: m`;
    expect(parseRuleDocument(text)[0]!.id).toBe("ok-deep");
  });

  it("顶层形状收紧：裸 rules 列表必须有版本信封；rule 与 apiVersion 二选一；都没有拒绝", () => {
    // 没有 apiVersion 的一批规则无法判断按哪套语义求值——不接受"看起来能用"的规则件
    expect(codeOf(() => parseRuleDocument('rules:\n  - {id: r, severity: warn, scope: scene, when: {"!": {var: x}}, message: m}'))).toBe("E_RULE_PARSE");
    expect(codeOf(() => parseRuleDocument('apiVersion: yushu.rules/v2\nid: s\nrules: []'))).toBe("E_RULE_PARSE");
    expect(codeOf(() => parseRuleDocument('rule: {id: r, severity: warn, scope: scene, when: {"!": {var: x}}, message: m}\napiVersion: yushu.rules/v1'))).toBe("E_RULE_PARSE");
    expect(codeOf(() => parseRuleDocument("other: 1"))).toBe("E_RULE_PARSE");
    expect(codeOf(() => parseRuleDocument("- 1\n- 2"))).toBe("E_RULE_PARSE");
    expect(codeOf(() => parseRuleDocument("apiVersion: yushu.rules/v1\nid: s"))).toBe("E_RULE_PARSE");
  });
});

describe("evaluateRule：命中与不命中", () => {
  it("境界升而战力降 → 命中，结论占位符已代入", () => {
    const result = evaluateRule(parseOne(POWER_RULE), pair());
    expect(result.matched).toBe(true);
    expect(result.message).toBe("境界提升但战力下降（第 3 章→第 4 章），疑似战力崩塌");
    expect(result.severity).toBe("error");
  });

  it("不该命中：战力没降（100→200）时 matched=false，但 evidence 仍给出四个读数", () => {
    const data = pair({ b: { chapter: "第 4 章", realm: { tier: 4 }, combat_power: 200 } });
    const result = evaluateRule(parseOne(POWER_RULE), data);
    expect(result.matched).toBe(false);
    expect(result.evidence["b.combat_power"]).toBe("200");
    expect(Object.keys(result.evidence).sort()).toEqual(["a.combat_power", "a.realm.tier", "b.combat_power", "b.realm.tier"]);
  });

  it("不该命中：境界没升（tier 4→3）时前一个 and 条件即为假，短路后不再取战力", () => {
    const data = {
      a: { chapter: "A", realm: { tier: 4 }, combat_power: 100 },
      b: { chapter: "B", realm: { tier: 3 }, combat_power: 80 },
    };
    const result = evaluateRule(parseOne(POWER_RULE), data);
    expect(result.matched).toBe(false);
    // and 短路：第二个条件未求值 → 其 var 不进 evidence（evidence 只登记"真读过的"）
    expect(result.evidence["b.combat_power"]).toBeUndefined();
  });

  it("比值规则（除法）：战力跌破 8 成即命中", () => {
    const rule: ConsistencyRule = {
      id: "power-drop-ratio",
      severity: "warn",
      scope: "cross_chapter",
      when: { "<": [{ "/": [{ var: "b.combat_power" }, { var: "a.combat_power" }] }, 0.8] },
      message: "战力比为 {b.combat_power}/{a.combat_power}",
      priority: 1,
    };
    expect(evaluateRule(rule, pair()).matched).toBe(false); // 80/100 = 0.8，不「< 0.8」
    expect(evaluateRule(rule, pair({ b: { chapter: "B", realm: { tier: 4 }, combat_power: 79 } })).matched).toBe(true);
    expect(evaluateRule(rule, pair({ b: { chapter: "B", realm: { tier: 4 }, combat_power: 60 } })).matched).toBe(true);
  });

  it("乘法单位元：* 从 1 起步（曾因与 + 共用 0 而恒为 0）", () => {
    const rule: ConsistencyRule = {
      id: "mul",
      severity: "info",
      scope: "scene",
      when: { ">=": [{ "*": [{ var: "count" }, 3] }, 6] },
      message: "m",
      priority: 0,
    };
    expect(evaluateRule(rule, { count: 2 }).matched).toBe(true);
    expect(evaluateRule(rule, { count: 1 }).matched).toBe(false);
  });

  it("缺字段：var 取不到就是 undefined，可与 null 比等值，但绝不做大小比较", () => {
    const eqRule: ConsistencyRule = { id: "eq", severity: "info", scope: "chapter", when: { "==": [{ var: "a.realm.depth" }, null] }, message: "m", priority: 0 };
    expect(evaluateRule(eqRule, pair()).matched).toBe(true);
    expect(evaluateRule(eqRule, pair()).evidence["a.realm.depth"]).toBe("（缺失）");

    const cmpRule: ConsistencyRule = { id: "cmp", severity: "info", scope: "chapter", when: { "<": [{ var: "a.realm.depth" }, 3] }, message: "m", priority: 0 };
    expect(codeOf(() => evaluateRule(cmpRule, pair()))).toBe("E_RULE_UNORDERABLE");
  });
});

describe("沙箱闸门：禁循环 / 禁 IO / 深度 / 预算", () => {
  it("迭代原语拒绝，且错误信息点名「禁循环」", () => {
    const rule: ConsistencyRule = { id: "loop", severity: "error", scope: "project", when: { reduce: [{ var: "items" }] }, message: "m", priority: 0 };
    expect(codeOf(() => evaluateRule(rule, pair()))).toBe("E_RULE_OPERATOR");
    expect(messageOf(() => evaluateRule(rule, pair()))).toContain("禁循环");
  });

  it("正则类原语拒绝（模式匹配属检测器，不属布尔求值）", () => {
    const rule: ConsistencyRule = { id: "re", severity: "error", scope: "project", when: { regex: ["a", "b"] }, message: "m", priority: 0 };
    expect(messageOf(() => evaluateRule(rule, pair()))).toContain("禁正则");
  });

  it("未知操作符不静默当假：必须抛错（静默放行＝规则永不响，面板上与「一切正常」无法区分）", () => {
    const rule: ConsistencyRule = { id: "unknown", severity: "error", scope: "project", when: { frobnicate: 1 }, message: "m", priority: 0 };
    expect(codeOf(() => evaluateRule(rule, pair()))).toBe("E_RULE_OPERATOR");
    expect(messageOf(() => evaluateRule(rule, pair()))).toContain("不静默当假");
  });

  it("原型链与函数一律拒绝：var 只能读数据", () => {
    const protoRule: ConsistencyRule = { id: "proto", severity: "info", scope: "project", when: { "!=": [{ var: "__proto__.polluted" }, null] }, message: "m", priority: 0 };
    expect(codeOf(() => evaluateRule(protoRule, pair()))).toBe("E_RULE_VAR");

    const dataWithFn = pair({ hook: () => ({ polluted: true }) });
    const fnRule: ConsistencyRule = { id: "fn", severity: "info", scope: "project", when: { "!=": [{ var: "hook" }, null] }, message: "m", priority: 0 };
    expect(codeOf(() => evaluateRule(fnRule, dataWithFn))).toBe("E_RULE_VAR");
  });

  it("求值期深度上限独立生效（绕过解析器直接构造的规则）", () => {
    let deep: unknown = { var: "x" };
    for (let i = 0; i < RULE_MAX_DEPTH + 3; i += 1) deep = { "!": deep };
    const rule: ConsistencyRule = { id: "deep", severity: "info", scope: "scene", when: deep, message: "m", priority: 0 };
    expect(codeOf(() => evaluateRule(rule, { x: true }))).toBe("E_RULE_DEPTH");
  });

  it("节点预算：超长候选数组中断求值（计数中断，不用墙钟计时）", () => {
    const big = Array.from({ length: RULE_MAX_NODES + 10 }, (_unused, index) => index);
    const rule: ConsistencyRule = { id: "big", severity: "info", scope: "scene", when: { in: [{ var: "x" }, big] }, message: "m", priority: 0 };
    expect(codeOf(() => evaluateRule(rule, { x: 1 }))).toBe("E_RULE_BUDGET");
  });

  it("不该拦：正常长度的 in 数组与常见嵌套深度照常求值", () => {
    const rule: ConsistencyRule = { id: "in", severity: "info", scope: "scene", when: { in: [{ var: "b.realm.tier" }, [3, 4, 5]] }, message: "m", priority: 0 };
    expect(evaluateRule(rule, pair()).matched).toBe(true);
    expect(evaluateRule(rule, { b: { realm: { tier: 9 } } }).matched).toBe(false);
  });

  it("除数为 0 报错而不是产出 Infinity（Infinity 会让下一条比较静默失真）", () => {
    const rule: ConsistencyRule = { id: "div", severity: "info", scope: "scene", when: { "<": [{ "/": [{ var: "a.combat_power" }, { var: "b.combat_power" }] }, 1] }, message: "m", priority: 0 };
    expect(codeOf(() => evaluateRule(rule, pair({ b: { chapter: "B", realm: { tier: 1 }, combat_power: 0 } })))).toBe("E_RULE_DIV_ZERO");
  });
});

describe("求值语义细节", () => {
  it("等值是严格的：0 与 \"0\" 不相等；null 与 undefined 都算「没有」", () => {
    const zero: ConsistencyRule = { id: "z", severity: "info", scope: "scene", when: { "==": [{ var: "n" }, "0"] }, message: "m", priority: 0 };
    expect(evaluateRule(zero, { n: 0 }).matched).toBe(false);
    const nullish: ConsistencyRule = { id: "u", severity: "info", scope: "scene", when: { "==": [{ var: "missing" }, { var: "explicitNull" }] }, message: "m", priority: 0 };
    expect(evaluateRule(nullish, { explicitNull: null }).matched).toBe(true);
  });

  it("大小比较不比字符串字典序（跨平台排序不稳定）", () => {
    const rule: ConsistencyRule = { id: "s", severity: "info", scope: "scene", when: { "<": ["甲", "乙"] }, message: "m", priority: 0 };
    expect(codeOf(() => evaluateRule(rule, {}))).toBe("E_RULE_UNORDERABLE");
  });

  it("in 对字符串是子串检查；候选既非数组也非字符串则拒绝", () => {
    const sub: ConsistencyRule = { id: "sub", severity: "info", scope: "scene", when: { in: ["渡劫", { var: "b.title" }] }, message: "m", priority: 0 };
    expect(evaluateRule(sub, { b: { title: "渡劫境重逢" } }).matched).toBe(true);
    expect(evaluateRule(sub, { b: { title: "筑基" } }).matched).toBe(false);
    const bad: ConsistencyRule = { id: "bad", severity: "info", scope: "scene", when: { in: [1, { var: "n" }] }, message: "m", priority: 0 };
    expect(codeOf(() => evaluateRule(bad, { n: 5 }))).toBe("E_RULE_OPERATOR");
  });

  it("and / or / ! 的真值语义与空参数约定（and 空为真、or 空为假）", () => {
    const andEmpty: ConsistencyRule = { id: "ae", severity: "info", scope: "scene", when: { and: [] }, message: "m", priority: 0 };
    expect(evaluateRule(andEmpty, {}).matched).toBe(true);
    const orEmpty: ConsistencyRule = { id: "oe", severity: "info", scope: "scene", when: { or: [] }, message: "m", priority: 0 };
    expect(evaluateRule(orEmpty, {}).matched).toBe(false);
    const notRule: ConsistencyRule = { id: "nt", severity: "info", scope: "scene", when: { "!": { var: "flag" } }, message: "m", priority: 0 };
    expect(evaluateRule(notRule, { flag: "" }).matched).toBe(true);
    expect(evaluateRule(notRule, { flag: "有值" }).matched).toBe(false);
  });

  it("一个对象里塞两个操作符键 → 拒绝（不猜优先级）", () => {
    const rule: ConsistencyRule = { id: "two", severity: "info", scope: "scene", when: { ">": [1, 0], "<": [2, 3] }, message: "m", priority: 0 };
    expect(codeOf(() => evaluateRule(rule, {}))).toBe("E_RULE_OPERATOR");
  });

  it("参数数量不对 → 拒绝（> 只接受二元）", () => {
    const rule: ConsistencyRule = { id: "arity", severity: "info", scope: "scene", when: { ">": [3, 2, 1] }, message: "m", priority: 0 };
    expect(codeOf(() => evaluateRule(rule, {}))).toBe("E_RULE_OPERATOR");
  });
});

describe("readPath 与 renderMessage", () => {
  it("数组段用数字下标；越界与非法下标返回 undefined 而非报错", () => {
    const data = { items: [{ name: "玄铁令" }, { name: "残卷" }] };
    expect(readPath(data, "items.0.name")).toBe("玄铁令");
    expect(readPath(data, "items.5.name")).toBeUndefined();
    expect(readPath(data, "items.x.name")).toBeUndefined();
  });

  it("空段路径报错；对象中间层是标量时报错（不静默返回 undefined 让规则误判）", () => {
    expect(codeOf(() => readPath({ a: 1 }, "a.b"))).toBe("E_RULE_VAR");
    expect(codeOf(() => readPath({ a: 1 }, "a..b"))).toBe("E_RULE_VAR");
  });

  it("占位符复用已求值的 evidence；取不到的路径留「（缺 路径）」而不是整条规则失败", () => {
    const rule = parseOne(POWER_RULE);
    const result = evaluateRule(rule, pair());
    expect(result.message).toContain("第 3 章");
    expect(renderMessage("阶段 {a.realm.tier} 上限 {a.cap}", { "a.realm.tier": "已读值" }, pair())).toBe("阶段 已读值 上限 （缺 a.cap）");
  });

  it("非占位语法（含空格 / 非法首字符）原样保留，不做二次猜测", () => {
    expect(renderMessage("成本 {a b} 与 {1a}", {}, {})).toBe("成本 {a b} 与 {1a}");
  });
});

describe("确定性", () => {
  it("同规则同数据两次求值：结论、文案与 evidence 逐字段一致", () => {
    const rule = parseOne(POWER_RULE);
    const first = evaluateRule(rule, pair());
    const second = evaluateRule(rule, pair());
    expect(second).toEqual(first);
    expect(JSON.stringify(second.evidence)).toBe(JSON.stringify(first.evidence));
  });
});
