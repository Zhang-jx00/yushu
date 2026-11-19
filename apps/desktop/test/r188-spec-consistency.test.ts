/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkPlatformSpecConsistency,
  type PlatformSpec,
} from "@yushu/export";

/**
 * **跨包一致性接进桌面侧**（R178 欠账结清）。
 *
 * R177 押后时的话：「没有消费者就不算做完」⇒ 本轮接线：
 * **全部**合规规则包一起喂给引擎的 `checkPlatformSpecConsistency`
 * （漏一个包，这条校验就只剩半个世界），结论进导出页载荷 ⇒ 界面如实说。
 *
 * 判据盯四件事（两条腿：源码 + 归档回执；引擎单测已有——R177 的 6 处）：
 * ① **接线在主进程**（export-ops 扫 spec ⇒ 引擎校验 ⇒ 结论进载荷）；
 * ② **坏包不进校验**（它们自己在 platforms 清单里带着 parseError 露脸）；
 * ③ **界面如实说**（0 包无从校验 / 1 包无从打架 / 0 冲突「口径不打架」/ 冲突逐条点名）；
 * ④ **回执腿**：step161 取证。
 */

const ROOT = join(__dirname, "..", "..", "..");
const exportOps = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "export-ops.ts"), "utf8");
const view = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "views", "ExportView.tsx"), "utf8");
const ipc = readFileSync(join(ROOT, "apps", "desktop", "src", "shared", "ipc.ts"), "utf8");
const report = JSON.parse(
  readFileSync(join(ROOT, "docs", "assets", "m1-preview", "walkthrough-report.json"), "utf8"),
) as { steps: Array<{ step: number; ok: boolean; detail: string }> };

/** 内存里造两份打架的 spec（单测腿：引擎判据抓得到人） */
const specA = {
  apiVersion: "yushu.platform-spec/v1",
  platform: "demo",
  packId: "demo-a",
  source_urls: ["https://example.com/a"],
  rules: [
    {
      id: "demo-daily-words",
      title: "日更字数",
      field: "daily_update_words",
      value: 2000,
      unit: "字/日",
      meaning: "每日更新字数口径",
      source: "https://example.com/a#r1",
      effective_from: "2026-01-01",
    },
  ],
} as unknown as PlatformSpec;

describe("跨包一致性接线（R188）：结论进载荷，界面如实说", () => {
  it("**单测腿：引擎判据抓得到打架**（id 撞车 + 口径同义不同 ⇒ 两条冲突）", () => {
    const specB = {
      ...specA,
      platform: "demo",
      packId: "demo-b",
      rules: [
        {
          id: "demo-daily-words",
          title: "日更字数",
          field: "daily_update_words",
          value: 6000,
          unit: "字/日",
          meaning: "后台打卡口径",
          source: "https://example.com/b#r1",
          effective_from: "2026-01-01",
        },
      ],
    } as unknown as PlatformSpec;
    const conflicts = checkPlatformSpecConsistency([
      { packId: "demo-a", spec: specA },
      { packId: "demo-b", spec: specB },
    ]);
    const kinds = conflicts.map((row) => row.kind);
    expect(kinds).toContain("id-collision");
    expect(kinds).toContain("field-meaning-mismatch");
  });

  it("**接线在主进程**（export-ops 扫 spec ⇒ 全部喂给引擎 ⇒ 结论进载荷）", () => {
    expect(exportOps, "没有扫 spec 包").toContain("scanPlatformSpecs(platformRoot)");
    expect(exportOps, "没有把全部合规包喂给引擎校验").toContain(
      "checkPlatformSpecConsistency(specPacks)",
    );
    expect(exportOps, "坏包没有被过滤掉（坏包进校验会污染结论）").toContain(
      "item.spec !== null",
    );
    expect(ipc, "载荷里没有结论字段").toContain("specConflicts: PlatformSpecConflictPayload[]");
    expect(ipc, "载荷里没有参与包数").toContain("specPackCount: number");
  });

  it("**界面如实说**（0 包 / 1 包 / 0 冲突 / 冲突逐条，四种情形都有话）", () => {
    expect(view, "没有跨包一致性面板").toContain('data-spec-consistency="1"');
    expect(view, "0 包没有如实说").toContain("无从校验");
    expect(view, "1 包没有如实说").toContain("无从打架");
    expect(view, "0 冲突没有如实说").toContain("各包口径不打架");
    expect(view, "冲突没有逐条点名").toContain("data-conflict-kind=");
  });

  it("**回执腿：step161 取证过**（面板在 + 参与包数如实 + 结论如实）", () => {
    const step = report.steps.find((row) => row.step === 161);
    expect(step, "报告里没有 step161（跨包一致性取证）那一步").toBeTruthy();
    expect((step as { ok: boolean }).ok, "step161 没过").toBe(true);
    const detail = (step as { detail: string }).detail;
    expect(detail, "step161 没取证面板在").toContain("面板在=true");
    expect(detail, "step161 没取证参与包数").toContain("参与包数=");
    expect(detail, "step161 没取证结论").toContain("结论=");
  });
});
