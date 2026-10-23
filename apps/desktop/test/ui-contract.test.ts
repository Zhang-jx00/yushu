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

/**
 * **键盘可达**的例外（只在它同时具备这三样时才算数）：
 * `role="button"` + `tabIndex={0}` + 一个 `onKeyDown`。
 *
 * 为什么需要这个例外：SVG 里放不了 HTML 按钮（`<g>` 只能是图形元素），
 * 而关系图的节点是**真的可点**的。把它做成"键盘可达的图形按钮"（可聚焦 + 回车/空格触发）
 * 才符合契约 §1.3 的原话——"任何可点的东西必须**可用键盘完成**"，
 * 而不是"必须用 `<button>` 标签"（那只是手段）。
 *
 * 三样缺一就不算数 ⇒ 只挂 `role` 的、只挂 `tabIndex` 的、只写 `onKeyDown` 的，一律算债。
 */
function declaresKeyboardReachable(openTag: string): boolean {
  return (
    /role=["']button["']/.test(openTag) &&
    /tabIndex=\{?0\}?/.test(openTag) &&
    /onKeyDown=/.test(openTag)
  );
}

/** 取某个 onClick 所在元素的**开标签**（`>` 出现在 `=>` 里不算结尾，属性顺序无关） */
function openingTagOf(source: string, onClickIndex: number): string {
  const before = source.slice(0, onClickIndex);
  const start = before.lastIndexOf("<");
  if (start < 0) return "";
  let depth = 0;
  for (let k = onClickIndex; k < source.length; k += 1) {
    const ch = source[k];
    if (ch === "=" && source[k + 1] === ">") {
      k += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth <= 0) return source.slice(start, k + 1);
  }
  return source.slice(start);
}

function clickTargetsOutsideNativeControls(source: string): string[] {
  const hits: string[] = [];
  let i = 0;
  while ((i = source.indexOf("onClick=", i)) !== -1) {
    const before = source.slice(0, i);
    const tag = /<([a-zA-Z][\w-]*)[^<]*$/.exec(before);
    if (tag !== null && tag[1] !== undefined && !NATIVE_INTERACTIVE.has(tag[1])) {
      if (!declaresKeyboardReachable(openingTagOf(source, i))) {
        hits.push(`${tag[1]} @ 第 ${before.split("\n").length} 行`);
      }
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

  it("渲染层的键盘债**归零**（R110：9 → 0；SVG 节点按「键盘可达」算，缺一不算）", () => {
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
    // R96 起 12 → 10（记忆页 2 处），R97 再修掉编辑器草稿章节表 1 处 ⇒ 9，
    // **R110 归零**：8 处清单行改成真按钮，1 处 SVG 节点改成键盘可达的图形按钮。
    // 要降必须真的改画面。
    expect(total, `键盘债还剩 ${String(total)} 处：${JSON.stringify(debt)}`).toBe(0);
    expect(debt).toEqual({});
  });

  it("扫描器自己能红：缺 role / tabIndex / onKeyDown 任一项都不算键盘可达", () => {
    // 三份样本各自**只缺一项**（早先三份各缺两项 ⇒ 放松任何一条都看不出来，那个自检是漏的）
    const lacksKeyDown = '<g className="x" role="button" tabIndex={0} onClick={() => {}}';
    const lacksTabIndex = '<g className="x" role="button" onKeyDown={() => {}} onClick={() => {}}';
    const lacksRole = '<g className="x" tabIndex={0} onKeyDown={() => {}} onClick={() => {}}';
    const all = '<g className="x" role="button" tabIndex={0} onKeyDown={() => {}} onClick={() => {}}';
    expect(clickTargetsOutsideNativeControls(lacksKeyDown).length, "缺 onKeyDown 仍被当成可达").toBe(1);
    expect(clickTargetsOutsideNativeControls(lacksTabIndex).length, "缺 tabIndex 仍被当成可达").toBe(1);
    expect(clickTargetsOutsideNativeControls(lacksRole).length, "缺 role 仍被当成可达").toBe(1);
    expect(clickTargetsOutsideNativeControls(all).length, "三样齐全却还被算债").toBe(0);
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

/**
 * UI 重构第一轮（R109）的机器判据：密度档 + 品牌标记。
 *
 * 两条都盯"看起来是小事、其实是作者每天的体验"的地方：
 * ① **默认档必须等于改版前的取值**——密度档是个**开关**，不是"我们顺手把画面改了"；
 * ② **品牌标记只有一个来源**——标记散落两份就等于有两枚不同的印，署名与识别都失守。
 */
describe("UI 重构第一轮（R109）：密度档与品牌标记", () => {
  const brand = readFileSync(join(VIEW_ROOT, "brand.tsx"), "utf8");

  it("密度三档齐备，且**默认档 cozy 的取值就是改版前的样子**（不许偷偷改默认画面）", () => {
    const rootBlock = css.slice(css.indexOf(":root {"));
    const cozy = rootBlock.slice(0, rootBlock.indexOf("}") + 1);
    // 改版前 `.slot-table th/td` 的 padding 是 `4px 8px` ⇒ 默认档必须还是它
    expect(cozy).toContain("--density-cell-pad-y: 4px;");
    expect(cozy).toContain("--density-cell-pad-x: 8px;");
    expect(cozy).toContain("--density-text: 12.5px;");
    for (const id of ["compact", "roomy"]) {
      expect(css, `缺密度档 ${id}`).toContain(`:root[data-density="${id}"]`);
    }
  });

  it("表格内距必须走密度令牌（不许再写 px 字面量，否则切档对表格无效）", () => {
    const tableBlock = /\.slot-table th,\s*\.slot-table td \{[^}]*\}/.exec(css)?.[0] ?? "";
    expect(tableBlock).toContain("var(--density-cell-pad-y)");
    expect(tableBlock).toContain("var(--density-cell-pad-x)");
    // 只看 **padding 那一条**（同一块里还有 `border-bottom: 1px`，那是描边不是内距）
    const paddingLine = tableBlock.split("\n").find((row) => row.includes("padding:")) ?? "";
    expect(paddingLine).not.toMatch(/\d+px/);
  });

  it("密度档的三档取值都只出现在 :root 里（棘轮口径：字面量不许散在别处）", () => {
    // 两档覆盖块必须写成 :root[data-density=...]：令牌就是 :root 级的
    expect(css).not.toMatch(/html\[data-density=/);
    const densityBlocks = [...css.matchAll(/:root\[data-density="[a-z]+"\] \{[^}]*\}/g)].map((m) => m[0]);
    expect(densityBlocks.length).toBe(2);
  });

  it("品牌标记只有一个来源：path 只许出现在 brand.tsx，组件里不许内联第二份", () => {
    expect(brand).toContain("BRAND_MARK_PATHS");
    expect(brand).toContain("BRAND_MARK_SEAL");
    // 标记的形状是"一卷书 + 右下角一枚朱印"⇒ 两条 path 里的特征串
    const fingerprint = "M6 4h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z";
    const files = tsxFiles(VIEW_ROOT);
    const holders = files
      .filter((file) => readFileSync(file, "utf8").includes(fingerprint))
      .map((file) => file.split(/[\\/]/).slice(-2).join("/"));
    expect(holders, "品牌标记的 path 出现在多个文件里").toEqual(["src/brand.tsx"]);
  });

  it("品牌标记是**自绘**的（不抄图标库），且声明了来源与改动规矩", () => {
    expect(brand).toContain("自绘");
    expect(brand).toContain("不许随手改 path");
    expect(brand).toContain("24×24");
  });

  it("开屏的入场用**过渡**而不是 @keyframes（契约 §5 把 @keyframes 锁在 1）", () => {
    // 用剥了注释的 css 数（注释里提到 "@keyframes" 不算一条规则）
    const keyframes = [...masked.join("\n").matchAll(/@keyframes/g)].length;
    expect(keyframes).toBeLessThanOrEqual(1);
    expect(css).toContain(".welcome.is-entered");
  });

  it("reduced-motion 必须把开屏那组过渡也关掉（只关 animation 等于没关）", () => {
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".welcome-mark");
    expect(reduced).toContain("transition: none;");
  });
});

/**
 * UI 重构第二批（R110）的机器判据：键盘债归零 + 排版口径。
 *
 * 这一批动的都是**画面**，所以判据必须是"量得到的东西"：
 * 键盘债用扫描器数（不是靠人肉确认），行长与对齐用 CSS 令牌钉住。
 */
describe("UI 重构第二批（R110）：键盘债与排版口径", () => {
  it("键盘债必须为 0（清单行是真按钮；SVG 节点按「键盘可达」算）", () => {
    const files = tsxFiles(VIEW_ROOT);
    const debt: Record<string, number> = {};
    let total = 0;
    for (const f of files) {
      const hits = clickTargetsOutsideNativeControls(readFileSync(f, "utf8"));
      if (hits.length === 0) continue;
      const rel = f.split("\\").join("/").replace(ROOT.split("\\").join("/") + "/", "");
      debt[rel] = hits.length;
      total += hits.length;
    }
    expect(total, `键盘债还剩 ${String(total)} 处：${JSON.stringify(debt)}`).toBe(0);
  });

  it("写作面版的行长**不动**（R64 刻意的 44em：写作是扫，不是读）", () => {
    expect(css).toContain("--prose-measure: 44em;");
    expect(css).toMatch(/\.cm-host,\s*\.tiptap-host \{[^}]*max-width: var\(--prose-measure\)/);
  });

  it("阅读型长文块另有更短的上限（两种版面是两种用法）", () => {
    expect(css).toContain("--prose-measure-narrow: 34em;");
    expect(css).toMatch(/\.panel p \{[^}]*max-width: var\(--prose-measure-narrow\)/);
  });

  it("数字格统一走 .num（右对齐 + 等宽数位），导入面板不再单开一个类", () => {
    expect(css).toMatch(/\.num \{[^}]*text-align: right/);
    expect(css).toMatch(/\.num \{[^}]*font-variant-numeric: tabular-nums/);
    expect(css, "旧的 .import-num 应当并入 .num").not.toContain(".import-num {");
    const panel = readFileSync(join(VIEW_ROOT, "components", "ImportPanel.tsx"), "utf8");
    expect(panel).not.toContain("import-num");
    expect(panel).toContain('className="num"');
  });
});

/**
 * UI 重构调研与设计规范（docs/11，R109 第一轮）的机器判据。
 *
 * 调研这一段最容易被"写完就烂在文档里"⇒ 所以把**用户提的那条硬指标**（百款以上）
 * 与必备小节都变成判据：条目数掉了要红，小节被掏空要红。
 */
describe("UI 重构调研与设计规范（docs/11，R109）", () => {
  const doc = readFileSync(join(ROOT, "docs", "11-UI重构调研与设计规范.md"), "utf8");

  it("调研清单**百款以上**（用户提的硬指标，掉了就要红）", () => {
    const urls = [...doc.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]);
    const unique = new Set(urls);
    expect(unique.size, `调研条目只有 ${String(unique.size)} 条`).toBeGreaterThanOrEqual(100);
  });

  it("必备小节一个不许少（少一节就是规范被掏空）", () => {
    for (const heading of [
      "## 0. 怎么调研的",
      "## 1. 视觉语言",
      "## 2. 排版与密度",
      "## 3. 动效",
      "## 4. 交互",
      "## 5. 图标与品牌",
      "## 6. 开屏",
      "## 7. 五批实施计划",
      "## 8. 明确还没做的",
      "## 9. 附录：调研清单",
    ]) {
      expect(doc, `规范缺小节：${heading}`).toContain(heading);
    }
  });

  it("写清「只取口径不抄代码」的边界与反参照（否则将来有人手痒）", () => {
    expect(doc).toContain("不复制任何闭源产品");
    expect(doc).toContain("反参照");
  });

  it("明写还没做的（不许被读成已做，也不许把已完成的塞回来）", () => {
    const section = doc.slice(doc.indexOf("## 8. 明确还没做的"));
    // R119 起只钉**真的还没做**的那些：排版改版（R110 已做）与密度档持久化（R117 已做）
    // 已经不在「还没做的」名单里了——继续钉它们等于逼着人说假话。
    for (const item of ["暗色色板", "世界地图", "插画"]) {
      expect(section).toContain(item);
    }
    // 反向也钉一条：**已经做掉的，不许再写进「还没做的」**（R119 清台账时最怕的就是这种）。
    for (const done of ["排版改版（行长", "密度档的持久化"]) {
      expect(section).not.toContain(done);
    }
  });
});

/**
 * UI 重构第三批（R111）的机器判据：动效族落地。
 *
 * 这一批把 docs/11 §3 的四族语义（进场 / 退场 / 状态 / 揭示）真正接进组件，
 * 给唯一的浮层（@ 候选菜单）补上**进退场**、给列表项补上**微反馈**。
 *
 * 三条纪律落在判据上：
 * ① **退场比进场快**不是口号：浮层的退场族时长必须**短于**进场族（从 :root 解析实际值比较）。
 * ② **时长只有一个来源**：别名指向既有三档（不新增时长值），组件只许引用别名；
 *    退场的延时也必须从令牌读，不许在组件里写死毫秒数。
 * ③ **每个扫描器都要能红**：R110 栽过"三份样本各缺两项 ⇒ 放松任一条都看不出来"，
 *    所以这里每个判据都配一份"违规样本"，样本必须被判红——恒绿的锁比没锁更坏。
 */

/** 四族语义别名 → 它们指向的既有三档（docs/11 §3.1） */
const MOTION_ALIASES: Record<string, string> = {
  "--motion-exit": "--motion-quick",
  "--motion-state": "--motion-quick",
  "--motion-enter": "--motion-base",
  "--motion-reveal": "--motion-slow",
};

/** 取 :root 里某令牌的声明值（跨多个 :root 块合并，后写的覆盖先写的） */
function rootTokenValue(token: string): string | null {
  let value: string | null = null;
  const escaped = token.replace(/[-]/g, "\\-");
  for (const [start, end] of RANGES) {
    for (let i = start - 1; i < end; i += 1) {
      const m = new RegExp(`^\\s*${escaped}\\s*:\\s*([^;]+);`).exec(masked[i] ?? "");
      if (m) value = (m[1] ?? "").trim();
    }
  }
  return value;
}

/** 把令牌值解析成毫秒（支持 var(--x) 引用与 ms/s） */
function resolveMs(token: string, depth = 0): number | null {
  if (depth > 4) return null;
  const raw = rootTokenValue(token);
  if (raw === null) return null;
  const ref = /^var\((--[a-z0-9-]+)\)$/.exec(raw);
  if (ref) return resolveMs(ref[1] as string, depth + 1);
  const num = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(raw);
  if (!num) return null;
  const n = Number(num[1]);
  return num[2] === "s" ? n * 1000 : n;
}

/** :root 之外引用了哪些动效令牌（去重，按出现顺序） */
function motionRefsOutsideRoot(source: string[], isInRoot: (lineNo: number) => boolean): string[] {
  const hits: string[] = [];
  for (let i = 0; i < source.length; i += 1) {
    if (isInRoot(i + 1)) continue;
    for (const m of (source[i] ?? "").matchAll(/var\((--motion-[a-z0-9-]+)\)/g)) {
      const token = m[1] as string;
      if (!hits.includes(token)) hits.push(token);
    }
  }
  return hits;
}

/** 取一条规则块的内容（选择器精确匹配；source 传剥过注释的全文） */
function ruleBlock(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[}\\n])\\s*${escaped}\\s*\\{([^}]*)\\}`, "m");
  return re.exec(source)?.[1] ?? "";
}

/** 退场时长必须短于进场时长（docs/11 §3.2 第 1 条：退场比进场快） */
function exitFasterThanEnter(enterMs: number | null, exitMs: number | null): boolean {
  if (enterMs === null || exitMs === null) return false;
  return exitMs < enterMs;
}

/**
 * 取出某个媒体查询块的内容（大括号配对，不写死行数）。
 * 用剥过注释的全文当源：注释里可能也有花括号，计深度会算错。
 */
function mediaBlock(source: string, condition: string): string {
  const start = source.indexOf(condition);
  if (start < 0) return "";
  const open = source.indexOf("{", start);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

/**
 * 媒体块里，**覆盖了某个选择器的那些规则**的内容（一条规则一块）。
 *
 * 为什么不能只看"块里有没有 transition: none"：reduced-motion 块里有多处
 * `transition: none`（开屏那组、浮层那组）——只做整块 contains 的话，
 * **别处的 none 会冒充浮层的**，那条判据就恒绿了。
 * 这正是 R110 栽过的那一类："三份样本各缺两项 ⇒ 放松任一条都看不出来"。
 */
function reducedRulesCovering(block: string, selector: string): string[] {
  const out: string[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) {
    if ((m[1] ?? "").includes(selector)) out.push(m[2] ?? "");
  }
  return out;
}

describe("UI 重构第三批（R111）：动效族落地", () => {
  const bare = masked.join("\n");
  const editor = readFileSync(join(VIEW_ROOT, "views", "ChapterEditorView.tsx"), "utf8");

  it("四族语义别名齐备，且都指向既有三档（别名是引用，不是新的时长值）", () => {
    for (const [alias, base] of Object.entries(MOTION_ALIASES)) {
      expect(rootTokenValue(alias), `缺别名 ${alias}`).toBe(`var(${base})`);
    }
    // 底层三档仍在、取值没动过（别名不新增时长 ⇒ R83 的时长例外清单一条不变）
    expect(resolveMs("--motion-quick")).toBe(140);
    expect(resolveMs("--motion-base")).toBe(240);
    expect(resolveMs("--motion-slow")).toBe(380);
  });

  it("组件规则只许用四族语义别名，不许再直接引用「快/中/慢」三档（扫描器自检：违规样本必须被点名）", () => {
    const offenders = motionRefsOutsideRoot(masked, insideRoot).filter(
      (token) => !Object.keys(MOTION_ALIASES).includes(token),
    );
    expect(offenders, `组件仍在直接引用三档：${offenders.join(" | ")}`).toEqual([]);
    // 自检：扫描器坏了 ⇒ 零命中会伪装成全绿，所以先证明它抓得住
    const sample = ["button { transition: transform var(--motion-base) linear; }"];
    expect(motionRefsOutsideRoot(sample, () => false)).toEqual(["--motion-base"]);
  });

  it("浮层的退场比进场快（进场用 --motion-enter、退场用 --motion-exit，实际时长更短）", () => {
    const enterBlock = ruleBlock(bare, ".mention-menu");
    const leaveBlock = ruleBlock(bare, ".mention-menu.is-leaving");
    expect(enterBlock, "浮层没有进场过渡").toContain("var(--motion-enter)");
    expect(leaveBlock, "浮层没有退场态").toContain("var(--motion-exit)");
    const enterMs = resolveMs("--motion-enter");
    const exitMs = resolveMs("--motion-exit");
    expect(exitFasterThanEnter(enterMs, exitMs), `进场 ${String(enterMs)}ms / 退场 ${String(exitMs)}ms`).toBe(true);
    // 自检：退场与进场同长时必须判红（否则这条判据就是恒绿的）
    expect(exitFasterThanEnter(240, 240)).toBe(false);
    expect(exitFasterThanEnter(null, 140)).toBe(false);
  });

  it("面板揭示族也分进退（展开走 --motion-reveal、收起走 --motion-exit）", () => {
    expect(ruleBlock(bare, ".disclosure-panel")).toContain("var(--motion-exit)");
    expect(ruleBlock(bare, ".disclosure.open .disclosure-panel")).toContain("var(--motion-reveal)");
  });

  it("浮层的退场是真的实现了（组件里有退场态，且延时取自令牌而不是写死毫秒）", () => {
    expect(editor).toContain("is-leaving");
    expect(editor, "退场延时必须从 --motion-exit 读").toContain("--motion-exit");
    expect(editor, "退场延时不许写死数字（时长只有一个来源）").not.toMatch(/setTimeout\([^,]*,\s*\d+\s*\)/);
    // 自检：写死的延时必须被抓到——扫描器恒绿等于没有扫描器
    expect(/setTimeout\([^,]*,\s*\d+\s*\)/.test("setTimeout(() => { a(); b(); }, 140)")).toBe(true);
  });

  it("reduced-motion 把浮层的过渡整个关掉（只关 animation 等于没关）", () => {
    const reduced = mediaBlock(bare, "@media (prefers-reduced-motion: reduce)");
    const rules = reducedRulesCovering(reduced, ".mention-menu");
    const ok = rules.length > 0 && rules.every((body) => body.includes("transition: none"));
    expect(ok, "reduced-motion 没有关掉浮层的过渡").toBe(true);
    // 自检：**别处**的 `transition: none` 不许冒充浮层的覆盖——
    // 少了这一条，"整块 contains" 写法会让本判据恒绿（恒绿的锁比没锁更坏）。
    const decoy = "@media (prefers-reduced-motion: reduce) {\n  .welcome h1 { transition: none; }\n  .mention-menu { opacity: 1; }\n}\n";
    const decoyRules = reducedRulesCovering(mediaBlock(decoy, "@media (prefers-reduced-motion: reduce)"), ".mention-menu");
    expect(decoyRules.length).toBe(1);
    expect(decoyRules.every((body) => body.includes("transition: none")), "别处的 none 冒充了浮层的覆盖").toBe(false);
  });

  it("列表项的微反馈走状态族（hover 与高亮都有过渡，且走 --motion-state）", () => {
    const liBlock = ruleBlock(bare, ".mention-menu li");
    expect(liBlock, "候选行没有微反馈过渡").toContain("var(--motion-state)");
    expect(liBlock).toContain("transition");
  });

  it("浮层的阴影走 --elev-overlay 令牌（:root 之外不许再写字面量阴影）", () => {
    expect(ruleBlock(bare, ".mention-menu")).toContain("var(--elev-overlay)");
  });
});

/**
 * UI 重构第四批（R112）的机器判据：标题层级靠**字重与留白**，不靠更多字号。
 *
 * 改版前的实况（2026-10-21 复核，不是印象）：
 * - `h2` 与 `h4` **根本没有规则** ⇒ 靠浏览器默认（h2 = 1.5em ≈ 19.5px / h4 = 1em），
 *   和别处的 14px 标题对不上；
 * - `.panel-title`（面板标题条，12.5px）**比它块内的 `.panel h3`（14px）还小** ⇒ 层级是反的；
 * - 同一个视觉位置（面板标题条）有时放 `<h3>`、有时放纯文字 ⇒ **同一层级两种字号**。
 *
 * 口径（docs/11 §2「靠字重与留白，不靠更多字号」）：
 * 三级 = 页面标题（h2）/ 区块标题（h3）/ 次级标题（h4）；
 * 面板标题条（`.panel-title`）与区块标题**同档**（它本来就是"这一块的标题"，
 * 不是"这一页的标题"）⇒ 消灭"同一位置两种字号"。
 */

/** 解析字号令牌的��际 px（只认 px；标题层级只用 px 档位） */
function tokenPx(token: string): number | null {
  const raw = rootTokenValue(token);
  if (raw === null) return null;
  const m = /^(\d+(?:\.\d+)?)px$/.exec(raw);
  return m ? Number(m[1]) : null;
}

/** 某条标题规则里 font-size / font-weight 的实际取值（都走令牌） */
function titleMetrics(selector: string): { size: number | null; weight: number | null; block: string } {
  const block = ruleBlock(BARE, selector);
  const sizeTok = /font-size:\s*var\((--[a-z0-9-]+)\)/.exec(block);
  const size = sizeTok ? tokenPx(sizeTok[1] as string) : null;
  const wm = /font-weight:\s*(\d+)/.exec(block);
  const weight = wm ? Number(wm[1]) : null;
  return { size, weight, block };
}

/** 剥过注释的全文（模块级：R112 的工具函数定义在 describe 外，取不到组内变量） */
const BARE = masked.join("\n");

describe("UI 重构第四批（R112）：标题层级", () => {
  it("h2 / h3 / h4 三级都有显式规则（不许靠浏览器默认：h2 默认 1.5em，和别处对不上）", () => {
    for (const tag of ["h2", "h3", "h4"]) {
      const { block } = titleMetrics(tag);
      expect(block, `${tag} 没有显式规则（靠浏览器默认 = 层级失控）`).not.toBe("");
      expect(block, `${tag} 没定字号`).toContain("font-size");
      expect(block, `${tag} 没定字重`).toContain("font-weight");
    }
  });

  it("层级单调：字号与字重都不许随层级下降而变大（页面 → 区块 → 次级）", () => {
    const page = titleMetrics("h2");
    const block = titleMetrics("h3");
    const sub = titleMetrics("h4");
    expect(page.size, "h2 的字号解析不出来").not.toBeNull();
    expect(block.size, "h3 的字号解析不出来").not.toBeNull();
    expect(sub.size, "h4 的字号解析不出来").not.toBeNull();
    expect(page.weight).toBeGreaterThanOrEqual(block.weight ?? 0);
    expect(block.weight).toBeGreaterThanOrEqual(sub.weight ?? 0);
    expect(page.size).toBeGreaterThan(block.size ?? 0);
    expect(block.size).toBeGreaterThan(sub.size ?? 0);
  });

  it("标题的字号与字重只许走令牌（不许新增字号档，也不许硬写 px）", () => {
    for (const tag of ["h2", "h3", "h4"]) {
      const { block } = titleMetrics(tag);
      expect(block, `${tag} 里有硬写的字号`).not.toMatch(/font-size:\s*\d/);
      expect(block, `${tag} 的字号没走令牌`).toMatch(/font-size:\s*var\(--text-/);
    }
  });

  it("面板标题条只有一种呈现：`.panel-title` 与它里面的 h3 必须同档（同位置不许两种字号）", () => {
    const panel = titleMetrics(".panel-title");
    const inner = titleMetrics(".panel-title h3");
    expect(panel.size, "面板标题条没有走字号令牌").not.toBeNull();
    expect(inner.block, "`.panel-title h3` 没有重置规则（面板标题条里会出现两种字号）").not.toBe("");
    expect(inner.block).toContain("font-size: inherit");
    expect(inner.block).toContain("font-weight: inherit");
    // 面板标题条与块内区块标题同档
    const h3 = titleMetrics("h3");
    expect(panel.size).toBe(h3.size);
  });

  it("局部覆盖标题层级的写法一个都不许有（层级只能由那三条全局规则决定）", () => {
    for (const sel of [".panel h2", ".panel h3", ".panel h4"]) {
      expect(BARE, `${sel} 局部覆盖了标题层级`).not.toContain(sel + " {");
      expect(BARE, `${sel} 局部覆盖了标题层级`).not.toContain(sel + ",");
    }
  });

  it("扫描器自己要能红：把某级的显式规则删掉，判据必须点名（防解析器坏了 ⇒ 零命中冒充全绿）", () => {
    const broken = "h2 {\n  font-size: var(--text-lg);\n}\n";
    const block = ruleBlock(broken, "h2");
    expect(block).not.toBe("");
    expect(block).not.toContain("font-weight"); // 缺字重 ⇒ 判据会红
    const missing = ruleBlock("h3 { font-size: var(--text-base); }", "h4");
    expect(missing).toBe(""); // 根本没有这条规则 ⇒ 判据会红
  });
});

/**
 * UI 重构第四批·第二段（R113）的机器判据：图标与插画的**来源登记**。
 *
 * 为什么图标也要有账：图标看起来最不需要交代，但它们常常是**别人做的**。
 * 一件署了别人名字的资产混进产品里，出了事追不到源头；把自绘的当上游的用，功劳也算错了人。
 * 所以这张表（`docs/12-图标与插画来源登记.md`）只回答三件事：谁做的、什么许可、画布多大。
 *
 * 规矩四条（docs/12 §3）：渲染层里的矢量图形只许出现在登记过的文件里；
 * 上游的 path 不许改；自绘的必须写明"自绘"；许可声明跟着文件走。
 */

/** 矢量图形的判定：内联 <svg> 或 <path>（判据自检要用它，所以做成纯函数） */
function isVectorSource(src: string): boolean {
  return src.includes("<svg") || src.includes("<path");
}

/**
 * 登记点名的五个文件：**三个图标类**（Lucide 图标集 / 品牌标记 / 折叠箭头）
 * + **两个数据呈现类**（节奏曲线图 / 关系图谱图）。
 *
 * 为什么图表也进表：它们同样是渲染层里的矢量图形，只是画法由**数据**决定，
 * 不是一份"资产"。不进表就会出现"这里有个 svg 却查不到出处"的糊涂账。
 * 区别写在 docs/12 §1.3：图标类必须有 path（固定画法），图表类没有 path（数据绑定）。
 */
const VECTOR_FILES = [
  "icons.tsx",
  "brand.tsx",
  "Disclosure.tsx",
  "RelationGraphPanel.tsx",
  "StatsView.tsx",
  "StateArt.tsx", // R118：自绘的空/错态插画（登记在 docs/12 §1.4）
  "WorldMapPanel.tsx", // R120：世界地图画布（数据驱动，登记在 docs/12 §1.3）
];
/** 其中属于"图标资产"的三个（判据要求它们真的有 path） */
const ICON_FILES = ["icons.tsx", "brand.tsx", "Disclosure.tsx"];

describe("UI 重构第四批·第二段（R113）：图标与插画来源登记", () => {
  const registry = readFileSync(join(ROOT, "docs", "12-图标与插画来源登记.md"), "utf8");

  it("登记表存在，且必备小节一个不许少（少一节就是登记被掏空）", () => {
    // §4 的标题 R119 起改成「明确还没做的」——这是份长期有效的登记表，"本轮"指向不明。
    for (const heading of ["## 0. 为什么要有这张表", "## 1. 登记表", "## 2. 已知的两套口径", "## 3. 规矩", "## 4. 明确还没做的"]) {
      expect(registry, `登记表缺小节：${heading}`).toContain(heading);
    }
  });

  it("11 个 Lucide 图标**逐个**点名（漏一个 = 有一个图标没有出处）", () => {
    // 逐行核对，**不是**整篇 contains：整篇 contains 会让别处的同名内容冒充
    // （图标名在别处提一句就算"点名"了？那是假登记）。
    const rows = registry.split("\n");
    for (const name of ["layers", "list-ordered", "pen-line", "library", "sparkles", "brain", "scale", "download", "book-open", "chart-column", "folder-tree"]) {
      const pattern = new RegExp("^\\|\\s*\\d+\\s*\\|\\s*`" + name + "`\\s*\\|");
      expect(rows.some((row) => pattern.test(row.trim())), `登记表没有以独立一行列出图标 ${name}`).toBe(true);
    }
  });

  it("登记了来源与许可：Lucide 的 ISC、以及自绘的「没有上游」（不许冒充上游）", () => {
    // 许可那一行必须自己写着 ISC：整篇 contains 会让标题里的 "(ISC)" 冒充这一行的许可声明
    const rows = registry.split("\n");
    const licenseRow = rows.find((row) => row.includes("许可：") && row.includes("ISC"));
    expect(licenseRow, "登记表没有在许可那一行写明 ISC").toBeTruthy();
    expect(registry).toContain("lucide-static@1.55.0");
    expect(registry).toContain("没有上游");
    expect(registry).toContain("自绘");
  });

  it("渲染层里的矢量图形只许出现在**登记过的文件**里（不许内联未登记的图形）", () => {
    const files = tsxFiles(VIEW_ROOT);
    const holders = files
      .filter((f) => isVectorSource(readFileSync(f, "utf8")))
      .map((f) => f.split("\\").pop() ?? "")
      .sort();
    expect(holders, `渲染层里的矢量图形出现在未登记的文件里：${holders.join(" | ")}`).toEqual([...VECTOR_FILES].sort());
    // 登记表必须把这五个文件都点名（登记与代码互为对账，不能一边改一边忘了另一边）
    for (const name of VECTOR_FILES) {
      expect(registry, `登记表没点名 ${name}`).toContain(name);
    }
  });

  it("图标类文件必须真的有 path（固定画法的资产），图表类则没有（画法由数据决定）", () => {
    for (const name of ICON_FILES) {
      const file = tsxFiles(VIEW_ROOT).find((f) => (f.split("\\").pop() ?? "") === name);
      expect(file, `找不到 ${name}`).toBeTruthy();
      expect(readFileSync(file as string, "utf8"), `${name} 是图标类却没有 path`).toContain("<path");
    }
    for (const name of ["RelationGraphPanel.tsx", "StatsView.tsx"]) {
      const file = tsxFiles(VIEW_ROOT).find((f) => (f.split("\\").pop() ?? "") === name);
      expect(file, `找不到 ${name}`).toBeTruthy();
      expect(readFileSync(file as string, "utf8"), `${name} 声明成图表类却含 path（该重分类）`).not.toContain("<path");
    }
  });

  it("扫描器自己要能红：一处内联图形必须被抓到（防扫描器坏了 ⇒ 零命中冒充全绿）", () => {
    expect(isVectorSource("const A = () => (<svg><path d=\"M0 0\" /></svg>);")).toBe(true);
    expect(isVectorSource("export function Plain() { return <div>没有图形</div>; }")).toBe(false);
  });
});

/**
 * UI 重构第四批·第三段（R115）的机器判据：界面级状态/操作图标集 + 空状态与错误态。
 *
 * 两条要治的毛病：
 * ① **空状态散落各处、写法各不相同**——有的只是一句灰字，作者分不出「还没写」还是「坏了」；
 *    有的干脆混在正文里。统一成三段式：图标（哪一类状态）+ 标题（是什么）+ 说明（怎么办）。
 * ② **图标与登记表可能各说各话**——登记表点名了但代码里没有（死图标），
 *    或者代码里有了但登记表没点名（查不到出处）。所以要**双向对账**。
 *
 * 图标的**唯一来源**是 `icons.tsx`（Lucide 原件 path，见 `docs/12-图标与插画来源登记.md`），
 * 状态提示组件里不许内联 path——散落一份就等于有两套画法，且没人说得清那份从哪儿来。
 */

/** 代码里声明的图标名（YushuIconName 联合类型） */
function iconNamesFromSource(): string[] {
  const src = readFileSync(join(VIEW_ROOT, "icons.tsx"), "utf8");
  const m = /export type YushuIconName =([\s\S]*?);/.exec(src);
  if (m === null) return [];
  return [...(m[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1] as string);
}

/** 登记表里逐条点名的图标名（表格第一列的行） */
function registeredIconNames(registry: string): string[] {
  const out: string[] = [];
  for (const row of registry.split("\n")) {
    const m = /^\|\s*\d+\s*\|\s*`([^`]+)`\s*\|/.exec(row.trim());
    if (m !== null) out.push(m[1] as string);
  }
  return out;
}

describe("UI 重构第四批·第三段（R115）：状态图标集与空/错态", () => {
  const registry = readFileSync(join(ROOT, "docs", "12-图标与插画来源登记.md"), "utf8");

  it("图标登记表与代码**双向对账**（代码有而表里没 = 查不到出处；表里有而代码没 = 死图标）", () => {
    const code = iconNamesFromSource();
    const table = registeredIconNames(registry);
    // 下限 12：R115 时是 13 枚，R119 回收了没有落点的 `inbox`（见 R119 组的「只留一个信号」）
    expect(code.length, "没解析出任何图标名（解析器坏了？）").toBeGreaterThanOrEqual(12);
    const missing = code.filter((name) => !table.includes(name));
    expect(missing, `代码里用了但登记表没点名：${missing.join(" | ")}`).toEqual([]);
    const dead = table.filter((name) => !code.includes(name));
    expect(dead, `登记表点名了但代码里没有（死图标）：${dead.join(" | ")}`).toEqual([]);
  });

  it("状态族图标在界面上**真的有落点**（登记了却没人用 = 死图标）", () => {
    const files = tsxFiles(VIEW_ROOT).filter((f) => !f.endsWith("icons.tsx"));
    // R119 起只剩 `circle-x`：区块级空/错态由自绘插画承担状态表达 ⇒ `inbox` 没了落点，已回收
    for (const name of ["circle-x"]) {
      const hit = files.some((f) => readFileSync(f, "utf8").includes(`"${name}"`));
      expect(hit, `状态族图标 ${name} 在界面上一个落点都没有`).toBe(true);
    }
  });

  it("空状态必须走 StateNote（不许再写一句灰字打发了）", () => {
    for (const rel of ["views/AiView.tsx", "views/OutlineView.tsx"]) {
      const src = readFileSync(join(VIEW_ROOT, rel), "utf8");
      expect(src, `${rel} 还有裸的空状态灰字`).not.toMatch(/className="muted">\s*尚无/);
      expect(src, `${rel} 没用 StateNote`).toContain("StateNote");
    }
  });

  it("StateNote 是三段式：矢量图形 + 标题 + 说明；**不许内联 path**", () => {
    const src = readFileSync(join(VIEW_ROOT, "components", "StateNote.tsx"), "utf8");
    // R119：第三段之前是「图标」，现在改由自绘插画承担（R119 组另有专门一条锁钉住"不再挂图标"）
    expect(src).toContain("StateArt");
    expect(src).toContain("state-note-title");
    expect(src).toContain("state-note-text");
    expect(src, "状态提示组件里内联了 path（图标就有了第二套画法）").not.toContain("<path");
  });
});

/**
 * UI 重构第五批（R116）的机器判据：颜色令牌**两层化** + 默认色板**逐字不变**。
 *
 * 为什么要分层：换主题时只改 **primitive（调色板）** 一层，
 * semantic（用途：`--bg` / `--panel` / `--ink` / `--muted` / `--accent` / …）一个字都不用动。
 * 分层做歪了有两种典型坏法：① semantic 里又写起字面色值 ⇒ 两层形同虚设；
 * ② 顺手把色板改了 ⇒ "改版"变成了"重设计"。所以这两条都要钉住。
 *
 * 口径见 `docs/13-暗色主题口径.md`（R116 那轮只记口径、不动色板）。
 *
 * **R137 的补充**：默认色板后来**有据改过三处**（次要字 / 提示色 / 成功色）——
 * 逐页对比度体检量出它们低于 docs/13 §3 的 4.5 底线 ⇒ 调到过线。
 * 所以"一个像素都没动"这句话**不再是现状**，改成了两条更严的：
 * ① 当前值与**登记表**逐字一致（改之前先登记）；
 * ② 与历史基线的差异**只有登记在案的那三处**（不许悄悄多改，也不许登记了却没改）。
 */

/**
 * 默认色板的**历史基线**（R116 改版前的原值，逐字）：semantic → 当时的字面值。
 *
 * 这张表现在是**历史**，不是"当前值"：R137 的逐页对比度体检查出**默认档自己**
 * 违反 docs/13 §3 的 4.5 底线（次要文字 3.49:1、提示色 4.19:1、成功色 4.38:1），
 * 于是**有据**改了三处 ⇒ 当前值见 PALETTE_R137，理由见 PALETTE_CHANGES_R137。
 *
 * 为什么把历史表留着不删：它记着"当初一个像素都没动"这件事，也给"改了什么"留凭据。
 * 删掉它就等于把这段历史抹了（那样后来的人只会看到一张凭空改过的色板）。
 */
const PALETTE_BASELINE: Record<string, string> = {
  "--bg": "#f7f4ee",
  "--panel": "#fffdf8",
  "--panel-2": "#f2ece1",
  "--ink": "#2b2620",
  "--muted": "#8a8175",
  "--accent": "#8c5a2b",
  "--accent-soft": "#f0e2ce",
  "--border": "#e4dccf",
  "--good": "#2f7d4f",
  "--bad": "#b3402e",
  "--warn": "#a06a12",
  "--ink-on-accent": "#fff",
  "--bad-soft-bg": "#fbeae6",
  "--bad-soft-border": "#f0d4cd",
  "--bad-tint-bg": "#fdf0ee",
  "--good-soft-bg": "#e6f2e9",
  "--warn-soft-bg": "#fdf7e8",
  "--warn-tint-bg": "#fdf6e9",
  "--heat-l1": "#d9e8d4",
  "--heat-l2": "#a9cfa4",
  "--heat-l3": "#6faa74",
};

/**
 * 默认色板**当前**的登记值（R137 起）：semantic → 字面值。
 * 这一份是**逐字锁**：以后谁动色板，这张表会红，改之前必须先在这里登记并说清理由。
 */
const PALETTE_R137: Record<string, string> = {
  ...PALETTE_BASELINE,
  "--muted": "#675f55",
  "--good": "#2a7042",
  "--warn": "#8a570a",
  // R138：框定时"正在拖的那一块"的半透明朱（字面色值不许出现在 :root 之外 ⇒ 收进令牌）
  "--accent-veil": "rgba(140, 90, 43, 0.12)",
};

/**
 * R116 → R137 的**有据变更**逐条登记（不许悄悄多改一个色，也不许登记了却没改）。
 * 每条的理由都带**实测比值**，不是"看着更清楚"。
 */
const PALETTE_CHANGES_R137: Record<string, { from: string; to: string; why: string }> = {
  "--muted": {
    from: "#8a8175",
    to: "#675f55",
    why: "次要文字：纸底 3.49:1、朱底 3.01:1 ⇒ 低于 docs/13 §3 的 4.5（预演 step99 逐页实测）",
  },
  "--warn": {
    from: "#a06a12",
    to: "#8a570a",
    why: "提示色：纸底 4.19:1、凹陷底 3.91:1 ⇒ 低于 4.5",
  },
  "--good": {
    from: "#2f7d4f",
    to: "#2a7042",
    why: "成功色：在自己的浅底 #e6f2e9 上 4.38:1 ⇒ 低于 4.5",
  },
};

/** 取 :root 块里某个令牌的声明值 */
function rootToken(block: string, name: string): string | null {
  const m = new RegExp(`^\\s*${name.replace(/-/g, "\\-")}\\s*:\\s*([^;]+);`, "m").exec(block);
  return m ? (m[1] ?? "").trim() : null;
}

/** 默认 :root 块（不带属性选择器的那一块；密度档块是 :root[data-density=…]） */
function defaultRootBlock(): string {
  return /:root \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
}

/** 高对比媒体块的内容 */
function highContrastBlock(): string {
  const m = /@media \(prefers-contrast: more\) \{([\s\S]*?)\n\}/.exec(css);
  return m?.[1] ?? "";
}

describe("UI 重构第五批（R116）：颜色令牌两层化", () => {
  it("每个 semantic 颜色都**引用 primitive**，语义层里不许再写字面色值", () => {
    const root = defaultRootBlock();
    expect(root, "没解析出默认 :root 块").not.toBe("");
    const offenders: string[] = [];
    for (const name of Object.keys(PALETTE_BASELINE)) {
      const value = rootToken(root, name);
      expect(value, `默认 :root 里没有 ${name}`).not.toBeNull();
      if (value === null) continue;
      if (!/^var\(--c-[a-z0-9-]+\)$/.test(value)) offenders.push(`${name}=${value}`);
    }
    expect(offenders, `这些语义色没有引用 primitive：${offenders.join(" | ")}`).toEqual([]);
  });

  it("默认色板与 **R137 登记值逐字一致**（改色板要先改登记表并说清理由）", () => {
    const root = defaultRootBlock();
    const wrong: string[] = [];
    for (const [name, expected] of Object.entries(PALETTE_R137)) {
      const semantic = rootToken(root, name) ?? "";
      const ref = /^var\((--c-[a-z0-9-]+)\)$/.exec(semantic);
      if (ref === null) {
        wrong.push(`${name} 不是引用`);
        continue;
      }
      const primitive = rootToken(root, ref[1] as string);
      if (primitive !== expected) wrong.push(`${name}（${ref[1]}）= ${primitive ?? "(无)"} ≠ 登记值 ${expected}`);
    }
    expect(wrong, `色板与登记值不一致：${wrong.join(" | ")}`).toEqual([]);
  });

  it("R116 → R137 的差异**只有登记在案的那三处**（不许悄悄多改一个色，也不许登记了却没改）", () => {
    const root = defaultRootBlock();
    const problems: string[] = [];
    for (const [name, baseline] of Object.entries(PALETTE_BASELINE)) {
      const semantic = rootToken(root, name) ?? "";
      const ref = /^var\((--c-[a-z0-9-]+)\)$/.exec(semantic);
      if (ref === null) {
        problems.push(`${name} 不是引用`);
        continue;
      }
      const primitive = rootToken(root, ref[1] as string);
      const registered = PALETTE_CHANGES_R137[name];
      if (primitive !== baseline && registered === undefined) {
        problems.push(`${name} 从 ${baseline} 变成了 ${primitive ?? "(无)"}，但变更表里没有登记`);
      }
    }
    // 反向：登记了却没改 ⇒ 登记表是假的
    for (const [name, change] of Object.entries(PALETTE_CHANGES_R137)) {
      const semantic = rootToken(root, name) ?? "";
      const ref = /^var\((--c-[a-z0-9-]+)\)$/.exec(semantic);
      const primitive = ref === null ? null : rootToken(root, ref[1] as string);
      if (primitive !== change.to) {
        problems.push(`${name} 登记成 ${change.to}，实际是 ${primitive ?? "(无)"}`);
      }
      if (change.from !== PALETTE_BASELINE[name]) {
        problems.push(
          `${name} 变更表的起点（${change.from}）与历史基线（${PALETTE_BASELINE[name] ?? "(无)"}）不一致`,
        );
      }
    }
    expect(problems, `色板变更登记对不上：${problems.join(" | ")}`).toEqual([]);
  });

  it("高对比模式覆盖的是 **primitive** 一层（覆盖点集中在一处，semantic 自动跟着变）", () => {
    const block = highContrastBlock();
    expect(block, "没找到 prefers-contrast 块").not.toBe("");
    const semanticInBlock = Object.keys(PALETTE_BASELINE).filter((name) =>
      new RegExp(`^\\s*${name.replace(/-/g, "\\-")}\\s*:`, "m").test(block),
    );
    expect(semanticInBlock, `高对比块里覆盖了 semantic：${semanticInBlock.join(" | ")}`).toEqual([]);
    expect(block, "高对比块没有覆盖 primitive").toMatch(/--c-[a-z0-9-]+\s*:/);
  });

  it("暗色主题口径文档存在，且必备小节一个不许少（少一节就是口径被掏空）", () => {
    const doc = readFileSync(join(ROOT, "docs", "13-暗色主题口径.md"), "utf8");
    for (const heading of ["## 1. 令牌分两层", "## 2. 换暗底时**不能直接反相**的三样东西", "## 3. 对比度底线", "## 4. 与「高对比模式」的区别", "## 6. 本轮明确没做的"]) {
      expect(doc, `暗色主题口径缺小节：${heading}`).toContain(heading);
    }
    expect(doc).toContain("本轮只记口径，不动色板");
  });

  it("解析器自己能红：把语义色改回字面值，判据必须点名（防解析器坏了 ⇒ 零命中冒充全绿）", () => {
    const root = defaultRootBlock();
    expect(rootToken(root, "--bg")).toBe("var(--c-paper)");
    expect(rootToken(root, "--not-a-token")).toBeNull();
    expect(rootToken(root, "--ink-on-accent")).toBe("var(--c-on-accent)");
  });

  it("浮层进场**不能只靠 rAF**（窗口被遮挡 / 最小化时 rAF 会暂停 ⇒ 浮层永远不可见）", () => {
    // 预演 v266 实撞：两次 attempt 的终值 opacity 都是 0，根因是当时窗口被遮挡
    // （同一步的第 1 轮截图报 UnknownVizError），浏览器暂停了 rAF ⇒ is-entered 永远不加。
    // 作者把窗口放到后台再打开 @ 菜单，看到的就是一片空白。
    const src = readFileSync(join(VIEW_ROOT, "views", "ChapterEditorView.tsx"), "utf8");
    expect(src).toContain("requestAnimationFrame");
    expect(src, "浮层进场没有定时器兜底（窗口被遮挡时 rAF 暂停 ⇒ 浮层永远不进场）").toMatch(
      /setTimeout\(markEntered, MENTION_ENTER_FALLBACK_MS\)/,
    );
  });
});

/**
 * UI 重构第四批·第四段（R118）的机器判据：空状态 / 错误态的**插画**。
 *
 * 插画与图标是**分工**：图标（Lucide `inbox` / `circle-x`）说"这是哪一类状态"，
 * 插画（自绘的稿纸）说"这里将来会有什么"。插画是**自绘、没有上游**的，
 * 所以它登记的不是出处而是**画法口径**——并立一条锁：画法不许走样。
 */
describe("UI 重构第四批·第四段（R118）：空/错态插画", () => {
  const art = readFileSync(join(VIEW_ROOT, "components", "StateArt.tsx"), "utf8");

  it("插画画法与品牌标记同族：24×24 画布 / 2px 描边 / 不填色 / 单色 currentColor", () => {
    // **逐行核对**（不是整文件 contains）：注释里写着 `fill="none"` 时，
    // 整文件 contains 会让**注释冒充属性** ⇒ 把插画改成填色也照样绿（恒绿的锁比没锁更坏）。
    expect(art, "viewBox 不是 24×24").toMatch(/^\s*viewBox="0 0 24 24"\s*$/m);
    expect(art, "描边不是 2px").toMatch(/^\s*strokeWidth="2"\s*$/m);
    expect(art, "插画被填色了（线稿不该填色）").toMatch(/^\s*fill="none"\s*$/m);
    expect(art, "颜色不是 currentColor").toMatch(/^\s*stroke="currentColor"\s*$/m);
    // 插画是线稿 ⇒ 不许写死任何颜色
    expect(art, "插画里写死了颜色").not.toMatch(/#[0-9a-fA-F]{3,8}/);
    expect(art, "插画里写死了颜色").not.toMatch(/rgb\(/);
  });

  it("插画必须登记进 docs/12（自绘的也要写明「没有上游」）", () => {
    const doc = readFileSync(join(ROOT, "docs", "12-图标与插画来源登记.md"), "utf8");
    expect(doc, "登记表没提 StateArt.tsx").toContain("StateArt.tsx");
    expect(doc, "登记表没写「自绘插画」").toContain("自绘插画");
    expect(doc, "登记表没写「没有上游」").toContain("没有上游");
  });

  it("插画只在状态组件里出现（不许散落到各处各画一份）", () => {
    const holders = tsxFiles(VIEW_ROOT)
      .filter((f) => readFileSync(f, "utf8").includes("StateArt"))
      .map((f) => f.split("\\").pop() ?? "")
      .sort();
    // R119：错误条里的 16px 插画撤掉了（与图标重复表达）⇒ App.tsx 不再出现 StateArt
    expect(holders).toEqual(["StateArt.tsx", "StateNote.tsx"]);
  });
});

/**
 * UI 重构五批总复核（R119）：**每个地方只留一个信号** + 空态版式。
 *
 * 为什么要有它：R111–R118 每一轮都在**加**东西（动效别名、标题层级、图标登记、颜色两层、
 * 密度持久化、空态插画）。加的东西一多，就会开始**互相打架**——R119 的总复核抓到两处真问题：
 * ① 区块级空态里「插画」与「状态图标」表达的是**同一件事**（空 = 没东西，坏 = 坏了），
 *    而全局错误条里「16px 插画」与「14px 叉号圆」并排，同一个"错误"说了两遍；
 * ② 40px 的插画**孤悬在文案上方一行**，既不对齐也不成组，看着像随手放的小图。
 *
 * 判据要点：**先剥注释再核对**——否则注释里写着的同名字面量会冒充属性，
 * 这类锁会变成"恒绿"，比没锁更坏（项目里已经吃过三次这种亏）。
 */
/**
 * 世界地图（M5/T5-1，R120）的机器判据。
 *
 * 口径回源 `docs/research/K-软件工程与产品/K08-时间线与地图UI.md` §3：
 * ⑥ 地图 = 图片底图 + bounds（坐标是图片像素 / 归一化坐标，**不用经纬度**）；
 * ⑦ 标注即地点卡；⑨ 分层可控（**图层独立显隐**）。
 *
 * 判据要点：逐行/逐块核对（先剥注释），否则注释里的同名字面量会冒充属性——
 * 这类锁会变成"恒绿"，比没锁更坏。
 */
describe("世界地图（M5/T5-1，R120）：坐标空间 + 标注 + 图层显隐 + 点标注查卡", () => {
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const archive = readFileSync(join(VIEW_ROOT, "views", "ArchiveView.tsx"), "utf8");
  const ops = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "map-ops.ts"), "utf8");

  it("地图面板挂在世界观档案页（不挂 = 界面根本到不了这张图）", () => {
    // **只看 JSX 里的挂载**：只查"出现过 WorldMapPanel"是恒绿的——
    // import 那一行还在的话，把面板从页面里摘掉也照样绿（变异 M5 实测抓到的）。
    expect(archive).toMatch(/<WorldMapPanel[^>]*\/>/);
  });

  it("标注用归一化坐标落位（坐标空间那一层不许自己换算像素）", () => {
    expect(panel).toContain("marker.nx");
    expect(panel).toContain("marker.ny");
  });

  it("图层独立显隐在渲染层做（每层一枚开关，点了只切自己）", () => {
    expect(panel).toContain("map-layer-toggle");
    expect(panel, "图层的显隐过滤不见了").toContain("hidden.includes(marker.layer)");
  });

  it("点标注查地点卡（K08 §3.7：标注即地点卡）", () => {
    expect(panel).toContain("map-card-name");
    expect(panel, "地点卡读不出来（点标注只能看个名字）").toContain("card.read");
  });

  it("地图的**读**通道是只读的（渲染层不写盘）；写盘只有「底图登记」这一条（R135）", () => {
    // 逐行核对：**读**的那两个 ops（worldMapView / worldMapBase）里不许出现写盘调用
    const readOps = [
      /export async function worldMapView\(([\s\S]*?)\n}\n/.exec(ops)?.[0] ?? "",
      /export async function worldMapBase\(([\s\S]*?)\n}\n/.exec(ops)?.[0] ?? "",
    ].join("\n");
    expect(readOps, "没找到两个读通道").not.toBe("");
    for (const line of readOps.split("\n")) {
      expect(line, "地图的读通道里出现了写盘调用").not.toMatch(/card\.write|doc\.write|writeDoc|writeBinary/);
    }
    // 写盘**只有**「底图登记」这一条（作者把图放进去），而且它明确写盘
    expect(ops, "底图登记没有写盘").toMatch(/writeBinary\(/);
    expect(ops, "底图登记没有写 map.yaml").toMatch(/writeDoc\(MAP_PATH/);
  });
});


/**
 * 暗色主题（R121）的机器判据：**取值实测** + 只改 primitive 一层。
 *
 * 口径回源 `docs/13-暗色主题口径.md`：
 * §1 换主题**只改 primitive**（semantic 一个字都不动）；
 * §2 不能直接反相（纸/墨/朱各有各的底线）；
 * §3 对比度底线（正文与次要文字 ≥ 4.5:1；描边在深底上要比纸**更亮**）；
 * §4 与「高对比模式」不是一回事，不能互相顶掉。
 *
 * 判据要点：**对比度是从 CSS 里取真值现算的**，不是把口径文档里写的数字抄一遍——
 * 抄一遍的话，改了色值而忘了改文档，这道锁照样绿（恒绿的锁比没锁更坏）。
 */
describe("暗色主题（R121）：取值实测 + 只改 primitive 一层", () => {
  // R129 起，暗色底色**同时罩住两档**（`dark` 与 `dark-soft`）⇒ 解析时要认这个选择器列表
  const darkBlock = /:root\[data-theme="dark"\](?:,\s*:root\[data-theme="dark-soft"\])? \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const darkToken = (name: string): string | null => rootToken(darkBlock, name);
  const defaultAccent = rootToken(defaultRootBlock(), "--c-accent") ?? "";

  /** sRGB 相对亮度（WCAG 2.x） */
  function luminance(hex: string): number {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
    const f = (c: number): number => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  }

  /** 对比度比值 */
  function ratio(a: string, b: string): number {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  /** HLS 饱和度（朱色要"降饱和"，这条要可算） */
  function saturation(hex: string): number {
    const h = hex.replace("#", "");
    const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255) as [
      number,
      number,
      number,
    ];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return 0;
    return l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
  }

  it("暗色块存在，且**只覆盖 primitive**（semantic 一个字都不许动）", () => {
    expect(darkBlock, "没找到 :root[data-theme=\"dark\"] 块").not.toBe("");
    const semanticInBlock = Object.keys(PALETTE_BASELINE).filter((name) =>
      new RegExp(`^\\s*${name.replace(/-/g, "\\-")}\\s*:`, "m").test(darkBlock),
    );
    expect(semanticInBlock, `暗色块里覆盖了 semantic：${semanticInBlock.join(" | ")}`).toEqual([]);
    expect(darkBlock, "暗色块没有覆盖 primitive").toMatch(/--c-[a-z0-9-]+\s*:/);
  });

  it("对比度实测达标（从 CSS 真值现算，不是抄文档里的数字）", () => {
    const paper = darkToken("--c-paper") ?? "";
    const raised = darkToken("--c-paper-raised") ?? "";
    const ink = darkToken("--c-ink") ?? "";
    const muted = darkToken("--c-ink-soft") ?? "";
    const accent = darkToken("--c-accent") ?? "";
    const onAccent = darkToken("--c-on-accent") ?? "";
    const line = darkToken("--c-line") ?? "";
    const floors: Array<[string, string, string, number]> = [
      ["正文 ink on 底", ink, paper, 4.5],
      ["正文 ink on 面板", ink, raised, 4.5],
      ["次要 muted on 底", muted, paper, 4.5],
      ["朱 accent on 底（当文字用）", accent, paper, 4.5],
      ["朱底上的字 on-accent", onAccent, accent, 4.5],
    ];
    const bad: string[] = [];
    for (const [name, fg, bg, floor] of floors) {
      const value = ratio(fg, bg);
      if (!(value >= floor)) bad.push(`${name} = ${value.toFixed(2)}（底线 ${floor.toFixed(1)}）`);
    }
    expect(bad, `暗色下的对比度不达标：${bad.join(" | ")}`).toEqual([]);
    // 描边另有一条**相对**规则（docs/13 §3 只说"在深底上要比纸更亮"，没说绝对比值；
    // 浅色档自己的描边对底也才 1.25:1 ⇒ 拿 3:1 卡它是"拿一个更严的尺子量别人"）。
    // 真正的底线是：**暗色的描边不许比默认档更看不见**。
    const defaultLine = rootToken(defaultRootBlock(), "--c-line") ?? "";
    const defaultPaper = rootToken(defaultRootBlock(), "--c-paper") ?? "";
    const darkVisible = ratio(line, paper);
    const defaultVisible = ratio(defaultLine, defaultPaper);
    expect(
      darkVisible,
      `暗色描边对底 ${darkVisible.toFixed(2)} 比默认档的 ${defaultVisible.toFixed(2)} 更看不见`,
    ).toBeGreaterThanOrEqual(defaultVisible);
  });

  it("纸墨关系不许丢（不能直接反相：raised 亮于底、sunken 暗于底、墨不是纯白、底不是纯黑）", () => {
    const paper = darkToken("--c-paper") ?? "";
    const raised = darkToken("--c-paper-raised") ?? "";
    const sunken = darkToken("--c-paper-sunken") ?? "";
    const ink = darkToken("--c-ink") ?? "";
    const line = darkToken("--c-line") ?? "";
    expect(luminance(raised), "raised 要比底亮（层次全靠这个）").toBeGreaterThan(luminance(paper));
    expect(luminance(sunken), "sunken 要比底暗（凹陷感）").toBeLessThan(luminance(paper));
    expect(ink.toLowerCase(), "墨不能是纯白（深底上纯白刺眼）").not.toBe("#ffffff");
    expect(paper.toLowerCase(), "底不能是纯黑（那不是纸，是发光的屏幕）").not.toBe("#000000");
    expect(luminance(line), "描边要比纸更亮（深底上更深的描边等于看不见）").toBeGreaterThan(luminance(paper));
  });

  it("朱色**降饱和 + 提亮**（御书的朱是落款印，不是警示灯）", () => {
    const darkAccent = darkToken("--c-accent") ?? "";
    expect(saturation(darkAccent), "暗色朱色比默认档还饱和 ⇒ 要降饱和").toBeLessThan(
      saturation(defaultAccent),
    );
    expect(luminance(darkAccent), "暗色朱色要提亮（深底上原来的朱看不见）").toBeGreaterThan(
      luminance(defaultAccent),
    );
  });

  it("高对比在深色下**不被压掉**（另给一套，不是让深色色板赢）", () => {
    const block = highContrastBlock();
    const darkSub = /:root\[data-theme="dark"\] \{([\s\S]*?)\n\s*\}/.exec(block)?.[1] ?? "";
    expect(darkSub, "高对比块里没有深色档的一套（深色会把高对比顶掉）").not.toBe("");
    expect(darkSub, "深色档的高对比没有覆盖 primitive").toMatch(/--c-[a-z0-9-]+\s*:/);
  });

  it("主题档是**用户级偏好**（只决定用哪一套 primitive，不进项目真源）", () => {
    const app = readFileSync(join(VIEW_ROOT, "App.tsx"), "utf8");
    expect(app).toContain('dataset["theme"]');
    expect(app).toContain("saveThemePref");
    expect(app).toContain("loadThemePref");
    // 主题偏好不许写进项目真源通道
    expect(app, "主题偏好写进了项目真源").not.toMatch(/doc\.write\([^)]*theme/);
  });
});


/**
 * 标注的**错峰落位**与明暗逐页对照（R122）的机器判据。
 *
 * 为什么要有它：R121 把暗色色板落地了，但**只在预演那几页看过**——
 * `docs/13` §5 明写要「逐页截图对照」，不能只靠对比度数字自证。
 * 这一轮补上成对的对照步骤（浅色 / 深色，同一屏同一滚动位置），并把"错峰落位"这条动效钉住。
 *
 * 判据要点：动效这条最容易写坏——**错峰的延迟放在标注自己身上会连悬停的放大一起拖慢**
 * （反馈必须跟手，R111 的口径），所以它必须落在**只带 opacity 一条过渡的 wrapper** 上。
 */
describe("R122：标注错峰落位（动效）+ 明暗逐页对照", () => {
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const walk = readFileSync(new URL("../src/main/walkthrough.ts", import.meta.url), "utf8");

  it("错峰落在**只动 opacity 的 wrapper** 上（不碰 transform —— 那是悬停/选中的反馈）", () => {
    // 锚点收窄到"入场那条规则"：reduced-motion 块里也有一个 .map-marker-in
    // （只把延迟归零），不收窄的话这条判据量到的会是那一条。
    const block = /\.map-marker-in \{\n  opacity: 0;[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
    expect(block, "styles.css 里没有 .map-marker-in（错峰落位不在）").not.toBe("");
    expect(block, "错峰没有动 opacity").toContain("opacity");
    expect(block, "错峰不该动 transform（会和悬停反馈打架）").not.toContain("transform");
    expect(block, "错峰的延迟要按序号错开").toContain("calc(var(--i) * var(--motion-enter) / 4)");
    // 时长走**进场族**（--motion-enter），不是随手写个毫秒
    expect(block, "错峰的时长没走进场族").toContain("var(--motion-enter)");
  });

  it("系统要求减少动效时，错峰的**时长与延迟都归零**（只归零时长的话标注会一盏盏闪出来）", () => {
    const block = /@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(block, "没找到 prefers-reduced-motion 块").not.toBe("");
    // 只查"块里出现过 .map-marker-in"是**恒绿的**：独立的 `transition-delay: 0s` 规则
    // 里也有这个名字 ⇒ 把它从**时长归零的选择器列表**里摘掉也照样绿（变异 M3 实测抓到）。
    // 真正的要求是两条都在：**时长**归零（0.01ms）+ **延迟**归零（0s）。
    const selectorList = (block.split("transition-duration: 0.01ms")[0] ?? "");
    expect(selectorList, "减少动效时没把 .map-marker-in 的**时长**也归零（标注会一盏盏闪出来）").toContain(
      ".map-marker-in",
    );
    expect(block, "减少动效时错峰的延迟没归零").toContain("transition-delay: 0s");
  });

  it("面板确实用了 wrapper 与入场状态（不是只写了 CSS 没人用）", () => {
    expect(panel).toContain("map-marker-in");
    expect(panel).toContain("is-entered");
    expect(panel).toContain("requestAnimationFrame");
  });

  it("明暗对照是**成对**的（同一屏，浅色 + 深色各一张）", () => {
    expect(walk).toContain("step83-compare-light.png");
    expect(walk).toContain("step84-compare-dark.png");
  });
});


/**
 * 世界地图**底图**（R123）的机器判据。
 *
 * 口径回源 K08 §3.6：地图 = **图片底图 + bounds**——底图是作者自己放进项目的一张图，
 * 真源 `world/map.yaml` 的 `base_image` 记相对路径；坐标以图片像素 / 归一化坐标记录。
 * 地图登记**不设表单**（与其它真源 YAML 同一处置）⇒ 这一段只负责**读与画**。
 *
 * 三条纪律落在判据上：
 * ① 底图是**作者找的图，深浅不保证** ⇒ 底图上要压一层「地面色」，标注与网格才读得出来；
 *    而这层压暗必须跟着主题换（primitive 层）⇒ 暗色下压的是暗的地面。
 * ② 底图通道**只读**（路径防护走 gateway，K12 防路径穿越）。
 * ③ 地点卡的信息**逐行对齐**——一行用「·」串起来的长串，在窄栏里会断成三行，读起来像碎片。
 */
describe("世界地图底图（R123）：铺在坐标空间上 + 压暗层 + 卡片排版", () => {
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const ops = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "map-ops.ts"), "utf8");

  it("底图铺在坐标空间上（按 bounds 铺满，不拉伸变形）", () => {
    expect(panel, "面板没有画底图（<image>）").toMatch(/<image/);
    expect(panel, "底图没按 bounds 铺满").toContain("preserveAspectRatio=\"none\"");
    expect(panel, "底图的数据不是从通道来的").toContain("map.base()");
  });

  it("底图上要压一层地面色（作者找的图深浅不保证 ⇒ 标注与网格要读得出来）", () => {
    expect(panel, "没有压暗层").toContain("map-scrim");
    const scrim = /\.map-scrim \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(scrim, "压暗层没有引用 primitive（换主题时它不会跟着换）").toContain("var(--c-map-scrim)");
    // 暗色块里也必须覆盖这一层 ⇒ 暗色下压的是暗的地面
    // （R129 起暗色底色同时罩住 `dark` 与 `dark-soft` 两档 ⇒ 解析要认这个选择器列表）
    const dark = /:root\[data-theme="dark"\](?:,\s*:root\[data-theme="dark-soft"\])? \{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    expect(dark, "暗色块没覆盖压暗层").toContain("--c-map-scrim");
  });

  it("底图通道是**只读**的（不写盘，路径防护走 gateway）", () => {
    const base = /export async function worldMapBase\(([\s\S]*?)\n}\n/.exec(ops)?.[0] ?? "";
    expect(base, "没找到 worldMapBase").not.toBe("");
    for (const line of base.split("\n")) {
      expect(line, "底图通道里出现了写盘调用").not.toMatch(/writeDoc|doc\.write|card\.write|deleteDoc/);
    }
    expect(base, "底图没有走 gateway 的路径防护").toContain("readBinary");
  });

  it("地点卡的信息**逐行对齐**（不再用「·」串成一长串）", () => {
    // R126 起地点卡也走**共享**的键值行组件（SummaryRows）⇒ 键值行的样式只有一处
    expect(panel, "地点卡没有逐行对齐").toContain("<SummaryRows");
    expect(panel, "地点卡还在用「·」串信息").not.toMatch(/entityRef\} · /);
    // 旧类名不许留在组件里：CSS 已改名（.map-card-row → .summary-row），
    // 留着旧类名 = **那些行根本没有样式**（R126 差点就这么漏过去）
    expect(panel, "地点卡还在用旧的 .map-card-row 类名（CSS 已改名 ⇒ 这些行没有样式）").not.toContain("map-card-row");
  });
});


/**
 * 排版与动效（R124）的机器判据。
 *
 * 三条纪律（写进 docs/11 §7.3）：
 * ① **说明不许堆成一长串**：信息多于两三项就分行对齐；要结构化就**让载荷带结构**，
 *    别在界面里切字符串（切出来的"项"会丢掉句子里的限定词 ⇒ 意思变了还不自知）。
 * ② **窄容器用容器查询，不拿媒体查询猜**：面板在栅格里时宽度由**栅格**决定，不是视口宽度
 *    ⇒ 媒体查询一定会猜错（窄面板被挤成 175px 的窄柱）。
 * ③ **动效不许过渡会让每一帧都重排的属性**（width/height/top/left/right/bottom/margin/padding）：
 *    那些过渡每一帧都重排 ⇒ 掉帧。要动就用 opacity / transform（合成器就能做，不触发布局）。
 */
describe("排版与动效（R124）：说明分行 + 容器查询 + 不过渡布局属性", () => {
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const shared = readFileSync(join(ROOT, "apps", "desktop", "src", "shared", "ipc.ts"), "utf8");

  it("地图的摘要由**载荷带结构**，界面按行渲染（不是切一长串自由文本）", () => {
    expect(shared, "载荷里没有结构化摘要").toMatch(/summary:\s*\{\s*markers:/);
    // R126 起地图的汇总也改用**共享**的键值行组件（SummaryRows）⇒ 这里认组件名
    expect(panel, "面板没有把摘要排成行").toContain("<SummaryRows");
    expect(panel, "面板还在渲染一长串自由文本摘要").not.toContain("{map.note}</div>");
  });

  it("窄容器用**容器查询**换布局（面板在栅格里，宽度由栅格决定，媒体查询会猜错）", () => {
    expect(css, "地图面板没有当容器（container-type）").toMatch(/\.map-panel \{[^}]*container-type: inline-size/);
    expect(css, "没有按容器宽度的布局分支").toMatch(/@container \(max-width: \d+px\)/);
  });

  it("动效不许过渡**会让每一帧都重排的属性**（那些过渡每一帧都重排 ⇒ 掉帧）", () => {
    // 展开 / 收起的 grid-template-rows 是**唯一**登记的例外（内容增减，面板小，R111 刻意选的）
    const FORBIDDEN = ["width", "height", "top", "left", "right", "bottom", "margin", "padding"];
    // 登记的例外：两个进度条**刻意**用 width 过渡（宽度就是它们要表达的东西，
    // 且那两处时长本来就登记在时长例外清单里）⇒ 不算"过渡布局属性"。
    const ALLOWED = [".index-progress-bar", ".stats-progress-bar"];
    const offenders: string[] = [];
    for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const selector = (rule[1] ?? "").trim();
      const body = rule[2] ?? "";
      for (const block of body.matchAll(/transition:\s*([^;]+);/g)) {
        const decl = block[1] ?? "";
        // 过渡的写法是 `transition: <属性> <时长> <缓动>`（**属性后面没有冒号**）⇒
        // 按逗号分段取**首词**才是属性名。原先去找「属性:」⇒ 永远匹配不上 ⇒ 这条锁是恒绿的
        // （变异 M4 实测抓到：加了 `transition: width …` 它照样绿）。
        for (const part of decl.split(",")) {
          const prop = (part.trim().split(/\s+/)[0] ?? "").toLowerCase();
          if (!FORBIDDEN.includes(prop)) continue;
          if (ALLOWED.some((sel) => selector.includes(sel))) continue;
          offenders.push(`${selector} → ${decl.replace(/\s+/g, " ").trim()}`);
        }
      }
    }
    expect(offenders, `这些过渡会每一帧都重排（掉帧）：${offenders.join(" | ")}`).toEqual([]);
  });
});


/**
 * 页面列的容器选择器不许写成**后代**（R124 的重点修复）。
 *
 * 起因是用户截图：**记忆页"全是乱的"**——卡片互相压住、按钮浮在正文上、几段文字叠成一团。
 * 根因不是"设计没做好"，是 `.memory section { display:flex; flex-direction:column; min-height:0 }`
 * 这个**后代选择器**把右列里**嵌套的那个 <section>** 也套上了 ⇒ 它在 flex 列里被压缩、
 * 内容溢出自己、压住下面的卡片。**同一个写法在 5 个页面都有**。
 *
 * 为什么值得立锁：它**不会让任何门禁变红**——静态结构合法，坏的是"哪一条规则命中了谁"。
 * ⇒ 这条锁把"页面列必须是直接子级"写死，并把"卡片不许互相重叠"交给预演去量。
 */
describe("页面列的容器选择器不许写成后代（R124：卡片叠在一起的根因）", () => {
  it("页面列的子项不许被压到比内容还矮（压扁了内容就探出卡片、压住彼此）", () => {
    // `.panel { min-height: 0 }` 是 R110 为**档案页的 grid** 修的，但它是全局的 ⇒
    // 在 flex 列里它覆盖了 flex item 默认的 `min-height: auto`
    // （= 不许被压到比内容还矮）⇒ 面板被压扁 ⇒ 里面的内容探出卡片、压住下一个面板。
    // **先剥注释**再扫规则：注释里写着 `{ min-height: 0 }` 这种带花括号的片段时，
    // 规则正则会被切碎、扫出来的"规则"根本不是规则（判据就会恒绿 —— 实测踩过）。
    const bareCss = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const name of ["genesis", "outline", "ai", "memory", "export"]) {
      // 规则可能是**分组选择器**（几个页面共用一条）⇒ 不能用"选择器后面紧跟 {"的写法，
      // 要把选择器列表里含它的规则都找出来。
      const bodies = [...bareCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => (m[1] ?? "").includes(`${name} > section > *`))
        .map((m) => m[2] ?? "")
        .join(" ");
      expect(bodies, `${name} 页面列的子项没有「按内容撑高」这条（flex: none）`).toContain("flex: none");
    }
    // 左列同理：`.outline` / `.ai` / `.memory` / `.export` 的 aside 也是 flex 列
    for (const name of ["outline", "ai", "memory", "export"]) {
      const bodies = [...bareCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
        .filter((m) => (m[1] ?? "").includes(`${name} > aside > *`))
        .map((m) => m[2] ?? "")
        .join(" ");
      expect(bodies, `${name} 页面左列的子项没有「按内容撑高」这条（flex: none）`).toContain("flex: none");
    }
  });

  it("五个页面列的容器都只命中直接子级", () => {
    const offenders = [...css.matchAll(/^\.(genesis|outline|ai|memory|export) section \{/gm)].map(
      (m) => m[0],
    );
    expect(
      offenders,
      `这些后代选择器会把列里**嵌套的 section** 也套上 flex 列规则 ⇒ 内容溢出、压住彼此：${offenders.join(" | ")}`,
    ).toEqual([]);
    // 反过来也要看一眼：直接子级那条规则确实在
    for (const name of ["genesis", "outline", "ai", "memory", "export"]) {
      expect(css, `${name} 页面列没有「直接子级」规则`).toMatch(
        new RegExp(`^\\.${name} > section \\{`, "m"),
      );
    }
  });
});


/**
 * 面板汇总的**结构化**（R126）。
 *
 * 为什么要结构化：各面板的汇总原先都是**一长串自由文本**（"13 个实体 · 4 条引用行 → 1 条边；全图；…"），
 * 在窄栏里会折成三四行、读起来像碎片；更要紧的是——**切出来的"项"会丢掉句子里的限定词**
 * （"读到 3 个爽点 · 3 条承诺"切成两项后，前一项的"读到"就管不到后一项了）⇒
 * 结构**必须由后端给**（载荷带 `summary` 行），界面只排版。
 */
describe("面板汇总的结构化（R126）：后端给结构，界面只排版", () => {
  const graph = readFileSync(join(VIEW_ROOT, "components", "RelationGraphPanel.tsx"), "utf8");
  const graphOps = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "graph-ops.ts"), "utf8");
  const css = readFileSync(join(VIEW_ROOT, "styles.css"), "utf8");
  const rows = readFileSync(join(VIEW_ROOT, "components", "SummaryRows.tsx"), "utf8");

  it("图谱面板渲染的是**结构化行**，不是那串自由文本", () => {
    expect(graph, "图谱面板没有用共享的键值行组件").toContain("<SummaryRows");
    expect(graph, "图谱面板还在渲染自由文本汇总").not.toContain("graph-summary muted");
  });

  it("结构由**后端**给（不在界面里切字符串 —— 切出来的项会丢掉句子里的限定词）", () => {
    expect(graphOps, "图谱 ops 没有造结构化汇总").toContain("const summary = [");
    expect(graphOps, "结构化汇总里没有逐项的标签").toContain('label: "实体"');
    expect(graph, "界面里不该出现把 note 切开的写法").not.toMatch(/\.split\("[·；]"\)/);
  });

  it("孤立节点**列全**，不截断（原先只给前 8 个 + 省略号 ⇒ 作者看不到到底哪些没有关系）", () => {
    expect(graph, "孤立节点名单还在截断").not.toContain("slice(0, 8)");
    expect(graph, "孤立节点名单没有用可展开的组件").toContain("Disclosure");
    expect(graph, "可展开的名单没有逐个列出节点").toContain("graph-isolated-list");
  });

  it("标签列是**共享的一列**（每行各自定宽 ⇒ 值列左边界参差、标签被挤成两行）", () => {
    // 父级定列（auto = 宽度由清单里最宽的标签决定）+ 子行借用父级的列（subgrid）
    expect(css, "汇总容器没有定列").toMatch(/\.summary-rows \{[^}]*grid-template-columns:/);
    expect(css, "汇总行没有借用父级的列（subgrid）").toMatch(/\.summary-row \{[^}]*grid-template-columns: subgrid/);
    // 不许再出现"每行自己定死一个窄标签列"：
    // 「悬空引用」四个汉字塞不进 3em（37.5px）⇒ 标签折行、整行高度翻倍（R126 step89 抓到）
    expect(css, "标签列又变回每行各自定宽").not.toMatch(/\.summary-row \{[^}]*grid-template-columns: 3em/);
  });

  it("键值行的**类型只有一个来源**（后端载荷与界面组件各写一份 ⇒ 慢慢长歪）", () => {
    expect(rows, "组件自己又定义了一份 SummaryRow").not.toMatch(/export interface SummaryRow/);
    expect(rows, "组件没有用共享契约里的 SummaryRow").toContain("from \"../../../src/shared/ipc\"");
  });

  it("代码里不许再读那个**已经没了的** .graph-summary（那是自由文本汇总的类名）", () => {
    const walk = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "walkthrough.ts"), "utf8");
    expect(walk, "预演还在读 .graph-summary（R126 起汇总是结构化行）").not.toContain(".graph-summary");
    expect(graph, "图谱面板里还有 graph-summary").not.toContain("graph-summary");
    // 样式也不该留着没人用的 .graph-summary
    expect(css, "CSS 里还留着没人用的 .graph-summary").not.toMatch(/\.graph-summary\s*\{/);
  });
});

/**
 * 其余三个面板的汇总也结构化（R127）：爽点 / 编年史 / 伏笔。
 *
 * 口径与 R126 同一套：结构**由后端给**（载荷带 `summary` 行），界面用共享组件 `SummaryRows` 逐行渲染。
 * 伏笔那一处原先最严重：「读到 N 条伏笔；…；共 N 条 · 未回收 N · 已回收 N · …」一长串。
 */
describe("其余三个面板的汇总也结构化（R127）：爽点 / 编年史 / 伏笔", () => {
  const satisfaction = readFileSync(join(VIEW_ROOT, "components", "SatisfactionPanel.tsx"), "utf8");
  const chronology = readFileSync(join(VIEW_ROOT, "components", "ChronologyPanel.tsx"), "utf8");
  const archive = readFileSync(join(VIEW_ROOT, "views", "ArchiveView.tsx"), "utf8");
  const satOps = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "satisfaction-ops.ts"), "utf8");
  const chrOps = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "chronicle-ops.ts"), "utf8");
  const fsOps = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "foreshadow-ops.ts"), "utf8");

  it("三个面板都走**共享的键值行组件**（不许各写各的键值行样式）", () => {
    // 认 **JSX 用法**（`<SummaryRows`）而不是组件名：`import { SummaryRows } …` 这一行
    // 也含 "SummaryRows" ⇒ 只认名字的话，这判据在"面板早就不用了"时照样是绿的（恒绿判据）
    expect(satisfaction, "爽点面板没有用共享组件").toContain("<SummaryRows");
    expect(chronology, "编年史面板没有用共享组件").toContain("<SummaryRows");
    expect(archive, "伏笔看板没有用共享组件").toContain("<SummaryRows");
  });

  it("结构由**后端**给（三个 ops 都造 summary 行；界面里不许切字符串）", () => {
    // 认**具体那一行**（`{ label: "…" }`），不认 "summary: [" ——
    // 后者会被 `summary: []`（空数组）满足 ⇒ 判据恒绿（实测：把行删光它照样绿）
    expect(satOps, "爽点 ops 没有造结构化汇总").toContain('{ label: "爽点"');
    expect(chrOps, "编年史 ops 没有造结构化汇总").toContain('{ label: "事件"');
    expect(fsOps, "伏笔 ops 没有造结构化汇总").toContain('{ label: "伏笔"');
    for (const [name, src] of [["爽点", satisfaction], ["编年史", chronology], ["伏笔", archive]] as const) {
      expect(src, name + "面板在界面里切字符串了").not.toMatch(/\.split\("[·；]"\)/);
    }
  });

  it("伏笔那串「共 N 条 · 未回收 N · 已回收 N · …」不许再出现在界面里", () => {
    expect(archive, "伏笔汇总还在拼那串自由文本").not.toContain("未回收 {board.stats.open}");
    expect(archive, "伏笔汇总还在拼那串自由文本").not.toContain("共 {board.stats.total} 条");
    // 后端那串 note 仍在（它是"没有台账/读不了"时的解释），但界面不再拿它当汇总
    expect(fsOps, "伏笔 ops 不该丢掉给作者看的解释").toContain("note:");
  });
});

