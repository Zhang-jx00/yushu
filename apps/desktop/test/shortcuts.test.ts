/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  GLOBAL_SHORTCUT_COUNT,
  SHORTCUTS,
  keysLabel,
} from "../renderer/src/components/shortcuts.js";

/**
 * 快捷键一览（R157）：**面板上的条目数必须与代码里真实的绑定数一致**。
 *
 * 这条锁防的是"照抄一份自己想象的清单"——那种清单看起来很像那么回事，
 * 但作者按了没反应，而且**永远不会有人发现**（没人会去数代码里的绑定）。
 *
 * 对账的办法（**逐处**，不是"文件里出现过这个键"）：
 * ① 每个条目的 `probe` 必须在它声明的文件里**恰好出现一次**（认位置、认精确形态）；
 * ② 同一文件里各条 `probe` 的位置**递增**（否则认领的区域会重叠）；
 * ③ 每个条目**认领**的那一段里的按键判断，必须与它声明的 `keys` **多重集相等**
 *    （不许登记一个代码里没有的键，也不许漏掉代码里判过的键）；
 * ④ 每个文件里**所有**按键判断都要被这些条目**恰好认领一次**（不漏、不重）；
 * ⑤ 每个条目至少认领一处（不许有凭空条目）；
 * ⑥ **全局条目数 == 代码里窗口级 keydown 监听器的数量**（认调用，不认"看起来像全局"）。
 */

const ROOT = join(__dirname, "..", "..", "..");

/** 按键判断：`event.key === "X"`（也覆盖 `e.key` / `ev.key` 这类写法） */
const KEY_TEST = /\.key\s*===\s*"([^"]+)"/g;

/** 注释换成等长空格：**位置不变**，判据靠位置对账（位置变了才红） */
function maskComments(src: string): string {
  const chars = src.split("");
  let i = 0;
  let inBlock = false;
  while (i < src.length) {
    if (inBlock) {
      const close = src.indexOf("*/", i);
      if (close === -1) {
        for (let k = i; k < src.length; k += 1) chars[k] = " ";
        break;
      }
      for (let k = i; k < close + 2; k += 1) chars[k] = " ";
      i = close + 2;
      inBlock = false;
      continue;
    }
    const open = src.indexOf("/*", i);
    const slash = src.indexOf("//", i);
    if (open === -1 && slash === -1) break;
    const next = open === -1 ? slash : slash === -1 ? open : Math.min(open, slash);
    if (next === open) {
      const close = src.indexOf("*/", open + 2);
      if (close === -1) {
        for (let k = open; k < src.length; k += 1) chars[k] = " ";
        break;
      }
      for (let k = open; k < close + 2; k += 1) chars[k] = " ";
      i = close + 2;
      continue;
    }
    // 行注释：涂到行尾（换行符不动）
    let end = src.indexOf("\n", slash);
    if (end === -1) end = src.length;
    for (let k = slash; k < end; k += 1) chars[k] = " ";
    i = end;
  }
  return chars.join("");
}

/** 文件里逐处按键判断：位置 + 键 */
function keyTestsOf(masked: string): { at: number; key: string }[] {
  const out: { at: number; key: string }[] = [];
  for (const match of masked.matchAll(KEY_TEST)) {
    out.push({ at: match.index ?? 0, key: match[1] ?? "" });
  }
  return out;
}

