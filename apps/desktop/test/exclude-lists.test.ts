/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { GIT_EXCLUDES } from "../src/main/git-ops.js";
import { WALK_EXCLUDES } from "../src/main/file-gateway.js";
import { DEFAULT_INDEX_EXCLUDES } from "@yushu/world-engine";

/**
 * 三张"哪些目录不算作者内容"的清单必须同源（R80，接外部审计那条"排除清单三向一致"）。
 *
 * 仓库里现在有三处各写一份：
 * - `GIT_EXCLUDES`（git-ops）：决定哪些文件不进版本管理，也是生成项目 `.gitignore` 的唯一来源；
 * - `DEFAULT_INDEX_EXCLUDES`（world-engine/index-input）：决定哪些文件进检索索引；
 * - `WALK_EXCLUDES`（file-gateway）：决定目录树遍历跳过什么。
 *
 * 漂移的真实代价不是"少排一个目录"，而是**同一份派生物在一处被当作者内容、在另一处被当垃圾**：
 * 比如给 git 加了 `imports/` 却忘了给索引加 ⇒ 导入作业状态被当成正文片段检索出来，
 * 搜索结果里出现一堆 YAML 作业记录，作者只会觉得"这工具在发疯"。三条断言各挡一种漂：
 * ① git 与索引**逐字等集**（两者语义相同：不是作者写的东西）；
 * ② 树遍历跳过的目录必须是 git/索引也跳过的子集（树都不显示的东西不该出现在提交里）；
 * ③ 反向不成立是**有意的**：`exports/` 要在文件树里看得见（作者要找自己的导出件），
 *    但不进 git 也不进索引——所以这里断言它"在 git/索引里、不在树排除里"，
 *    而不是笼统要求三者相同（那样会把这条设计意图抹平）。
 */

const dirsOf = (prefixes: readonly string[]): string[] =>
  prefixes.map((prefix) => prefix.replace(/\/$/, "")).sort();

describe("排除清单三向一致", () => {
  it("git 与索引两份逐字等集（同一语义，不许各写一份）", () => {
    expect(dirsOf(GIT_EXCLUDES)).toEqual(dirsOf(DEFAULT_INDEX_EXCLUDES));
  });

  it("目录树跳过的，git 与索引也一定跳过（子集方向）", () => {
    const excluded = new Set(dirsOf(GIT_EXCLUDES));
    const missing = [...WALK_EXCLUDES].filter((name) => !excluded.has(name));
    expect(missing).toEqual([]);
  });

  it("exports/ 是刻意的例外：树里看得见，git 与索引都不收", () => {
    expect(dirsOf(GIT_EXCLUDES)).toContain("exports");
    expect(dirsOf(DEFAULT_INDEX_EXCLUDES)).toContain("exports");
    expect(WALK_EXCLUDES.has("exports")).toBe(false);
  });

  it("凭据与索引库所在的 .yushu/ 三处都排除（红线：派生物与凭据不入库不进索引）", () => {
    expect(dirsOf(GIT_EXCLUDES)).toContain(".yushu");
    expect(dirsOf(DEFAULT_INDEX_EXCLUDES)).toContain(".yushu");
    expect(WALK_EXCLUDES.has(".yushu")).toBe(true);
  });
});