/**
 * 时间线面板的汇总也结构化（R128）：**最后一个还在用自由文本的面板**。
 *
 * 到这一轮为止，「世界观档案」页上五个带汇总的面板（图谱 / 爽点 / 编年史 / 伏笔 / 时间线）
 * 全部走共享组件 `SummaryRows`，结构全部由后端给。
 */
describe("时间线面板的汇总也结构化（R128）：最后一个还在用自由文本的面板", () => {
  const archive = readFileSync(join(VIEW_ROOT, "views", "ArchiveView.tsx"), "utf8");
  const ops = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "timeline-ops.ts"), "utf8");

  it("时间线面板走共享组件，且后端造结构化行", () => {
    expect(archive, "时间线面板没有用共享组件").toContain("<SummaryRows");
    expect(ops, "时间线 ops 没有造结构化汇总").toContain('{ label: "事件"');
  });

  it("时间线面板不再自己拼那句自由文本（连「当前显示按…」也是后端给的行）", () => {
    // 认**"当前显示按"这几个字**（而不是带插值的长串）：修好之后那串长文本本来就不在了 ⇒
    // 拿长串当判据 = 恒绿（变异动不到它）——实测踩过
    expect(archive, "时间线汇总还在自己拼历法那句").not.toContain("当前显示按");
    expect(ops, "后端没有给「当前显示」那一行").toContain('{ label: "当前显示"');
  });
});

