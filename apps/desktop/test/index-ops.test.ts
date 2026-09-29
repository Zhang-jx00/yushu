import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeIndexFiles } from "@yushu/search";
import { adoptDraft } from "../src/main/ai-ops.js";
import { INDEX_DB_RELATIVE, readIndexStatus, rebuildProjectIndex, searchProjectIndex } from "../src/main/index-ops.js";
import { createOutlineChapter, createProject, generateOutline, writeCardDoc } from "../src/main/project-ops.js";
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
  dir = await mkdtemp(join(tmpdir(), "yushu-idxops-"));
});

afterEach(async () => {
  await removeIndexFiles(join(dir, ".yushu", "index.db")).catch(() => undefined);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(
    () => undefined,
  );
});

interface Fixture {
  gateway: ProjectGateway;
  volumeId: string;
  chapterId: string;
  cardPath: string;
}

async function setupProject(): Promise<Fixture> {
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  const gateway = new ProjectGateway(dir);
  const card = await writeCardDoc(gateway, {
    card: { type: "character", name: "林渊", layer: "characters", aliases: ["小渊"] },
    body: "边城少年，剑指苍穹。",
  });
  await writeCardDoc(gateway, {
    card: { type: "law", name: "灵气法则", layer: "laws" },
    body: "天地灵气随境界潮汐涨落。",
  });
  const generated = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 1,
  });
  const volume = generated.doc.volumes[0]!;
  const chapter = volume.chapters[0]!;
  await createOutlineChapter(gateway, {
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
  return { gateway, volumeId: volume.id, chapterId: chapter.id, cardPath: card.path };
}

describe("桌面端索引（T1-21 / T1-22）", () => {
  it("重建产出统计；中文全文检索与实体检索命中", async () => {
    const { gateway } = await setupProject();
    const before = await readIndexStatus(gateway);
    expect(before.exists).toBe(false);
    expect(before.path).toBe(INDEX_DB_RELATIVE);

    const rebuilt = await rebuildProjectIndex(gateway);
    expect(rebuilt.exists).toBe(true);
    expect(rebuilt.path).toBe(INDEX_DB_RELATIVE);
    expect(rebuilt.skipped).toEqual([]);
    expect(rebuilt.stats.files).toBeGreaterThanOrEqual(4);
    expect(rebuilt.stats.entities).toBe(2);
    expect(rebuilt.stats.refs).toBe(0);
    expect(rebuilt.stats.ftsRows).toBe(rebuilt.stats.chunks);
    expect(rebuilt.stats.chunks).toBeGreaterThanOrEqual(4); // 2 卡 + 1 章 + 1 大纲

    const contentSearch = await searchProjectIndex(gateway, "夜色");
    expect(contentSearch.chunks.length).toBeGreaterThanOrEqual(1);
    expect(contentSearch.chunks[0]?.snippet).toContain("【夜色】");
    expect(contentSearch.chunks[0]?.chapterId).toBeTruthy();

    const entitySearch = await searchProjectIndex(gateway, "林渊");
    expect(entitySearch.entities.map((entity) => entity.name)).toEqual(["林渊"]);
    const aliasSearch = await searchProjectIndex(gateway, "小渊");
    expect(aliasSearch.entities).toHaveLength(1);
  });

  it("删除索引库后重建：统计与检索结果一致（零丢失）", async () => {
    const { gateway, cardPath } = await setupProject();
    const first = await rebuildProjectIndex(gateway);
    const beforeChunks = await searchProjectIndex(gateway, "夜色");

    await removeIndexFiles(join(dir, ".yushu", "index.db"));
    expect((await readIndexStatus(gateway)).exists).toBe(false);

    const second = await rebuildProjectIndex(gateway);
    expect(second.stats.chunks).toBe(first.stats.chunks);
    expect(second.stats.entities).toBe(first.stats.entities);
    expect(await searchProjectIndex(gateway, "夜色")).toEqual(beforeChunks);
    // 零丢失：真源文件未被触碰（仍可读取且内容完整）
    const cardSnapshot = await gateway.readDoc(cardPath);
    expect(cardSnapshot.content).toContain("边城少年，剑指苍穹。");
  });

  it("索引缺失时检索给出可操作错误", async () => {
    const { gateway } = await setupProject();
    await expect(searchProjectIndex(gateway, "夜色")).rejects.toMatchObject({
      code: "E_INDEX_MISSING",
    });
  });
});