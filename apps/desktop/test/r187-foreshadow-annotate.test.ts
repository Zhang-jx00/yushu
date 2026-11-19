/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **钩子标注**（R187）：作者在编辑器里把本章标进伏笔的埋设 / 回收章清单——
 * 写进真源 `world/foreshadow.yaml`，**与 T4-6 台账同源（不许两本账）**。
 *
 * 判据盯四件事（两条腿：源码 + 归档回执；纯函数腿在 world-engine 的 foreshadow.test.ts）：
 * ① **写通道是专用窄通道**（map-ops 家族先例）：CHANNELS + wrapWrite + WRITE_CHANNELS 补登；
 *    落盘用引擎现成的 `serializeForeshadowLedger`（键序固定防 diff 淹没）；
 * ② **同源由数据流保证**：读写都走真源（gateway），判定永远 buildForeshadowBoard 现算，
 *    写动作**返回重算的看板** ⇒ 面板与台账页拿同一个载荷（不靠两边各刷一遍）；
 * ③ **面板不自己算读数**：state/overdueBy 全部来自载荷（R65 纪律：不替作者改状态）；
 *    章号锚点 `data-annotate-chapter` 供预演对账盘上 plant_chapters；
 * ④ **回执腿**：step160 取证（盘上 plant_chapters 含当前章 + 徽标 + 撤销回原样）。
 */

const ROOT = join(__dirname, "..", "..", "..");
const ops = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "foreshadow-ops.ts"), "utf8");
const ipc = readFileSync(join(ROOT, "apps", "desktop", "src", "shared", "ipc.ts"), "utf8");
const panel = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "ForeshadowAnnotate.tsx"), "utf8");
const writeWrappers = readFileSync(join(ROOT, "apps", "desktop", "test", "ipc-write-wrappers.test.ts"), "utf8");
const report = JSON.parse(
  readFileSync(join(ROOT, "docs", "assets", "m1-preview", "walkthrough-report.json"), "utf8"),
) as { steps: Array<{ step: number; ok: boolean; detail: string }> };

describe("钩子标注（R187）：写通道与同源", () => {
  it("**专用窄通道**（CHANNELS + wrapWrite + WRITE_CHANNELS 补登；落盘用引擎序列化器）", () => {
    expect(ipc, "CHANNELS 里没有 foreshadowAnnotate").toContain('foreshadowAnnotate: "foreshadow:annotate"');
    expect(ops, "写盘没用引擎的序列化器（键序固定防 diff 淹没）").toContain("serializeForeshadowLedger(nextLedger)");
    expect(writeWrappers, "WRITE_CHANNELS 没补登 foreshadowAnnotate").toContain('"foreshadowAnnotate"');
    expect(ops, "找不到那条伏笔时没有点名拒绝").toContain("找不到这条伏笔");
  });

  it("**同源由数据流保证**（读写走真源；返回重算看板；面板不自己算读数）", () => {
    expect(ops, "写动作没有走真源读（同源破功）").toContain("gateway.readDoc(FORESHADOW_PATH)");
    expect(ops, "写动作没有走真源写").toContain("gateway.writeDoc(FORESHADOW_PATH");
    expect(ops, "返回的不是重算的看板（面板与台账页会各拿一份）").toContain("return {");
    expect(panel, "面板写后没有用返回值刷新（会各拉一份）").toContain("setBoard(next)");
    expect(panel, "面板摆了当前章的对账锚点").toContain("data-annotate-chapter=");
    expect(panel, "面板没有明示「当前章」口径").toContain("章清单最后一章");
  });

  it("**回执腿：step160 取证过**（盘上真源变了 + 徽标 + 撤销回原样）", () => {
    const step = report.steps.find((row) => row.step === 160);
    expect(step, "报告里没有 step160（钩子标注取证）那一步").toBeTruthy();
    expect((step as { ok: boolean }).ok, "step160 没过").toBe(true);
    const detail = (step as { detail: string }).detail;
    expect(detail, "step160 没取证盘上真源变了").toContain("盘上 plant_chapters 含本章=true");
    expect(detail, "step160 没取证徽标").toContain("已埋于本章」=true");
    expect(detail, "step160 没取证撤销回原样").toContain("撤销后盘上回原样=true");
  });
});