/**
 * 深色·柔和高对比这一档（R129）：docs/13 §6 明写没做的那条。
 *
 * 系统「高对比度」在深色下是**纯黑底 + 纯白字**（把对比拉到两头），夜里看久了晃眼；
 * 这一档**按纸墨底调**：底还是那张暗纸、字是暖白、描边加重 ⇒ 依然是高对比，但不刺眼。
 */
describe("深色·柔和高对比这一档（R129）：docs/13 §6 那条明写没做的", () => {
  const prefs = readFileSync(join(VIEW_ROOT, "theme-prefs.ts"), "utf8");
  const css = readFileSync(join(VIEW_ROOT, "styles.css"), "utf8");

  /**
   * 把 CSS 拆成（选择器, 块体）——**按选择器找块**，不靠正则碰运气。
   *
   * 为什么不能直接正则：暗色底色是**选择器列表**（`dark` 与 `dark-soft` 共用），
   * 那个列表的第二行**也是** `:root[data-theme="dark-soft"] {` ⇒
   * 拿 `/:root\[data-theme="dark-soft"\] \{([^}]*)\}/` 去取，**取到的是暗色底色那块**
   * ⇒ 判据指错了地方（实测：把柔和高对比那块删掉，它照样绿）。
   */
  const cssBlocks = (): { selector: string; body: string }[] => {
    // **先剥注释**（注释会混进"选择器"那一段 ⇒ 块就认不出来了）
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const out: { selector: string; body: string }[] = [];
    for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({ selector: (m[1] ?? "").trim(), body: m[2] ?? "" });
    }
    return out;
  };
  /** 柔和高对比**自己那块**（选择器恰好等于它，不是选择器列表里的第二行） */
  const softBlock = (): string | null => {
    const hit = cssBlocks().find(
      (b) => b.selector.replace(/\s+/g, " ") === ':root[data-theme="dark-soft"]',
    );
    return hit === undefined ? null : hit.body;
  };
  /** 同时罩住 dark 与 dark-soft 的那块（暗色底色） */
  const sharedDarkBlock = (): string | null => {
    const hit = cssBlocks().find(
      (b) =>
        b.selector.includes(':root[data-theme="dark"]') &&
        b.selector.includes(':root[data-theme="dark-soft"]'),
    );
    return hit === undefined ? null : hit.body;
  };

  it("第三档进了主题白名单（id 与 `data-theme` 的取值一致）", () => {
    expect(prefs, "主题档里没有第三档").toContain('{ id: "dark-soft"');
    expect(prefs, "第三档没有界面文案").toMatch(/id: "dark-soft", label: "深色·柔和高对比"/);
  });

  it("CSS 里有这一档自己的色板块，且**暗色底色同时罩住两档**", () => {
    expect(softBlock(), "没有找到柔和高对比自己的色板块").not.toBeNull();
    expect(sharedDarkBlock(), "暗色底色没有同时罩住 dark-soft").not.toBeNull();
  });

  it("只动 primitive 一层（semantic 一个字没动）", () => {
    const block = softBlock();
    expect(block, "没有找到柔和高对比自己的色板块").not.toBeNull();
    const vars = (block ?? "").match(/--[a-z0-9-]+\s*:/g) ?? [];
    const notPrimitive = vars.filter((v) => !v.startsWith("--c-"));
    expect(notPrimitive, "dark-soft 块里出现了非 primitive 变量").toEqual([]);
  });
});

