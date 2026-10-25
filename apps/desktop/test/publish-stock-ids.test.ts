/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 存稿池的**口径必须逐字一致**，且**不许另造写入点**（R174 / M5 T5-6）。
 *
 * 这条锁盯三件具体的事：
 *
 * ① **四种处境四处一致**：引擎的 `STOCK_DUE_STATES`、共享层的 `PUBLISH_STOCK_DUE_STATES`
 *    （零依赖文件只能本地抄一份）、面板的 `DUE_STATE_LABEL`。
 *    少改一处不会立刻报错，但面板上会出现一个**没有标签**的处境
 *    （作者看到空白格，只能猜那是"临期"还是"已定时"）。
 *
 * ② **桌面侧不自己判到期**：到期判定只有一个出处（引擎的 `publishAtDueMs`）。
 *    桌面侧若自己写一遍 `publish_at` 与 now 的比较式，那就有两个"到期 N 条"。
 *
 * ③ **存稿池不新增写入通道**：池子里每行的两个动作必须走**既有**那两条通道
 *    （`publish:setStatus` / `publish:schedule`）——另造第三套写入点就会漂，
 *    漂出来的按钮点下去只会被引擎拒（与"渲染层不自己抄一份迁移表"同一条纪律）。
 */

const engine = readFileSync(
  new URL("../../../packages/@yushu/world-engine/src/publish-stock.ts", import.meta.url),
  "utf8",
);
const publishEngine = readFileSync(
  new URL("../../../packages/@yushu/world-engine/src/publish.ts", import.meta.url),
  "utf8",
);
const ops = readFileSync(new URL("../src/main/publish-ops.ts", import.meta.url), "utf8");
const shared = readFileSync(new URL("../src/shared/ipc.ts", import.meta.url), "utf8");
const panel = readFileSync(
  new URL("../renderer/src/components/PublishPanel.tsx", import.meta.url),
  "utf8",
);

/** 从 `export const STOCK_DUE_STATES = ["due", "soon", ...] as const` 里取出值 */
function engineStates(): string[] {
  const match = /STOCK_DUE_STATES\s*=\s*\[([^\]]*)\]/.exec(engine);
  if (match === null) throw new Error("publish-stock.ts 里找不到 STOCK_DUE_STATES");
  return [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((item) => item[1] ?? "").filter((item) => item !== "");
}

/** 从 `export const PUBLISH_STOCK_DUE_STATES = [...] as const` 里取出值 */
function sharedStates(): string[] {
  const match = /PUBLISH_STOCK_DUE_STATES\s*=\s*\[([^\]]*)\]/.exec(shared);
  if (match === null) throw new Error("shared/ipc.ts 里找不到 PUBLISH_STOCK_DUE_STATES");
  return [...(match[1] ?? "").matchAll(/"([^"]+)"/g)].map((item) => item[1] ?? "").filter((item) => item !== "");
}

/** 面板 `DUE_STATE_LABEL` 的键 */
function panelStates(): string[] {
  const match = /DUE_STATE_LABEL:\s*Record<[^>]+>\s*=\s*\{([\s\S]*?)\}/.exec(panel);
  if (match === null) throw new Error("PublishPanel.tsx 里找不到 DUE_STATE_LABEL");
  return [...(match[1] ?? "").matchAll(/^\s*([a-z_]+):/gm)].map((item) => item[1] ?? "").filter((item) => item !== "");
}

describe("存稿池口径逐字一致（R174）", () => {
  it("引擎的 STOCK_DUE_STATES 就是那四种处境", () => {
    expect(engineStates()).toEqual(["due", "soon", "scheduled", "stock"]);
  });

  it("共享层抄的那一份与引擎逐字一致（零依赖文件抄了就得钉死）", () => {
    expect(sharedStates()).toEqual(engineStates());
  });

  it("面板给每一种处境都有标签（不许出现没有名字的格子）", () => {
    expect(panelStates().sort()).toEqual([...engineStates()].sort());
  });

  it("临期窗口与预警阈值是引擎里的具名常量，不许散落成字面量", () => {
    expect(engine).toContain("export const STOCK_SOON_WINDOW_MS");
    expect(engine).toContain("export const STOCK_WARN_DAYS");
    // 桌面侧不许自己写这两个数（它们是口径，不是实现细节）
    expect(ops).not.toMatch(/48\s*\*\s*60/);
    expect(ops).not.toMatch(/STOCK_WARN_DAYS\s*=/);
  });
});

describe("到期判定只有一个出处（R174）", () => {
  it("引擎把到期判定拎成了 publishAtDueMs，提醒队列与存稿池都调它", () => {
    expect(publishEngine).toContain("export function publishAtDueMs");
    expect(publishEngine).toMatch(/publishAtDueMs\s*\(/);
    // 提醒队列里那句比较式已经被替换掉（不再各写一遍）
    expect(publishEngine).not.toMatch(/if\s*\(atMs\s*>\s*nowMs\)\s*continue;/);
  });

  it("桌面侧不自己判到期：它调引擎的 planStockPool，且不自己比较 publish_at 与 now", () => {
    expect(ops).toContain("planStockPool(");
    expect(ops).not.toMatch(/Date\.parse\([^)]*publishAt/);
    expect(ops).not.toMatch(/publishAt[^\n]*[<>]\s*now/);
  });
});

describe("存稿池不另造写入点（R174）", () => {
  it("发布线仍然只有三条通道：看板 / 改状态 / 设定定时（存稿池不新增）", () => {
    const channels = [...shared.matchAll(/publish[A-Za-z]+:\s*"publish:[a-zA-Z]+"/g)].map((item) => item[0]);
    expect(channels).toHaveLength(3);
    expect(channels.join("|")).toContain("publish:board");
    expect(channels.join("|")).toContain("publish:setStatus");
    expect(channels.join("|")).toContain("publish:schedule");
  });

  it("池子里每行的两个动作走既有通道，并且是真 <button>（键盘可达）", () => {
    expect(panel).toContain("api().publish.setStatus(");
    expect(panel).toContain("api().publish.schedule(");
    expect(panel).toContain('data-stock-action="publish"');
    expect(panel).toContain('data-stock-action="undo-reminder"');
    expect(panel).toContain("<button");
  });
});
