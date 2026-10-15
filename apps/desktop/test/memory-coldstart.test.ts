/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptDraft } from "../src/main/ai-ops.js";
import { loadMemoryState, saveMemorySummary } from "../src/main/memory-ops.js";
import { createOutlineChapter, createProject, generateOutline } from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { OUTLINE_PATH } from "@yushu/world-engine";

/**
 * 冷启动记忆衔接的桌面侧（M5 / T5-9，R95）。
 *
 * 计划本身是纯函数（`@yushu/memory/coldstart.ts`），这里要验的是**接上了真数据**：
 * 数字来自三级大纲 + 章节正文 + 已入库的摘要记录，同一次 `loadMemoryState` 里自洽。
 * T5-9 的"自动补候选"落在这里的边界之外——生成候选仍走既有的「生成候选 → 采纳」，
 * 本模块只报"缺哪几条、先补哪几条"，一个字摘要都不替作者编。
 */

let dir: string;

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-coldstart-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** 建项目 + 生成大纲；`drafts` 指定"第几卷第一章"创建草稿并写入正文 */
async function projectWithDrafts(volumeCount: number, draftVolumes: number[]): Promise<ProjectGateway> {
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  const gateway = new ProjectGateway(dir);
  const generated = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount,
    chaptersPerVolume: 2,
  });
  // 每建一章都会重写 outline.yaml ⇒ baseHash 必须逐次取新值，拿旧值就是拿旧事实
  let outlineHash = generated.hash;
  for (const index of draftVolumes) {
    const volume = generated.doc.volumes[index]!;
    const chapter = volume.chapters[0]!;
    const draft = await createOutlineChapter(gateway, {
      volumeId: volume.id,
      chapterId: chapter.id,
      baseHash: outlineHash,
    });
    await adoptDraft(gateway, {
      usageId: "test-usage",
      volumeId: volume.id,
      chapterId: chapter.id,
      text: "天启界的夜色压下来，林渊握紧了手里的剑。",
      mode: "replace",
    });
    expect(draft.chapterPath).toContain("chapters/");
    outlineHash = (await gateway.readDoc(OUTLINE_PATH)).hash;
  }
  return gateway;
}

describe("记忆状态里的冷启动计划（T5-9，R95）", () => {
  it("两卷各一章正文：卷摘要全缺、章摘要全缺，覆盖率按有素材的目标算", async () => {
    const gateway = await projectWithDrafts(2, [0, 1]);
    const state = await loadMemoryState(gateway);
    expect(state.coldStart.volumes.total).toBe(2);
    expect(state.coldStart.volumes.missing).toBe(2);
    expect(state.coldStart.chapters.total).toBe(2);
    expect(state.coldStart.chapters.missing).toBe(2);
    expect(state.coldStart.noMaterial).toBe(0);
    expect(state.coldStart.materialTargets).toBe(4);
    expect(state.coldStart.coverageRatio).toBe(0);
    expect(state.coldStart.firstChapterMissing).toBe(true);
    // 批次：卷摘要在前（一条顶一卷的上下文），其余按大纲序
    expect(state.coldStart.batch.slice(0, 2).map((item) => item.layer)).toEqual([
      "volume_summary",
      "volume_summary",
    ]);
  });

  it("补上一条章摘要后，同一次读取里计数、覆盖率与批次同时跟着变（不留第二份事实）", async () => {
    const gateway = await projectWithDrafts(2, [0, 1]);
    const before = await loadMemoryState(gateway);
    const firstChapter = before.targets.find((item) => item.layer === "chapter_summary")!;
    await saveMemorySummary(gateway, {
      layer: "chapter_summary",
      id: firstChapter.id,
      text: "林渊在边城初次察觉体内系统的异动。",
      origin: "human",
    });
    const after = await loadMemoryState(gateway);
    expect(after.coldStart.chapters.covered).toBe(1);
    expect(after.coldStart.chapters.missing).toBe(1);
    expect(after.coldStart.coverageRatio).toBeCloseTo(1 / 4, 10);
    expect(after.coldStart.firstChapterMissing).toBe(false);
    expect(after.coldStart.batch.some((item) => item.id === firstChapter.id)).toBe(false);
    // 待补总数与"批次 + 剩余"必须自洽（数字之间不许打架）
    const gaps = after.coldStart.volumes.missing + after.coldStart.chapters.missing;
    expect(after.coldStart.batch.length + after.coldStart.stillMissing).toBe(gaps);
  });

  it("没建草稿的卷不进待补：正文为空就没有素材，报它等于逼作者凭空编", async () => {
    const gateway = await projectWithDrafts(3, [0]);
    const state = await loadMemoryState(gateway);
    expect(state.coldStart.volumes.total).toBe(3);
    expect(state.coldStart.volumes.missing).toBe(1);
    expect(state.coldStart.noMaterial).toBe(2);
    expect(state.coldStart.materialTargets).toBe(2);
    expect(state.coldStart.coverageRatio).toBe(0);
    expect(state.coldStart.batch.every((item) => item.sourceChars > 0)).toBe(true);
  });

  it("一条有素材的目标都没有 ⇒ 覆盖率 null 并给原因，不拿 0 冒充结论", async () => {
    const gateway = await projectWithDrafts(2, []);
    const state = await loadMemoryState(gateway);
    expect(state.coldStart.materialTargets).toBe(0);
    expect(state.coldStart.coverageRatio).toBeNull();
    expect(state.coldStart.coverageReason).toContain("素材");
    expect(state.coldStart.batch).toEqual([]);
    expect(state.coldStart.firstChapterMissing).toBe(false);
  });
});