/**
 * 机器跑法**不许打扰作者的桌面**（R130）。
 *
 * 作者反馈：每次预演都把窗口压在桌面上、强制置顶、抢焦点，打游戏时会把游戏顶掉。
 * 根因是预演里那句 `win.setAlwaysOnTop(true); win.moveTop();`（当时的理由是"预演期间窗口
 * 本来就该是屏幕上唯一被看的东西"）⇒ 那是**拿别人的桌面当测试台**。
 *
 * 现在的口径：**机器跑法走离屏渲染（offscreen）、永不显示** ⇒ 桌面上没有窗口；
 * 离屏渲染没有"被遮挡就不出帧"的问题（探针实测：中间态 12 帧、截图非空、visibility=visible）。
 */
describe("机器跑法不许打扰作者的桌面（R130）", () => {
  const main = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "main.ts"), "utf8");
  const walk = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "walkthrough.ts"), "utf8");
  /** 剥注释（块注释 + 行注释）——注释里提过这些 API，不许冒充"还在用" */
  const strip = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("机器跑法走**离屏渲染**且**永不显示**（作者桌面上没有窗口）", () => {
    expect(main, "机器跑法没有走离屏渲染").toContain("offscreen: true");
    expect(main, "机器跑法的窗口没有设为不显示").toMatch(/show: !automation/);
    // 真正的应用启动**照旧显示窗口**（离屏只给机器跑法用）
    expect(main, "正常启动被改成不显示了").toMatch(/\n {2}createWindow\(\);/);
  });

  it("预演循环里不许再**强制置顶 / 抢顶层**（那正是压住作者桌面的元凶）", () => {
    const bare = strip(walk);
    // 认**调用**（`.moveTop(` / `.setAlwaysOnTop(`），不认裸词——
    // 裸词会撞上别的标识符（实测：`moveTop` 命中的是同名片段）⇒ 判据指错了地方
    expect(bare, "预演又强制置顶了").not.toMatch(/\.setAlwaysOnTop\(/);
    expect(bare, "预演又把窗口提到最前了").not.toMatch(/\.moveTop\(/);
  });

  it("不许再靠**透明 / 鼠标穿透 / 不可聚焦**那一套（页面自己画着不透明底 ⇒ 照样压屏；而且窗口会变成点不掉、关不掉）", () => {
    const bare = strip(main);
    expect(bare, "机器跑法还在用透明窗口（页面底色不透明 ⇒ 照样看得见）").not.toContain("transparent: automation");
    expect(bare, "机器跑法还在鼠标穿透（作者的点击会被吃掉）").not.toContain("setIgnoreMouseEvents");
    expect(bare, "机器跑法还在禁用聚焦（窗口变成关不掉）").not.toContain("setFocusable(false)");
  });

  it("每个机器跑法都要用**离屏窗口**（预演 / e2e / trial / perf / 杀进程实测）", () => {
    const count = (main.match(/createWindow\(\{ automation: true \}\)/g) ?? []).length;
    expect(count, "机器跑法里还有没走离屏窗口的").toBeGreaterThanOrEqual(5);
  });
});

