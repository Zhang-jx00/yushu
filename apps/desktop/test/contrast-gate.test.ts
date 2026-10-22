/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 色板对比度门禁（R137）。
 *
 * 起因：R137 的**逐页对比度体检**（预演 step99）量出 11 个（页 × 主题）组合不过 4.5，
 * 追下去发现根因不在某一页，而在**默认色板本身**：
 * `--c-ink-soft`（次要文字）在纸底上只有 3.49:1、在朱底上只有 3.01:1 ——
 * 而 docs/13 §3 明写「正文与次要文字都要 ≥ 4.5」。也就是说**默认档自己违反自家口径**，
 * 而此前没有任何一条判据看这件事（暗色只在 step82/step92 量了两页，见 docs/13 §6）。
 *
 * 这条门禁做的是**静态**那一半：把样式表自己声明的「字色 × 它那层底色」全解析出来，
 * 逐对算对比度，五套主题（浅色 / 暗色 / 暗色·柔和高对比 / 高对比·浅 / 高对比·暗）逐套过 4.5。
 * 另一半是**动态**那一半：预演 step99 逐页现算（页面上真正在显示的文字）。
 * 两道门禁各管一半：静态那道管「样式表声明的所有组合」，动态那道管「实际渲染出来的样子」。
 *
 * 三条设计上的自我约束（防自指的假绿）：
 * ① **不许靠"文件里有这个词"过关**：这里算的是**具体某一对**（哪个字色、哪层底、哪个主题），
 *    失败时点名是哪一对、多大比值，不是报一个总数。
 * ② **不许靠删规则绕过**：断言里钉住几对**必须存在**的组合（`.chip.static` 的 muted/panel-2、
 *    `.badge.good` 的 good/good-soft-bg、`.chip.on` 的 ink-on-accent/accent…），
 *    少一对就红——否则"把那条 CSS 删了"就能让门禁变绿。
 * ③ **不许靠解析器坏掉变绿**：每套主题都断言解析出的组合数有下限（≥ 20），
 *    解析器失灵时零命中会伪装成"全绿"。
 *
 * 口径与例外：
 * - 底线 **4.5:1**（docs/13 §3 的正文级对比度，WCAG AA）。
 * - **`--ink-on-accent` 是唯一的例外**：它的语义是「字画在强调底上」，
 *   所以只与 `--accent` / `--good` 配对。`.chip.on:hover` 那条规则只写了字色、
 *   底色在另一条规则里（`.chip.on`），静态解析看不见这个关系 ⇒
 *   若不单列，它会被误判成「白字写在纸底上」（实测 1.02:1 的假警报）。
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const CSS_PATH = join(ROOT, "apps", "desktop", "renderer", "src", "styles.css");
const css = readFileSync(CSS_PATH, "utf8");

/** WCAG 相对亮度 */
function luminance(hex: string): number {
  const h = hex.trim().replace(/^#/, "");
  const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  if ([r, g, b].some((n) => !Number.isFinite(n))) return Number.NaN;
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** 对比度（WCAG 2.x 的 (L1+0.05)/(L2+0.05)） */
function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** 取匹配到的每个选择器块的**内容**（按花括号配对，不靠正则硬啃嵌套） */
function blockBodies(source: string, anchor: RegExp): string[] {
  const flags = anchor.flags.includes("g") ? anchor.flags : `${anchor.flags}g`;
  const re = new RegExp(anchor.source, flags);
  const out: string[] = [];
  let m = re.exec(source);
  while (m !== null) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < source.length && depth > 0) {
      if (source[i] === "{") depth += 1;
      else if (source[i] === "}") depth -= 1;
      i += 1;
    }
    out.push(source.slice(start, i - 1));
    re.lastIndex = i;
    m = re.exec(source);
  }
  return out;
}

/** 块里的变量声明 */
function parseVars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = m[1];
    if (name !== undefined && m[2] !== undefined) out[name] = m[2].trim();
  }
  return out;
}

function merge(...maps: Record<string, string>[]): Record<string, string> {
  return Object.assign({}, ...maps);
}

/** 沿 var() 链解析到具体色值（解析不了就返回 null，不猜） */
function resolve(map: Record<string, string>, token: string, depth = 0): string | null {
  const raw = map[token];
  if (raw === undefined || depth > 8) return null;
  const asVar = /^var\(\s*(--[a-z0-9-]+)\s*\)$/.exec(raw);
  if (asVar !== null && asVar[1] !== undefined) return resolve(map, asVar[1], depth + 1);
  if (raw.startsWith("#") || raw.startsWith("rgb")) return raw;
  return null;
}

