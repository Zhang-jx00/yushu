/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { planColdStart, type ColdStartTarget } from "../src/coldstart.js";

/**
 * 冷启动记忆衔接（M5 / T5-9，R95）：长篇项目导入后"开场即失忆"的量化与待补批次。
 *
 * 任务原文是「导入后自动补卷/章摘要候选，避免长篇项目开场即失忆（I09 + T3-5）」。
 * 这一层只做**判定与排序**，不做生成：摘要内容要么由 AI 产出（走既有的「生成候选 → 采纳」，
 * 候选化原则不变），要么由作者自己写。御书在这里负责回答三个问题——
 * 缺多少、缺在哪、先补哪几条最不至于失忆；至于"补什么内容"，代码里一个字都不编。
 */

function target(overrides: Partial<ColdStartTarget> = {}): ColdStartTarget {
  return {
    layer: "chapter_summary",
    id: "ch-001",
    title: "第1章 开端",
    volumeId: "vol-1",
    sourceChars: 1200,
    hasSummary: false,
    summaryRev: 0,
    ...overrides,
  };
}

/** 两卷：卷一 3 章（首章已补）、卷二 2 章；卷摘要都没补；卷二末章正文为空 */
function fixture(): ColdStartTarget[] {
  return [
    target({ layer: "volume_summary", id: "vol-1", title: "第一卷·起", volumeId: "vol-1", sourceChars: 3600 }),
    target({ id: "ch-001", title: "第1章 开端", hasSummary: true, summaryRev: 0 }),
    target({ id: "ch-002", title: "第2章 后事", volumeId: "vol-1" }),
    target({ id: "ch-003", title: "第3章 转折", volumeId: "vol-1" }),
    target({ layer: "volume_summary", id: "vol-2", title: "第二卷·承", volumeId: "vol-2", sourceChars: 2400 }),
    target({ id: "ch-004", title: "第4章 血战", volumeId: "vol-2" }),
    target({ id: "ch-005", title: "第5章 空章", volumeId: "vol-2", sourceChars: 0 }),
  ];
}

describe("冷启动计划的计数", () => {
  it("卷与章分开计数，已有摘要的不算缺", () => {
    const plan = planColdStart({ targets: fixture() });
    expect(plan.volumes.total).toBe(2);
    expect(plan.volumes.missing).toBe(2);
    expect(plan.chapters.total).toBe(5);
    // 空正文的章不进"待补"：没有素材就没有候选，报它等于逼作者补一份凭空写的东西
    expect(plan.chapters.missing).toBe(3);
    expect(plan.noMaterial).toBe(1);
  });

  it("覆盖率只按有素材的目标算（空章不稀释分母）", () => {
    const plan = planColdStart({ targets: fixture() });
    // 有素材的目标 = 2 卷 + 4 章 = 6，其中只有 ch-001 有摘要 ⇒ 1/6
    expect(plan.materialTargets).toBe(6);
    expect(plan.coverageRatio).toBeCloseTo(1 / 6, 10);
  });

  it("一个有素材的目标都没有 ⇒ 覆盖率给 null 并带原因，不拿 0 冒充「一切正常」", () => {
    const plan = planColdStart({
      targets: [target({ sourceChars: 0 }), target({ layer: "volume_summary", id: "vol-1", sourceChars: 0 })],
    });
    expect(plan.materialTargets).toBe(0);
    expect(plan.coverageRatio).toBeNull();
    expect(plan.coverageReason).toContain("素材");
  });

  it("首章缺摘要要单独点名（开场即失忆最直接的那一条）", () => {
    const withFirst = planColdStart({ targets: fixture() });
    expect(withFirst.firstChapterMissing).toBe(false);
    const withoutFirst = planColdStart({
      targets: fixture().map((item) => (item.id === "ch-001" ? { ...item, hasSummary: false } : item)),
    });
    expect(withoutFirst.firstChapterMissing).toBe(true);
  });
});

describe("冷启动批次（先补哪几条）", () => {
  it("卷摘要排在章摘要之前，且按输入的大纲顺序", () => {
    const plan = planColdStart({ targets: fixture(), batchSize: 10 });
    expect(plan.batch.map((item) => item.id)).toEqual(["vol-1", "vol-2", "ch-002", "ch-003", "ch-004"]);
  });

  it("批次上限生效，且 batchChars 是这批素材字数合计（成本预估的原料）", () => {
    const plan = planColdStart({ targets: fixture(), batchSize: 2 });
    expect(plan.batch.map((item) => item.id)).toEqual(["vol-1", "vol-2"]);
    expect(plan.batchChars).toBe(3600 + 2400);
    expect(plan.batchTruncated).toBe(true);
    expect(plan.stillMissing).toBe(3);
  });

  it("缺省批次大小存在且不为 0（界面不许自己猜一个数）", () => {
    const plan = planColdStart({ targets: fixture() });
    expect(plan.batch.length).toBeGreaterThan(0);
    expect(plan.batch.length).toBeLessThanOrEqual(10);
  });

  it("空批次里绝不混进无素材或已补过的目标", () => {
    const plan = planColdStart({ targets: fixture(), batchSize: 20 });
    expect(plan.batch.every((item) => item.sourceChars > 0 && item.hasSummary === false)).toBe(true);
  });

  it("同一输入调用两次逐字一致（不读墙钟、不带随机）", () => {
    const a = planColdStart({ targets: fixture(), batchSize: 3 });
    const b = planColdStart({ targets: fixture(), batchSize: 3 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("打乱输入顺序不改变计数与覆盖率，只改变批次顺序（批次有意跟大纲序）", () => {
    const forward = planColdStart({ targets: fixture(), batchSize: 3 });
    const shuffled = planColdStart({ targets: [...fixture()].reverse(), batchSize: 3 });
    expect(shuffled.volumes).toEqual(forward.volumes);
    expect(shuffled.chapters).toEqual(forward.chapters);
    expect(shuffled.coverageRatio).toBe(forward.coverageRatio);
    expect(shuffled.noMaterial).toBe(forward.noMaterial);
    // 批次顺序跟着输入走：主进程给的是大纲序，那才是作者认定的顺序
    expect(shuffled.batch.map((item) => item.id)).not.toEqual(forward.batch.map((item) => item.id));
  });
});
