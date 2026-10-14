/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RULE_STATS_API_VERSION } from "@yushu/world-engine";
import { ProjectGateway } from "../src/main/file-gateway.js";
import {
  createProject,
  createOutlineChapter,
  generateOutline,
  writeCardDoc,
} from "../src/main/project-ops.js";
import { markConsistencyStale, runConsistencyCheck } from "../src/main/consistency-ops.js";

/**
 * 规则豁免率的桌面接线（M4 / T4-11 的后半，R84）。
 *
 * 引擎侧 `rule-stats.ts` 已经把"怎么算、什么时候不判"定清楚了（8 例单测）。
 * 这一份测的是**接上去之后作者看得见什么**，重点三条：
 * ① 没配阈值也要把率算出来——"有数据没结论"和"没数据"是两回事，
 *    面板不能因为没配就把那一格显示成空白或"没问题"；
 * ② 阈值文件读不了 ⇒ **不判**，但错误必须外显（与豁免清单同一条 fail-safe：
 *    坏文件不等于全通过，也不等于静默按默认走）；
 * ③ 体检全程只读——阈值文件跑完字节不能变。
 */

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

const THRESHOLDS_PATH = "config/consistency-thresholds.yaml";
const ALLOW_PATH = "config/consistency.yaml";
const CARD_PATH = "world/cards/character/char-linyuan.md";

let dir: string;
let gateway: ProjectGateway;

async function writeDoc(path: string, text: string): Promise<void> {
  const existing = await gateway.readDoc(path).catch(() => null);
  await gateway.writeDoc(path, text, existing?.hash);
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-noise-"));
  markConsistencyStale();
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(dir);
  await writeCardDoc(gateway, {
    card: {
      id: "char-linyuan",
      type: "character",
      name: "林渊",
      layer: "characters",
      refs: [{ relation: "师从", target: "fac-ghost" }],
    },
    body: "边城少年，剑道天赋被夺。",
  });
  await writeCardDoc(gateway, {
    card: { id: "char-haize", type: "character", name: "海泽", layer: "characters" },
    body: "同日入城的另一人。",
  });
  const generated = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 2,
  });
  const volume = generated.doc.volumes[0]!;
  await createOutlineChapter(gateway, {
    volumeId: volume.id,
    chapterId: volume.chapters[0]!.id,
    baseHash: generated.hash,
  });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("一致性体检的豁免率视图（T4-11）", () => {
  it("未配置阈值：exists=false、不判，但率照样算出来给作者看", async () => {
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(report.thresholds.exists).toBe(false);
    expect(report.thresholds.rate).toBeNull();
    expect(report.thresholds.error).toBeNull();
    const row = report.noise.find((item) => item.rule === "ref-dangling");
    expect(row, "报了 ref-dangling 却不在噪音表里").toMatchObject({
      reported: 1,
      suppressed: 0,
      // 1 条样本、0 条豁免 ⇒ 率是 0，但样本不足以下结论
      rate: 0,
      verdict: "insufficient-sample",
    });
  });

  it("阈值文件读不了：不判，且错误原文外显（不静默按默认走）", async () => {
    await writeDoc(THRESHOLDS_PATH, "apiVersion: yushu.consistency-thresholds/v99\n");
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(report.thresholds.exists).toBe(true);
    expect(report.thresholds.error).toContain("apiVersion");
    // 读不了 ⇒ 按"没配"处理：不判 noisy，但率仍然算出来
    const row = report.noise.find((item) => item.rule === "ref-dangling");
    expect(row?.verdict).toBe("insufficient-sample");
    expect(row?.rate).toBe(0);
  });

  it("配好阈值 + 这条被豁免：报出 0 / 豁免 1 ⇒ 率 100% 判 noisy", async () => {
    await writeDoc(
      THRESHOLDS_PATH,
      `apiVersion: ${RULE_STATS_API_VERSION}\nsuppression_rate: 0.1\nmin_samples: 1\n`,
    );
    await writeDoc(
      ALLOW_PATH,
      `apiVersion: yushu.consistency-allow/v1\nentries:\n  - rule: ref-dangling\n    subject: char-linyuan\n    related: fac-ghost\n    reason: 幽灵势力第二部再揭晓\n`,
    );
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(report.entries.some((entry) => entry.rule === "ref-dangling")).toBe(false);
    expect(report.suppressed).toHaveLength(1);
    expect(report.thresholds).toMatchObject({ exists: true, rate: 0.1, minSamples: 1, error: null });
    const row = report.noise.find((item) => item.rule === "ref-dangling");
    expect(row).toMatchObject({ reported: 0, suppressed: 1, rate: 1, verdict: "noisy" });
  });

  it("噪音表覆盖范围：本次报出或被豁免过的规则一条都不许漏", async () => {
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    const seen = new Set([...report.entries, ...report.suppressed].map((item) => item.rule));
    const listed = new Set(report.noise.map((item) => item.rule));
    expect([...seen].filter((rule) => !listed.has(rule))).toEqual([]);
    expect(listed.size).toBeGreaterThan(0);
  });

  it("体检只读：阈值文件跑完字节不变（它是判定尺度，不是体检产物）", async () => {
    await writeDoc(
      THRESHOLDS_PATH,
      `apiVersion: ${RULE_STATS_API_VERSION}\nsuppression_rate: 0.3\n`,
    );
    const before = await gateway.readDoc(THRESHOLDS_PATH);
    await runConsistencyCheck(gateway, { timing: "manual" });
    await runConsistencyCheck(gateway, { timing: "manual" });
    const after = await gateway.readDoc(THRESHOLDS_PATH);
    expect(after.hash).toBe(before.hash);
    expect(after.content).toBe(before.content);
  });
});
