import { describe, expect, it } from "vitest";
import { checkPunctuation, normalizePunctuation } from "@yushu/text";

/**
 * 标点核查（`proofread-punctuation-gb`，J14 §2.3 / §3.3）：依据 GB/T 15834-2011 与中文排版指北，
 * 检测可自动、修复需确认。
 *
 * 误报抑制是本模块的重点（真源是 Markdown，正文里有标题 / 列表 / 加粗 / 链接 / 数字）：
 * 半角标点只有在**两侧都是汉字**时才算误用，所以 `3.5`、`http://…`、`- 列表项` 一律不报。
 */

const rules = (text: string): string[] => checkPunctuation(text).map((f) => f.rule);
const hits = (text: string) => checkPunctuation(text);

describe("checkPunctuation：命中", () => {
  it("中文语境里的半角逗号 / 句号 / 感叹号 / 问号报 warn", () => {
    for (const text of ["他走了,没有回头", "天黑了。他起身,推门出去", "快走!危险", "你是谁?"]) {
      const found = checkPunctuation(text);
      expect(found.length).toBeGreaterThan(0);
      expect(found[0]!.rule).toBe("proofread-punctuation-gb");
      expect(found[0]!.severity).toBe("warn");
    }
  });

  it("省略号写成三个点或三个句号 → 建议六连点 ……", () => {
    const dots = checkPunctuation("他迟疑道...没有");
    expect(dots.some((f) => f.suggestion === "……")).toBe(true);
    const periods = checkPunctuation("他迟疑道。。。我没有");
    expect(periods.some((f) => f.suggestion === "……")).toBe(true);
  });

  it("同类标点连排（！！！ / ？？）只保留一个", () => {
    const found = checkPunctuation("快走！！危险");
    expect(found.length).toBe(1);
    expect(found[0]!.span.text).toBe("！！");
    expect(found[0]!.suggestion).toBe("！");
  });

  it("逗号紧跟句号（，。混用）报出", () => {
    const found = checkPunctuation("他走了，。");
    expect(found.length).toBe(1);
    expect(found[0]!.suggestion).toBe("。");
  });

  it("引号不配对按左右各自点名（不漏报也不虚报数量）", () => {
    const unclosed = checkPunctuation("他说“我没有离开");
    expect(unclosed.some((f) => f.evidence.includes("右引号”缺失"))).toBe(true);
    const extra = checkPunctuation("他说我没有离开”");
    expect(extra.some((f) => f.evidence.includes("左引号“缺失"))).toBe(true);
  });

  it("破折号写成两个半角连字符 → 建议 ——", () => {
    const found = checkPunctuation("夜色压下来--很沉");
    expect(found.some((f) => f.suggestion === "——")).toBe(true);
  });

  it("每条结果都带可解释 evidence 与原文片段", () => {
    const found = checkPunctuation("他走了,没有回头");
    const first = found[0]!;
    expect(first.span.text).toBe(",");
    expect(first.evidence.length).toBeGreaterThan(4);
    expect(first.autofix).toBe(true); // 标点属"只改格式不改字义"，可自动修但仍需确认
    expect(first.source.engine).toBe("rule:punctuation-gb");
  });
});

describe("checkPunctuation：不该命中（误报抑制）", () => {
  it("规范中文标点段落零命中", () => {
    const text = "夜色压下来，林渊拔剑而起。“走！”他低声道。远处是落霞峰——一座沉默的影子。";
    expect(hits(text)).toEqual([]);
  });

  it("数字与英文不打扰：小数 / URL / 千分位 / 英文缩写", () => {
    for (const text of [
      "距今 3.5 万年",
      "详见 https://example.com/a.md 说明",
      "共 1,200 字",
      "他用了 e.g. 这个写法",
    ]) {
      expect(hits(text)).toEqual([]);
    }
  });

  it("Markdown 结构字符不误伤：标题、列表、加粗、行内代码、链接", () => {
    for (const text of [
      "# 第一章：初入宗门",
      "- 剑修、体修、术修",
      "**警惕**:前方有伏",
      "他用 `if(x<y)` 比喻处境",
      "[设定卡](world/cards/character/lin-yuan.md)",
    ]) {
      expect(hits(text)).toEqual([]);
    }
  });

  it("省略号与破折号用对了就不报", () => {
    expect(hits("他迟疑道……我没有。")).toEqual([]);
    expect(hits("夜色压下来——很沉。")).toEqual([]);
  });

  it("对话引号配对正确不报", () => {
    expect(hits("“你来了。”他说。")).toEqual([]);
  });

  it("空文本与纯空白零命中", () => {
    expect(rules("")).toEqual([]);
    expect(rules("   \n\n  ")).toEqual([]);
  });
});

describe("normalizePunctuation：修复候选（不写回，只给结果）", () => {
  it("逐处替换给出 from/to 与下标，且按原文下标升序", () => {
    const result = normalizePunctuation("他走了,没有回头!!");
    expect(result.text).toBe("他走了，没有回头！");
    expect(result.changes.map((c) => c.from)).toEqual([",", "!!"]);
    expect(result.changes[0]!.to).toBe("，");
    expect(result.changes[1]!.to).toBe("！");
    const starts = result.changes.map((c) => c.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
  });

  it("幂等：对已规范的文本再跑一次不产生改动", () => {
    const once = normalizePunctuation("他走了,没有回头!!").text;
    expect(normalizePunctuation(once).changes).toEqual([]);
  });

  it("数字 / URL / Markdown 结构字符一律不动", () => {
    for (const text of ["距今 3.5 万年", "见 https://a.com/x.md", "- 列表项 - 第二项"]) {
      expect(normalizePunctuation(text).text).toBe(text);
    }
  });

  it("改动下标必须能切片回原文（span 与 from 一致）", () => {
    const text = "快走!危险,别停";
    const { changes } = normalizePunctuation(text);
    for (const change of changes) {
      expect(text.slice(change.start, change.start + change.from.length)).toBe(change.from);
    }
  });

  it("同输入同输出（确定性）", () => {
    const text = "他走了,没有回头!!然后……不,我没有";
    expect(normalizePunctuation(text)).toEqual(normalizePunctuation(text));
  });
});