/**
 * 事件锚点（R131；口径回源 K08 §3.8「事件挂坐标 ⇒ 时空联动」）。
 *
 * 与标注的差别：标注绑**地点实体**（点开是地点卡），锚点绑**事件**（选事件能定位到地图上）。
 */
describe("事件锚点（R131）：K08 §3.8 的事件挂坐标", () => {
  const engine = readFileSync(join(ROOT, "packages", "@yushu", "world-engine", "src", "world-map.ts"), "utf8");
  const ops = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "map-ops.ts"), "utf8");
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const shared = readFileSync(join(ROOT, "apps", "desktop", "src", "shared", "ipc.ts"), "utf8");
  const css = readFileSync(join(VIEW_ROOT, "styles.css"), "utf8");

  it("真源支持 `event_anchors`，且**严格解析**（未知键 / 同一个事件两个锚点 一律点名）", () => {
    // 认**允许键列表**里的那一个名字，不是"文件里出现过 event_anchors 这几个字"——
    // 后者会把"解析循环里还留着、但允许键没了"当成有支持（实测：那样判据是绿的）
    expect(engine, "真源的允许键列表里没有 event_anchors").toMatch(/\[\s*"apiVersion"[^\]]*"event_anchors"/);
    expect(engine, "照 K08 抄的未知键没有被点名").toContain("有未知键");
    expect(engine, "同一个事件两个锚点没有拒绝").toContain("事件锚点重复");
  });

  it("载荷带锚点，界面画出来、也列出来（作者要知道哪个事件钉在地图哪一点）", () => {
    expect(shared, "载荷里没有锚点字段").toMatch(/anchors: \{/);
    expect(ops, "ops 没有把锚点传出去").toContain("anchors: projection.anchors.map");
    // 认**真的遍历了锚点**（`map.anchors.map(`），不认类名——类名留着、遍历没了，锚点照样画不出来
    expect(panel, "地图面板没有遍历锚点").toMatch(/map\.anchors\.map\(/);
    // 还要认**画布上那处**（条件表达式里的类名）：名单与画布是两处，只有一处被删掉时上面那条仍会绿
    expect(panel, "地图面板没有在画布上画锚点").toMatch(/className=\{\s*"map-anchor"\s*\+/);
    expect(panel, "地图面板没有列锚点").toContain("map-anchors");
  });

  it("锚点的**形状**与地点标注区分开（形状优先于颜色：空心环 vs 实心）", () => {
    expect(css, "锚点没有独立的样式").toMatch(/\.map-anchor circle \{[^}]*fill: none/);
    expect(panel, "锚点没有独立的中心点").toContain("map-anchor-core");
  });
});

/**
 * 时空联动（R132；K08 §3.8 后半句：选事件定位地图锚点 / 点 marker 跳到时间轴对应事件）。
 *
 * 两个方向靠**同一个事件 id**串起来 ⇒ 判据也要盯住"同一个 id"这件事，
 * 而不是"两处都高亮了"（两处高亮的是不同事件，联动照样是坏的）。
 */
describe("时空联动（R132）：锚点 ↔ 时间线双向定位", () => {
  const archive = readFileSync(join(VIEW_ROOT, "views", "ArchiveView.tsx"), "utf8");
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const css = readFileSync(join(VIEW_ROOT, "styles.css"), "utf8");

  it("地图面板把锚点**上报**并接受「被选中的事件」（父组件据此联动）", () => {
    expect(panel, "地图面板没有上报锚点").toContain("onAnchors");
    expect(panel, "地图面板没有接受被选中的事件").toContain("linkedEvent");
    // R141：锚点的 onClick 变成了一整块（先看"刚拖过就不算数"，再跳时间线）⇒ 锁认**里面那一下**
    expect(panel, "锚点不可点（点它去不了时间线）").toMatch(
      /onClick=\{\(\) => \{[\s\S]{0,240}pickAnchor\(anchor\.eventRef\)/,
    );
  });

  it("时间线那边给「地图上有锚点」的入口，并按**同一个事件 id**高亮", () => {
    expect(archive, "时间线没有「地图上有锚点」的入口").toContain("timeline-map-link");
    expect(archive, "时间线没有按事件 id 找锚点").toMatch(/mapAnchors\.find\(\(item\) => item\.eventRef === row\.id\)/);
    // **一个**事件 id 贯穿两头（两套状态会对不上 ⇒ 联动看起来像坏了）
    expect(archive, "联动用了不止一个状态").toContain("linkedEvent");
    expect(archive, "地图与时间线没有接上").toContain("linkedEvent={linkedEvent}");
  });

  it("被选中的那一行 / 那个锚点**看得见**（跨面板的高亮得够显眼）", () => {
    // 判据要认**高亮与普通行不是同一个底色**——只认"规则存在"的话，
    // 把高亮写成和普通行一样的底色它照样绿（实测：这就是恒绿）
    expect(css, "时间线那一行没有高亮样式").toMatch(
      /\.timeline-table tr\.is-linked td \{[^}]*background: var\(--panel-2\)/,
    );
    expect(css, "锚点没有高亮样式").toMatch(/\.map-anchor\.is-linked circle \{/);
  });
});

/**
 * 地点方向的联动（R133；K08 §3.8「点 marker 跳到时间轴对应事件」）。
 *
 * 前提是**事件能引用地点实体**（K08 的 `place_ref`）——
 * 时间线原先的 `location` 是**自由文本**（写给人看的地名）⇒ 与地图标注对不上号。
 */
describe("地点方向的联动（R133）：事件能引用地点实体（place_ref）", () => {
  const engine = readFileSync(join(ROOT, "packages", "@yushu", "world-engine", "src", "timeline.ts"), "utf8");
  const archive = readFileSync(join(VIEW_ROOT, "views", "ArchiveView.tsx"), "utf8");
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const shared = readFileSync(join(ROOT, "apps", "desktop", "src", "shared", "ipc.ts"), "utf8");

  it("时间线事件能引用**地点实体**（`place_ref`；严格解析 + 投影 + 序列化）", () => {
    // 认**允许键列表**里的那一个名字，不是"文件里出现过 place_ref 这几个字"——
    // 后者会把"解析循环里还留着、但允许键没了"当成有支持（实测：那样判据是绿的）
    expect(engine, "真源的允许键列表里没有 place_ref").toMatch(/\["id"[^\]]*"place_ref"/);
    expect(engine, "投影里没有带出 placeRef").toMatch(/placeRef: event\.placeRef \?\? null/);
    expect(shared, "载荷里没有 placeRef").toContain("placeRef");
  });

  it("地图把**地点实体清单**上报，界面据此判断「这个地点在地图上」", () => {
    // 认**真的调用**（`props.onPlaces(...)`），不认 prop 名——prop 名留着、调用没了，界面照样瞎
    expect(panel, "地图面板没有上报地点清单").toMatch(/props\.onPlaces\(\[\.\.\.new Set\(map\.markers/);
    expect(panel, "地图面板没有上报点了哪个标注").toMatch(/props\.onMarkerPick\(marker\.entityRef/);
    expect(archive, "时间线没有用地点清单").toContain("mapPlaces");
    // 认**那个按钮**（onClick + 文案），不认文案本身——文案留着、按钮没了，入口就没了
    expect(archive, "时间线没有「这个地点在地图上」的入口").toMatch(
      /onClick=\{\(\) => jumpToPlace\(placeRef \?\? ""\)\}[\s\S]{0,80}这个地点在地图上/,
    );
  });

  it("点标注 ⇒ 地图面板**旁边**说清这个地点在时间线上有哪几条（不把页面滚走）", () => {
    // 认**那整块**（条件 + 类名），不认类名——类名留着、条件改成 false，作者就什么也看不到
    expect(archive, "点标注后没有说清地点与事件的关系").toMatch(
      /\{pickedPlace !== null && placeEvents\.length > 0 && \([\s\S]{0,80}map-place-events/,
    );
    expect(archive, "没有把地点与事件的关联算出来").toContain("placeEvents");
  });
});

/**
 * 底图登记（R135）：**作者的入口**——挑一张图 ⇒ 拷进项目 ⇒ **边界按量出来的尺寸自动填**。
 *
 * 口径回源 K08 §5「地图编辑器：上传底图 → 框定 bounds → …」的第一段。
 * 为什么值得做：作者手填 `bounds` 填不对是常态（`map-bounds-missing` 那条诊断码就是这么来的）。
 */
describe("底图登记（R135）：作者的入口 + 写盘纪律", () => {
  const ops = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "map-ops.ts"), "utf8");
  const ipc = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "ipc.ts"), "utf8");
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const engine = readFileSync(join(ROOT, "packages", "@yushu", "world-engine", "src", "world-map.ts"), "utf8");

  it("这条通道是**写通道**（写完索引要刷、上一轮结论要置脏）", () => {
    expect(ipc, "底图登记没有走 wrapWrite").toMatch(/CHANNELS\.worldMapUploadBase[\s\S]{0,200}wrapWrite/);
  });

  it("**路径不出主进程**（原生对话框在主进程开；渲染层只拿项目内的相对路径与尺寸）", () => {
    expect(ipc, "原生对话框不在主进程开").toContain("dialog.showOpenDialog");
    expect(panel, "渲染层自己接触了本地路径").not.toContain("filePaths");
  });

  it("边界**按量出来的尺寸**填（作者手填边界填不对是常态 ⇒ 让工具量）", () => {
    expect(ops, "bounds 不是按量出来的尺寸填的").toMatch(
      /bounds: \[\[0, 0\], \[\$\{size\.width\}, \$\{size\.height\}\]\]/,
    );
    expect(engine, "引擎没有「追加那三行」的那个函数").toContain("appendMapBase");
  });

  it("地图面板给作者一个**按钮**（不是只读面板里加一句说明）", () => {
    expect(panel, "地图面板没有登记底图的调用").toContain("map.uploadBase(");
    // 认**按钮的绑定**（`onClick` 真的调了登记）——只认"文件里出现过这个调用"的话，
    // 按钮没了、调用还留在函数里，它照样绿（实测）
    expect(panel, "登记底图的按钮没有绑上").toMatch(/onClick=\{\(\) => void uploadBase\(\)\}/);
    // 认**完整的类名**（`className="map-upload-btn"`）——`toContain("map-upload-btn")`
    // 会被 `map-upload-btn-x` 满足（实测：改名后它照样绿）
    expect(panel, "地图面板没有那个按钮").toMatch(/className="map-upload-btn"/);
  });

  it("**换**底图与**第一次登记**走的是同一个入口（按钮按有没有登记过给不同的模式）", () => {
    // 模式由**有没有登记过**决定（不是两个按钮）：作者点"换底图"就是换
    expect(panel, "没有按有没有登记过区分模式").toMatch(/mode: hasBase \? "replace" : "register"/);
    // 换之前的那三行要给作者看（他要换回去就贴回去）
    expect(panel, "换之前的三行没给作者看").toContain("uploadPrevious");
  });
});

/**
 * 框定边界（R138）：作者在底图上**拖出**地图在图里的哪一块。
 *
 * 口径回源 K08 §3.6「地图 = 图片底图 + bounds → 用户上传底图并**框定 bounds**」。
 *
 * 这一轮是**模型翻转**：bounds 从"整张图"变成"图里的一块"⇒
 * 画布 = 框、底图按框裁切、框定模式画整张图。
 *
 * 判据认**具体的形状**（哪一行算裁切、哪个键是回车、哪个角色被撤掉），
 * 不是"文件里出现过框定两个字"——后者会随改名一起失效。
 */
describe("框定边界（R138）：拖一块 ⇒ 只改 bounds 那一行 ⇒ 画布按它裁切", () => {
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const ipc = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "ipc.ts"), "utf8");
  const ops = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "map-ops.ts"), "utf8");
  const engine = readFileSync(join(ROOT, "packages", "@yushu", "world-engine", "src", "world-map.ts"), "utf8");

  it("地图面板给作者一个**框定边界**的入口（按钮真的绑在拖框上）", () => {
    expect(panel, "面板里没有「框定边界」这个入口").toContain("框定边界");
    expect(panel, "框定按钮没有绑上").toMatch(/onClick=\{toggleFraming\}/);
    // 真的写盘：调的是 map.setBounds（不是只画个框给他看）
    expect(panel, "没有调用 map.setBounds").toContain("map.setBounds(");
  });

  it("画布 = **框定的那一块**，底图按它**裁切**（往左挪 -x0）", () => {
    expect(panel, "画布没有按 bounds 那一块算").toMatch(
      /frameW = frame === null \? canvas\.width : frame\.x1 - frame\.x0/,
    );
    expect(panel, "底图没有按框裁切").toMatch(/const imageX = framing \? 0 : -\(frame\?\.x0 \?\? 0\)/);
  });

  it("框定模式画的是**整张图**（否则作者在已裁切的画面上拖，永远框不到图外）", () => {
    expect(panel, "框定模式没有画整张图").toMatch(/const width = framing \? baseW :/);
  });

  it("**键盘也能框**（方向键移动、+ / - 改大小、回车定下来）——拖拽不是唯一的路", () => {
    expect(panel, "没有方向键移动").toContain("ArrowLeft");
    expect(panel, "没有回车定下来").toMatch(/event\.key === "Enter"/);
    // R145：画布**恒可聚焦**（缩放/平移的键盘路 + / - / 方向键 / 0 挂在这里）⇒ 不再只在框定模式里
    const canvasTags = panel.match(/<svg[\s\S]*?>/g) ?? [];
    const canvasTag = canvasTags.find((tag) => tag.indexOf("map-svg") >= 0) ?? "";
    expect(canvasTag, "没找到画布那个 <svg> 标签").not.toBe("");
    expect(canvasTag, "画布不可聚焦（缩放与平移就没有键盘路）").toContain("tabIndex={0}");
  });

  it("框定模式里标注与锚点**不可点**（那一下是拖框，不是开卡）", () => {
    // 框定模式是**单独一支**（没有 onClick ⇒ 不构成键盘债，也不跟拖框抢那一下）
    const framingBranch = /\{framing \? \(([\s\S]*?)\) : \(/.exec(panel)?.[1] ?? "";
    expect(framingBranch, "面板里没有框定模式那一支").not.toBe("");
    expect(framingBranch, "框定模式里标注仍然可点（那一下应该是拖框）").not.toContain("onClick");
    expect(framingBranch, "框定模式那一支没有标出来").toContain("map-frame-points");
  });

  it("写盘走 **wrapWrite**（真源写 ⇒ 索引要刷、上一轮结论要置脏）", () => {
    expect(ipc, "框定边界没有走 wrapWrite").toMatch(/CHANNELS\.worldMapSetBounds[\s\S]{0,200}wrapWrite/);
  });

  it("主进程**只改 bounds 那一行**，写盘带 baseHash（作者在别处改过 ⇒ 报冲突不覆盖）", () => {
    expect(ops, "没有只改那一行的替换").toContain("/^bounds[^\\r\\n]*/m");
    expect(ops, "写盘没带 baseHash").toMatch(/writeDoc\(MAP_PATH, content, snapshot\.hash\)/);
  });

  it("引擎不再要求 bounds 与底图**等大**（作者框一块是正式功能，不是尺寸写错）", () => {
    expect(engine, "引擎还在要求尺寸相等").not.toMatch(/width !== def\.baseSize\.width/);
    expect(engine, "引擎没有「范围必须落在底图里」这条判定").toContain("bounds.x1 > def.baseSize.width");
  });
});

/**
 * 挪标注（R139）：作者在图上把标注**拖到新位置**。
 *
 * 口径回源 K08 §5「地图编辑器：上传底图 → 框定 bounds → **放 marker**、区域、行程线 → 绑定实体」——
 * R135 做了「上传底图」、R138 做了「框定 bounds」，这一轮接上「放 marker」的第一步。
 *
 * 判据认**具体的形状**（哪个事件绑在哪、哪个键是方向键、哪条通道走 wrapWrite），
 * 不是"文件里出现过挪标注三个字"。
 */
describe("挪标注（R139）：拖到新位置 ⇒ 只改那一个标注的 x / y", () => {
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const ipc = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "ipc.ts"), "utf8");
  const ops = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "map-ops.ts"), "utf8");
  const engine = readFileSync(join(ROOT, "packages", "@yushu", "world-engine", "src", "world-map.ts"), "utf8");

  it("地图面板的标注**可拖**（真的调 map.setMarker，不是只画个预览）", () => {
    expect(panel, "面板里没有调 map.setMarker").toContain("map.setMarker(");
    expect(panel, "标注没有绑上拖拽的开始").toMatch(
      /onPointerDown=\{\(event\) => onItemPointerDown\(event, "marker", marker\.id\)\}/,
    );
    expect(panel, "标注没有绑上拖拽的结束").toMatch(
      /onPointerUp=\{\(event\) => onItemPointerUp\(event, "marker", marker\.id\)\}/,
    );
  });

  it("**键盘也能挪**（方向键微调）——拖拽不是唯一的路", () => {
    // 认**标注那一份**的方向键处理（不是框定模式里的那份）
    expect(panel, "标注没有方向键微调").toMatch(/event\.key === "ArrowLeft"\) dx = -step/);
    expect(panel, "标注的方向键没有写盘").toMatch(/moveMarker\(marker\.id, marker\.x \+ dx, marker\.y \+ dy\)/);
  });

  it("写盘走 **wrapWrite**（真源写 ⇒ 索引要刷、上一轮结论要置脏）", () => {
    expect(ipc, "挪标注没有走 wrapWrite").toMatch(/CHANNELS\.worldMapSetMarker[\s\S]{0,200}wrapWrite/);
  });

  it("主进程**只改那一个标注**（别的标注、底图、bounds、注释原样留着）", () => {
    expect(ops, "没有按标注 id 改那一行").toContain(
      "setMapMarkerPosition(snapshot.content, request.markerId, { x, y })",
    );
    expect(ops, "写盘没带 baseHash").toMatch(/writeDoc\(MAP_PATH, moved\.content, snapshot\.hash\)/);
  });

  it("引擎的挪标注**只改那一行**（不是解析→改对象→重新序列化）", () => {
    expect(engine, "引擎里没有挪标注这个函数").toContain("export function setMapMarkerPosition");
    // 逐行改写，而不是整份重排（`lines[index] = next` 是证据）
    expect(engine, "引擎不是逐行改写").toMatch(/lines\[index\] = next/);
  });
});