// ---- 五套主题的 primitive 取值 --------------------------------------------
// 浅色：顶层 `:root {`（行首对齐的那种；高对比媒体块里的 `:root` 是缩进的，取不到）
const lightBlocks = blockBodies(css, /^:root \{/m).map(parseVars);
const lightPrimitives = merge(...lightBlocks);
// 暗色：`:root[data-theme="dark"], :root[data-theme="dark-soft"] {`
const darkPrimitives = merge(...blockBodies(css, /:root\[data-theme="dark"\],\s*:root\[data-theme="dark-soft"\] \{/).map(parseVars));
// 暗色·柔和高对比：上面那条**组合选择器**里也含 dark-soft ⇒ 取**最后**一块（独立的那块）
const softBlocks = blockBodies(css, /^:root\[data-theme="dark-soft"\] \{/m).map(parseVars);
const softPrimitives = softBlocks[softBlocks.length - 1] ?? {};
// 系统高对比：媒体块里另给一套
const hqStart = css.indexOf("@media (prefers-contrast: more)");
const hqText = hqStart >= 0 ? css.slice(hqStart) : "";
const hqLightPrimitives = merge(...blockBodies(hqText, /:root \{/).map(parseVars));
const hqDarkPrimitives = merge(...blockBodies(hqText, /:root\[data-theme="dark"\] \{/).map(parseVars));

const THEMES: Record<string, Record<string, string>> = {
  light: lightPrimitives,
  dark: merge(lightPrimitives, darkPrimitives),
  "dark-soft": merge(lightPrimitives, darkPrimitives, softPrimitives),
  "high-contrast-light": merge(lightPrimitives, hqLightPrimitives),
  "high-contrast-dark": merge(lightPrimitives, darkPrimitives, hqLightPrimitives, hqDarkPrimitives),
};

// ---- semantic 层：用途 → primitive -----------------------------------------
const semanticToPrimitive: Record<string, string> = {};
for (const m of lightPrimitives["--muted"] !== undefined ? css.matchAll(/(--[a-z0-9-]+)\s*:\s*var\(\s*(--c-[a-z0-9-]+)\s*\)\s*;/g) : []) {
  const name = m[1];
  const prim = m[2];
  if (name !== undefined && prim !== undefined) semanticToPrimitive[name] = prim;
}

function valueOf(theme: Record<string, string>, token: string): string | null {
  const prim = semanticToPrimitive[token];
  if (prim === undefined) return resolve(theme, token);
  return resolve(theme, prim);
}

// ---- 样式表自己声明的「字色 × 底色」组合 ------------------------------------
interface Pair {
  text: string;
  bg: string;
  where: string;
}

const explicitPairs: Pair[] = [];
const inheritedTexts = new Set<string>();
for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = (m[1] ?? "").trim();
  const body = m[2] ?? "";
  if (selector.startsWith("@") || selector.startsWith("/*")) continue;
  const colors = [...body.matchAll(/(?:^|;)\s*(?:-webkit-text-fill-color|color)\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/g)].map(
    (x) => x[1] ?? "",
  );
  const bgs = [...body.matchAll(/(?:^|;)\s*background(?:-color)?\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/g)].map(
    (x) => x[1] ?? "",
  );
  for (const c of colors) {
    if (bgs.length === 0) {
      inheritedTexts.add(c);
      continue;
    }
    for (const b of bgs) {
      explicitPairs.push({ text: c, bg: b, where: selector.split("\n")[0]?.slice(0, 48) ?? "" });
    }
  }
}

/** 元素没自带底色时，身后可能是这三层底 */
const BASE_SURFACES = ["--bg", "--panel", "--panel-2"];
/** 唯一的例外：字画在强调底上的那个令牌 */
const EXCEPTION_SURFACES: Record<string, string[]> = {
  "--ink-on-accent": ["--accent", "--good"],
};

/** 某个字色必须过的那几层底 */
function surfacesFor(text: string): string[] {
  const exception = EXCEPTION_SURFACES[text];
  if (exception !== undefined) return exception;
  const set = new Set<string>();
  for (const p of explicitPairs) if (p.text === text) set.add(p.bg);
  if (inheritedTexts.has(text)) for (const s of BASE_SURFACES) set.add(s);
  return [...set].sort();
}

const FLOOR = 4.5;

describe("色板对比度门禁（R137）：字色 × 它那层底色，逐套主题 ≥ 4.5", () => {
  it("解析器扫到了东西：五套主题、够数的组合、该存在的组合都在", () => {
    expect(Object.keys(THEMES), "主题数不对（高对比那两套没解析到？）").toHaveLength(5);
    for (const [name, primitives] of Object.entries(THEMES)) {
      for (const token of ["--c-paper", "--c-ink", "--c-ink-soft", "--c-accent", "--c-good", "--c-bad", "--c-warn"]) {
        expect(resolve(primitives, token), `${name} 档里 ${token} 没解析出取值`).not.toBeNull();
      }
    }
    // 防自指：解析器坏掉 ⇒ 零命中 ⇒ 伪装成全绿
    expect(explicitPairs.length, "显式配对太少（解析器可能坏了）").toBeGreaterThanOrEqual(10);
    expect(inheritedTexts.size, "继承底色的字色太少").toBeGreaterThanOrEqual(5);
    // 认形状：这几对是**必须存在**的（删掉对应 CSS 就能绕过门禁 ⇒ 必须钉住）
    const mustExist: Array<[string, string]> = [
      ["--muted", "--panel-2"],
      ["--muted", "--panel"],
      ["--good", "--good-soft-bg"],
      ["--bad", "--bad-soft-bg"],
      ["--accent", "--accent-soft"],
      ["--ink-on-accent", "--accent"],
      ["--ink-on-accent", "--good"],
    ];
    for (const [t, b] of mustExist) {
      expect(
        explicitPairs.some((p) => p.text === t && p.bg === b),
        `样式表里没有「${t} 写在 ${b} 上」这条组合（对应规则被删了？门禁会被绕过）`,
      ).toBe(true);
    }
  });

  for (const [themeName, primitives] of Object.entries(THEMES)) {
    it(`${themeName} 档：每一对「字色 × 底色」都 ≥ ${FLOOR}`, () => {
      const failures: string[] = [];
      let checked = 0;
      for (const text of [...new Set([...explicitPairs.map((p) => p.text), ...inheritedTexts])].sort()) {
        for (const bg of surfacesFor(text)) {
          const fg = valueOf(primitives, text);
          const back = valueOf(primitives, bg);
          if (fg === null || back === null) {
            failures.push(`${text} on ${bg}：取值没解析出来（fg=${fg} bg=${back}）`);
            continue;
          }
          checked += 1;
          const ratio = contrast(fg, back);
          if (ratio < FLOOR) {
            failures.push(
              `${text}(${fg}) on ${bg}(${back}) = ${ratio.toFixed(2)}:1 —— 低于 ${FLOOR}`,
            );
          }
        }
      }
      expect(checked, `${themeName} 档实际比对的组合太少（解析器可能坏了）`).toBeGreaterThanOrEqual(20);
      expect(failures, `${themeName} 档有 ${failures.length} 对不过 ${FLOOR}:\n${failures.join("\n")}`).toEqual([]);
    });
  }

  it("默认档的次要文字与状态色都不许靠「刚好差一点」过关（离底线留出余量）", () => {
    // 浅色档的三处最薄组合（accent-soft 底上的 muted、paper 底上的 warn…）必须有余量，
    // 否则以后新增一层底色就会把这条线踩穿 ⇒ 要求 ≥ 底线 + 0.2。
    const margin = 0.2;
    const pairs: Array<[string, string]> = [
      ["--muted", "--bg"],
      ["--muted", "--panel"],
      ["--muted", "--panel-2"],
      ["--warn", "--bg"],
      ["--warn", "--panel-2"],
      ["--good", "--bg"],
      ["--good", "--panel-2"],
      ["--good", "--good-soft-bg"],
    ];
    const thin: string[] = [];
    // 浅色档解析不出来 ⇒ 下面会「一对都量不到」而空过 ⇒ 这里先把它钉住
    expect(THEMES["light"], "没解析出浅色档").toBeDefined();
    const light = THEMES["light"] ?? {};
    for (const [t, b] of pairs) {
      const fg = valueOf(light, t);
      const back = valueOf(light, b);
      if (fg === null || back === null) {
        thin.push(`${t} on ${b}：取值没解析出来（fg=${fg} bg=${back}）`);
        continue;
      }
      const ratio = contrast(fg, back);
      if (ratio < FLOOR + margin) thin.push(`${t}(${fg}) on ${b}(${back}) = ${ratio.toFixed(2)}:1`);
    }
    expect(thin, `这几对离底线不足 ${margin}:\n${thin.join("\n")}`).toEqual([]);
  });
});
