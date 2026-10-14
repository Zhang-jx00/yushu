/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * utility 进程的收尾源码锁（R63 清理轮）。
 *
 * `repo-worker.ts` 里那个 `stopRepoWorker()` 是全仓**唯一**能关掉索引 utility 进程的钩子，
 * 而它此前没有任何调用点——等于"写了一个灭火器放在墙上，没人被允许拿"。
 * Electron 的 utilityProcess 不会随窗口关闭自动消失，所以这条不是洁癖，是资源泄漏。
 * 锁的形式：主进程入口必须在窗口全部关闭时调用它。把那一行删掉，本测试立刻红。
 */
describe("utility 进程收尾（repo-worker）", () => {
  const main = readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8");
  const worker = readFileSync(new URL("../src/main/repo-worker.ts", import.meta.url), "utf8");

  it("repo-worker 导出 stopRepoWorker", () => {
    expect(worker).toContain("export function stopRepoWorker");
  });

  it("主进程入口调用它，且挂在窗口全部关闭的收尾路径上", () => {
    expect(main).toContain("stopRepoWorker()");
    const handler = /app\.on\("window-all-closed",[\s\S]*?\n\}\);/.exec(main);
    expect(handler, "找不到 window-all-closed 处理器").not.toBeNull();
    expect(handler[0]).toContain("stopRepoWorker()");
  });
});
