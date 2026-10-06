import { mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeIndexFiles, openIndex, closeIndex } from "@yushu/search";
import { adoptDraft } from "../src/main/ai-ops.js";
import { INDEX_DB_RELATIVE, readIndexStatus, rebuildProjectIndex, searchProjectIndex } from "../src/main/index-ops.js";
import { createOutlineChapter, createProject, generateOutline, writeCardDoc } from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import type { IndexProgressPayload } from "../src/shared/ipc.js";

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

  it("增量重建（T2-5）：复用未变文件、只重解析变更、移除已删文件；新内容可检索", async () => {
    const { gateway, cardPath } = await setupProject();
    const full = await rebuildProjectIndex(gateway);
    expect(full.mode).toBe("full");
    expect(full.integrityIssues).toEqual([]);

    // 1) 内容未变 → 全部复用（mtime+size 快速跳过）
    const reused = await rebuildProjectIndex(gateway, { incremental: true });
    expect(reused.mode).toBe("incremental");
    expect(reused.updatedFiles).toBe(0);
    expect(reused.reusedFiles).toBe(full.stats.files);
    expect(reused.removedFiles).toBe(0);
    expect(reused.stats.chunks).toBe(full.stats.chunks);
    expect(reused.stats.ftsRows).toBe(reused.stats.chunks);

    // 2) 改一张卡 → 只有它被重解析；新词可检索；FTS 行数与 chunks 对齐
    const snapshot = await gateway.readDoc(cardPath);
    await gateway.writeDoc(
      cardPath,
      snapshot.content.replace("剑指苍穹", "剑指苍穹，持有玄铁令"),
      snapshot.hash,
    );
    const afterCard = await rebuildProjectIndex(gateway, { incremental: true });
    expect(afterCard.updatedFiles).toBe(1);
    expect(afterCard.reusedFiles).toBe(full.stats.files - 1);
    expect(afterCard.stats.ftsRows).toBe(afterCard.stats.chunks);
    const hit = await searchProjectIndex(gateway, "玄铁令");
    expect(hit.chunks.length).toBeGreaterThanOrEqual(1);
    expect(hit.chunks[0]?.path).toBe(cardPath);
    expect((await searchProjectIndex(gateway, "林渊")).entities).toHaveLength(1);

    // 3) 删除一张卡 → 从索引移除（实体与引用一并清理）
    await rm(join(dir, cardPath), { force: true });
    const afterRemove = await rebuildProjectIndex(gateway, { incremental: true });
    expect(afterRemove.removedFiles).toBe(1);
    expect(afterRemove.stats.entities).toBe(1);
    expect((await searchProjectIndex(gateway, "林渊")).entities).toHaveLength(0);
    expect(afterRemove.stats.ftsRows).toBe(afterRemove.stats.chunks);
  });

  it("增量 racy 防护（T2-5 复核）：mtime 不早于上次索引写入时不做快速跳过（同大小改写仍被 hash 确认）", async () => {
    const { gateway, cardPath } = await setupProject();
    const abs = join(dir, cardPath);
    // 构造 racy 场景：文件 mtime 晚于索引写入时刻（与索引写入同刻的外部改写 / 时钟偏移）
    const future = new Date("2030-01-01T00:00:00.000Z");
    await utimes(abs, future, future);
    const full = await rebuildProjectIndex(gateway);
    expect(full.stats.builtAt < future.toISOString()).toBe(true); // racy 前提：mtime >= builtAt

    // 同大小内容改写 + 保持 mtime 不变：旧口径（仅比 mtime+size）会直接跳过 → 新内容进不了索引
    const snapshot = await gateway.readDoc(cardPath);
    await gateway.writeDoc(cardPath, snapshot.content.replace("剑指苍穹", "剑指沧溟"), snapshot.hash);
    await utimes(abs, future, future);

    const inc = await rebuildProjectIndex(gateway, { incremental: true });
    expect(inc.mode).toBe("incremental");
    expect(inc.updatedFiles).toBe(1);
    expect((await searchProjectIndex(gateway, "沧溟")).chunks.length).toBeGreaterThanOrEqual(1);
  });

  it("增量解析下沉 utilityProcess（T2-11 切片 B）：worker 不可用时回退主进程，回执注明且结果一致", async () => {
    const { gateway, cardPath } = await setupProject();
    await rebuildProjectIndex(gateway);
    const snapshot = await gateway.readDoc(cardPath);
    await gateway.writeDoc(
      cardPath,
      snapshot.content.replace("剑指苍穹", "剑指苍穹，持有玄铁令"),
      snapshot.hash,
    );

    const inc = await rebuildProjectIndex(gateway, { incremental: true });
    expect(inc.mode).toBe("incremental");
    expect(inc.updatedFiles).toBe(1);
    expect(inc.reusedFiles).toBe(inc.stats.files - 1);
    // vitest 无 Electron：utilityProcess 不可用 → 回退主进程（真实 Electron 下由 e2e 断言 utility）
    expect(inc.parseVia).toBe("main");
    expect((await searchProjectIndex(gateway, "玄铁令")).chunks.length).toBeGreaterThanOrEqual(1);
    expect(inc.stats.ftsRows).toBe(inc.stats.chunks);
  });

  it("完整性自愈（T2-5）：FTS 不一致时增量自动回退全量重建并回报问题项", async () => {
    const { gateway } = await setupProject();
    const full = await rebuildProjectIndex(gateway);

    // 人为破坏：删掉卡片 chunks（FTS 索引行随之与 chunks 表不一致）
    const dbPath = join(dir, ".yushu", "index.db");
    const db = openIndex(dbPath);
    try {
      db.exec("DELETE FROM chunks WHERE kind = 'card'");
    } finally {
      closeIndex(db);
    }

    // 真实 FTS 对齐指标（复核修复）：缺行在统计上可见（旧口径 `count(*) FROM chunks_fts`
    // 走 content 表、恒等于 chunks，无法暴露——ftsRows 现取影子表 chunks_fts_docsize）
    const brokenStats = (await readIndexStatus(gateway)).stats;
    expect(brokenStats).not.toBeNull();
    expect(brokenStats!.ftsRows).not.toBe(brokenStats!.chunks);

    const healed = await rebuildProjectIndex(gateway, { incremental: true });
    expect(healed.mode).toBe("full");
    expect(healed.integrityIssues.length).toBeGreaterThan(0);
    expect(healed.integrityIssues.join("；")).toContain("FTS");
    expect(healed.stats.chunks).toBe(full.stats.chunks);
    expect(healed.stats.ftsRows).toBe(healed.stats.chunks);
  });

  it("全量重建进度（T2-5 切片 B）：解析与分片写入事件可达；分片数 = chunks 事件数", async () => {
    const { gateway } = await setupProject();
    const events: IndexProgressPayload[] = [];
    const result = await rebuildProjectIndex(gateway, { onProgress: (progress) => events.push(progress) });

    expect(result.mode).toBe("full");
    expect(result.shards).toBeGreaterThanOrEqual(1);
    expect(events.some((event) => event.phase === "parse")).toBe(true);

    const chunkEvents = events.filter((event) => event.phase === "chunks");
    expect(chunkEvents).toHaveLength(result.shards);
    expect(chunkEvents[chunkEvents.length - 1]!.done).toBe(result.stats.chunks);
    expect(events[events.length - 1]!.phase).toBe("merge");

    // 解析进度最终 done == total（所有可索引文件均被读取）
    const parseEvents = events.filter((event) => event.phase === "parse");
    const lastParse = parseEvents[parseEvents.length - 1]!;
    expect(lastParse.done).toBe(lastParse.total);
    expect(lastParse.total).toBe(result.stats.files);

    // 分片写入完成后 FTS 与内容对齐（影子表口径）
    expect(result.stats.ftsRows).toBe(result.stats.chunks);
  });

  it("增量重建进度（T2-5 切片 B）：读取流转为 parse 事件；回执分片数为 0", async () => {
    const { gateway, cardPath } = await setupProject();
    await rebuildProjectIndex(gateway);
    const snapshot = await gateway.readDoc(cardPath);
    await gateway.writeDoc(
      cardPath,
      snapshot.content.replace("剑指苍穹", "剑指苍穹，持有玄铁令"),
      snapshot.hash,
    );

    const events: IndexProgressPayload[] = [];
    const result = await rebuildProjectIndex(gateway, {
      incremental: true,
      onProgress: (progress) => events.push(progress),
    });
    expect(result.mode).toBe("incremental");
    expect(result.shards).toBe(0);
    expect(events.some((event) => event.phase === "parse" && event.currentPath === cardPath)).toBe(true);
  });
});