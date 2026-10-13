import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * "视图只读真源、不依赖索引库"的源码锁（M4 / 验收 A5 的前半，R68）。
 *
 * A5 要的是：**删掉 `.yushu/index.db` 之后，浏览与体检只是检索退化，视图不能塌**。
 * 与其每次都演一遍"删库再看"，更硬的是从结构上断掉依赖——这两个 ops 模块**根本不 import 索引层**，
 * 所以索引在不在，它们读到的字节都一样。引擎侧同理：判定吃的是真源解析出来的行表，不是 SQLite 查询结果。
 *
 * 这条锁能红：往这两个文件里加任何一条 `@yushu/search` / `./index-ops.js` 的 import，它立刻点名。
 */

const FILES = [
  { path: "src/main/timeline-ops.ts", why: "时间线视图（T4-7）" },
  { path: "src/main/foreshadow-ops.ts", why: "伏笔台账看板（T4-6）" },
];

/** 索引层与派生库的入口：出现任何一个就说明视图开始依赖可删的派生物 */
const FORBIDDEN = [
  "@yushu/search",
  "./index-ops.js",
  "./indexer.js",
  "repo-worker.js",
  "index.db",
  "openIndex",
];

describe("视图只读真源（A5 前半：不依赖索引库）", () => {
  for (const file of FILES) {
    it(`${file.path}（${file.why}）不引用索引层，只走 FileGateway 读真源`, () => {
      const source = readFileSync(new URL(`../${file.path}`, import.meta.url), "utf8");
      const hits = FORBIDDEN.filter((token) => source.includes(token));
      expect(hits).toEqual([]);
      expect(source).toContain("gateway.readDoc(");
    });
  }

  it("时间线引擎侧的判定输入是真源解析结果，不是索引行表", () => {
    const source = readFileSync(new URL("../../../packages/@yushu/world-engine/src/timeline.ts", import.meta.url), "utf8");
    // 只允许 yaml / core 两个运行时依赖：一旦开始 import 索引包，"删库视图就塌"就成真了
    const imports = [...source.matchAll(/^import .*from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.every((spec) => ["@yushu/core", "yaml", "./power-log.js"].includes(spec))).toBe(true);
  });
});
