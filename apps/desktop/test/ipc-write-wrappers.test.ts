/* SPDX-License-Identifier: Apache-2.0 */
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
  "proposalApply",
  // R79 存量导入·入库：建卷 + 建章纲 + 写章节草稿，全是真源写 ⇒ 必须与上面同一类
  // （R78 那条注记说的"import:apply 落地时必须换进写清单"，换的就是这一行）
  "importApply",
  // R102 视角看板的两处写入都是真源：`config/pov.yaml`（策略 YAML）与章 frontmatter 的 `pov`。
  // 走 wrapWrite 不只看哈希：策略一改，上一轮体检结论就该置脏；章一改，索引要跟着刷。
  "povWriteConfig",
  "povSetChapter",
  // R105 发布状态机：改状态要写章 frontmatter 的 status + `config/publish.yaml` 的留痕，
  // 设时要写章 frontmatter 的 publish_at —— **全是真源写** ⇒ 必须与上面同一类
  // （"只提醒不代替平台发布"是语义，不是"只读通道"的许可证）
  "publishSetStatus",
  "publishSchedule",
  // R135 底图登记：把图**拷进项目**（world/assets/map/…）+ 改 `world/map.yaml`
  // ⇒ 真源写 ⇒ 必须与上面同一类（写完索引要刷、上一轮体检结论要置脏）
  "worldMapUploadBase",
  // R138 框定边界：改 `world/map.yaml` 的 `bounds` 那一行 ⇒ 同样是真源写
  "worldMapSetBounds",
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
  // R61 影响传播：预览与决策都只写 `.yushu/proposals/`（派生区，经 writeDerived 的窄门），
  // 真源一个字节都不动 ⇒ 不该因此刷索引或置脏一致性结论（**写回那条 proposalApply 在写清单里**）
  "propagatePreview",
  "proposalDecide",
  "proposalList",
  // R77 存量导入·第一段可达的部分：pick 只把原生对话框结果登记进闸门（写的是进程内票据表，
  // 不是文件），preview 只读外部字节算报告——**一个字节都不落盘**，所以不该刷索引也不该置脏结论。
  // 真正会建卷建章的 `import:apply`（R78）必须进 WRITE_CHANNELS，别拿这两条的口径替它说话。
  "importPick",
  "importPreview",
  // R98 设定集导出：写的是 `exports/*.md` 派生物（与 `exportRun` 完全同一类），真源一个字节不动 ⇒ 不该刷索引
  "bibleRun",
  // R101 迁移包导出：写的是**项目外**用户选的目录，本项目真源与索引都不动 ⇒ 不走 wrapWrite（密钥剥离与复扫由自身判据钉）
  "projectExportRun",
  // R106 批量补摘要候选：**只发请求、只产候选**，真源一个字节不动（写库要走 memory:saveSummary，
  // 那条在写清单里）⇒ 走只读包装器是有意的。
  // 顺带说明它为什么仍属"只读"：AI 用量落的是 `.yushu/ai-usage.jsonl`（派生物，与其它 AI 通道同类）。
  "memorySummarizeBatch",
  // R107 导入·AI 二次筛选切章与人工校正：两条都**只改导入计划**（计划上下文跟着票据走），
  // 写盘仍是 import:apply 那条 ⇒ 只读包装器是有意的（"只改计划"不是"只读通道"的许可证）。
  "importAiSplit",
  "importCorrect",
  // R108 导入·取消与任务清单：`import:cancel` 作废票据 + 记一次取消标记（不碰真源，
  // 真正被改的是运行期的票据与标记）；`import:jobs` 只读任务记录。两条都不写真源 ⇒ 只读包装器。
  "importCancel",
  "importJobs",
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
    starts.push({ at: found.index, name: found[1] ?? "" });
  }
  starts.forEach((entry, index) => {
    const end = index + 1 < starts.length ? (starts[index + 1]?.at ?? SOURCE.length) : SOURCE.length;
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
