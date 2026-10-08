import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectExpressionIssues,
  duplicateRuleIds,
  flattenRules,
  lintPack,
  loadPack,
  loadPackRuleSets,
  loadRuleSets,
} from "../src/index.js";

/**
 * 规则件套的**内容层**加载与 lint（M4 / T4-1 桌面接入，R51）。
 * 重点盯一件事：**坏规则不得静默消失**——解析失败、表达式问题、同包撞 id 都要有可读的 error。
 */

const PACK_DIR = fileURLToPath(new URL("../../../../packs/xuanhuan-xitong", import.meta.url));

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-rules-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 把规则文件写进临时目录，返回一个"清单指向这些文件"的已加载包（复用真包的合法 manifest） */
async function packWithRuleFiles(...texts: string[]): Promise<ReturnType<typeof loadPack>> {
  const pack = loadPack(PACK_DIR);
  const paths: string[] = [];
  for (const [index, text] of texts.entries()) {
    const file = join(dir, `rules-${index}.yaml`);
    await writeFile(file, text, "utf8");
    paths.push(file);
  }
  pack.resolvedFiles.rules = paths;
  return pack;
}

const GOOD = [
  "apiVersion: yushu.rules/v1",
  "id: good-set",
  "title: 正常规则",
  "source: D03",
  "rules:",
  '  - {id: r-ok, severity: warn, scope: chapter, when: {">": [{var: "a.tier"}, 3]}, message: 越界}',
].join("\n");

describe("loadPackRuleSets：真包与坏件", () => {
  it("真包两件全部可解析，文件路径给的是包内相对路径", () => {
    const sets = loadPackRuleSets(loadPack(PACK_DIR));
    expect(sets.map((set) => set.file)).toEqual(["rules/power-consistency.yaml", "rules/realm-progress.yaml"]);
    expect(sets.every((set) => set.error === null)).toBe(true);
    expect(sets.every((set) => Object.keys(set.expressionIssues).length === 0)).toBe(true);
    expect(flattenRules(sets)).toHaveLength(6);
    expect(sets[0]!.packId).toBe("xuanhuan-xitong");
  });

  it("读不出来的文件报 error 而不是当成「没有规则」", async () => {
    const pack = loadPack(PACK_DIR);
    pack.resolvedFiles.rules = [join(dir, "does-not-exist.yaml")];
    const sets = loadPackRuleSets(pack);
    expect(sets[0]!.error).toContain("读不出来");
    expect(sets[0]!.rules).toEqual([]);
  });

  it("多包摊平顺序稳定（按传入包顺序、包内按声明顺序）", () => {
    const sets = loadRuleSets([loadPack(PACK_DIR), loadPack(PACK_DIR)]);
    expect(sets).toHaveLength(4);
    expect(flattenRules(sets).map((rule) => rule.id)).toEqual([
      "power-no-regress",
      "power-ceiling-exceeded",
      "power-no-cost",
      "realm-gap-too-large",
      "realm-lifespan-missing",
      "realm-breakthrough-uncelebrated",
      "power-no-regress",
      "power-ceiling-exceeded",
      "power-no-cost",
      "realm-gap-too-large",
      "realm-lifespan-missing",
      "realm-breakthrough-uncelebrated",
    ]);
  });
});

