/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  canReplaceSelection,
  sliceReplacement,
} from "../renderer/src/components/editor-rewrite.js";

/**
 * **选区替换的两条纯判定**（R185）。
 *
 * 为什么是纯函数：预演层造不出「生成期间正文被改过」的场景
 * （CM6 的文本输入走原生 input 事件，脚本派发 keydown 插不进字）⇒
 * 「位置失效即拒」这条红线钉在单元层，不假装预演能验。
 *
 * 三条判据：
 * ① **位置失效即拒**：正文与生成时的快照不同 ⇒ 旧偏移不可信 ⇒ 拒绝；
 * ② **替换只动那一段**：其余正文**逐字不动**（不顺手规范化——规范化会改掉作者的排版）；
 * ③ **区间越界不猜**：from/to 倒挂或越界 ⇒ 原样返回（不截断、不抛错、
 *    由调用方决定怎么处理）。
 */

describe("选区替换（R185）：位置失效即拒 + 只动那一段", () => {
  it("**正文与快照一致 ⇒ 可替换**（偏移仍可信）", () => {
    expect(canReplaceSelection("原文甲\n原文乙", "原文甲\n原文乙")).toBe(true);
  });

  it("**正文变了 ⇒ 拒绝**（旧偏移不可信；不拿旧下标盲替换）", () => {
    expect(canReplaceSelection("原文甲\n原文乙", "原文甲改过了\n原文乙")).toBe(false);
    // 末尾多一个字也算变了（位置整体平移 ⇒ 偏移全不可信）
    expect(canReplaceSelection("原文甲", "原文甲 ")).toBe(false);
  });

  it("**替换只动那一段**：其余正文逐字不动", () => {
    const body = "第一段。\n\n第二段选中。\n\n第三段。";
    const from = body.indexOf("第二段选中。");
    const out = sliceReplacement(body, from, from + "第二段选中。".length, "第二段改写。");
    expect(out).toBe("第一段。\n\n第二段改写。\n\n第三段。");
    // 不做"顺手规范化"：空行、缩进都原样
    expect(out.split("\n")).toEqual(body.split("\n").map((line, i) => (i === 2 ? "第二段改写。" : line)));
  });

  it("**区间越界 / 倒挂 ⇒ 原样返回**（不猜、不截断）", () => {
    const body = "abc";
    expect(sliceReplacement(body, 2, 1, "x")).toBe(body);
    expect(sliceReplacement(body, -1, 2, "x")).toBe(body);
    expect(sliceReplacement(body, 0, 99, "x")).toBe(body);
    expect(sliceReplacement(body, 1, 1, "x")).toBe(body);
  });

  it("**整段替换**：区间覆盖全文 ⇒ 结果就是新文本", () => {
    expect(sliceReplacement("旧全文", 0, 3, "新全文")).toBe("新全文");
  });
});