/**
 * 放标注（R140）：作者选一个**地点实体** ⇒ 在图上点一下 ⇒ 落一个标注。
 *
 * 口径回源 K08 §5「地图编辑器：上传底图 → 框定 bounds → **放 marker**、区域、行程线 → 绑定实体」。
 *
 * 判据认**具体的形状**（哪个按钮、哪个调用、十字光标的类名、哪条通道走 wrapWrite）。
 */
describe("放标注（R140）：选一个地点 ⇒ 在图上点一下 ⇒ 落一个标注", () => {
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const ipc = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "ipc.ts"), "utf8");
  const ops = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "map-ops.ts"), "utf8");
  const engine = readFileSync(join(ROOT, "packages", "@yushu", "world-engine", "src", "world-map.ts"), "utf8");

  it("地图面板给作者一个**放标注**的入口（真的调 map.createMarker，不是只画个点）", () => {
    expect(panel, "面板里没有「放标注」这个入口").toContain("放标注");
    expect(panel, "没有调用 map.createMarker").toContain("map.createMarker(");
    // R142：放置分两种（地点标注 / 事件锚点）⇒ 按钮带上**种类**
    expect(panel, "放标注的按钮没有绑上").toMatch(/onClick=\{\(\) => togglePlacing\("marker"\)\}/);
  });

  it("可选的地点**来自真源**（只给 location 类实体，地图上放的是地点不是事件）", () => {
    expect(ops, "没有按 location 类筛地点").toMatch(/entity\.type === "location"/);
    // 认**渲染那一处**（下拉的选项是从 map.places 画出来的）——
    // 只认"文件里出现过 map.places"太弱（按钮的 disabled 判断里也有这几个字 ⇒ 照样绿）
    expect(panel, "下拉的选项不是从真源地点清单画的").toMatch(/map\.places\.map\(\(place\)/);
  });

  it("放标注也要**键盘可达**（十字光标 + 方向键 + 回车）——点一下不是唯一的路", () => {
    expect(panel, "没有十字光标").toContain("map-place-cursor");
    // 认**绑定**（覆盖层真的接了键盘），不是"文件里定义过这个函数"
    // R143：画形状时 onKeyDown 是一整块（先判"是不是在画形状"，再交给 onPlaceKeyDown）⇒ 认那一下调用
    expect(panel, "覆盖层没有接键盘").toMatch(/onPlaceKeyDown\(event\)/);
    expect(panel, "回车没落点").toMatch(/event\.key === "Enter"[\s\S]{0,120}placeAt/);
  });

  it("写盘走 **wrapWrite**（真源写 ⇒ 索引要刷、上一轮结论要置脏）", () => {
    expect(ipc, "放标注没有走 wrapWrite").toMatch(/CHANNELS\.worldMapCreateMarker[\s\S]{0,200}wrapWrite/);
  });

  it("引擎只**追加**那一行（不重排整个文件 ⇒ 作者的标注顺序不变）", () => {
    expect(engine, "引擎里没有追加标注这个函数").toContain("export function appendMapMarker");
    expect(ops, "主进程没有用引擎的追加函数").toContain("appendMapMarker(snapshot.content");
  });
});

