import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 写通道的包装器源码锁（R59 ①）。
 *
 * 起因是外部审计的一条指认：`git:rollback` 会把工作区文件整体落回旧提交（真源被改写），
 * 却注册在**只读**包装器 `wrap` 上——于是索引不刷新、一致性结论不置脏，面板继续显示回滚前的世界。
 * 同门的 `snapshot:restore` 走的是 `wrapWrite`，两条"恢复文件"的路径一条刷新一条不刷新，
 * 说明这不是设计而是漏。
 *
 * 为什么锁源码而不是锁行为：漏掉的根因是**没有东西逼着新通道表态**。`wrap` 与 `wrapWrite`
 * 长得很像、diff 里也只差五个字母，靠人盯迟早再漏一次。这里把"哪些通道会写真源"写成一张表，
 * 表里每条都必须是 `wrapWrite`；新增写通道就必须在表里出现，否则表与实现谁也没盯着谁。
 *
 * 表里的 `wrap` 一侧（NON_WRITE）同样写明理由：它们确实写盘，但写的是**派生物或被索引器排除的文件**，
 * 刷新索引对它们没有意义（旁路文件 `.conflict-*.md` 由 `index-input.ts` 的 CONFLICT_SIDECAR_RE 排除）。
 */

const SOURCE = readFileSync(new URL("../src/main/ipc.ts", import.meta.url), "utf8");

/** 会改写真源（Markdown / YAML 事实文件）的通道——必须走 wrapWrite */
const WRITE_CHANNELS = [
  "cardWrite",
  "docWrite",
  "docRename",
  "outlineGenerate",
  "outlineWrite",
  "outlineCreateChapter",
  "chapterWrite",
  "aiAdopt",
  "aiSaveConfig",
  "aiSaveKey",
  "aiClearKey",
  "snapshotRestore",
  "gitRollback",
  "memorySaveSummary",
  "memorySaveFact",
  "memoryDeleteFact",
  "extractAdopt",
] as const;

/** 写盘但不写真源（派生物 / 索引器排除文件 / .git 内部）——走只读包装器是有意的 */
const NON_WRITE_CHANNELS = [
  "chapterWriteSidecar",
  "exportRun",
  "statsSetGoal",
  "snapshotTake",
  "gitCommit",
  "gitInit",
  "recoveryWriteJournal",
  "recoveryClearJournal",
] as const;

/** 解析每个 `ipcMain.handle(CHANNELS.x, …)` 块，返回通道 → 所用包装器 */
function wrappersByChannel(): Map<string, "write" | "read" | "none"> {
  const out = new Map<string, "write" | "read" | "none">();
  // 通道名可能另起一行写（docWrite 那处就是），所以 `handle(` 之后允许空白再找 CHANNELS
  const head = /ipcMain\.handle\(\s*CHANNELS\.([a-zA-Z]+)/g;
  const starts: Array<{ at: number; name: string }> = [];
  for (;;) {
    const found = head.exec(SOURCE);
    if (!found) break;
    starts.push({ at: found.index, name: found[1] });
  }
  starts.forEach((entry, index) => {
    const end = index + 1 < starts.length ? starts[index + 1].at : SOURCE.length;
    const block = SOURCE.slice(entry.at, end);
    out.set(entry.name, block.includes("wrapWrite<") ? "write" : block.includes("wrap<") ? "read" : "none");
  });
  return out;
}

describe("写通道必须走 wrapWrite（R59 ①）", () => {
  const wrappers = wrappersByChannel();

  it("表里的通道都能在 ipc.ts 找到注册（改名或删注册要在这里红）", () => {
    const missing = [...WRITE_CHANNELS, ...NON_WRITE_CHANNELS].filter((name) => !wrappers.has(name));
    expect(missing).toEqual([]);
  });

  it("清单不缩水（少于 12 条写通道说明表被悄悄清空了）", () => {
    expect(WRITE_CHANNELS.length).toBeGreaterThanOrEqual(12);
  });

  it("回滚通道在写通道清单里（本轮审计指认的那一条）", () => {
    expect(WRITE_CHANNELS).toContain("gitRollback");
  });

  it.each(WRITE_CHANNELS)("%s 走 wrapWrite", (name) => {
    expect(wrappers.get(name)).toBe("write");
  });

  it.each(NON_WRITE_CHANNELS)("%s 有意走只读 wrap（派生物 / 索引器排除）", (name) => {
    expect(wrappers.get(name)).toBe("read");
  });
});
