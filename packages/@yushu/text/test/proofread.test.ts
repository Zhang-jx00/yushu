import { describe, expect, it } from "vitest";
import {
  PROOFREAD_RULES,
  applyFixes,
  checkPunctuation,
  checkTypos,
  proofreadText,
  type ProofreadFinding,
} from "@yushu/text";

/**
 * 校对汇总与安全闸门（T3-13 / J14 §2.6「分级呈现与修复边界」、§3.8「一键修复边界」）。
 *
 * 本文件最重要的断言是那条 error 红线：**未经用户确认不得写入正文**——
 * `applyFixes` 在 `confirmed:false` 时必须一字不改，并回一条 `proofread-autofix-unconfirmed`（error）。
 */

const MIXED = "他走头无路,只能甘败下风。";

describe("proofreadText：汇总", () => {
  it("同时跑多规则，结果按严重度→位置排序，计数与条目一致", () => {
    const result = proofreadText(MIXED, { chapter: "ch-004" });
    expect(result.findings.length).toBeGreaterThanOrEqual(3);
    expect(result.counts.warn).toBeGreaterThanOrEqual(3); // 两个别字 + 一个半角逗号
    expect(result.counts.error).toBe(0);
    const rules = new Set(result.findings.map((f) => f.rule));
    expect(rules.has("proofread-typo")).toBe(true);
    expect(rules.has("proofread-punctuation-gb")).toBe(true);
    expect(result.chars).toBe(MIXED.length);
    expect(result.checkedRules.length).toBe(PROOFREAD_RULES.length - 1); // 除 autofix 闸门外的检测规则
  });

  it("同输入同输出（排序不靠 locale）", () => {
    const text = "他慢慢的走过去,心里穿流不息。";
    expect(JSON.stringify(proofreadText(text))).toBe(JSON.stringify(proofreadText(text)));
  });

  it("可用开关关掉某条规则（skipped 如实登记，不假装跑过）", () => {
    const off = proofreadText(MIXED, { rules: { "proofread-typo": false } });
    expect(off.findings.some((f) => f.rule === "proofread-typo")).toBe(false);
    expect(off.skippedRules).toContain("proofread-typo");
    expect(off.checkedRules).not.toContain("proofread-typo");
  });

  it("空文本：零结果、零计数", () => {
    const result = proofreadText("");
    expect(result.findings).toEqual([]);
    expect(result.counts).toEqual({ error: 0, warn: 0, info: 0 });
    expect(result.chars).toBe(0);
  });

  it("章节标注逐条透传", () => {
    for (const finding of proofreadText(MIXED, { chapter: "ch-009" }).findings) {
      expect(finding.span.chapter).toBe("ch-009");
    }
  });

  it("下标全部可切片回原文（面板据此高亮不会错位）", () => {
    const text = "他走头无路,只能甘败下风。";
    for (const f of proofreadText(text).findings) {
      expect(text.slice(f.span.start, f.span.end)).toBe(f.span.text);
    }
  });
});

describe("applyFixes：未确认即写入是 error 红线", () => {
  const typoFixes = (): ProofreadFinding[] => checkTypos("他走头无路。");

  it("confirmed=false：一字不改，并逐条回 error 结果", () => {
    const result = applyFixes("他走头无路。", typoFixes(), { confirmed: false });
    expect(result.text).toBe("他走头无路。");
    expect(result.applied).toEqual([]);
    expect(result.blocked.length).toBe(1);
    expect(result.blocked[0]!.rule).toBe("proofread-autofix-unconfirmed");
    expect(result.blocked[0]!.severity).toBe("error");
    expect(result.blocked[0]!.evidence).toContain("未确认");
  });

  it("confirmed=true：按建议替换，返回改前/改后与下标", () => {
    const result = applyFixes("他走头无路。", typoFixes(), { confirmed: true });
    expect(result.text).toBe("他走投无路。");
    expect(result.applied.length).toBe(1);
    expect(result.applied[0]!).toMatchObject({ start: 1, from: "走头无路", to: "走投无路" });
    expect(result.blocked).toEqual([]);
  });

  it("位置失效（正文已被改动）时拒绝该条，不盲替换", () => {
    const stale = { ...typoFixes()[0]!, span: { ...typoFixes()[0]!.span, text: "走头无路" } };
    const result = applyFixes("他走头无路上路了。", [stale], { confirmed: true });
    // 原文下标处内容仍等于 span.text → 允许；换一个对不上的才拒绝
    expect(result.applied.length).toBe(1);
    const broken = { ...stale, span: { ...stale.span, text: "走投无路" } };
    const rejected = applyFixes("他走头无路。", [broken], { confirmed: true });
    expect(rejected.applied).toEqual([]);
    expect(rejected.rejected[0]!.reason).toContain("位置失效");
  });

  it("autofix=false 的规则不给自动修（除非作者显式选定候选）", () => {
    const ambiguous = proofreadText("头发。", { rules: { "proofread-repetition-high": false } }).findings.filter(
      (f) => f.rule === "proofread-conversion-ambiguous",
    );
    expect(ambiguous.length).toBe(1);
    const plain = applyFixes("头发。", ambiguous, { confirmed: true });
    expect(plain.applied).toEqual([]);
    expect(plain.rejected[0]!.reason).toContain("需显式选定候选");

    const chosen = applyFixes("头发。", ambiguous, { confirmed: true, replacements: ["髮"] });
    // 只替换该条命中的歧义字本身（其余字不在本条 span 内，不"顺手"转换全句）
    expect(chosen.text).toBe("头髮。");
    expect(chosen.applied[0]!.to).toBe("髮");
  });

  it("标点批量修复走同一闸门（未确认全挡）", () => {
    const found = checkPunctuation("他走了,没有回头!!");
    expect(found.length).toBe(2);
    expect(applyFixes("他走了,没有回头!!", found, { confirmed: false }).text).toBe("他走了,没有回头!!");
    expect(applyFixes("他走了,没有回头!!", found, { confirmed: true }).text).toBe("他走了，没有回头！");
  });

  it("重叠的修复只应用先到的那条（不互相踩踏）", () => {
    const a = checkTypos("甘败下风")[0]!;
    const overlapping: ProofreadFinding = { ...a, span: { ...a.span, start: 1, end: 3, text: "败下" } };
    const result = applyFixes("甘败下风。", [a, overlapping], { confirmed: true });
    expect(result.applied.length).toBe(1);
    expect(result.rejected[0]!.reason).toContain("重叠");
  });

  it("繁简候选必须属于条目登记的候选表（任意文本一律拒绝）", () => {
    const found = proofreadText("他头发乱了。").findings.filter(
      (f) => f.rule === "proofread-conversion-ambiguous",
    );
    expect(found.length).toBe(1);
    expect(found[0]!.candidates).toEqual(["發", "髮"]);
    const outside = applyFixes("他头发乱了。", found, { confirmed: true, replacements: ["随手的任意文本"] });
    expect(outside.applied).toEqual([]);
    expect(outside.rejected[0]!.reason).toContain("不在该条目登记的候选内");
    expect(outside.text).toBe("他头发乱了。");
    const inside = applyFixes("他头发乱了。", found, { confirmed: true, replacements: ["髮"] });
    expect(inside.text).toBe("他头髮乱了。"); // 只换掉命中的那一个歧义字
  });
  it("空请求列表：文本原样返回", () => {
    const result = applyFixes("夜色压下来。", [], { confirmed: true });
    expect(result.text).toBe("夜色压下来。");
    expect(result.applied).toEqual([]);
  });
});
