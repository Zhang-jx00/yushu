/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * SPDX 文件头锁（R82，`docs/04` §11.6 第一条门槛的后半）。
 *
 * `LICENSE`（Apache-2.0）与 `NOTICE` 早就在仓库根，但**逐文件的 SPDX 标识一直没加**——
 * 那意味着机器与下游只能靠"根目录有一份 LICENSE"来推断每个文件的许可，
 * 一旦某个文件被单独复制走（源码片段复用、fork、打包抽取），许可信息就丢了。
 *
 * 这条锁放在桌面端的 test 目录里，是因为 vitest 只收 packages 与 apps 两处 `test` 子目录的通配
 * （见 `vitest.config.ts`）；它检查的是**整个仓库**，不是桌面端自己。
 *
 * 三条设计决定：
 * ① **不靠"数一下有几个文件"来证明扫到了东西**——扫描器自己把目录写错就等于零命中全绿，
 *    这是自查脚本最容易犯的假绿（同族事故见 `docs/06` 第 63 轮注记）。所以断言里带一条**下限**：
 *    至少 290 个源文件在扫描范围内，且必须覆盖到每个包与两个应用。
 * ② 只要求**首行**是 SPDX 注释：首行是 REUSE / SPDX 工具与绝大多数扫描器的默认读取位置，
 *    放在第二行就等着被工具判成"未声明"。
 * ③ 排除清单要**显式且窄**：只排 `node_modules` 与构建产物 `dist`。
 *    不排 `*.d.ts`（那是人写的），也不排测试（测试文件同样受许可约束）。
 */

const ROOT = join(__dirname, "..", "..", "..");
const SPDX_LINE = "/* SPDX-License-Identifier: Apache-2.0 */";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".cjs", ".mjs"];
const EXCLUDED_DIRS = new Set(["node_modules", "dist"]);

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    const stat = statSync(abs);
    if (stat.isDirectory()) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      walk(abs, out);
      continue;
    }
    if (SOURCE_EXTENSIONS.some((ext) => entry.endsWith(ext))) out.push(abs);
  }
}

const scanned: string[] = [];
for (const top of ["packages", "apps"]) {
  walk(join(ROOT, top), scanned);
}
// 两份构建配置也是源码的一部分，一起纳管
for (const extra of ["vitest.config.ts", join("apps", "desktop", "vite.config.ts")]) {
  const abs = join(ROOT, extra);
  if (!scanned.includes(abs)) scanned.push(abs);
}
const rel = (abs: string): string => relative(ROOT, abs).split(sep).join("/");

describe("SPDX 文件头（docs/04 §11.6 第一条）", () => {
  it("扫描范围本身非空：至少 290 个源文件，且每个包与两个应用都在内", () => {
    expect(scanned.length).toBeGreaterThanOrEqual(290);
    const groups = new Set(scanned.map((abs) => rel(abs).split("/").slice(0, 2).join("/")));
    for (const area of ["packages/@yushu", "apps/desktop", "apps/cli"]) {
      expect([...groups].some((g) => g.startsWith(area.split("/").slice(0, 2).join("/")))).toBe(true);
    }
    // 抽查（不只看计数）：三个具体文件必须在清单里，防止"路径写错 ⇒ 扫了个寂寞"
    for (const sample of [
      "packages/@yushu/core/src/ids.ts",
      "apps/desktop/src/main/ipc.ts",
      "apps/desktop/renderer/src/App.tsx",
    ]) {
      expect(scanned.map(rel)).toContain(sample);
    }
  });

  it("每个源文件的头部都带 SPDX Apache-2.0 标识（shebang 之后算第二位）", () => {
    // 允许的唯一例外：`#!/usr/bin/env node` 这类 shebang 必须是第一行，标识就落在第二行
    // ——这也是 SPDX REUSE 规范认可的位置。除此之外（第三行、注释块中间）一律算缺失。
    const missing = scanned.filter((abs) => {
      const lines = readFileSync(abs, "utf8").split(/\r?\n/);
      const first = (lines[0] ?? "").trim();
      const head = first.startsWith("#!") ? (lines[1] ?? "").trim() : first;
      return !head.startsWith(SPDX_LINE);
    });
    expect(missing.map(rel)).toEqual([]);
  });

  it("带 shebang 的文件恰好是那 2 个可执行入口（防止有人拿 shebang 当免检牌）", () => {
    const withShebang = scanned
      .filter((abs) => readFileSync(abs, "utf8").split(/\r?\n/)[0]?.trim().startsWith("#!"))
      .map(rel)
      .sort();
    expect(withShebang).toEqual(["apps/cli/src/cli.ts", "apps/desktop/scripts/kill-recovery.mjs"]);
  });

  it("头里的许可与 LICENSE / NOTICE 是同一个（防止头写了 Apache、根目录却是 MIT）", () => {
    expect(readFileSync(join(ROOT, "LICENSE"), "utf8")).toContain("Apache License");
    expect(readFileSync(join(ROOT, "NOTICE"), "utf8")).toContain("Apache License 2.0");
  });
});
