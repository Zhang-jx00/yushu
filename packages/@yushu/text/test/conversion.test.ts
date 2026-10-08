import { describe, expect, it } from "vitest";
import {
  TRADITIONAL_AMBIGUOUS,
  checkConversion,
  toSimplified,
  toTraditional,
} from "@yushu/text";

/**
 * 繁简转换（`proofread-conversion-ambiguous`，J14 §2.2 / §3.2）。
 *
 * OpenCC 的第一原则是「严格区分一简对多繁与一简对多异」——"发/髮/發""后/後"这类
 * 单靠字面无法判定的条目**必须高亮待确认，不能全自动回写正文**。
 * 本模块因此把"不硬猜"做成实现约束：**歧义字一律原样保留**，只登记候选，
 * 转换结果里绝不出现"猜出来的繁体"。
 */

describe("toTraditional：无歧义字直转，歧义字原样保留", () => {
  it("常用无歧义条目转换（剑→劍、龙→龍、门→門）", () => {
    const result = toTraditional("林渊拔剑，龙门如在雾中。");
    expect(result.text).toContain("拔劍");
    expect(result.text).toContain("龍門");
    expect(result.ambiguous).toEqual([]);
  });

  it("一简对多繁不猜测：字不变、候选点名", () => {
    const result = toTraditional("他出发去理发。");
    expect(result.ambiguous.length).toBe(2);
    expect(result.text).toContain("出发"); // 未被改写成「出發」或「出髮」
    const first = result.ambiguous[0]!;
    expect(first.char).toBe("发");
    expect(first.candidates.length).toBeGreaterThan(1);
    expect(first.candidates).toContain("發");
  });

  it("下标可切片回原文且按位置升序", () => {
    const text = "发后里";
    const { ambiguous } = toTraditional(text);
    for (const hit of ambiguous) expect(text.slice(hit.start, hit.end)).toBe(hit.char);
    expect(ambiguous.map((h) => h.start)).toEqual([...ambiguous.map((h) => h.start)].sort((a, b) => a - b));
  });

  it("同输入同输出（确定性）", () => {
    const text = "头发后面是山谷，钟声里带着干粮。";
    expect(toTraditional(text)).toEqual(toTraditional(text));
  });

  it("空文本返回空结果", () => {
    expect(toTraditional("")).toEqual({ text: "", ambiguous: [] });
  });
});

describe("toSimplified：多繁对一简是安全的", () => {
  it("髮 / 發 都归 发，裡 / 裏 都归 里", () => {
    expect(toSimplified("頭髮")).toBe("头发");
    expect(toSimplified("這裡")).toBe("这里");
    expect(toSimplified("劍龍門")).toBe("剑龙门");
  });

  it("已是简体的文本原样返回（幂等）", () => {
    const text = "夜色压下来，林渊拔剑而起。";
    expect(toSimplified(text)).toBe(text);
    expect(toSimplified(toSimplified(text))).toBe(text);
  });
});

describe("checkConversion：把歧义点变成可解释的检测结果", () => {
  it("歧义字逐条 info 级点名，不自动修（autofix=false）", () => {
    const found = checkConversion("头发", { chapter: "ch-001" });
    expect(found.length).toBe(1);
    const hit = found[0]!;
    expect(hit.rule).toBe("proofread-conversion-ambiguous");
    expect(hit.severity).toBe("info");
    expect(hit.span.text).toBe("发");
    expect(hit.span.chapter).toBe("ch-001");
    expect(hit.autofix).toBe(false);
    expect(hit.suggestion).toContain("發");
    expect(hit.evidence).toContain("一简对多繁");
    expect(hit.evidence).toContain("未自动改写");
    expect(hit.source.engine).toBe("lexicon:conversion");
  });

  it("无歧义文本零命中（简→繁与纯简体两类都不打扰）", () => {
    expect(checkConversion("林渊拔剑。")).toEqual([]);
    expect(checkConversion("")).toEqual([]);
    expect(checkConversion("夜色压下来，远处是落霞峰。")).toEqual([]);
  });

  it("歧义表自洽：每个条目候选 ≥2 且都包含简体本身或繁体重写", () => {
    expect(TRADITIONAL_AMBIGUOUS.length).toBeGreaterThanOrEqual(6);
    for (const entry of TRADITIONAL_AMBIGUOUS) {
      expect(entry.candidates.length).toBeGreaterThanOrEqual(2);
      expect(new Set(entry.candidates).size).toBe(entry.candidates.length);
    }
  });

  it("繁→简不产生歧义命中（多繁对一简方向安全）", () => {
    expect(checkConversion("頭髮", { direction: "t2s" })).toEqual([]);
    expect(checkConversion("頭髮")).toEqual([]); // 缺省 s2t：頭/髮 都不是简体字，表内按简体匹配
  });
});
