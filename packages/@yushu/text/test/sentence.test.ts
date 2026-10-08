import { describe, expect, it } from "vitest";
import { LONG_SENTENCE_LIMIT, checkLongSentences, checkSubordinateDe, splitSentences } from "@yushu/text";

/**
 * 句级轻提示（`proofread-long-sentence` / `proofread-demiscue`，J14 §2.5 / §3.6）。
 *
 * 两条都定级 **info（存疑提示）**而非 warn/error：长句节奏与"的地得"都存在语境弹性
 * （J14 §2.6 明确「必须分级……存在语境弹性」），所以这里只提示、不判错、更不自动改。
 */

describe("splitSentences：句段切分", () => {
  it("按句末点号与换行切句，下标可切片回原文", () => {
    const text = "夜色压下来。林渊拔剑而起！远处传来钟声？\n他停下脚步。";
    for (const part of splitSentences(text)) {
      expect(text.slice(part.start, part.end)).toContain(part.text.slice(0, 2));
    }
    expect(splitSentences(text).length).toBe(4); // 四个带句末点号的句段（换行不单独成段）
  });

  it("空文本零句段", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   ")).toEqual([]);
  });
});

describe("checkLongSentences：超长句", () => {
  it(`超过阈值（缺省 ${LONG_SENTENCE_LIMIT} 字）给出 info 提示，不改写`, () => {
    const long = "他" + "想".repeat(95);
    const found = checkLongSentences(`${long}。短句。`, { chapter: "ch-002" });
    expect(found.length).toBe(1);
    const hit = found[0]!;
    expect(hit.rule).toBe("proofread-long-sentence");
    expect(hit.severity).toBe("info");
    expect(hit.autofix).toBe(false);
    expect(hit.suggestion).toBeUndefined();
    expect(hit.span.chapter).toBe("ch-002");
    expect(hit.evidence).toContain("96 字");
    expect(hit.evidence).toContain(String(LONG_SENTENCE_LIMIT));
    expect(hit.source.engine).toBe("rule:sentence-length");
    expect(hit.span.text.length).toBe(long.length + 1); // 含句末点号
  });

  it("阈值内与恰好到阈值都不报", () => {
    expect(checkLongSentences("字".repeat(LONG_SENTENCE_LIMIT) + "。")).toEqual([]);
    expect(checkLongSentences("夜色压下来，林渊拔剑而起。")).toEqual([]);
  });

  it("阈值可调（limit=10）", () => {
    expect(checkLongSentences("字".repeat(12) + "。", { limit: 10 }).length).toBe(1);
  });

  it("多条超长句按位置升序、同输入同输出", () => {
    const long = "走".repeat(90);
    const text = `${long}。${long}。`;
    const found = checkLongSentences(text);
    expect(found.length).toBe(2);
    expect(found[0]!.span.start).toBeLessThan(found[1]!.span.start);
    expect(JSON.stringify(found)).toBe(JSON.stringify(checkLongSentences(text)));
  });

  it("Markdown 结构行（标题 / 列表 / 代码）不计入", () => {
    expect(checkLongSentences("# 标题" + "字".repeat(90))).toEqual([]);
    expect(checkLongSentences("- " + "字".repeat(90))).toEqual([]);
  });
});

describe("checkSubordinateDe：状语位置的「的」疑似应为「地」", () => {
  it("命中方式副词之后的「的」，info 级并给候选", () => {
    const found = checkSubordinateDe("他慢慢的走过去。", { chapter: "ch-003" });
    expect(found.length).toBe(1);
    const hit = found[0]!;
    expect(hit.rule).toBe("proofread-demiscue");
    expect(hit.severity).toBe("info");
    expect(hit.span.text).toBe("的");
    expect(hit.suggestion).toBe("地");
    expect(hit.autofix).toBe(false); // 语境弹性：只提示，不自动替换
    expect(hit.evidence).toContain("慢慢");
    expect(hit.evidence).toContain("动词");
    expect(hit.evidence).toContain("存疑");
    expect(hit.span.chapter).toBe("ch-003");
  });

  it("正确写法与固定写法不报（误报抑制）", () => {
    for (const text of [
      "他慢慢地走过去。",
      "她认真的态度让人信服。",
      "所有的安排都已就绪。",
      "他真的是被逼无奈。",
      "这是此地的目的地，没什么奇怪的。",
    ]) {
      expect(checkSubordinateDe(text)).toEqual([]);
    }
  });

  it("多处命中按位置升序，且下标可切片回原文", () => {
    const text = "他慢慢的说，她又快速的答。";
    const found = checkSubordinateDe(text);
    expect(found.length).toBe(2);
    for (const hit of found) expect(text.slice(hit.span.start, hit.span.end)).toBe(hit.span.text);
  });

  it("空文本与无「的」文本零命中", () => {
    expect(checkSubordinateDe("")).toEqual([]);
    expect(checkSubordinateDe("夜色压下来。")).toEqual([]);
  });
});
