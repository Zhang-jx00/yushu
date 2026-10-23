/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * IPC 四处对账（R66 补的锁）。
 *
 * CONTRIBUTING.md 写着"新增通道必须四处同步，仓库里有源码锁测试会当场拦住漏掉的四处"——
 * 那句话在写下来时**并没有对应的测试**（只有 R59 的写通道包装器锁）。这条文件把它变成事实。
 *
 * 四处：
 * ① `src/shared/ipc.ts` 的 `CHANNELS`（唯一事实源）
 * ② `src/main/ipc.ts` 的 `ipcMain.handle(CHANNELS.x, ...)`（主进程注册）
 * ③ `preload/preload.cjs` 的 `invoke("ns:verb")` 字面量（白名单）
 * ④ `renderer/src/api.ts` 的 `YushuApi` 接口 `组.方法`（渲染层可见面）
 *
 * 口径：**以 ② 注册过的通道为基准**——注册了却没进白名单 = 渲染层调不到（静默功能缺失）；
 * 白名单里有却没注册 = 调用即 E_UNKNOWN；① 里有却既没注册也没暴露 = 死通道。
 * 单向事件通道（`webContents.send`）不在 invoke 白名单里，单独按事件清单核对。
 */

const shared = readFileSync(new URL("../src/shared/ipc.ts", import.meta.url), "utf8");
const mainIpc = readFileSync(new URL("../src/main/ipc.ts", import.meta.url), "utf8");
const preload = readFileSync(new URL("../preload/preload.cjs", import.meta.url), "utf8");
const apiTs = readFileSync(new URL("../renderer/src/api.ts", import.meta.url), "utf8");

/** ① CHANNELS 的 name → 字面量 */
function channelMap(): Map<string, string> {
  const block = /export const CHANNELS = \{([\s\S]*?)\} as const;/.exec(shared);
  if (!block) throw new Error("找不到 CHANNELS 块（改了结构就要同步改这条锁）");
  const out = new Map<string, string>();
  for (const [, name, value] of (block[1] ?? "").matchAll(/^\s*(\w+):\s*"([^"]+)",/gm)) {
    if (name === undefined || value === undefined) continue;
    out.set(name, value);
  }
  return out;
}

