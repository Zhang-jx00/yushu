import { describe, expect, it } from "vitest";
import { collectVarReferences } from "../src/rule-dsl.js";

/**
 * 规则表达式里的取数路径清单（M4 / T4-2，R74）。
 *
 * 用途只有一个：**让"这条规则为什么没跑"由数据回答，而不是由一张手写名单回答**。
 * 桌面端拿着这份清单去比对实际拼出来的求值数据，缺哪个 var 就点名哪个——
 * 新增规则不再需要改调用点的代码，也不会出现"悄悄没跑"。
 */

describe("collectVarReferences", () => {
  it("收集并集：嵌套 and / or 里的 var 全部拿到，去重后按码点序", () => {
    const expr = {
      and: [
        { ">=": [{ var: "b.realm.tier" }, { var: "a.realm.tier" }] },
        { "<": [{ var: "b.combat_power" }, { var: "a.combat_power" }] },
        { "==": [{ var: "b.realm.tier" }, ""] },
      ],
    };
    expect(collectVarReferences(expr)).toEqual([
      "a.combat_power",
      "a.realm.tier",
      "b.combat_power",
      "b.realm.tier",
    ]);
  });

  it("字面量与操作符名不会被当成路径", () => {
    expect(collectVarReferences({ ">": [{ var: "scene.combat_power" }, 100] })).toEqual(["scene.combat_power"]);
  });

  it("没有 var 的常量表达式返回空清单（不是 undefined，调用点要直接判长度）", () => {
    expect(collectVarReferences({ "==": [true, true] })).toEqual([]);
  });

  it("非对象节点（裸字符串 / 数字 / null）安全返回空", () => {
    expect(collectVarReferences("x")).toEqual([]);
    expect(collectVarReferences(7)).toEqual([]);
    expect(collectVarReferences(null)).toEqual([]);
  });

  it("var 值不是字符串时跳过（交给加载期校验报错，这里不猜）", () => {
    expect(collectVarReferences({ var: 3 })).toEqual([]);
  });

  it("超深嵌套不炸：走到多深都只收集，不递归爆炸", () => {
    let expr: unknown = { var: "leaf" };
    for (let i = 0; i < 40; i += 1) expr = { and: [expr] };
    expect(collectVarReferences(expr)).toEqual(["leaf"]);
  });
});
