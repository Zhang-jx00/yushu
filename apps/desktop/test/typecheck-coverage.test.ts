/* SPDX-License-Identifier: Apache-2.0 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * "test/ 到底有没有被类型检查"这件事本身要有锁（R88）。
 *
 * 第 87 轮发现：全仓 11 个 tsconfig 的 `include` 都只有 `src`，**测试文件从来没进过类型检查**。
 * 暴露方式很具体——`export-tooling.test.ts` 的夹具漏了必填字段 `title`，`pnpm typecheck` 一路 Done。
 * 现在补了 `tsconfig.test.json` 并接进各包的 `typecheck` 脚本；这条锁保证**将来不会因为改了脚本
 * 又悄悄退回"只查 src"**：判据是"有 test 目录 ⇒ 有 test 配置 + 脚本真的跑它"，不是数文件个数。
 */

// apps/desktop/test → 仓库根（用 import.meta.url，ESM 下没有 __dirname）
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** 仓库里所有"包 / 应用"目录（9 包 + 2 应用） */
function packageDirs(): string[] {
  const dirs: string[] = [];
  for (const scope of ["packages/@yushu", "apps"]) {
    const abs = join(ROOT, scope);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) {
      const dir = join(abs, name);
      if (existsSync(join(dir, "package.json"))) dirs.push(`${scope}/${name}`);
    }
  }
  return dirs.sort();
}

function hasTests(dir: string): boolean {
  const testDir = join(ROOT, dir, "test");
  if (!existsSync(testDir)) return false;
  return readdirSync(testDir).some((file) => file.endsWith(".test.ts") || file.endsWith(".test.tsx"));
}

describe("测试文件纳入类型检查（R88）", () => {
  const withTests = packageDirs().filter(hasTests);

  it("仓库结构符合预期：有测试的包不是零个（锁不能空跑）", () => {
    expect(withTests.length, `实测有测试的包：${withTests.join(", ")}`).toBeGreaterThanOrEqual(11);
  });

  it.each(withTests.map((dir) => [dir]))("%s：有 tsconfig.test.json 且 include 里含 test", (dir) => {
    const path = join(ROOT, dir, "tsconfig.test.json");
    expect(existsSync(path), `${dir} 有测试文件却没有 tsconfig.test.json`).toBe(true);
    const cfg = JSON.parse(readFileSync(path, "utf8")) as { include?: string[]; compilerOptions?: { noEmit?: boolean } };
    expect(cfg.include ?? [], `${dir}/tsconfig.test.json 必须把 test 纳入 include`).toContain("test");
    // 只检查不产出：测试配置一旦能 emit，就会把 .js 落到包里
    expect(cfg.compilerOptions?.noEmit).toBe(true);
  });

  it.each(withTests.map((dir) => [dir]))("%s：typecheck 脚本真的跑了这份配置", (dir) => {
    const pkg = JSON.parse(readFileSync(join(ROOT, dir, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const script = pkg.scripts?.typecheck ?? "";
    expect(script, `${dir} 的 typecheck 脚本没跑 tsconfig.test.json ⇒ 测试文件又回到无人检查`).toContain(
      "tsc -p tsconfig.test.json",
    );
  });
});
