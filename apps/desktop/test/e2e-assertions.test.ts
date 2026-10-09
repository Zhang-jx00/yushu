import { describe, expect, it } from "vitest";
import { unmetAssertions, type E2eAssertion } from "../src/main/e2e-assertions.js";

/**
 * e2e 具名断言清单（R55，收口 docs/06 §七「e2e 失败不点名断言」）。
 *
 * 这条链原来是单条大布尔：`const ok = a && b && …`（300+ 项），失败时只打
 * 「断言未满足」，R43 定位 `git.error` 全靠绿跑与红跑两份结果 JSON 逐项 diff。
 * 现在把每项收成 [名字, 值]，这里验的就是"点名"这件事本身：
 * ① 失败项必须被叫出名字（含带引号的表达式原文）；
 * ② 通过项一个都不能被叫出来（误报会让作者去查没坏的地方）。
 */

const PAIRS: E2eAssertion[] = [
  ['result.cards === 2', true],
  ['result.git.error === ""', false],
  ['result.memory.aiRev === 0', true],
  ['(result.rag.store === "cosine" || result.rag.store === "sqlite-vec")', false],
];

describe("e2e 具名断言清单", () => {
  it("未满足项按声明顺序点名", () => {
    expect(unmetAssertions(PAIRS)).toEqual([
      'result.git.error === ""',
      '(result.rag.store === "cosine" || result.rag.store === "sqlite-vec")',
    ]);
  });

  it("全绿时不点名任何一项", () => {
    expect(unmetAssertions(PAIRS.map(([name]) => [name, true]))).toEqual([]);
  });

  it("真值判定只认布尔 false，不因值为 0/空串就跳过", () => {
    // 断言项写的是表达式结果，任何假值都意味着该条没成立
    expect(unmetAssertions([["a", false], ["b", 0 as unknown as boolean], ["c", "" as unknown as boolean], ["d", true]])).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("空清单不报错也不误报", () => {
    expect(unmetAssertions([])).toEqual([]);
  });
});
