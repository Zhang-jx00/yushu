/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * CSS 令牌棘轮锁（R83）。
 *
 * 先说这轮**没做**的事：不做 primitive→semantic→component 三层重构。
 * 普查数据（`styles.css` 2939 行、1442 条声明、`var()` 已用 246 次）显示这个样式表
 * 本来就在令牌上跑，:root 之外的字面量只剩 26 处——为 26 处做一次全表改写，
 * 收益抵不上风险。所以本轮只把那 26 处里**重复出现的语义**收进令牌（18 处），
 * 然后立这条棘轮：**字面量只许降、不许升**，例外必须逐条登记理由。
 *
 * 三条设计上的自我约束（都是被同类事故教过的）：
 * ① **行内剥注释、不删行**。上一版普查脚本把整块注释 `continue` 掉了，
 *    注释之后的行号整体前移十几行——计数没错、行号是错的，报出来的"第 2430 行"根本不在那。
 *    所以这里把注释换成等长空格，保证行号与文件逐字对齐。
 * ② **不靠计数证明扫到了东西**。断言里带一条绝对下限（文件行数、令牌条数），
 *    解析器坏掉时零命中不会伪装成"全绿"。
 * ③ 时长例外用**逐条清单**而不是上限：新加一处会红，把已登记那处改成别的值也会红。
 */

const ROOT = join(__dirname, "..", "..", "..");
const CSS_PATH = join(ROOT, "apps", "desktop", "renderer", "src", "styles.css");
const lines = readFileSync(CSS_PATH, "utf8").split(/\r?\n/);

/** 把 /* ... *\/ 之间的字符换成等长空格：行数与每行长度都不变，行号因此可信 */
function maskComments(source: string[]): string[] {
  const out: string[] = [];
  let inBlock = false;
  for (const line of source) {
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

/** :root 块的行范围（1 基，含 @media 里内嵌的 :root） */
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

const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const COLOR_FN = /\b(?:rgba?|hsla?)\([^)]*\)/g;
const DURATION = /\b\d+(?:\.\d+)?m?s\b/g;

function literalsOutsideRoot(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (let i = 0; i < masked.length; i += 1) {
    const trimmed = (masked[i] ?? "").trim();
    if (trimmed === "" || insideRoot(i + 1)) continue;
    for (const match of trimmed.match(pattern) ?? []) {
      hits.push(`${String(i + 1)}:${match.replace(/\s+/g, "")}`);
    }
  }
  return hits;
}

/** :root 里声明的令牌名（跨多个 :root 块合并） */
function declaredTokens(): string[] {
  const names: string[] = [];
  for (const [start, end] of RANGES) {
    for (let i = start - 1; i < end; i += 1) {
      for (const match of (masked[i] ?? "").matchAll(/(--[a-z0-9-]+)\s*:/g)) names.push(match[1] as string);
    }
  }
  return [...new Set(names)];
}

describe("CSS 令牌棘轮（R83：字面量只降不升，例外逐条登记）", () => {
  it("扫描本身要成立：文件够长、:root 块够多、令牌够数（防解析器坏了 ⇒ 零命中冒充全绿）", () => {
    expect(lines.length).toBeGreaterThan(2000);
    expect(RANGES.length).toBeGreaterThanOrEqual(3);
    expect(declaredTokens().length).toBeGreaterThanOrEqual(26);
  });

  it("字面颜色棘轮：:root 之外只许有那一道阴影", () => {
    const colors = literalsOutsideRoot(HEX).concat(literalsOutsideRoot(COLOR_FN));
    // 上限 1（当前实测恰好 1）：新增任何一处硬写颜色都会红
    expect(colors.length).toBeLessThanOrEqual(1);
    expect(colors).toEqual(["2008:rgba(0,0,0,0.12)"]);
  });

  it("字面时长例外逐条登记：进度条两档刻意不同 + reduced-motion 的 0.01ms 惯用值", () => {
    expect(literalsOutsideRoot(DURATION)).toEqual(["1416:0.15s", "1600:0.2s", "2311:0.01ms"]);
  });

  it("本轮收进来的语义令牌都必须被用到（防「定义了没人用」的死令牌）", () => {
    const body = masked.join("\n");
    const unused = [
      "--ink-on-accent",
      "--bad-soft-bg",
      "--bad-soft-border",
      "--bad-tint-bg",
      "--good-soft-bg",
      "--warn-soft-bg",
      "--warn-tint-bg",
      "--heat-l1",
      "--heat-l2",
      "--heat-l3",
    ].filter((token) => (body.match(new RegExp(`var\\(${token}\\)`, "g")) ?? []).length === 0);
    expect(unused).toEqual([]);
  });

  it("高对比那组覆盖必须逐条对应 :root 里已有的令牌（覆盖一个不存在的变量=静默失效）", () => {
    const contrastBlock = RANGES
      .map(([a, b]) => lines.slice(a - 1, b).join("\n"))
      .find((block) => block.includes("--ink: #14100b"));
    expect(contrastBlock, "没找到高对比 :root 覆盖块（被删了？那就是无障碍回归）").toBeTruthy();
    const overridden = [...(contrastBlock as string).matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1] as string);
    expect(overridden.length).toBeGreaterThanOrEqual(6);
    const declared = new Set(declaredTokens());
    const dangling = overridden.filter((token) => !declared.has(token));
    expect(dangling).toEqual([]);
  });
});
