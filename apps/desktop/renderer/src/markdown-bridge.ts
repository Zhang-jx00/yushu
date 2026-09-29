import MarkdownIt from "markdown-it";
import TurndownService from "turndown";

/**
 * Markdown ⇄ 富文本（HTML）桥（M2 / T2-1 切片 B）。
 * - 磁盘真源始终是 Markdown 文本；富文本形态是同一文本的另一种视图（不做双真源）；
 * - md → HTML 用 markdown-it；TipTap 编辑后 getHTML() → Markdown 用 turndown；
 * - 富文本形态（StarterKit）暂不支持表格/代码块/图片/链接/原始 HTML 等语法：
 *   `findUnsupportedSyntax` 负责检测，UI 在这些语法存在时保持源码形态，**避免往返丢数据**。
 */

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });
const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  emDelimiter: "*",
  strongDelimiter: "**",
});
// 保留分隔线（Turndown 默认会把 <hr> 变成 * * *，我们统一为 ---）
turndown.addRule("hr", { filter: "hr", replacement: () => "\n\n---\n\n" });

export function mdToHtml(text: string): string {
  return md.render(text);
}

export function htmlToMd(html: string): string {
  return turndown
    .turndown(html)
    // Turndown 默认在列表标记后输出 3 空格；归一为单空格（更符合中文写作习惯的 Markdown 输出）
    .replace(/^([ \t]*)([-*+]) {2,}/gm, "$1$2 ")
    .replace(/^([ \t]*)(\d+)\. {2,}/gm, "$1$2. ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface UnsupportedSyntax {
  /** 语法名称（用于 UI 提示） */
  label: string;
  /** 触发示例（首行片段） */
  sample: string;
}

/** 富文本形态尚不支持、切换会造成格式损失的 Markdown 语法检测（保守白名单） */
export function findUnsupportedSyntax(text: string): UnsupportedSyntax[] {
  const found: UnsupportedSyntax[] = [];
  const lines = text.split("\n");

  const push = (label: string, sample: string) => {
    if (!found.some((item) => item.label === label)) {
      found.push({ label, sample: sample.trim().slice(0, 40) });
    }
  };

  let inFence = false;
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      push("代码块", line);
      continue;
    }
    if (inFence) continue;
    if (/^\s*\|.*\|\s*$/.test(line) && line.includes("-") === false && line.split("|").length >= 3) {
      // 表格特征：单元格行 + 至少两个分隔（更细的判定交给下方分隔行规则）
      push("表格", line);
    }
    if (/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes("|")) {
      push("表格", line);
    }
    if (/!\[[^\]]*\]\(/.test(line)) push("图片", line);
    if (/(?<!!)\[[^\]]+\]\([^)]+\)/.test(line)) push("链接", line);
    if (/^\s*\[[^\]]+\]:\s*\S+/.test(line)) push("引用式链接", line);
    if (/<\/?[a-zA-Z][^>]*>/.test(line)) push("原始 HTML", line);
    if (/\{\{|\}\}/.test(line)) push("模板标记", line);
  }
  return found;
}