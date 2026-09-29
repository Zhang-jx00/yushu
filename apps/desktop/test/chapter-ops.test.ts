import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countWords } from "@yushu/core";
import { readChapterFile } from "@yushu/world-engine";
import { readChapter, writeChapterBody } from "../src/main/chapter-ops.js";
import { previewExport } from "../src/main/export-ops.js";
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
  dir = await mkdtemp(join(tmpdir(), "yushu-chapter-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(
    () => undefined,
  );
});

interface Fixture {
  gateway: ProjectGateway;
  chapterPath: string;
}

async function setupProject(): Promise<Fixture> {
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  const gateway = new ProjectGateway(dir);
  const generated = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 1,
  });
  const volume = generated.doc.volumes[0]!;
  const chapter = volume.chapters[0]!;
  const draft = await createOutlineChapter(gateway, {
    volumeId: volume.id,
    chapterId: chapter.id,
    baseHash: generated.hash,
  });
  return { gateway, chapterPath: draft.chapterPath };
}

describe("章节正文读写（M2 / T2-1 切片 A）", () => {
  it("读取返回正文与记录字数；写入同步 word_count 且保留 frontmatter 其他字段", async () => {
    const { gateway, chapterPath } = await setupProject();
    const initial = await readChapter(gateway, chapterPath);
    expect(initial.title).toBe("第1章（待拟题）");
    expect(initial.body.trim()).toBe("");
    expect(initial.hash.length).toBe(64);

    const body = "第一章 烬余\n\n夜色压下来，林渊拔剑而起。";
    const written = await writeChapterBody(gateway, {
      path: chapterPath,
      body,
      baseHash: initial.hash,
    });
    expect(written.wordCount).toBe(countWords(body));
    expect(written.hash).not.toBe(initial.hash);

    const reread = await readChapter(gateway, chapterPath);
    expect(reread.body).toContain("林渊拔剑而起");
    expect(reread.wordCount).toBe(countWords(body));

    // frontmatter 的映射字段（outline_ref / volume 等）未被编辑器破坏
    const snapshot = await gateway.readDoc(chapterPath);
    const { chapter } = readChapterFile(snapshot.content);
    expect(chapter.outline_ref).toBeTruthy();
    expect(chapter.volume).toBeTruthy();
    expect(chapter.status).toBe("draft");
  });

  it("陈旧 baseHash 被拒绝（外部改动后不允许盲覆盖）", async () => {
    const { gateway, chapterPath } = await setupProject();
    const first = await readChapter(gateway, chapterPath);
    const saved = await writeChapterBody(gateway, {
      path: chapterPath,
      body: "第一版正文。",
      baseHash: first.hash,
    });
    await expect(
      writeChapterBody(gateway, {
        path: chapterPath,
        body: "第二版正文（应被拒绝）。",
        baseHash: first.hash,
      }),
    ).rejects.toMatchObject({ code: "E_DOC_CONFLICT" });
    // 用最新 hash 可以正常保存
    const second = await writeChapterBody(gateway, {
      path: chapterPath,
      body: "第二版正文。",
      baseHash: saved.hash,
    });
    expect(second.wordCount).toBe(countWords("第二版正文。"));
  });

  it("编辑器保存后导出对账仍一致（word_count 与正文同步，A4 不回退）", async () => {
    const { gateway, chapterPath } = await setupProject();
    const initial = await readChapter(gateway, chapterPath);
    await writeChapterBody(gateway, {
      path: chapterPath,
      body: "编辑器中写入的正文，用于验证对账。",
      baseHash: initial.hash,
    });
    const preview = await previewExport(gateway);
    expect(preview.chapters).toBe(1);
    expect(preview.reconcile[0]?.matched).toBe(true);
    expect(preview.totalWords).toBe(countWords("编辑器中写入的正文，用于验证对账。"));
  });
});