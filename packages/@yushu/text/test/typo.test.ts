import { describe, expect, it } from "vitest";
import { TYPO_TABLE, checkTypos } from "@yushu/text";

/**
 * 错别字 / 别字检测（`proofread-typo`，J14 §2.1 / §3.1：规则层先行、模型层补位）。
 *
 * R44 只做**内置词表层**（同音 / 形近别字），给出候选而不自动改；
 * pycorrector / MacBERT 一类模型层是后续替换点（`source.engine` 已按 J14 的条目结构预留）。
 *
 * 误报是本规则的最大风险（错别字告警一旦不可信，作者会直接忽略整块面板），
 * 所以词表**只收"错法本身不可能是正确写法"的条目**，并逐条配一例不该命中的对照。
 */

const wrong = (text: string) => checkTypos(text);

describe("checkTypos：命中", () => {
  it("常见成语别字给出正确候选（warn，不自动改）", () => {
    const found = checkTypos("他这次是真的走头无路了。");
    expect(found.length).toBe(1);
    const hit = found[0]!;
    expect(hit.rule).toBe("proofread-typo");
    expect(hit.severity).toBe("warn");
    expect(hit.suggestion).toBe("走投无路");
    expect(hit.span.text).toBe("走头无路");
    expect(hit.source.engine).toBe("lexicon:typo");
    expect(hit.source.conf).toBe(1);
    expect(hit.evidence).toContain("走投无路");
  });

  it("同音形近一并覆盖（迫不急待 / 再接再励 / 变本加利）", () => {
    const found = checkTypos("他迫不急待地赶来，誓言再接再励、绝不变本加利于人。");
    const pairs = found.map((f) => [f.span.text, f.suggestion]);
    expect(pairs).toEqual([
      ["迫不急待", "迫不及待"],
      ["再接再励", "再接再厉"],
      ["变本加利", "变本加厉"],
    ]);
  });

  it("下标可切片回原文（start/end 与 span.text 一致）", () => {
    const text = "此事按步就班即可，无需布署专人。";
    for (const hit of checkTypos(text)) {
      expect(text.slice(hit.span.start, hit.span.end)).toBe(hit.span.text);
    }
    expect(wrong(text).length).toBe(2);
  });

  it("同输入同输出、结果按位置升序（确定性）", () => {
    const text = "甘败下风，换然一新。";
    const once = checkTypos(text);
    const twice = checkTypos(text);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
    expect(once.map((f) => f.span.start)).toEqual([...once.map((f) => f.span.start)].sort((a, b) => a - b));
  });

  it("chapter 标注只透传，不影响判定", () => {
    expect(checkTypos("甘败下风", { chapter: "ch-001" })[0]!.span.chapter).toBe("ch-001");
    expect(checkTypos("甘败下风")[0]!.span.chapter).toBeUndefined();
  });
});

describe("checkTypos：不该命中（误报抑制）", () => {
  it("正确写法零命中（逐条对照词表的右侧）", () => {
    const correct = [...TYPO_TABLE.entries()].map(([from, to]) => to).join("，") + "。";
    expect(wrong(correct)).toEqual([]);
  });

  it("词表左项作为子串出现在合法语境中不得误伤", () => {
    // 「义气」是合法词，只有「义气用事」才是别字；「坐」与「阵」单独出现也不该命中
    expect(wrong("他很讲义气，这次为朋友两肋插刀。")).toEqual([]);
    expect(wrong("前排阵地锣鼓齐鸣。")).toEqual([]);
  });

  it("叠用同一条目不重复报，也不越过已占用区间", () => {
    const found = checkTypos("甘败下风，甘败下风。");
    expect(found.length).toBe(2);
    expect(found[1]!.span.start).toBeGreaterThan(found[0]!.span.end);
  });

  it("空文本与纯标点零命中", () => {
    expect(wrong("")).toEqual([]);
    expect(wrong("……——！！")).toEqual([]);
  });

  it("词表本身干净：左右两侧必须不同且无重复左项", () => {
    const seen = new Set<string>();
    for (const [from, to] of TYPO_TABLE.entries()) {
      expect(from).not.toBe(to);
      expect(seen.has(from)).toBe(false);
      seen.add(from);
    }
    expect(TYPO_TABLE.size).toBeGreaterThanOrEqual(20);
  });
});
