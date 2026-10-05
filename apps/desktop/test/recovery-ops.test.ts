import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptDraft } from "../src/main/ai-ops.js";
import { writeChapterBody } from "../src/main/chapter-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { createOutlineChapter, createProject, generateOutline } from "../src/main/project-ops.js";
import {
  RECOVERY_DIR,
  clearRecoveryJournal,
  discardRecoveryJournal,
  listRecoverable,
  writeRecoveryJournal,
} from "../src/main/recovery-ops.js";

let dir: string;

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-recovery-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

interface Fixture {
  gateway: ProjectGateway;
  chapterPath: string;
  diskBody: string;
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
  await adoptDraft(gateway, {
    usageId: "test",
    volumeId: volume.id,
    chapterId: chapter.id,
    text: "夜色压下来，林渊拔剑而起。",
    mode: "replace",
  });
  return { gateway, chapterPath: draft.chapterPath, diskBody: "夜色压下来，林渊拔剑而起。" };
}

async function journalFiles(): Promise<string[]> {
  return readdir(join(dir, RECOVERY_DIR)).catch(() => [] as string[]);
}

describe("编辑日志（T2-8 切片 A）", () => {
  it("写入 journal → 检测为可恢复（与磁盘不一致）；章节磁盘不被触碰", async () => {
    const { gateway, chapterPath, diskBody } = await setupProject();
    await writeRecoveryJournal(gateway, { path: chapterPath, body: `${diskBody}\n\n崩溃前新写的段落。` });
    expect(await journalFiles()).toHaveLength(1);

    const entries = await listRecoverable(gateway);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ path: chapterPath });
    expect(entries[0]!.body).toContain("崩溃前新写的段落。");
    expect(entries[0]!.wordCount).toBeGreaterThan(0);
    expect(entries[0]!.updatedAt).not.toBe("");

    // 真源未被触碰：磁盘正文仍是保存时内容
    const snapshot = await gateway.readDoc(chapterPath);
    expect(snapshot.content).toContain(diskBody);
    expect(snapshot.content).not.toContain("崩溃前新写的段落。");
    // 检测不消费 journal（用户尚未抉择）
    expect(await journalFiles()).toHaveLength(1);
  });

  it("journal 与磁盘一致（保存后漏清）→ 自动清除且不提示", async () => {
    const { gateway, chapterPath, diskBody } = await setupProject();
    await writeRecoveryJournal(gateway, { path: chapterPath, body: diskBody });
    expect(await listRecoverable(gateway)).toEqual([]);
    expect(await journalFiles()).toHaveLength(0); // 漏清 journal 已自愈
  });

  it("清除 / 丢弃：journal 移除后不再提示", async () => {
    const { gateway, chapterPath, diskBody } = await setupProject();
    await writeRecoveryJournal(gateway, { path: chapterPath, body: `${diskBody}改动` });
    await clearRecoveryJournal(gateway, chapterPath);
    expect(await journalFiles()).toHaveLength(0);

    await writeRecoveryJournal(gateway, { path: chapterPath, body: `${diskBody}改动2` });
    await discardRecoveryJournal(gateway, chapterPath);
    expect(await listRecoverable(gateway)).toEqual([]);
    expect(await journalFiles()).toHaveLength(0);
  });

  it("损坏 / 非法 journal：跳过且保留原文件（不静默删）", async () => {
    const { gateway, chapterPath, diskBody } = await setupProject();
    await writeRecoveryJournal(gateway, { path: chapterPath, body: `${diskBody}有效` });
    const [name] = await journalFiles();
    const abs = join(dir, RECOVERY_DIR, name!);

    // 1) 损坏 JSON
    await writeFile(abs, "{ not-json", "utf8");
    expect(await listRecoverable(gateway)).toEqual([]);
    expect(await journalFiles()).toHaveLength(1);

    // 2) 合法 JSON 但路径非法（非 chapters/）：同样跳过保留
    await writeFile(abs, JSON.stringify({ path: "world/cards/x.md", body: "x", updatedAt: "t" }), "utf8");
    expect(await listRecoverable(gateway)).toEqual([]);
    expect(await journalFiles()).toHaveLength(1);

    // 3) 章节文件不存在：保留 journal 但不提示（无处安放，保守不删）
    await writeFile(abs, JSON.stringify({ path: "chapters/vol-x/ch-missing.md", body: "x", updatedAt: "t" }), "utf8");
    expect(await listRecoverable(gateway)).toEqual([]);
    expect(await journalFiles()).toHaveLength(1);
  });

  it("非 chapters/ 路径的写入被拒绝（编辑日志仅服务章节）", async () => {
    const { gateway } = await setupProject();
    await expect(
      writeRecoveryJournal(gateway, { path: "world/cards/character/char-x.md", body: "x" }),
    ).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(clearRecoveryJournal(gateway, "project.toml")).rejects.toMatchObject({
      code: "E_INVALID_INPUT",
    });
  });

  it("external 改写后再落盘并存：list 与章节读取走同一 FileGateway（路径防护一致）", async () => {
    // 冒烟一条端到端：journal 对应章节经外部手段（直接写盘）更新为 journal 内容 → 自动清除
    const { gateway, chapterPath } = await setupProject();
    const recoveredBody = "外部恢复后的正文。";
    await writeRecoveryJournal(gateway, { path: chapterPath, body: recoveredBody });
    const snapshot = await gateway.readDoc(chapterPath);
    await writeChapterBody(gateway, { path: chapterPath, body: recoveredBody, baseHash: snapshot.hash });
    expect(await listRecoverable(gateway)).toEqual([]);
    expect(await journalFiles()).toHaveLength(0);
    expect((await readFile(join(dir, chapterPath), "utf8")).length).toBeGreaterThan(0);
  });
});