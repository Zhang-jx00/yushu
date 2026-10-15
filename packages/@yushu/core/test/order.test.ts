/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { codePointCompare } from "../src/order.js";

/**
 * 码点序比较器（红线 5：确定性靠码点比较，不靠 locale）。
 *
 * 为什么要有这一份公共实现：第 89 轮实测生产代码里有 15 处 `.localeCompare(`，
 * 而红线写的是"不用 localeCompare"——文档与代码各说各话。这一轮把该确定的那批收回来，
 * 并且**只留一份实现**（此前 llm/cost.ts 与 world-engine/propagate.ts 各有一份私有副本）。
 */

const TITLES = ["三体", "北京折叠", "Z 纪元", "abc", "abd", "ab"];

describe("码点序比较器（红线 5）", () => {
  it("只返回 -1 / 0 / 1 三值，不返回差值", () => {
    expect(codePointCompare("a", "b")).toBe(-1);
    expect(codePointCompare("b", "a")).toBe(1);
    expect(codePointCompare("a", "a")).toBe(0);
    // 差值型比较器在长字符串上会给出任意大数，这里必须被压成三值
    expect([-1, 0, 1]).toContain(codePointCompare("aaaaaaaaaa", "b"));
  });

  it("顺序与 Array#sort 的默认序（码点序）逐字一致", () => {
    const byDefault = [...TITLES].sort();
    const byHelper = [...TITLES].sort(codePointCompare);
    expect(byHelper).toEqual(byDefault);
  });

  it("中文与拉丁混排按码点，不按拼音（换 locale 不许换序）", () => {
    // "Z"(U+005A) 在"三"(U+4E09) 之前；拼音排序会把"北京"排到 Z 前面
    expect(codePointCompare("Z 纪元", "三体")).toBe(-1);
    expect([...TITLES].sort(codePointCompare)[0]).toBe("Z 纪元");
  });

  it("前缀短者在前；空串最小", () => {
    expect(codePointCompare("ab", "abc")).toBe(-1);
    expect(codePointCompare("", "a")).toBe(-1);
    expect(codePointCompare("", "")).toBe(0);
  });

  it("代理对不参与 locale：结果只由字符编码决定", () => {
    // 说清实现口径：比较用的是 `<` / `>`，也就是 **UTF-16 码元序**；
    // BMP 之内它与码点序一致，只有涉代理对（emoji 等）时才与纯码点序有差别。
    // 本项目的 id / 路径 / 卡名基本都在 BMP 内，要的是"换机器换 locale 不换序"这一条。
    expect(codePointCompare("a", "😀")).toBe(-1);
    expect(codePointCompare("😀", "😀")).toBe(0);
  });
});
