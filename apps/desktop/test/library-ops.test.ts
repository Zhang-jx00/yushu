import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptDraft } from "../src/main/ai-ops.js";
import { readLibrary } from "../src/main/library-ops.js";
import { createOutlineChapter, createProject, generateOutline } from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

let dir: string;

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-library-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

describe("稿件总览（T2-4 切片 A：全库视图）", () => {
  it("汇总全部章节（含未建草稿）：草稿路径 / 字数 / 状态与总计", async () => {
    await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
    const gateway = new ProjectGateway(dir);
    const generated = await generateOutline(gateway, {
      templateId: "xuanhuan-xitong/three-act-upgrade",
      title: "天启界",
      volumeCount: 2,
      chaptersPerVolume: 2,
    });
    const volume = generated.doc.volumes[0]!;
    const firstChapter = volume.chapters[0]!;
    const draft = await createOutlineChapter(gateway, {
      volumeId: volume.id,
      chapterId: firstChapter.id,
      baseHash: generated.hash,
    });
    // 写入正文（字数入 frontmatter）——仅第一章建草稿，其余三章未建
    await adoptDraft(gateway, {
      usageId: "library-test",
      volumeId: volume.id,
      chapterId: firstChapter.id,
      text: "夜色压下来，林渊拔剑而起。",
      mode: "replace",
    });

    const library = await readLibrary(gateway);
    expect(library.bookTitle).toBe("天启界");
    expect(library.totals.chapters).toBe(4); // 2 卷 × 2 章
    expect(library.totals.drafted).toBe(1);
    expect(library.totals.words).toBeGreaterThan(0);

    const drafted = library.chapters.filter((item) => item.chapterPath !== null);
    expect(drafted).toHaveLength(1);
    expect(drafted[0]!.chapterPath).toBe(draft.chapterPath);
    expect(drafted[0]!.wordCount).toBe(library.totals.words);
    expect(drafted[0]!.status).toBe("draft");
    expect(drafted[0]!.title).toBe(firstChapter.title);
    expect(drafted[0]!.idx).toBe(firstChapter.idx);
    expect(drafted[0]!.volumeTitle).toBe(volume.title);

    const undrafted = library.chapters.filter((item) => item.chapterPath === null);
    expect(undrafted).toHaveLength(3);
    expect(undrafted.every((item) => item.wordCount === 0 && item.status === "")).toBe(true);
    // 全库顺序：按卷 -> 章序（与大纲一致）
    expect(library.chapters.map((item) => item.volumeId)).toEqual([
      volume.id,
      volume.id,
      generated.doc.volumes[1]!.id,
      generated.doc.volumes[1]!.id,
    ]);
  });

  it("无大纲文件时返回空视图（不抛错）", async () => {
    await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
    const gateway = new ProjectGateway(dir);
    const library = await readLibrary(gateway);
    expect(library.chapters).toEqual([]);
    expect(library.totals).toEqual({ chapters: 0, drafted: 0, words: 0 });
  });
});