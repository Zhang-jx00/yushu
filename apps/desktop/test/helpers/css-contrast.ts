/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 样式表令牌解析 + WCAG 对比度计算（**单一真源**）。
 *
 * 这套实现原先长在 `contrast-gate.test.ts` 里。R144 要判「分段控件的当前档位**看得见**」
 * （选中态底色 vs 常态底色 ⇒ WCAG 1.4.11 的非文本对比度 ≥ 3:1），
 * 那条判据要的是**同一套**解析与算法 ⇒ 把它们提到这里，判据文件只做"取哪一对、卡哪个阈值"。
 *
 * 纪律：**两份实现 ⇒ 两份数 ⇒ 假账**。所以别在别的测试文件里再写一份 luminance/contrast。
 *
 * 口径：
 * - 底线 **4.5:1**（docs/13 §3 的正文级对比度，WCAG AA）。
 * - **非文本对比度 3:1**（WCAG 1.4.11）用于"状态/选中态这类非文字元素要能分辨"。
 */

/** 仓库根 */
export const ROOT = fileURLToPath(new URL("../../../..", import.meta.url));
export const CSS_PATH = join(ROOT, "apps", "desktop", "renderer", "src", "styles.css");
export const css = readFileSync(CSS_PATH, "utf8");

/** WCAG 相对亮度 */
export function luminance(hex: string): number {
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
export function contrast(fg: string, bg: string): number {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** 取匹配到的每个选择器块的**内容**（按花括号配对，不靠正则硬啃嵌套） */
export function blockBodies(source: string, anchor: RegExp): string[] {
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
export function parseVars(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const name = m[1];
    if (name !== undefined && m[2] !== undefined) out[name] = m[2].trim();
  }
  return out;
}

export function merge(...maps: Record<string, string>[]): Record<string, string> {
  return Object.assign({}, ...maps);
}

/** 沿 var() 链解析到具体色值（解析不了就返回 null，不猜） */
export function resolve(map: Record<string, string>, token: string, depth = 0): string | null {
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

export const THEMES: Record<string, Record<string, string>> = {
  light: lightPrimitives,
  dark: merge(lightPrimitives, darkPrimitives),
  "dark-soft": merge(lightPrimitives, darkPrimitives, softPrimitives),
  "high-contrast-light": merge(lightPrimitives, hqLightPrimitives),
  "high-contrast-dark": merge(lightPrimitives, darkPrimitives, hqLightPrimitives, hqDarkPrimitives),
};

// ---- semantic 层：用途 → primitive -----------------------------------------
export const semanticToPrimitive: Record<string, string> = {};
for (const m of lightPrimitives["--muted"] !== undefined ? css.matchAll(/(--[a-z0-9-]+)\s*:\s*var\(\s*(--c-[a-z0-9-]+)\s*\)\s*;/g) : []) {
  const name = m[1];
  const prim = m[2];
  if (name !== undefined && prim !== undefined) semanticToPrimitive[name] = prim;
}

export function valueOf(theme: Record<string, string>, token: string): string | null {
  const prim = semanticToPrimitive[token];
  if (prim === undefined) return resolve(theme, token);
  return resolve(theme, prim);
}

/**
 * 某个规则块里声明的 `background` / `color` 令牌。
 * 只认**直接**写了 `var(--x)` 的声明（`background: var(--panel)` 这种）⇒
 * 拿到的是"这条规则真的用的那个令牌"，不是"文件里出现过这个词"。
 */
export function declaredTokens(body: string): { background: string | null; color: string | null } {
  const bg = /(?:^|;)\s*background(?:-color)?\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/.exec(body);
  const fg = /(?:^|;)\s*color\s*:\s*var\(\s*(--[a-z0-9-]+)\s*\)/.exec(body);
  return { background: bg?.[1] ?? null, color: fg?.[1] ?? null };
}