/** ② 主进程注册了哪些 CHANNELS.x */
function registeredNames(): string[] {
  return [...mainIpc.matchAll(/ipcMain\.handle\(\s*CHANNELS\.(\w+)/g)]
    .map((m) => m[1])
    .filter((n): n is string => n !== undefined);
}

/** ③ preload 白名单里的字面量（invoke 与单向 on 都算暴露面） */
function preloadLiterals(): { invoke: Set<string>; events: Set<string> } {
  const invoke = new Set<string>();
  for (const m of preload.matchAll(/invoke\(\s*"([^"]+)"/g)) {
    if (m[1] !== undefined) invoke.add(m[1]);
  }
  const events = new Set<string>();
  for (const m of preload.matchAll(/(?:on|once)\(\s*"([^"]+)"/g)) {
    if (m[1] !== undefined) events.add(m[1]);
  }
  return { invoke, events };
}

/** preload 里函数体也会出现 `return (` 这类行，别把它当方法名 */
const NOT_A_METHOD = new Set(["return", "const", "let", "if", "for", "while", "await", "void", "new"]);

/** ④ 渲染层接口与 preload 的「组.方法」集合（结构性对账，两边同一套解析） */
function memberPaths(source: string, startRe: RegExp): Set<string> {
  const start = startRe.exec(source);
  if (!start) throw new Error("找不到接口/白名单起点（改了结构就要同步改这条锁）");
  const out = new Set<string>();
  let group = "";
  for (const line of source.slice(start.index).split("\n")) {
    const opened = /^\s{2}(\w+):\s*\{/.exec(line) || /^\s{4}(\w+):\s*\{/.exec(line);
    if (opened) {
      group = opened[1] ?? "";
      continue;
    }
    const method = /^\s+(?:readonly\s+)?(\w+)\s*[:(]/.exec(line);
    if (method && method[1] !== undefined && group !== "" && !NOT_A_METHOD.has(method[1])) {
      out.add(`${group}.${method[1]}`);
      continue;
    }
    if (/^\s{2}\}/.test(line)) group = "";
    if (/^\}/.test(line)) break;
  }
  return out;
}

describe("IPC 四处对账（shared → main → preload → renderer api）", () => {
  const channels = channelMap();
  const registered = registeredNames();
  const literals = preloadLiterals();

  it("注册的每个通道都来自 CHANNELS（不在表里的字面量等于开后门）", () => {
    const unknown = registered.filter((name) => !channels.has(name));
    expect(unknown).toEqual([]);
  });

  it("每个注册通道都进了 preload 白名单（漏了就是渲染层调不到的静默缺失）", () => {
    const missing = registered
      .map((name) => channels.get(name) as string)
      .filter((literal) => !literals.invoke.has(literal) && !literals.events.has(literal));
    expect(missing).toEqual([]);
  });

  it("preload 白名单里没有未注册的通道（调了就 E_UNKNOWN，不如现在红）", () => {
    const known = new Set<string>([...channels.values()]);
    const orphans = [...literals.invoke, ...literals.events].filter((literal) => !known.has(literal));
    expect(orphans).toEqual([]);
  });

  it("渲染层 api 的「组.方法」覆盖 preload 暴露面（少一个方法就是界面拿不到）", () => {
    const exposed = memberPaths(preload, /contextBridge\.exposeInMainWorld/);
    const typed = memberPaths(apiTs, /export interface YushuApi \{/);
    const missing = [...exposed].filter((path) => !typed.has(path));
    expect(missing).toEqual([]);
  });

  it("伏笔看板通道在四处齐备（本轮新增的那一条，逐处点名）", () => {
    expect(channels.get("foreshadowBoard")).toBe("foreshadow:board");
    expect(registered).toContain("foreshadowBoard");
    expect(literals.invoke.has("foreshadow:board")).toBe(true);
    expect(memberPaths(apiTs, /export interface YushuApi \{/).has("foreshadow.board")).toBe(true);
  });

  it("时间线视图通道在四处齐备（R68 新增；带参只读通道同样要过这道闸）", () => {
    expect(channels.get("timelineView")).toBe("timeline:view");
    expect(registered).toContain("timelineView");
    expect(literals.invoke.has("timeline:view")).toBe(true);
    expect(memberPaths(apiTs, /export interface YushuApi \{/).has("timeline.view")).toBe(true);
  });

  it("关系图谱通道在四处齐备（R69 新增）", () => {
    expect(channels.get("graphRelation")).toBe("graph:relation");
    expect(registered).toContain("graphRelation");
    expect(literals.invoke.has("graph:relation")).toBe(true);
    expect(memberPaths(apiTs, /export interface YushuApi \{/).has("graph.relation")).toBe(true);
  });

  it("编年史通道在四处齐备（R71 新增）", () => {
    expect(channels.get("chronicleBook")).toBe("chronicle:book");
    expect(registered).toContain("chronicleBook");
    expect(literals.invoke.has("chronicle:book")).toBe(true);
    expect(memberPaths(apiTs, /export interface YushuApi \{/).has("chronicle.book")).toBe(true);
  });

  it("世界地图通道在四处齐备（R120 新增：只读，无入参——图层显隐在渲染层做）", () => {
    expect(channels.get("worldMapView")).toBe("map:view");
    expect(registered).toContain("worldMapView");
    expect(literals.invoke.has("map:view")).toBe(true);
    expect(memberPaths(apiTs, /export interface YushuApi \{/).has("map.view")).toBe(true);
  });

  it("世界地图底图通道在四处齐备（R123 新增：只读，读成 data URL）", () => {
    expect(channels.get("worldMapBase")).toBe("map:base");
    expect(registered).toContain("worldMapBase");
    expect(literals.invoke.has("map:base")).toBe(true);
    expect(memberPaths(apiTs, /export interface YushuApi \{/).has("map.base")).toBe(true);
  });

  it("底图登记通道在四处齐备（R135 新增：**写盘**——拷进项目 + 改 map.yaml）", () => {
    expect(channels.get("worldMapUploadBase")).toBe("map:uploadBase");
    expect(registered).toContain("worldMapUploadBase");
    expect(literals.invoke.has("map:uploadBase")).toBe(true);
    expect(memberPaths(apiTs, /export interface YushuApi \{/).has("map.uploadBase")).toBe(true);
  });

  it("框定边界通道在四处齐备（R138 新增：**写盘**——改 map.yaml 的 bounds 那一行）", () => {
    expect(channels.get("worldMapSetBounds")).toBe("map:setBounds");
    expect(registered).toContain("worldMapSetBounds");
    expect(literals.invoke.has("map:setBounds")).toBe(true);
    expect(memberPaths(apiTs, /export interface YushuApi \{/).has("map.setBounds")).toBe(true);
  });

  it("挪标注通道在四处齐备（R139 新增：**写盘**——改 map.yaml 里那一个标注的 x / y）", () => {
    expect(channels.get("worldMapSetMarker")).toBe("map:setMarker");
    expect(registered).toContain("worldMapSetMarker");
    expect(literals.invoke.has("map:setMarker")).toBe(true);
    expect(memberPaths(apiTs, /export interface YushuApi \{/).has("map.setMarker")).toBe(true);
  });

  it("放标注通道在四处齐备（R140 新增：**写盘**——往 map.yaml 的 markers 段追加一行）", () => {
    expect(channels.get("worldMapCreateMarker")).toBe("map:createMarker");
    expect(registered).toContain("worldMapCreateMarker");
    expect(literals.invoke.has("map:createMarker")).toBe(true);
    expect(memberPaths(apiTs, /export interface YushuApi \{/).has("map.createMarker")).toBe(true);
  });

  it("挪事件锚点通道在四处齐备（R141 新增：**写盘**——改 map.yaml 里那一个锚点的 x / y）", () => {
    expect(channels.get("worldMapSetAnchor")).toBe("map:setAnchor");
    expect(registered).toContain("worldMapSetAnchor");
    expect(literals.invoke.has("map:setAnchor")).toBe(true);
    expect(memberPaths(apiTs, /export interface YushuApi \{/).has("map.setAnchor")).toBe(true);
  });

  it("爽点看板通道在四处齐备（R73 新增）", () => {
    expect(channels.get("satisfactionBoard")).toBe("satisfaction:board");
    expect(registered).toContain("satisfactionBoard");
    expect(literals.invoke.has("satisfaction:board")).toBe(true);
    expect(memberPaths(apiTs, /export interface YushuApi \{/).has("satisfaction.board")).toBe(true);
  });

  it("存量导入两条通道在四处齐备（R77 新增：pick 只回票据、preview 只读）", () => {
    expect(channels.get("importPick")).toBe("import:pick");
    expect(channels.get("importPreview")).toBe("import:preview");
    expect(registered).toContain("importPick");
    expect(registered).toContain("importPreview");
    expect(literals.invoke.has("import:pick")).toBe(true);
    expect(literals.invoke.has("import:preview")).toBe(true);
    const typed = memberPaths(apiTs, /export interface YushuApi \{/);
    expect(typed.has("import.pick")).toBe(true);
    expect(typed.has("import.preview")).toBe(true);
  });

  it("迁移包三条通道在四处齐备（R101 新增：pick 只回票据、preview 只读、run 写项目外目录）", () => {
    expect(channels.get("projectExportPick")).toBe("project:exportPick");
    expect(channels.get("projectExportPreview")).toBe("project:exportPreview");
    expect(channels.get("projectExportRun")).toBe("project:exportRun");
    expect(registered).toContain("projectExportPick");
    expect(registered).toContain("projectExportPreview");
    expect(registered).toContain("projectExportRun");
    expect(literals.invoke.has("project:exportPick")).toBe(true);
    expect(literals.invoke.has("project:exportPreview")).toBe(true);
    expect(literals.invoke.has("project:exportRun")).toBe(true);
    const typed = memberPaths(apiTs, /export interface YushuApi \{/);
    expect(typed.has("project.exportPick")).toBe(true);
    expect(typed.has("project.exportPreview")).toBe(true);
    expect(typed.has("project.exportRun")).toBe(true);
  });

  it("视角看板三条通道在四处齐备（R102 新增：preview 只读，另两条写真源）", () => {
    expect(channels.get("povPreview")).toBe("pov:preview");
    expect(channels.get("povWriteConfig")).toBe("pov:writeConfig");
    expect(channels.get("povSetChapter")).toBe("pov:setChapter");
    expect(registered).toContain("povPreview");
    expect(registered).toContain("povWriteConfig");
    expect(registered).toContain("povSetChapter");
    expect(literals.invoke.has("pov:preview")).toBe(true);
    expect(literals.invoke.has("pov:writeConfig")).toBe(true);
    expect(literals.invoke.has("pov:setChapter")).toBe(true);
    const typed = memberPaths(apiTs, /export interface YushuApi \{/);
    expect(typed.has("pov.preview")).toBe(true);
    expect(typed.has("pov.writeConfig")).toBe(true);
    expect(typed.has("pov.setChapter")).toBe(true);
  });

  it("设定集两条通道在四处齐备（R98 新增：preview 只读、run 只写 exports/ 派生物）", () => {
    expect(channels.get("biblePreview")).toBe("bible:preview");
    expect(channels.get("bibleRun")).toBe("bible:run");
    expect(registered).toContain("biblePreview");
    expect(registered).toContain("bibleRun");
    expect(literals.invoke.has("bible:preview")).toBe(true);
    expect(literals.invoke.has("bible:run")).toBe(true);
    const typed = memberPaths(apiTs, /export interface YushuApi \{/);
    expect(typed.has("bible.preview")).toBe(true);
    expect(typed.has("bible.run")).toBe(true);
  });

  it("发布状态机三条通道在四处齐备（R105 新增：board 只读，另两条写真源）", () => {
    expect(channels.get("publishBoard")).toBe("publish:board");
    expect(channels.get("publishSetStatus")).toBe("publish:setStatus");
    expect(channels.get("publishSchedule")).toBe("publish:schedule");
    expect(registered).toContain("publishBoard");
    expect(registered).toContain("publishSetStatus");
    expect(registered).toContain("publishSchedule");
    expect(literals.invoke.has("publish:board")).toBe(true);
    expect(literals.invoke.has("publish:setStatus")).toBe(true);
    expect(literals.invoke.has("publish:schedule")).toBe(true);
    const typed = memberPaths(apiTs, /export interface YushuApi \{/);
    expect(typed.has("publish.board")).toBe(true);
    expect(typed.has("publish.setStatus")).toBe(true);
    expect(typed.has("publish.schedule")).toBe(true);
  });

  it("导入·AI 筛选与人工校正两条通道在四处齐备（R107 新增：两条都只改计划）", () => {
    expect(channels.get("importAiSplit")).toBe("import:aiSplit");
    expect(channels.get("importCorrect")).toBe("import:correct");
    expect(registered).toContain("importAiSplit");
    expect(registered).toContain("importCorrect");
    expect(literals.invoke.has("import:aiSplit")).toBe(true);
    expect(literals.invoke.has("import:correct")).toBe(true);
    const typed = memberPaths(apiTs, /export interface YushuApi \{/);
    expect(typed.has("import.aiSplit")).toBe(true);
    expect(typed.has("import.correct")).toBe(true);
  });

  it("导入·取消与任务清单两条通道在四处齐备（R108 新增：可中断续跑那两半）", () => {
    expect(channels.get("importCancel")).toBe("import:cancel");
    expect(channels.get("importJobs")).toBe("import:jobs");
    expect(registered).toContain("importCancel");
    expect(registered).toContain("importJobs");
    expect(literals.invoke.has("import:cancel")).toBe(true);
    expect(literals.invoke.has("import:jobs")).toBe(true);
    const typed = memberPaths(apiTs, /export interface YushuApi \{/);
    expect(typed.has("import.cancel")).toBe(true);
    expect(typed.has("import.jobs")).toBe(true);
  });

  it("入库通道在四处齐备（R79 新增：这条是真源写，与上面两条只读的不是一类）", () => {
    expect(channels.get("importApply")).toBe("import:apply");
    expect(registered).toContain("importApply");
    expect(literals.invoke.has("import:apply")).toBe(true);
    expect(memberPaths(apiTs, /export interface YushuApi \{/).has("import.apply")).toBe(true);
  });
});
