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
      "## 8. 本轮明确没做的",
      "## 9. 附录：调研清单",
    ]) {
      expect(doc, `规范缺小节：${heading}`).toContain(heading);
    }
  });

  it("写清「只取口径不抄代码」的边界与反参照（否则将来有人手痒）", () => {
    expect(doc).toContain("不复制任何闭源产品");
    expect(doc).toContain("反参照");
  });

  it("明写本轮没做的（不许被读成已做）", () => {
    const section = doc.slice(doc.indexOf("## 8. 本轮明确没做的"));
    for (const item of ["排版改版", "持久化", "世界地图"]) {
      expect(section).toContain(item);
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
];
/** 其中属于"图标资产"的三个（判据要求它们真的有 path） */
const ICON_FILES = ["icons.tsx", "brand.tsx", "Disclosure.tsx"];

describe("UI 重构第四批·第二段（R113）：图标与插画来源登记", () => {
  const registry = readFileSync(join(ROOT, "docs", "12-图标与插画来源登记.md"), "utf8");

  it("登记表存在，且必备小节一个不许少（少一节就是登记被掏空）", () => {
    for (const heading of ["## 0. 为什么要有这张表", "## 1. 登记表", "## 2. 已知的两套口径", "## 3. 规矩", "## 4. 本轮明确没做的"]) {
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
    expect(code.length, "没解析出任何图标名（解析器坏了？）").toBeGreaterThanOrEqual(13);
    const missing = code.filter((name) => !table.includes(name));
    expect(missing, `代码里用了但登记表没点名：${missing.join(" | ")}`).toEqual([]);
    const dead = table.filter((name) => !code.includes(name));
    expect(dead, `登记表点名了但代码里没有（死图标）：${dead.join(" | ")}`).toEqual([]);
  });

  it("状态族图标在界面上**真的有落点**（登记了却没人用 = 死图标）", () => {
    const files = tsxFiles(VIEW_ROOT).filter((f) => !f.endsWith("icons.tsx"));
    for (const name of ["inbox", "circle-x"]) {
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

  it("StateNote 是三段式：图标 + 标题 + 说明；图标只走 YushuIcon，**不许内联 path**", () => {
    const src = readFileSync(join(VIEW_ROOT, "components", "StateNote.tsx"), "utf8");
    expect(src).toContain("YushuIcon");
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
 * 口径见 `docs/13-暗色主题口径.md`（本轮只记口径，不动色板）。
 */

/** 默认色板的基线（R116 改版前的原值，逐字）：semantic → 当时的字面值 */
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

  it("**默认色板一个像素都没动**（逐字比对基线表；primitive 的取值就是改版前的原值）", () => {
    const root = defaultRootBlock();
    const wrong: string[] = [];
    for (const [name, expected] of Object.entries(PALETTE_BASELINE)) {
      const semantic = rootToken(root, name) ?? "";
      const ref = /^var\((--c-[a-z0-9-]+)\)$/.exec(semantic);
      if (ref === null) {
        wrong.push(`${name} 不是引用`);
        continue;
      }
      const primitive = rootToken(root, ref[1] as string);
      if (primitive !== expected) wrong.push(`${name}（${ref[1]}）= ${primitive ?? "(无)"} ≠ 基线 ${expected}`);
    }
    expect(wrong, `色板被改动了：${wrong.join(" | ")}`).toEqual([]);
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
    expect(holders).toEqual(["App.tsx", "StateArt.tsx", "StateNote.tsx"]);
  });
});
