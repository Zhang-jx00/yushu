import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeIndexFiles } from "@yushu/search";
import {
  createChapterDraft,
  createSettingCard,
  serializeCardFile,
  serializeChapterFile,
} from "@yushu/world-engine";
import { indexDbPath, runRebuild, runSearch, runStatus } from "../src/commands.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-cli-"));
  const card = createSettingCard({
    type: "character",
    name: "林渊",
    layer: "characters",
    aliases: ["小渊"],
  });
  const chapter = createChapterDraft({
    volume: "vol-1",
    idx: 1,
    title: "第1章 废物少年",
    outlineRef: "co-1",
  });
  await mkdir(join(dir, "world", "cards", "character"), { recursive: true });
  await mkdir(join(dir, "chapters", "vol-1"), { recursive: true });
  await writeFile(
    join(dir, "world", "cards", "character", `${card.id}.md`),
    serializeCardFile(card, "边城少年，天赋被夺。"),
    "utf8",
  );
  await writeFile(
    join(dir, "chapters", "vol-1", `${chapter.id}.md`),
    serializeChapterFile(chapter, "夜色压下来，林渊拔剑而起。"),
    "utf8",
  );
});

afterEach(async () => {
  await removeIndexFiles(indexDbPath(dir)).catch(() => undefined);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(
    () => undefined,
  );
});

describe("yushu rebuild（T1-21 无头命令）", () => {
  it("重建产出 .yushu/index.db 与统计；status/search 可读", async () => {
    const result = await runRebuild(dir);
    expect(result.dbPath).toBe(indexDbPath(dir));
    expect(existsSync(result.dbPath)).toBe(true);
    expect(result.stats.files).toBeGreaterThanOrEqual(2);
    expect(result.stats.entities).toBe(1);
    expect(result.stats.chunks).toBeGreaterThanOrEqual(2);
    expect(result.skipped).toEqual([]);

    const status = runStatus(dir);
    expect(status.exists).toBe(true);
    expect(status.stats).toEqual(result.stats);

    const search = runSearch(dir, "林渊");
    expect(search.entities.map((entity) => entity.id)).toHaveLength(1);
    expect(search.chunks.length).toBeGreaterThanOrEqual(1);
    expect(search.chunks[0]?.chapterId).toBeTruthy();
    expect(search.chunks[0]?.snippet).toContain("林渊");
  });

  it("删除索引库后重建：统计与检索结果一致（零丢失，真源只读）", async () => {
    const first = await runRebuild(dir);
    const before = runSearch(dir, "夜色压下来");

    await removeIndexFiles(indexDbPath(dir));
    expect(existsSync(indexDbPath(dir))).toBe(false);
    expect(runStatus(dir).exists).toBe(false);

    const second = await runRebuild(dir);
    expect(second.stats.entities).toBe(first.stats.entities);
    expect(second.stats.chunks).toBe(first.stats.chunks);
    expect(runSearch(dir, "夜色压下来")).toEqual(before);
  });

  it("rebuilt 幂等：二次重建覆盖旧数据（无重复计数）", async () => {
    const first = await runRebuild(dir);
    const second = await runRebuild(dir);
    expect(second.stats.chunks).toBe(first.stats.chunks);
    expect(second.stats.ftsRows).toBe(second.stats.chunks);
  });
});