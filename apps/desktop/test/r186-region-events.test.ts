/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **区域内容查询的事件段**（R186 · R173 剩余片）。
 *
 * 判据盯四件事（两条腿：源码 + 归档回执；纯函数腿在 world-engine 的 timeline.test.ts）：
 * ① **口径在时间线域**：`eventsForEntities`（placeRef 命中才算、year 升序）是
 *    world-engine 的纯函数 ⇒ 两处消费不会各判一遍；
 * ② **数据不另造**：面板挂载时走 `api().timeline.view()` 现取（跨页可读的持久数据）；
 * ③ **空结果不渲染段**（如实说，不摆一个恒零的空壳）；
 * ④ **回执腿**：step159 取证（placeRef 命中的事件出现、没落到地点的不出现、
 *    标注段与锚点段仍在——三段互补）。
 *
 * **明写没做的**（真源层无链路，不假装）：「章节」——事件没有 chapterId 字段
 * （要先把「事件↔章节」做成真源字段，属数据模型变更，另立轮次）；
 * 「伏笔」——台账挂的是章号（plant_chapters），没有实体引用。
 */

const ROOT = join(__dirname, "..", "..", "..");
const panel = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "WorldMapPanel.tsx"), "utf8");
const engine = readFileSync(join(ROOT, "packages", "@yushu", "world-engine", "src", "timeline.ts"), "utf8");
const report = JSON.parse(
  readFileSync(join(ROOT, "docs", "assets", "m1-preview", "walkthrough-report.json"), "utf8"),
) as { steps: Array<{ step: number; ok: boolean; detail: string }> };

describe("区域内容查询的事件段（R186）：口径在时间线域，数据不另造", () => {
  it("**口径是纯函数**（eventsForEntities 在 world-engine；placeRef 命中才算、按 year 排）", () => {
    expect(engine, "eventsForEntities 不在时间线域（放渲染层就会两处各判一遍）").toContain(
      "export function eventsForEntities",
    );
    expect(engine, "判定没有认 placeRef").toContain("entityIds.has(row.placeRef)");
    expect(engine, "没有按 year 排序").toContain("a.year - b.year");
  });

  it("**数据从通道现取**（timeline.view 挂载取数；事件段用同一个纯函数现算）", () => {
    expect(panel, "面板没有取时间线行").toContain(".timeline.view()");
    expect(panel, "事件段没有走纯函数").toContain("eventsForEntities(timelineRows, entityIds)");
    expect(panel, "事件行没有对账锚点").toContain("data-rc-event=");
  });

  it("**空结果不渲染段**（events.length === 0 ⇒ return null，不摆恒零空壳）", () => {
    expect(panel, "空结果没有如实不渲染").toContain("if (events.length === 0) return null;");
  });

  it("**回执腿：step159 取证过**（命中才出现 + 不出现没落点的 + 三段互补）", () => {
    const step = report.steps.find((row) => row.step === 159);
    expect(step, "报告里没有 step159（事件段取证）那一步").toBeTruthy();
    expect((step as { ok: boolean }).ok, "step159 没过").toBe(true);
    const detail = (step as { detail: string }).detail;
    expect(detail, "step159 没取证命中口径").toContain("命中=true");
    expect(detail, "step159 没取证没落点的不出现").toContain("不出现=true");
    expect(detail, "step159 没取证三段互补").toContain("标注段=");
    expect(detail, "step159 没取证锚点段").toContain("锚点段在=true");
  });
});
