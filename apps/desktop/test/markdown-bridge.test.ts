import { describe, expect, it } from "vitest";
import {
  findUnsupportedSyntax,
  htmlToMd,
  mdToHtml,
} from "../renderer/src/markdown-bridge";

describe("Markdown ⇄ 富文本桥（T2-1 切片 B）", () => {
  it("md → HTML：标题 / 粗斜体 / 引用 / 列表 / 分隔线", () => {
    const html = mdToHtml(
      [
        "## 第一章 烬余",
        "",
        "夜色压下来，**林渊**拔剑而起，*风声*忽然停了。",
        "",
        "> 今晚的灵气，比三年前那一夜更重。",
        "",
        "- 第一段线索",
        "- 第二段线索",
        "",
        "---",
      ].join("\n"),
    );
    expect(html).toContain("<h2>第一章 烬余</h2>");
    expect(html).toContain("<strong>林渊</strong>");
    expect(html).toContain("<em>风声</em>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<hr>");
  });

  it("常规叙事文本往返（md → html → md）保持一致", () => {
    const source = [
      "# 第一章 烬余",
      "",
      "夜色压下来，**林渊**拔剑而起。",
      "",
      "> 今晚的灵气更重。",
      "",
      "- 线索一",
      "- 线索二",
      "",
      "---",
      "",
      "收尾段落。",
    ].join("\n");
    const roundtrip = htmlToMd(mdToHtml(source));
    expect(roundtrip).toContain("# 第一章 烬余");
    expect(roundtrip).toContain("**林渊**");
    expect(roundtrip).toContain("> 今晚的灵气更重。");
    expect(roundtrip).toContain("- 线索一");
    expect(roundtrip).toContain("---");
    expect(roundtrip).toContain("收尾段落。");
    // 语义等价：去空白后应一致（允许空行数差异）
    expect(roundtrip.replace(/\s+/g, "")).toBe(source.replace(/\s+/g, ""));
  });

  it("富文本暂不支持的语法被检出（避免往返丢数据）", () => {
    const labels = (text: string) => findUnsupportedSyntax(text).map((item) => item.label);

    expect(labels("| 角色 | 境界 |\n| --- | --- |\n| 林渊 | 练气 |")).toContain("表格");
    expect(labels("```js\nconsole.log(1)\n```")).toContain("代码块");
    expect(labels("![封面](../assets/cover.png)")).toContain("图片");
    expect(labels("见[设定卡](world/cards/char-linyuan.md)")).toContain("链接");
    expect(labels("<div>原始 html</div>")).toContain("原始 HTML");
    expect(labels("普通叙事段落，**加粗**与*斜体*都没问题。")).toEqual([]);
  });
});