describe("collectExpressionIssues：不求值也能指出规则写错了", () => {
  it("合法表达式没有问题（不该命中侧）", () => {
    expect(collectExpressionIssues({ ">": [{ var: "a.tier" }, 3] })).toEqual([]);
    expect(collectExpressionIssues({ and: [{ "<": [{ var: "b.power" }, { var: "a.power" }] }, { "!": { var: "flag" } }] })).toEqual([]);
  });

  it("被禁原语给出可执行的改写方向", () => {
    const issues = collectExpressionIssues({ reduce: [{ var: "items" }] });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain("禁循环");
  });

  it("一个对象塞两个键 → 提示改用 and / or（真实包里就有两条这么写的）", () => {
    const issues = collectExpressionIssues({ "==": [{ var: "scene.power_used" }, true], cost_recorded: false });
    expect(issues.some((line) => line.includes("个键") && line.includes("and / or"))).toBe(true);
    expect(issues.some((line) => line.includes("未知操作符「cost_recorded」"))).toBe(true);
  });

  it("空对象与裸字面量的判定：空对象是问题，裸标量不是（它是操作数）", () => {
    expect(collectExpressionIssues({})).toEqual([expect.stringContaining("空对象")]);
    expect(collectExpressionIssues(3)).toEqual([]);
  });

  it("超深表达式在扫描期就报出来", () => {
    let deep: unknown = { var: "x" };
    for (let i = 0; i < 20; i += 1) deep = { "!": deep };
    expect(collectExpressionIssues(deep)[0]).toContain("嵌套超过");
  });
});

describe("lintPack 的规则件检查：坏规则必须报 error", () => {
  it("真包的规则件通过内容层校验", () => {
    const report = lintPack(loadPack(PACK_DIR));
    expect(report.issues.filter((issue) => issue.rule.startsWith("rule-"))).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("无法解析的件 → rule-unparsable（error），且不影响同包其它件继续校验", async () => {
    const pack = await packWithRuleFiles("apiVersion: yushu.rules/v9\nid: x\nrules: []", GOOD);
    const report = lintPack(pack);
    const unparsable = report.issues.filter((issue) => issue.rule === "rule-unparsable");
    expect(unparsable).toHaveLength(1);
    expect(unparsable[0]!.severity).toBe("error");
    expect(unparsable[0]!.message).toContain("0 条规则生效");
    expect(report.ok).toBe(false);
    // 另一件仍解析出 1 条规则：坏件不连坐
    expect(flattenRules(loadPackRuleSets(pack))).toHaveLength(1);
  });

  it("可解析但表达式违规 → rule-expression（error）", async () => {
    const bad = [
      "apiVersion: yushu.rules/v1",
      "id: bad-set",
      "rules:",
      '  - {id: r-bad, severity: warn, scope: chapter, when: {regex: ["a", "b"]}, message: 用了被禁原语}',
    ].join("\n");
    const report = lintPack(await packWithRuleFiles(bad));
    const expression = report.issues.filter((issue) => issue.rule === "rule-expression");
    expect(expression).toHaveLength(1);
    expect(expression[0]!.message).toContain("r-bad");
    expect(expression[0]!.message).toContain("禁正则");
  });

  it("同包多个文件撞同一个规则 id → rule-duplicate-id（不按加载顺序偷偷取后者）", async () => {
    const one = GOOD.replace("r-ok", "r-same");
    const report = lintPack(await packWithRuleFiles(one, one.replace("正常规则", "另一个集")));
    const dup = report.issues.filter((issue) => issue.rule === "rule-duplicate-id");
    expect(dup).toHaveLength(1);
    expect(dup[0]!.severity).toBe("error");
    expect(dup[0]!.message).toContain("r-same");
  });

  it("空 rules 列表在解析期就被拒（lint 侧统一报 rule-unparsable，不留「解析成功但 0 条」的中间态）", async () => {
    const empty = ["apiVersion: yushu.rules/v1", "id: empty-set", "rules: []"].join("\n");
    const report = lintPack(await packWithRuleFiles(empty));
    const unparsable = report.issues.filter((issue) => issue.rule === "rule-unparsable");
    expect(unparsable).toHaveLength(1);
    expect(unparsable[0]!.message).toContain("非空数组");
    expect(report.issues.filter((issue) => issue.rule === "rule-empty-set")).toEqual([]);
  });

  it("duplicateRuleIds 只报真正跨文件的重复（不该命中侧）", async () => {
    const pack = await packWithRuleFiles(GOOD, GOOD.replace("r-ok", "r-other"));
    expect(duplicateRuleIds(loadPackRuleSets(pack))).toEqual([]);
  });
});