/**
 * 放事件锚点（R142）：作者选一个**事件** ⇒ 在图上点一下 ⇒ 落一个锚点。
 *
 * 口径回源 K08 §3.8：事件可挂坐标 ⇒ 选事件能定位到地图上。
 * R131 之后锚点只能**手写**在 map.yaml 里 ⇒ 这一轮把它交给作者动手。
 */
describe("放事件锚点（R142）：选一个事件 ⇒ 在图上点一下 ⇒ 落一个锚点", () => {
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const ipc = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "ipc.ts"), "utf8");
  const ops = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "map-ops.ts"), "utf8");
  const engine = readFileSync(join(ROOT, "packages", "@yushu", "world-engine", "src", "world-map.ts"), "utf8");

  it("地图面板给作者一个**放锚点**的入口（真的调 map.createAnchor，不是只画个预览）", () => {
    expect(panel, "面板里没有「放锚点」这个入口").toContain("放锚点");
    expect(panel, "没有调用 map.createAnchor").toContain("map.createAnchor(");
    expect(panel, "放锚点的按钮没有绑上").toMatch(/onClick=\{\(\) => togglePlacing\("anchor"\)\}/);
  });

  it("事件清单来自**真源**（world/timeline.yaml ⇒ 锚点只能挂真实的事件）", () => {
    expect(ops, "主进程没有读时间线").toContain("TIMELINE_PATH");
    expect(ops, "地图载荷没有带事件清单").toMatch(/events = parseTimelineFile/);
    // 认**渲染那一处**（下拉的选项是从 map.events 画出来的）——
    // 只认"文件里出现过 map.events"太弱（按钮的 disabled 判断里也有这几个字 ⇒ 照样绿）
    expect(panel, "下拉的选项不是从真源事件清单画的").toMatch(/map\.events\.map\(\(event\)/);
  });

  it("写盘走 **wrapWrite**（真源写 ⇒ 索引要刷、上一轮结论要置脏）", () => {
    expect(ipc, "放锚点没有走 wrapWrite").toMatch(/CHANNELS\.worldMapCreateAnchor[\s\S]{0,200}wrapWrite/);
  });

  it("引擎只**追加**那一行（不重排整个文件 ⇒ 作者自己写的锚点顺序不变）", () => {
    expect(engine, "引擎里没有追加锚点这个函数").toContain("export function appendMapAnchor");
    expect(ops, "主进程没有用引擎的追加函数").toContain("appendMapAnchor(snapshot.content");
  });
});

/**
 * 放区域 / 放行程线（R143）：K08 §5 的地图编辑器链条的**最后两样**。
 *
 * 几何由本项目定（K08 只给了图层类型）：**点用底图像素**，`regions` / `routes` 两段，
 * 一行一个形状（口径写在 docs/11 §7.23）。
 */
describe("放区域 / 放行程线（R143）：点出一串点 ⇒ 落一个面 / 一条线", () => {
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const ipc = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "ipc.ts"), "utf8");
  const ops = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "map-ops.ts"), "utf8");
  const engine = readFileSync(join(ROOT, "packages", "@yushu", "world-engine", "src", "world-map.ts"), "utf8");

  it("地图面板给作者**放区域 / 放行程线**的入口（真的调 map.createShape）", () => {
    expect(panel, "面板里没有「放区域」这个入口").toContain("放区域");
    expect(panel, "面板里没有「放行程线」这个入口").toContain("放行程线");
    expect(panel, "没有调用 map.createShape").toContain("map.createShape(");
  });

  it("图层显隐**也要管到区域/行程线**（K08 §3.9「图层独立显隐」——不然关掉「路线」层，那条线还在）", () => {
    // 认**过滤那一处**（形状按图层过滤），不是"代码里出现过 hidden"
    expect(panel, "形状没有按图层过滤（关掉图层它还在）").toMatch(
      /map\.shapes\.filter\(\(shape\) => !hidden\.includes\(shape\.layer\)\)/,
    );
  });

  it("区域与行程线**画在图上**（面是填色、线是折线）", () => {
    // 认**渲染那一处**（是 map.shapes 画出来的）——只认"文件里出现过 <polygon>"太弱
    // （代码搬走了、不再被调用，它照样绿）
    expect(panel, "区域与行程线不是从 map.shapes 画的").toMatch(/map\.shapes\.[\s\S]{0,80}map\(\(shape\)/);
    expect(panel, "区域没有画成面").toContain("<polygon");
    expect(panel, "行程线没有画成折线").toContain("<polyline");
    expect(panel, "画到一半的那串点没有画出来").toContain("map-shape-pending");
  });

  it("写盘走 **wrapWrite**，且引擎**只追加**那一行", () => {
    expect(ipc, "放形状没有走 wrapWrite").toMatch(/CHANNELS\.worldMapCreateShape[\s\S]{0,200}wrapWrite/);
    expect(engine, "引擎里没有追加形状这个函数").toContain("export function appendMapShape");
    expect(ops, "主进程没有用引擎的追加函数").toContain("appendMapShape(snapshot.content");
  });

  it("**键盘也能画**（回车加顶点、退格删点）", () => {
    expect(panel, "回车没有加点").toMatch(/event\.key === "Enter"[\s\S]{0,160}setShapePoints/);
    expect(panel, "退格没有删点").toMatch(/event\.key === "Backspace"[\s\S]{0,120}setShapePoints/);
  });
});

