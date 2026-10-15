/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 前端设计契约的机器判据（R96）。
 *
 * 契约文档在 `docs/10-前端设计契约.md`。这里只解决一件事：
 * **写进契约的规矩必须当场可验证**——否则它会和"我们重视无障碍"这种话一样，
 * 写完那天开始腐（R91 的同一条教训：禁忌表里的规矩要变成判据，不然照样复发）。
 *
 * 每条扫描都带**绝对下限**（证明它真的扫到了东西）：解析器坏掉时零命中不会伪装成失败，
 * 只会伪装成"全绿"——这是本项目被同类事故教过最多次的一种假锁。
 */

const ROOT = join(__dirname, "..", "..", "..");
const CSS_PATH = join(ROOT, "apps", "desktop", "renderer", "src", "styles.css");
const DOC_PATH = join(ROOT, "docs", "10-前端设计契约.md");
const VIEW_ROOT = join(ROOT, "apps", "desktop", "renderer", "src");
const css = readFileSync(CSS_PATH, "utf8");
const lines = css.split(/\r?\n/);

/** 注释换成等长空格：行数与行长都不变，报出来的行号才可信（R83 的同一条做法） */
function maskComments(src: string[]): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of src) {
    let text = "";
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const close = line.indexOf("*/", i);
        if (close === -1) {
          text += " ".repeat(line.length - i);
          break;
        }
        text += " ".repeat(close + 2 - i);
        i = close + 2;
        inBlock = false;
        continue;
      }
      const open = line.indexOf("/*", i);
      if (open === -1) {
        text += line.slice(i);
        break;
      }
      text += line.slice(i, open);
      i = open;
      inBlock = true;
    }
    out.push(text);
  }
  return out;
}

const masked = maskComments(lines);

function rootRanges(): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < masked.length; i += 1) {
    const trimmed = (masked[i] ?? "").trim();
    if (!trimmed.includes(":root") || !trimmed.includes("{")) continue;
    let depth = 0;
    let end = i;
    for (let j = i; j < masked.length; j += 1) {
      const row = masked[j] ?? "";
      depth += (row.match(/\{/g) ?? []).length;
      depth -= (row.match(/\}/g) ?? []).length;
      if (depth <= 0) {
        end = j;
        break;
      }
    }
    ranges.push([i + 1, end + 1]);
  }
  return ranges;
}

const RANGES = rootRanges();
const insideRoot = (lineNo: number): boolean => RANGES.some(([a, b]) => lineNo >= a && lineNo <= b);

/** :root 之外的声明行（注释已剥） */
function declarationsOutsideRoot(): string[] {
  const out: string[] = [];
  for (let i = 0; i < masked.length; i += 1) {
    if (insideRoot(i + 1)) continue;
    const trimmed = (masked[i] ?? "").trim();
    if (trimmed !== "") out.push(trimmed);
  }
  return out;
}

const DECLS = declarationsOutsideRoot();

function tsxFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsxFiles(p));
    else if (/\.(tsx|ts)$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** 可交互元素必须是原生控件：找 `onClick=` 前面最近的标签名 */
const NATIVE_INTERACTIVE = new Set(["button", "a", "input", "select", "textarea", "summary", "label"]);

function clickTargetsOutsideNativeControls(source: string): string[] {
  const hits: string[] = [];
  let i = 0;
  while ((i = source.indexOf("onClick=", i)) !== -1) {
    const before = source.slice(0, i);
    const tag = /<([a-zA-Z][\w-]*)[^<]*$/.exec(before);
    if (tag !== null && tag[1] !== undefined && !NATIVE_INTERACTIVE.has(tag[1])) {
      hits.push(`${tag[1]} @ 第 ${before.split("\n").length} 行`);
    }
    i += 8;
  }
  return hits;
}

describe("设计契约文档本身（§0 学习清单与「不抄」边界必须写在纸上）", () => {
  const doc = readFileSync(DOC_PATH, "utf8");

  it("必备小节一个不许少（少了就是契约被掏空）", () => {
    for (const heading of [
      "## 0. 怎么来的：学习清单",
      "## 1. 三条不可谈判的原则",
      "## 2. 间距令牌",
      "## 3. 字体与中文排版",
      "## 4. 圆角与层级",
      "## 5. 动效",
      "## 6. 焦点与键盘",
      "## 7. 迁移策略",
    ]) {
      expect(doc, `契约缺小节：${heading}`).toContain(heading);
    }
  });

  it("写清「只学口径不抄代码」与图标的上游许可（否则将来没人说得清来源）", () => {
    expect(doc).toContain("Lucide");
    expect(doc).toContain("ISC");
    expect(doc).toContain("NOTICE");
    expect(doc).toContain("没有复制任何闭源产品的 CSS");
    expect(doc).toContain("不许改 path");
  });

  it("中文排版三条口径在纸上：正文禁 letter-spacing、行高区间、两端对齐的坑", () => {
    expect(doc).toContain("禁止** `letter-spacing`");
    expect(doc).toContain("1/4 em");
    expect(doc).toMatch(/1\.4[–-]1\.7|行高 1\.4/);
  });
});

describe("样式表按契约取值（棘轮：只降不升）", () => {
  it("扫描本身要成立：文件够长、:root 块够多、声明够密（防解析器坏了冒充全绿）", () => {
    expect(lines.length).toBeGreaterThan(3000);
    expect(RANGES.length).toBeGreaterThanOrEqual(3);
    expect(DECLS.length).toBeGreaterThan(1000);
  });

  it("border-radius 声明必须全部走 --radius-* 令牌，一个 px 字面量都不许留", () => {
    const radius = DECLS.filter((row) => row.startsWith("border-radius:"));
    // R96 实测 58 条；下限兜住"扫到了但扫空了"
    expect(radius.length).toBeGreaterThanOrEqual(58);
    const offenders = radius.filter((row) => !row.includes("var(--radius-") || /\d+px/.test(row));
    // 允许 0 与百分比之外的裸值只有"0"（复合圆角里的直角）
    expect(offenders, `未走令牌的圆角：${offenders.join(" | ")}`).toEqual([]);
  });

  it("长度字面量棘轮：R96 收口后 620 处，只许降不许升（且下限证明扫描有效）", () => {
    const hits: string[] = [];
    for (const row of DECLS) {
      for (const m of row.match(/(?<![\w.-])\d*\.?\d+(?:px|em|rem|ch)\b/g) ?? []) hits.push(m);
    }
    expect(hits.length).toBeLessThanOrEqual(620);
    expect(hits.length).toBeGreaterThanOrEqual(500);
  });

  it("焦点环宽度只有一个来源（高对比下 outline 才跟系统色，别退回 box-shadow）", () => {
    const outlines = DECLS.filter((row) => row.startsWith("outline:"));
    expect(outlines.length).toBeGreaterThanOrEqual(5);
    const literal = outlines.filter((row) => row !== "outline: none;" && !row.includes("var(--focus-width)"));
    expect(literal, `硬写宽度的焦点环：${literal.join(" | ")}`).toEqual([]);
    const widths = DECLS.filter((row) => row.startsWith("outline-width:"));
    expect(widths).toEqual([]);
  });

  it("@keyframes 数量锁死在 1（契约 §5 反参照：不做全站入场表演）", () => {
    const frames = masked.filter((row) => row.includes("@keyframes"));
    expect(frames.length).toBe(1);
  });

  it("prefers-reduced-motion 必须逐条覆盖所有声明了 animation 的选择器（只关一个等于没关）", () => {
    const start = lines.findIndex((row) => row.includes("@media (prefers-reduced-motion: reduce)"));
    expect(start).toBeGreaterThan(0);
    // 按大括号配对取整块（写死行数的话，块里多加一条规则就会把断言变成"看不见 animation"）
    let depth = 0;
    let end = start;
    for (let j = start; j < lines.length; j += 1) {
      depth += (lines[j]?.match(/\{/g) ?? []).length;
      depth -= (lines[j]?.match(/\}/g) ?? []).length;
      if (depth <= 0) {
        end = j;
        break;
      }
    }
    const block = lines.slice(start, end + 1).join("\n");
    expect(block).toContain("transition");
    const inBlock = (index: number): boolean => index >= start && index <= end;

    /** 声明所在规则的完整选择器（多行分组选择器要拼回来） */
    const selectorFor = (index: number): string => {
      let open = index;
      while (open >= 0 && !(masked[open] ?? "").trim().endsWith("{")) open -= 1;
      const parts: string[] = [];
      const head = (masked[open] ?? "").trim().replace(/\{$/, "").trim();
      if (head !== "") parts.unshift(head);
      for (let j = open - 1; j >= 0; j -= 1) {
        const row = (masked[j] ?? "").trim();
        if (row === "" || row.endsWith("}") || row.endsWith(";") || row.endsWith("{")) break;
        parts.unshift(row);
      }
      return parts.join(" ");
    };

    const animated = new Set<string>();
    for (let i = 0; i < masked.length; i += 1) {
      const row = (masked[i] ?? "").trim();
      if (inBlock(i) || !row.startsWith("animation:")) continue;
      for (const sel of selectorFor(i).split(",")) {
        const trimmed = sel.trim();
        if (trimmed !== "") animated.add(trimmed);
      }
    }
    // 绝对下限：现在只有一处入场动画。扫到 0 个说明扫描器坏了，不是"没人用动画"
    expect(animated.size).toBeGreaterThanOrEqual(1);
    for (const sel of animated) {
      expect(block, `reduced-motion 没有关掉「${sel}」的动画`).toContain(sel);
    }
  });
});

describe("可点选的必须是键盘能到的控件（契约 §6）", () => {
  it("扫描器自己要能红：一段已知的违规写法必须被点名", () => {
    const sample = `const A = () => (<li className="x" onClick={() => go()}><b>hi</b></li>);`;
    expect(clickTargetsOutsideNativeControls(sample)).toEqual(["li @ 第 1 行"]);
    const ok = `const B = () => (<button type="button" onClick={() => go()}>hi</button>);`;
    expect(clickTargetsOutsideNativeControls(ok)).toEqual([]);
  });

  it("渲染层的键盘债登记在案：只许降不许升，逐文件点名", () => {
    const files = tsxFiles(VIEW_ROOT);
    expect(files.length).toBeGreaterThanOrEqual(20);
    const debt: Record<string, number> = {};
    let total = 0;
    for (const f of files) {
      const hits = clickTargetsOutsideNativeControls(readFileSync(f, "utf8"));
      if (hits.length === 0) continue;
      const rel = f.split("\\").join("/").replace(ROOT.split("\\").join("/") + "/", "");
      debt[rel] = hits.length;
      total += hits.length;
    }
    // R96 起 12 → 10（记忆页 2 处），R97 再修掉编辑器草稿章节表 1 处 ⇒ 9。要降必须真的改画面。
    expect(total).toBeLessThanOrEqual(9);
    expect(debt).toEqual({
      "apps/desktop/renderer/src/components/RelationGraphPanel.tsx": 1,
      "apps/desktop/renderer/src/views/AiView.tsx": 1,
      "apps/desktop/renderer/src/views/ArchiveView.tsx": 2,
      "apps/desktop/renderer/src/views/GenesisView.tsx": 1,
      "apps/desktop/renderer/src/views/OutlineView.tsx": 1,
      "apps/desktop/renderer/src/views/ProjectView.tsx": 3,
    });
  });

  it("记忆页的列表行已经是真按钮（本轮修的那两处不许悄悄退回去）", () => {
    const view = readFileSync(join(VIEW_ROOT, "views", "MemoryView.tsx"), "utf8");
    const rows = view.match(/<li[^>]*onClick=/g) ?? [];
    expect(rows).toEqual([]);
    expect(view).toContain("aria-current");
    // 视觉复位靠这两条样式规则，删了就会变成"能点但看不出是按钮"
    const style = readFileSync(CSS_PATH, "utf8");
    expect(style).toContain(".memory-targets li > button");
    expect(style).toContain(".memory-coldstart-batch li > button");
  });

  it("编辑器草稿章节表与记忆页一样是真按钮并标了选中态（M4 变异暴露的空档）", () => {
    const editor = readFileSync(join(VIEW_ROOT, "views", "ChapterEditorView.tsx"), "utf8");
    expect(editor).not.toMatch(/<li[^>]*onClick=/);
    expect(editor).toContain("aria-current={target.chapterPath === selectedPath ? \"true\" : undefined}");
    const style = readFileSync(CSS_PATH, "utf8");
    expect(style).toContain(".draft-list li > button");
  });

  it("图标仍是上游原件 + 许可声明在文件头（改了 path 就等于署名失效）", () => {
    const icons = readFileSync(join(VIEW_ROOT, "icons.tsx"), "utf8");
    expect(icons).toContain("ISC License");
    expect(icons).toContain("lucide-static");
    expect(icons).toContain("不做二次创作");
    const notice = readFileSync(join(ROOT, "NOTICE"), "utf8");
    expect(notice.toLowerCase()).toContain("lucide");
    expect(statSync(join(VIEW_ROOT, "icons.tsx")).isFile()).toBe(true);
  });
});