/** 多重集相等（顺序不计，个数计） */
function sameMultiset(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

describe("快捷键一览（R157）：面板的条目数 == 代码里真实的绑定数", () => {
  it("扫描器本身要成立（防空转：扫空了也满屏绿）", () => {
    expect(SHORTCUTS.length).toBeGreaterThanOrEqual(10);
    const files = new Set(SHORTCUTS.map((entry) => entry.file));
    expect(files.size).toBeGreaterThanOrEqual(5);
    for (const entry of SHORTCUTS) {
      expect(entry.keys.length, `${entry.id} 一处都没绑`).toBeGreaterThan(0);
      expect(entry.probe.length, `${entry.id} 没有定位片段`).toBeGreaterThan(0);
    }
  });

  it("每个条目的定位片段在它声明的文件里**恰好出现一次**（认位置、认精确形态）", () => {
    for (const entry of SHORTCUTS) {
      const src = readFileSync(join(ROOT, entry.file.replace(/\//g, "\\")), "utf8");
      const count = src.split(entry.probe).length - 1;
      expect(count, `${entry.id} 的定位片段在 ${entry.file} 里出现 ${count} 次（必须恰好 1 次）`).toBe(1);
    }
  });

  it("每个条目认领的那一段里，**按键判断与它声明的键逐一相等**", () => {
    const byFile = new Map<string, typeof SHORTCUTS>();
    for (const entry of SHORTCUTS) {
      const list = byFile.get(entry.file) ?? [];
      list.push(entry);
      byFile.set(entry.file, list);
    }
    for (const [file, entries] of byFile) {
      const src = readFileSync(join(ROOT, file.replace(/\//g, "\\")), "utf8");
      const masked = maskComments(src);
      const tests = keyTestsOf(masked);
      const ordered = [...entries].sort(
        (a, b) => src.indexOf(a.probe) - src.indexOf(b.probe),
      );
      for (let i = 0; i < ordered.length; i += 1) {
        const entry = ordered[i]!;
        const start = src.indexOf(entry.probe);
        const end = i + 1 < ordered.length ? src.indexOf(ordered[i + 1]!.probe) : src.length;
        const claimed = tests.filter((test) => test.at >= start && test.at < end).map((test) => test.key);
        expect(
          sameMultiset(claimed, entry.keys),
          `${entry.id} 认领的键 ${JSON.stringify(claimed)} 与它声明的 ${JSON.stringify(entry.keys)} 对不上`,
        ).toBe(true);
      }
    }
  });

  it("**一处按键判断都不许漏**（每个文件的全量 == 各条目认领的合计）", () => {
    const byFile = new Map<string, typeof SHORTCUTS>();
    for (const entry of SHORTCUTS) {
      const list = byFile.get(entry.file) ?? [];
      list.push(entry);
      byFile.set(entry.file, list);
    }
    for (const [file, entries] of byFile) {
      const src = readFileSync(join(ROOT, file.replace(/\//g, "\\")), "utf8");
      const tests = keyTestsOf(maskComments(src));
      const claimed = entries.flatMap((entry) => entry.keys);
      expect(
        sameMultiset(
          tests.map((test) => test.key),
          claimed,
        ),
        `${file} 里有 ${tests.length} 处按键判断，登记表只认领了 ${claimed.length} 处`,
      ).toBe(true);
    }
  });

  it("**全局条目数 == 窗口级 keydown 监听器的数量**（认调用，不认「看起来像全局」）", () => {
    const files = new Set<string>();
    for (const entry of SHORTCUTS) {
      if (entry.scope === "global") files.add(entry.file);
    }
    let listeners = 0;
    for (const file of files) {
      const src = readFileSync(join(ROOT, file.replace(/\//g, "\\")), "utf8");
      listeners += (src.match(/addEventListener\(\s*["']keydown["']/g) ?? []).length;
    }
    expect(listeners, "窗口级 keydown 监听器的数量变了，全局条目的口径也得跟着改").toBeGreaterThan(0);
    expect(GLOBAL_SHORTCUT_COUNT).toBe(listeners);
  });

  it("面板上的键**人话由登记表现算**（不许另写一份文案）", () => {
    expect(keysLabel(["ArrowLeft", "ArrowRight"])).toBe("← / →");
    expect(keysLabel(["Enter", " "])).toBe("回车 / 空格");
    // 同一个键判了两次（逐处对账要写两遍），显示时只摆一次
    expect(keysLabel(["ArrowDown", "ArrowUp", "ArrowDown"])).toBe("↓ / ↑");
  });
});