/**
 * R144 的 UI 收口：五个编辑入口（框定 / 放标注 / 放锚点 / 放区域 / 放行程线）
 * **收成一个分段控件**。
 *
 * 为什么不是"一个入口 + 一个下拉"：这五件事的**清单、校验、结果都不同**
 * （地点清单 / 事件清单 / 顶点数下限 / 落点范围）⇒ 塞进一个入口反而看不清
 * "现在能放的是哪一种"；但**看起来**它们该是一组（都是「编辑地图」）。
 *
 * 于是：**一个分组 + 五个档位 + 当前档位高亮（is-on / aria-pressed）**。
 */
describe("地图编辑面收口（R144）：五个入口 = 一个分段控件", () => {
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");

  it("五个入口在**同一个分组**里（不是五处散落的按钮）", () => {
    expect(panel, "没有那个分段控件的分组").toContain('className="map-mode-group"');
    expect(panel, "分组没有说明它是什么").toContain('aria-label="编辑地图"');
    const group = /<div className="map-mode-group"[\s\S]*?<\/div>/.exec(panel)?.[0] ?? "";
    for (const label of ["框定边界", "放标注", "放锚点", "放区域", "放行程线"]) {
      expect(group, `分段控件里少了「${label}」这一档`).toContain(label);
    }
  });

  it("**当前模式看得出来**（高亮 + aria-pressed），不只靠按钮文案", () => {
    expect(panel, "没有模式态的类名").toMatch(/map-mode-btn" \+ \(framing \? " is-on"/);
    expect(panel, "没有 aria-pressed").toContain("aria-pressed={framing}");
  });

  it("模式相关的控件（框回整张图 / 画完了 / 对象下拉）**只在该模式里出现**", () => {
    expect(panel, "「框回整张图」没有跟着框定模式走").toMatch(/\{framing && \(\s*<button type="button" className="map-upload-btn" onClick=\{useWholeImage\}/);
    expect(panel, "「画完了」没有跟着画形状模式走").toMatch(/\{shapeKind !== null && \(\s*<button type="button" className="map-upload-btn" onClick=\{\(\) => void commitShape\(\)\}/);
  });
});

/**
 * R145：**缩放与平移** —— 底图再大，一屏也只看得到一块。
 *
 * 口径（`docs/11` §7.25）：
 * ① 缩放/平移是**"看"的状态** ⇒ 不写盘（放大不是作品的一部分）；
 * ② 看得见的范围永远在作者框定的那一块里（越界的平移要钳住）；
 * ③ 键盘路：+ / - 改大小、方向键挪画面、0 复位 —— 画布得可聚焦才走得了；
 * ④ 放置 / 框定 / 画形状时键盘**让位**（别抢作者正在做的事）。
 */
describe("地图缩放与平移（R145）：放大看局部，挪动看别处", () => {
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const mapView = readFileSync(join(VIEW_ROOT, "components", "map-view.ts"), "utf8");
  /**
   * **画布那一个** `<svg>` 标签（认位置，不认"文件里出现过 tabIndex={0}"）：
   * 标注、锚点、覆盖层也都有 `tabIndex={0}` ⇒ 全文搜一遍是**恒绿**的，
   * 把画布改成不可聚焦它照样绿 ⇒ 变异 M5 就是这么抓不到人的。
   */
  const svgTags = panel.match(/<svg[\s\S]*?>/g) ?? [];
  const canvasTag = svgTags.find((tag) => tag.indexOf("map-svg") >= 0) ?? "";

  it("画布的 viewBox 由「框内尺寸 + 缩放 + 平移」算出（不是写死整块）", () => {
    expect(panel, "viewBox 没走 computeViewBox").toContain(
      "computeViewBox(width, height, view.zoom, view.pan.x, view.pan.y)",
    );
    expect(panel, "viewBox 还是写死的整块（那就没有缩放这回事）").not.toContain(
      "viewBox={`0 0 ${width} ${height}`}",
    );
  });

  it("缩放**不写盘**（放大只是看，不是作品的一部分）", () => {
    // 认**缩放那一段**：它只能动视图状态，不许碰任何写盘接口
    const zoomBlock = /const changeZoom = useCallback\([\s\S]*?\n  \);/.exec(panel)?.[0] ?? "";
    expect(zoomBlock, "没找到缩放那一段").not.toBe("");
    expect(zoomBlock, "缩放去写盘了（放大不该改作品）").not.toMatch(/api\(\)\.map\./);
    const panBlock = /const moveView = useCallback\([\s\S]*?\n  \);/.exec(panel)?.[0] ?? "";
    expect(panBlock, "没找到平移那一段").not.toBe("");
    expect(panBlock, "平移去写盘了").not.toMatch(/api\(\)\.map\./);
  });

  it("放大 / 缩小 / 复位三个控件都在（作者不用记快捷键）", () => {
    expect(panel, "没有放大控件").toContain('title="放大（键盘：+）"');
    expect(panel, "没有缩小控件").toContain('title="缩小（键盘：-）"');
    expect(panel, "没有复位控件").toContain('title="回到整块（键盘：0）"');
  });

  it("键盘路：+ / - 缩放、方向键平移、0 复位（且画布可聚焦才走得了）", () => {
    expect(panel, "没有 + 键").toMatch(/event\.key === "\+"/);
    expect(panel, "没有 - 键").toMatch(/event\.key === "-"/);
    expect(panel, "没有方向键平移").toContain("ArrowRight");
    expect(panel, "没有 0 复位").toMatch(/event\.key === "0"/);
    expect(canvasTag, "没找到画布那个 <svg> 标签").not.toBe("");
    expect(canvasTag, "画布不可聚焦 ⇒ 键盘路走不了").toContain("tabIndex={0}");
  });

  it("放置 / 框定 / 画形状时，缩放平移的键盘**让位**（别抢作者正在做的事）", () => {
    const handler = /const onViewKeyDown = useCallback\([\s\S]*?\n  \);/.exec(panel)?.[0] ?? "";
    expect(handler, "没找到缩放平移的键盘处理").not.toBe("");
    expect(handler, "没让位给放置/框定/画形状").toMatch(
      /if \(framing \|\| placing \|\| shapeKind !== null\) return;/,
    );
    expect(handler, "没让位给被聚焦的标注/锚点").toMatch(
      /if \(event\.target !== event\.currentTarget\) return;/,
    );
  });

  it("越界的平移会被钳回作者框定的那一块，缩放也有上下限", () => {
    expect(mapView, "钳制没了").toContain("clampPan");
    expect(mapView, "缩放上下限没了").toContain("ZOOM_MAX");
    expect(mapView, "缩放步进没了").toContain("ZOOM_STEP");
  });
});

/**
 * 挪事件锚点（R141）+ **地图编辑面的 UI 收拾**。
 *
 * 锚点与标注是同一类东西（地图上的一个点）⇒ 同一套机制（R139/R140 的做法照搬）。
 *
 * UI 那几条是**用户明确要的**（"顺便多修修 UI"）⇒ 必须有锁钉住，
 * 否则下一轮又会把说明写成散 div、把实现细节露给作者。
 */
describe("挪事件锚点（R141）+ 地图编辑面的 UI 收拾", () => {
  const panel = readFileSync(join(VIEW_ROOT, "components", "WorldMapPanel.tsx"), "utf8");
  const ipc = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "ipc.ts"), "utf8");
  const ops = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "map-ops.ts"), "utf8");
  const engine = readFileSync(join(ROOT, "packages", "@yushu", "world-engine", "src", "world-map.ts"), "utf8");

  it("锚点**也可拖**（真的调 map.setAnchor，写盘只改那一个锚点）", () => {
    expect(panel, "没有调用 map.setAnchor").toContain("map.setAnchor(");
    expect(panel, "锚点没有绑上拖拽").toMatch(
      /onPointerDown=\{\(event\) => onItemPointerDown\(event, "anchor", anchor\.id\)\}/,
    );
    expect(ops, "主进程没有用引擎的挪锚点函数").toContain("setMapAnchorPosition(snapshot.content");
    expect(engine, "引擎里没有挪锚点这个函数").toContain("export function setMapAnchorPosition");
  });

  it("锚点也能**用键盘挪**（方向键微调）", () => {
    expect(panel, "锚点的方向键没有写盘").toMatch(/moveAnchor\(anchor\.id, anchor\.x \+ dx, anchor\.y \+ dy\)/);
  });

  it("写盘走 **wrapWrite**（真源写 ⇒ 索引要刷、上一轮结论要置脏）", () => {
    expect(ipc, "挪锚点没有走 wrapWrite").toMatch(/CHANNELS\.worldMapSetAnchor[\s\S]{0,200}wrapWrite/);
  });

  it("UI：地图的汇总**用共享的 SummaryRows**（不再是一串各自为政的 div）", () => {
    expect(panel, "地图的汇总没用共享组件").toContain("<SummaryRows rows={mapSummaryRows} />");
    expect(panel, "地图的汇总行没算出来").toContain("const mapSummaryRows: SummaryRow[] = useMemo(");
  });

  it("UI：**一条状态行**（框定 / 放标注 / 挪标注 的回执都在同一处，不再三四处各挂一句）", () => {
    expect(panel, "面板里没有统一的状态行").toContain('className="map-status"');
    expect(panel, "还有别的提示状态没并进来").not.toContain("setFrameNote(");
    expect(panel, "还有别的提示状态没并进来").not.toContain("setMarkerNote(");
    expect(panel, "还有别的提示状态没并进来").not.toContain("setPlaceNote(");
  });

  it("UI：提示是**作者语言**（不把「改的是哪个文件」写给作者看）", () => {
    expect(panel, "提示里还露着实现细节（map.yaml / x / y）").not.toContain("map.yaml 里那一个标注");
    expect(panel, "没有一行操作提示").toContain('className="map-hint"');
  });

  it("UI：工具栏**按钮归一组**（模式相关的控件只在该模式里出现）", () => {
    expect(panel, "工具栏没有分组").toContain('className="map-mode-group"');
  });
});

/**
 * `place_ref` 的孤儿体检（R134）：引用了**不存在**的地点实体，要有一条**体检结论**点名。
 *
 * 引擎不认地点实体（它只管时间）⇒ 这条判定只能在**桌面接线**这一层做
 * （那里能读项目的实体表）⇒ 写错 id 的地方当场被点名。
 */
describe("place_ref 的孤儿体检（R134）：写错了 id 要被点名", () => {
  const ops = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "timeline-ops.ts"), "utf8");

  it("时间线 ops 会核对 place_ref 指向的地点实体**存在吗**", () => {
    expect(ops, "时间线 ops 没有读项目的实体表").toContain("checkStructureFromSources");
    // 认**真的判定了**（过滤 + 产出结论），不认诊断码字符串（码字在、判定没了，它照样绿）
    expect(ops, "没有真的判定孤儿").toMatch(
      /filter\(\(event\) => event\.placeRef !== undefined && !entityIds\.has\(event\.placeRef\)\)/,
    );
  });

  it("孤儿是一条 **error** 级的 `tl-place-orphan` 结论，并点名事件与地点", () => {
    expect(ops, "没有 tl-place-orphan 这条诊断码").toContain("tl-place-orphan");
    expect(ops, "孤儿结论不是 error 级").toMatch(/severity: "error" as const,[\s\S]{0,80}rule: "tl-place-orphan"/);
    expect(ops, "孤儿结论没有进载荷的 findings").toMatch(/findings: \[\.\.\.view\.findings[\s\S]{0,80}placeOrphans\]/);
  });
});

describe("UI 重构五批总复核（R119）：空/错态只留一个信号 + 版式", () => {
  /** 剥掉注释（块注释 + 行注释），只留真代码 —— 注释里的同名字面量不许冒充属性 */
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  const noteSrc = readFileSync(join(VIEW_ROOT, "components", "StateNote.tsx"), "utf8");
  const appSrc = readFileSync(join(VIEW_ROOT, "App.tsx"), "utf8");
  const cssSrc = readFileSync(join(VIEW_ROOT, "styles.css"), "utf8");

  it("全局错误条不许同时挂插画与图标（同一个『错误』不说两遍）", () => {
    // 只取 error-bar 那一段：整文件 contains 会让别处的 StateArt 冒充。
    const bar = /<div className="error-bar">([\s\S]*?)<\/div>/.exec(appSrc)?.[1] ?? "";
    expect(bar, "App.tsx 里找不到 error-bar 那一段（判据自己坏了？）").not.toBe("");
    expect(bar, "错误条里还挂着插画（线稿缩到 16px 只剩噪点，还和图标重复表达）").not.toContain("StateArt");
    expect(bar, "错误条里没有错误图标了").toContain('name="circle-x"');
    // 连 import 都不能留 —— 留着就等着下一个人把它塞回去。
    expect(stripComments(appSrc), "App.tsx 还 import 着 StateArt（错误条已经不用它了）").not.toMatch(
      /import \{ StateArt \}/,
    );
  });

  it("区块级空态只由插画承担状态表达（不许再挂第二枚状态图标）", () => {
    const code = stripComments(noteSrc);
    expect(code, "StateNote 里又挂上了状态图标（它与插画说的是同一句话）").not.toContain("YushuIcon");
    expect(code, "StateNote 没有用登记过的插画").toContain("StateArt");
    // 三段式还在：插画（哪一类状态）+ 标题（是什么）+ 说明（怎么办）
    expect(code).toContain("state-note-title");
    expect(code).toContain("state-note-text");
  });

  it("插画默认 56px（区块级空态配得上一个示意尺寸），不许改小", () => {
    const m = /artSize \?\? (\d+)/.exec(stripComments(noteSrc));
    expect(m, "StateNote 里找不到插画默认尺寸（判据自己坏了？）").not.toBeNull();
    expect(Number(m?.[1]), "插画默认尺寸被改小了").toBeGreaterThanOrEqual(56);
  });

  it("版式：插画与文案**并排**且顶端对齐（不许插画孤悬一行）", () => {
    // 只取 `.state-note { ... }` 这一块：`.state-note-body` / `.state-note-error` 不该被误读进来。
    const block = /\.state-note \{([\s\S]*?)\}/.exec(cssSrc)?.[1] ?? "";
    expect(block, "styles.css 里找不到 .state-note 这一块（判据自己坏了？）").not.toBe("");
    expect(block, "插画还在单独一行（column）——改版前那个孤悬的样子").not.toContain("flex-direction: column");
    expect(block, "插画与文案没有并排（row）").toContain("flex-direction: row");
    expect(block, "没有顶端对齐").toContain("align-items: flex-start");
    // 文案块要能换行，不能把插画挤扁
    const body = /\.state-note-body \{([\s\S]*?)\}/.exec(cssSrc)?.[1] ?? "";
    expect(body, "文案块没有 min-width: 0（长句会把插画挤扁）").toContain("min-width: 0");
  });

  it("分工口径要写进 docs/12（不然下一个人还会把图标挂回空态里）", () => {
    const doc = readFileSync(join(ROOT, "docs", "12-图标与插画来源登记.md"), "utf8");
    expect(doc, "登记表没写明『每个地方只留一个信号』的分工口径").toContain("只留一个信号");
    // 只看编号登记表那几行（其它小节的表格不带编号）
    const rows = doc.split("\n").filter((row) => /^\|\s*\d+\s*\|/.test(row.trim()));
    expect(rows.join("\n"), "登记表里还留着 `inbox`（R119 已回收：它没有落点了）").not.toContain("inbox");
  });
});
