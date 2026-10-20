/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  applyImportCorrections,
  chapterTitleNumber,
  detectMiscuts,
  findChapterCandidates,
  resolveSourceLine,
  type ImportedChapter,
} from "../src/import.js";

/**
 * 存量导入的**第二段**分章判定（M5 / T5-7 第二段，R107；判据回源 I09 §3.4 / §3.5）。
 *
 * I09 §3.4：自动分章 = **两段式「规则海选 → AI 筛选」**，正则匹配率低时回退 AI。
 * I09 §3.5：**误切检测** = 章号连续性 / 标题长度 / 章节字数分布三类校验，
 * 异常进入人工校正清单（合并 / 拆分 / 重排）。
 *
 * 这一层**不碰磁盘、不调 AI**：只回答"哪些行像是章节标题""哪里切错了""按作者的校正该怎么切"。
 * AI 那一段在 `@yushu/world-engine/import-split.ts`（JSON Schema 契约 + 越界丢弃），
 * 桌面侧把它与这里的结果接起来。
 */

function chapter(title: string, body: string): ImportedChapter {
  return { title, body };
}

describe("海选：宽匹配捞出疑似章节标题（I09 §3.4 的前半段）", () => {
  it("认得带方括号 / 冒号 / 全角空格的章标题", () => {
    const text = ["【第一章 起】", "正文一", "第二章：承", "正文二", "第三章　转", "正文三"].join("\n");
    const candidates = findChapterCandidates(text);
    expect(candidates.map((item) => item.text)).toEqual(["【第一章 起】", "第二章：承", "第三章　转"]);
    expect(candidates[0]?.line).toBe(1);
    expect(candidates[1]?.line).toBe(3);
  });

  it("普通正文行不入选（海选也不能把段落当标题）", () => {
    const text = ["他推开了门。", "风从窗缝里灌进来。", "第十章 他推开了门"].join("\n");
    const candidates = findChapterCandidates(text);
    expect(candidates.map((item) => item.text)).toEqual(["第十章 他推开了门"]);
  });

  it("行号连续可数（1 起），AI 只能指认这些行", () => {
    const text = ["第一章", "x", "第二章", "y"].join("\n");
    const candidates = findChapterCandidates(text);
    expect(candidates.map((item) => item.line)).toEqual([1, 3]);
  });
});

describe("章号解析（误切检测的第一类校验要用）", () => {
  it("认得中文数字与阿拉伯数字", () => {
    expect(chapterTitleNumber("第十二章 夜探藏经阁")).toBe(12);
    expect(chapterTitleNumber("第 3 章 起")).toBe(3);
    expect(chapterTitleNumber("Chapter 7")).toBe(7);
  });

  it("不是章标题就返回 null（不硬编一个号出来）", () => {
    expect(chapterTitleNumber("他推开了门")).toBeNull();
    expect(chapterTitleNumber("")).toBeNull();
  });
});

