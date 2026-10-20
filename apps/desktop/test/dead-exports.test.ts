/* SPDX-License-Identifier: Apache-2.0 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 零引用导出的登记与棘轮（R99 死代码审计的产物）。
 *
 * 本轮把 `codePointCompareBy` 与 `isValidLocalId` 删了（确认全仓库零引用、且无文档价值），
 * 剩下的 12 个**有意留着**：它们是数据模型词表（`Relation` / `Storyline` / `MemoryLayer`）、
 * 布局常量（`ASSETS_DIR` 等，K03 布局的词汇表）与未接线的取消口（`cancelImport`，T5-7 的"可中断续跑"要用）。
 * 留着是判断，不是遗漏——所以把它变成机器判据：**新增零引用导出一律红**，删掉一个就把它从名单里划掉。
 *
 * 两条实现教训（第一版扫描器就是踩了这两个坑，把 75 条误报成"死代码"）：
 * ① 跳过"自己的声明行"时只能跳**那一行**，别把同一行里对它的使用一起跳掉
 *    （`export const appRoot = join(moduleDir, "..")` 既是声明行、又确实用了 `moduleDir`）；
 * ② 扫描根必须包含**测试目录**，否则"只被测试引用的公开 API"会被误判成死代码（那另有分类，不在这儿）。
 */

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

const SCAN_ROOTS = [
  "packages/@yushu",
  "apps/desktop/src",
  "apps/desktop/renderer",
  "apps/desktop/test",
  "apps/cli/src",
];
// 不含 apps/desktop/preload：那是 `.cjs`（本锁只解析 `.ts/.tsx`），列进来只会让"每个根都读到文件"这条红在空根上

/** 已知且有意保留的零引用导出：文件 → 符号名 */
const KNOWN_DEAD_EXPORTS: Record<string, string[]> = {
  "apps/desktop/src/main/import-ops.ts": ["cancelImport"],
  "packages/@yushu/core/src/types.ts": ["Relation", "Storyline"],
  "packages/@yushu/genre-engine/src/rule-dsl.ts": ["RULE_OPERATORS", "forbiddenOperatorHint"],
  "packages/@yushu/llm/src/batch.ts": ["BatchEligibleTask"],
  "packages/@yushu/memory/src/types.ts": ["MEMORY_API_VERSION", "MemoryLayer"],
  "packages/@yushu/world-engine/src/layout.ts": ["ASSETS_DIR", "PACKS_DIR", "SCHEMAS_DIR"],
};

const DECL = /^export\s+(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/;

function walk(dir: string, out: string[]): void {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === "node_modules" || name === "dist" || name === "out") continue;
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.tsx?$/.test(name)) out.push(abs);
  }
}

interface ScanResult {
  files: number;
  declarations: number;
  dead: Array<{ file: string; name: string }>;
}

function scan(): ScanResult {
  const files: string[] = [];
  for (const rel of SCAN_ROOTS) walk(join(ROOT, rel), files);
  // **本文件不进引用池**：名单里就写着这些符号的名字，拿自己当消费者会把它想拦的东西全放过
  // （"锁读原文被自己的注释喂饱"那一族，R99 写这条锁时真的踩到了：不加这行，dead 恒为 []）
  const self = fileURLToPath(import.meta.url);
  const texts = new Map<string, string>();
  for (const abs of files) {
    if (abs === self) continue;
    texts.set(abs, readFileSync(abs, "utf8"));
  }

  const dead: Array<{ file: string; name: string }> = [];
  let declarations = 0;
  for (const [abs, text] of texts) {
    for (const line of text.split(/\r?\n/)) {
      const match = DECL.exec(line.trim());
      if (!match) continue;
      const name = match[1];
      if (!name) continue;
      declarations += 1;
      const pattern = new RegExp(`\\b${name.replace(/\$/g, "\\$")}\\b`);
      let own = 0;
      for (const inner of text.split(/\r?\n/)) {
        // 只跳"就是它自己的声明行"：同一行别处的使用要算数
        const innerMatch = DECL.exec(inner.trim());
        if (innerMatch && innerMatch[1] === name) continue;
        if (pattern.test(inner)) own += 1;
      }
      let external = 0;
      for (const [other, otherText] of texts) {
        if (other === abs) continue;
        if (pattern.test(otherText)) external += 1;
      }
      if (own === 0 && external === 0) {
        dead.push({ file: relative(ROOT, abs).replace(/\\/g, "/"), name });
      }
    }
  }
  return { files: files.length, declarations, dead };
}

describe("零引用导出的登记与棘轮（R99）", () => {
  const result = scan();
  const known = Object.entries(KNOWN_DEAD_EXPORTS).flatMap(([file, names]) => names.map((name) => `${file}::${name}`));
  const found = result.dead.map((row) => `${row.file}::${row.name}`).sort();

  it("扫描器自己在干活（文件数与声明数都有下限，防「扫到 0 个就全绿」）", () => {
    expect(result.files, `实测扫到 ${result.files} 个源文件`).toBeGreaterThanOrEqual(300);
    expect(result.declarations, `实测解析出 ${result.declarations} 条导出声明`).toBeGreaterThanOrEqual(1000);
  });

  it("每个扫描根都真的读到文件（少一个根就整包漏检）", () => {
    const empty = SCAN_ROOTS.filter((rel) => {
      const listed: string[] = [];
      walk(join(ROOT, rel), listed);
      return listed.length === 0;
    });
    expect(empty, `这些扫描根一个文件都没读到：${empty.join(", ")}`).toEqual([]);
  });

  it("零引用导出的名单逐条对上（新增要红，删掉也要红在名单没更新）", () => {
    expect(found).toEqual([...known].sort());
  });

  it("棘轮只降不升", () => {
    expect(found.length).toBeLessThanOrEqual(known.length);
  });
});
