/* SPDX-License-Identifier: Apache-2.0 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Node ESM 的相对导入必须带 `.js` 后缀（R104）。
 *
 * 起因是本轮自己撞的：`opening-check.ts` 写了 `from "./outline"`，
 * **typecheck 绿、146 个测试文件全绿**，构建产物 `dist/opening-check.js` 里那句原样留着，
 * 直到 e2e 起 Electron 才炸出 `ERR_MODULE_NOT_FOUND`——因为 vitest / tsc 都按打包器的规矩补后缀，
 * 只有真正跑起来的那台 Node 不补。**门禁全绿而交付物是坏的**，这一类必须变成机器判据，否则照样复发。
 *
 * 覆盖范围说清楚（"全绿"不等于"扫到了全部"）：
 * - 扫 `packages/@yushu/<pkg>/src` 与 `apps/desktop/src`（主进程 / preload / shared）——
 *   这两处会被 tsc 原样编译成 ESM 交给 Node 加载；
 * - **不扫 `apps/desktop/renderer/src`**：渲染层走 vite 打包，扩展名由打包器解析，
 *   那里 `from "../api"` 是正确写法，硬要求 `.js` 反而会把人逼去写没用的后缀。
 */

const ROOTS = [
  "../../../packages/@yushu",
  "../src",
];

/** 剥掉注释（块注释 + 行注释）——注释里写的 `from "./outline"` 是在举例，不是代码 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** 只认 src 下的文件：`test/` 由 vitest 加载（它会补后缀），不进交付物，管它是白管 */
function isShippedSource(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.includes("/src/") && !normalized.includes("/test/");
}

/** 允许的后缀：`.js` 是硬要求，`.json` / 样式类按打包器规矩放行 */
const OK_SUFFIX = /\.(js|json|css|svg|png)$/;
const SPEC = /(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (entry === "node_modules" || entry === "dist") continue;
    const stats = statSync(path);
    if (stats.isDirectory()) out.push(...tsFiles(path));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && isShippedSource(path)) out.push(path);
  }
  return out;
}

function offenders(): string[] {
  const found: string[] = [];
  for (const root of ROOTS) {
    const abs = fileURLToPath(new URL(root, import.meta.url));
    let files: string[];
    try {
      files = tsFiles(abs);
    } catch {
      found.push(`扫描根不存在：${abs}（判据本身坏了，不是代码干净）`);
      continue;
    }
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(SPEC)) {
        const spec = match[1] ?? "";
        if (OK_SUFFIX.test(spec)) continue;
        found.push(`${file.replace(/\\/g, "/").split("/src/").pop() ?? file} → ${spec}`);
      }
    }
  }
  return found.sort();
}

describe("Node ESM 相对导入的后缀（R104）", () => {
  it("扫描根真的扫到了文件（防空转：根写错就是一条红，不是满屏绿）", () => {
    let total = 0;
    for (const root of ROOTS) {
      const abs = fileURLToPath(new URL(root, import.meta.url));
      total += tsFiles(abs).length;
    }
    expect(total, "一个 .ts 都没扫到 ⇒ 这条锁是空的").toBeGreaterThan(150);
  });

  it("相对导入一律带 .js 后缀：漏一处就是给交付物埋一颗只在运行时炸的雷", () => {
    expect(offenders()).toEqual([]);
  });

  /**
   * 第三块扫描范围（R119 新增）：**`apps/desktop/test/**`**。
   *
   * 起因是**两轮假绿**：R117 新写的 `test/density-prefs.test.ts` 把渲染层模块导成了
   * `from "../renderer/src/density-prefs"`（**没有 `.js` 后缀**）——
   * 桌面端 tsconfig 是 `module/moduleResolution: NodeNext`，而 `tsconfig.test.json`
   * **把 test 目录也纳进来** ⇒ `tsc` 报 TS2835（TS2835: Relative import paths need
   * explicit file extensions）。而 **vitest 不在乎后缀**（它会补）⇒ **单测全绿** ⇒
   * R117、R118 两轮台账写的「typecheck TC=0」**当时是假的**。
   *
   * 为什么渲染层源码自己不用写 `.js`、这里却要写：渲染层走 vite 打包（后缀由打包器解析），
   * 但**从 test 目录导入渲染层源码**时，这段代码归**桌面端的 NodeNext tsconfig** 管 ⇒ 必须带后缀。
   * 两条口径不冲突：**谁解析，谁要求**。
   */
  it("test 目录里的相对导入也要带 .js 后缀（R117 那两轮假绿就出在这里）", () => {
    const root = fileURLToPath(new URL("./", import.meta.url));
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        if (entry === "node_modules") continue;
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) files.push(path);
      }
    };
    walk(root);
    expect(files.length, "一个 test 文件都没扫到 ⇒ 这条锁是空的").toBeGreaterThan(20);
    const bad: string[] = [];
    for (const file of files) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const match of text.matchAll(SPEC)) {
        const spec = match[1] ?? "";
        if (spec.endsWith(".js") || spec.endsWith(".json")) continue;
        bad.push(`${file.replace(/\\/g, "/").split("/test/").pop() ?? file} → ${spec}`);
      }
    }
    expect(
      bad,
      `这些相对导入没有 .js 后缀（桌面端 tsconfig 是 NodeNext ⇒ tsc 会报 TS2835）：\n${bad.join("\n")}`,
    ).toEqual([]);
  });
});