describe("误切检测：三类校验（I09 §3.5）", () => {
  it("章号不连续 ⇒ 点名断掉的那一章", () => {
    const rows = detectMiscuts([
      { title: "第一章 起", chars: 2000 },
      { title: "第三章 承", chars: 2100 },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.issues.map((issue) => issue.code)).toContain("chapter-index-gap");
    expect(rows[0]?.title).toBe("第三章 承");
  });

  it("章号重复 ⇒ 也要点名（重排错了或同一章被切两次）", () => {
    const rows = detectMiscuts([
      { title: "第一章 起", chars: 2000 },
      { title: "第一章 起", chars: 2000 },
    ]);
    expect(rows.some((row) => row.issues.some((issue) => issue.code === "chapter-index-gap"))).toBe(true);
  });

  it("标题过长 ⇒ 像是一段正文被当成了标题", () => {
    const long = `第${"一".repeat(60)}章 ${"很长".repeat(40)}`;
    const rows = detectMiscuts([{ title: long, chars: 1000 }]);
    expect(rows[0]?.issues.map((issue) => issue.code)).toContain("chapter-title-too-long");
  });

  it("字数与全书中位数差一个量级 ⇒ 疑似切错", () => {
    const rows = detectMiscuts([
      { title: "第一章 起", chars: 3000 },
      { title: "第二章 承", chars: 3000 },
      { title: "第三章 转", chars: 20 },
    ]);
    expect(rows.some((row) => row.issues.some((issue) => issue.code === "chapter-length-outlier"))).toBe(true);
  });

  it("章号连续、标题正常、字数均衡 ⇒ 不进清单（没病不报）", () => {
    const rows = detectMiscuts([
      { title: "第一章 起", chars: 3000 },
      { title: "第二章 承", chars: 3100 },
      { title: "第三章 转", chars: 2900 },
    ]);
    expect(rows).toEqual([]);
  });

  it("章数太少时不下「字数离群」的结论（样本不足，样本 <3 不判）", () => {
    const rows = detectMiscuts([
      { title: "第一章 起", chars: 3000 },
      { title: "第二章 承", chars: 10 },
    ]);
    expect(rows.some((row) => row.issues.some((issue) => issue.code === "chapter-length-outlier"))).toBe(false);
  });
});

describe("人工校正：合并 / 拆分 / 重排（I09 §3.5 的后半段）", () => {
  const chapters: ImportedChapter[] = [
    chapter("第一章 起", "A1\nA2\nA3"),
    chapter("第二章 承", "B1\nB2\nB3"),
    chapter("第三章 转", "C1\nC2\nC3"),
  ];

  it("合并相邻两章：正文接起来，标题取前一章", () => {
    const merged = applyImportCorrections(chapters, [{ kind: "merge", at: 0 }]);
    expect(merged).toHaveLength(2);
    expect(merged[0]?.title).toBe("第一章 起");
    expect(merged[0]?.body).toBe("A1\nA2\nA3\nB1\nB2\nB3");
    expect(merged[1]?.title).toBe("第三章 转");
  });

  it("拆分：切点那一行当新章的标题（作者点的是「这行其实是章标题」）", () => {
    const split = applyImportCorrections(chapters, [
      { kind: "split", at: 0, line: 2, title: "第二章 承" },
    ]);
    expect(split).toHaveLength(4);
    expect(split[0]?.body).toBe("A1");
    expect(split[0]?.title).toBe("第一章 起");
    expect(split[1]?.body).toBe("A3");
    expect(split[1]?.title).toBe("第二章 承");
  });

  it("拆分没给标题 ⇒ 新章退回标「续」（章号本来就不可靠，标出来让作者看见）", () => {
    const split = applyImportCorrections(chapters, [{ kind: "split", at: 0, line: 2 }]);
    expect(split[1]?.title).toContain("续");
    expect(split[1]?.body).toBe("A3");
  });

  it("重排：把第三章挪到第一位，序号随位置重排由调用方负责", () => {
    const moved = applyImportCorrections(chapters, [{ kind: "move", from: 2, to: 0 }]);
    expect(moved.map((item) => item.title)).toEqual(["第三章 转", "第一章 起", "第二章 承"]);
  });

  it("越界的校正指令被忽略，不炸也不改内容（作者点了不该点的按钮）", () => {
    const same = applyImportCorrections(chapters, [
      { kind: "merge", at: 9 },
      { kind: "split", at: 9, line: 1 },
      { kind: "move", from: 9, to: 0 },
    ]);
    expect(same.map((item) => item.title)).toEqual(["第一章 起", "第二章 承", "第三章 转"]);
  });

  it("切出来的前半章或后半章会是空的 ⇒ 不切（不硬切一刀）", () => {
    const same = applyImportCorrections(chapters, [
      { kind: "split", at: 0, line: 1, title: "X" },
      { kind: "split", at: 0, line: 3, title: "Y" },
    ]);
    expect(same.map((item) => item.title)).toEqual(["第一章 起", "第二章 承", "第三章 转"]);
  });

  it("校正不改动入参（原数组原样）", () => {
    const before = chapters.map((item) => item.title).join("|");
    applyImportCorrections(chapters, [{ kind: "merge", at: 0 }]);
    expect(chapters.map((item) => item.title).join("|")).toBe(before);
  });
});

describe("原稿行号 → 章内行号的换算（拆分的落点不能切错句子）", () => {
  it("章正文从标题下一行开始 ⇒ 原稿行号直接对应章内行号", () => {
    const text = ["第一章 起", "正文甲", "正文乙", "正文丙", "第二章 承", "正文丁", "正文戊", "正文己"].join("\n");
    const resolved = resolveSourceLine(text, [1, 5], 3);
    expect(resolved).toEqual({ chapterIndex: 0, bodyLine: 2 });
    // 第二章的第 2 行正文（原稿第 7 行）：切点前后都留得住 ⇒ 切得开
    const second = resolveSourceLine(text, [1, 5], 7);
    expect(second).toEqual({ chapterIndex: 1, bodyLine: 2 });
  });

  it("章正文前面有空行 ⇒ 换算要把空行那一份偏移扣掉（否则切点会偏一句）", () => {
    const text = ["第一章 起", "", "", "正文甲", "正文乙", "正文丙"].join("\n");
    const resolved = resolveSourceLine(text, [1], 5);
    expect(resolved).toEqual({ chapterIndex: 0, bodyLine: 2 });
  });

  it("切点落在章标题本身 / 楔子里 / 章首之前 ⇒ 切不开（返回 null，不硬切一刀）", () => {
    const text = ["楔子内容。", "第一章 起", "正文甲", "正文乙", "正文丙", "第二章 承", "正文丁"].join("\n");
    expect(resolveSourceLine(text, [2, 6], 2)).toBeNull(); // 章标题本身
    expect(resolveSourceLine(text, [2, 6], 1)).toBeNull(); // 楔子里
    expect(resolveSourceLine(text, [2, 6], 99)).toBeNull(); // 越界
    expect(resolveSourceLine(text, [], 3)).toBeNull(); // 没有边界
  });

  it("切出来的前半章或后半章会是空的 ⇒ 切不开（章首行 / 章尾行都不算切点）", () => {
    const text = ["第一章 起", "正文甲", "正文乙", "正文丙"].join("\n");
    // 第 2 行是正文第一行：切了前半章是空的
    expect(resolveSourceLine(text, [1], 2)).toBeNull();
    // 第 4 行是正文最后一行：切了后半章是空的
    expect(resolveSourceLine(text, [1], 4)).toBeNull();
    // 第 3 行正好在中间：切得开
    expect(resolveSourceLine(text, [1], 3)).toEqual({ chapterIndex: 0, bodyLine: 2 });
  });
});
