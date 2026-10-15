/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 红线 5 的机器判据（R91）：**确定性排序不许用 `localeCompare`**。
 *
 * 这条规矩第 5 轮就写进文档了，第 89 轮实测却发现生产代码里有 15 处在用它——
 * 典型的"写进禁忌表但没变成判据，于是照样复发"。本锁把话说死：
 * ① 生产代码里出现 `.localeCompare(` 即红，除非文件在**显示排序白名单**里；
 * ② 白名单里的每一处还必须**显式传 locale**（`localeCompare(x, "zh")`），
 *    不传 locale 的写法跟着运行环境走，连"显示顺序稳定"都保证不了；
 * ③ 扫描器自身要有下限与命中数断言，否则"路径写错 ⇒ 零命中 ⇒ 全绿"这种假锁又会活下来。
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/** 只允许"给人看的顺序"用 locale 排序，且必须显式写清是哪个 locale */
const DISPLAY_ALLOWLIST = [
  "apps/desktop/renderer/src/mention-suggest.ts",
  "apps/desktop/src/main/project-ops.ts",
  "apps/desktop/src/main/prompt-ops.ts",
];

const SCAN_ROOTS = [
  "packages/@yushu/core/src",
  "packages/@yushu/text/src",
  "packages/@yushu/export/src",
  "packages/@yushu/memory/src",
  "packages/@yushu/genre-engine/src",
  "packages/@yushu/llm/src",
  "packages/@yushu/schema/src",
  "packages/@yushu/search/src",
  "packages/@yushu/world-engine/src",
  "apps/cli/src",
  "apps/desktop/src",
  "apps/desktop/renderer/src",
];

function walk(dir: string, out: string[]): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      walk(abs, out);
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(abs);
    }
  }
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function scanLocaleCompare(): { files: number; hits: Hit[] } {
  const hits: Hit[] = [];
  let files = 0;
  for (const rel of SCAN_ROOTS) {
    const found: string[] = [];
    walk(join(ROOT, rel), found);
    files += found.length;
    for (const abs of found) {
      const text = readFileSync(abs, "utf8");
      // 用 relative 而不是 slice：ROOT 末尾带不带分隔符都会让手工截断多切掉一个字符
      const repoRel = relative(ROOT, abs).replace(/\\/g, "/");
      text.split(/\r?\n/).forEach((line, index) => {
        // 注释里提一句"不用 localeCompare"是讲道理，不是违规：只认**调用**
        if (line.includes(".localeCompare(") && !/^\s*(\*|\/\/)/.test(line)) {
          hits.push({ file: repoRel, line: index + 1, text: line.trim() });
        }
      });
    }
  }
  return { files, hits };
}

/**
 * 逐个取出 `.localeCompare(...)` 的实参文本，并判断有没有**顶层第二个实参**。
 * 不能用"整行里有没有逗号 + 引号"来判：一行上写两个调用时，
 * 后面那个的 locale 会把前面那个没传 locale 的掩护过去（R91 写这锁时真的踩到了）。
 */
function localeCompareCalls(text: string): Array<{ args: string; hasLocale: boolean }> {
  const needle = ".localeCompare(";
  const out: Array<{ args: string; hasLocale: boolean }> = [];
  for (let i = text.indexOf(needle); i >= 0; i = text.indexOf(needle, i + needle.length)) {
    let depth = 1;
    let args = "";
    let hasLocale = false;
    for (let j = i + needle.length; j < text.length; j += 1) {
      const ch = text[j];
      if (ch === "(" || ch === "[") depth += 1;
      else if (ch === ")" || ch === "]") {
        depth -= 1;
        if (depth === 0) break;
      } else if (ch === "," && depth === 1) hasLocale = true;
      args += ch;
    }
    out.push({ args, hasLocale });
  }
  return out;
}

describe("确定性排序不许用 localeCompare（红线 5，R91）", () => {
  const { files, hits } = scanLocaleCompare();

  it("扫描器自己在干活：文件数与白名单命中数都有下限（防「零命中冒充全绿」）", () => {
    // 下限取实测值留余量：R91 用 find 独立数过，生产源文件 **191 个**（不是随手写的整数）。
    expect(files, `实测扫到 ${files} 个生产源文件`).toBeGreaterThanOrEqual(180);
    const allowed = hits.filter((hit) => DISPLAY_ALLOWLIST.includes(hit.file));
    expect(allowed.length, `白名单里 ${DISPLAY_ALLOWLIST.length} 个文件都应至少有一处，实际 ${allowed.length} 处`).toBeGreaterThanOrEqual(
      DISPLAY_ALLOWLIST.length,
    );
  });

  it("每个扫描根都真的读到文件：少一个根就会整包漏检（总数下限拦不住，R91 变异 D 实测）", () => {
    const empty = SCAN_ROOTS.filter((rel) => {
      const found: string[] = [];
      walk(join(ROOT, rel), found);
      return found.length === 0;
    });
    expect(empty, `这些扫描根一个文件都没读到（路径写错或目录被搬走）：${empty.join(", ")}`).toEqual([]);
  });

  it("白名单之外的生产代码一处都不许用 localeCompare", () => {
    const offenders = hits
      .filter((hit) => !DISPLAY_ALLOWLIST.includes(hit.file))
      .map((hit) => `${hit.file}:${hit.line} → ${hit.text.slice(0, 90)}`);
    expect(offenders, `这些排序会进导出/索引/报告，必须码点序：\n${offenders.join("\n")}`).toEqual([]);
  });

  it.each(DISPLAY_ALLOWLIST)("%s：白名单里的每一处都必须显式传 locale", (rel) => {
    const text = readFileSync(join(ROOT, rel), "utf8");
    const calls = localeCompareCalls(text);
    expect(calls.length, `${rel} 里没找到 localeCompare 调用（白名单该缩了）`).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.hasLocale, `${rel} 有调用没传 locale：localeCompare(${call.args.slice(0, 60)})`).toBe(true);
    }
  });
});
