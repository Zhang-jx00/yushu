import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseOutline, readChapterFile } from "@yushu/world-engine";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { ensureSynthFixture, generateFixtureBody, makeRng, synthFixtureExists } from "../src/main/perf-fixture.js";

/**
 * 性能夹具 synth-1m（T2-10）：结构完整性 / 字数口径 / 确定性（同 seed 同输出） / 幂等复用 / 大章靶子。
 * 小规模参数单测（~2 万字），生成器本身按同一路径服务百万字实测。
 */

let dir: string;

const SMALL = {
  targetChars: 20_000,
  chaptersPerVolume: 3,
  chapterChars: 3_000,
  seed: 7,
} as const;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-perf-fixture-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

describe("性能夹具 synth-1m（T2-10）", () => {
  it("结构完整：卷 / 草稿章节 / chapter_id 回填 / 首章可读；字数达到目标（单章粒度内）", async () => {
    const stats = await ensureSynthFixture({ dir, ...SMALL });
    expect(stats.reused).toBe(false);
    expect(stats.volumes).toBe(Math.ceil(20_000 / 3_000 / 3)); // 7 章 / 每卷 3 章 → 3 卷
    expect(stats.chapters).toBe(Math.ceil(20_000 / 3_000));
    expect(stats.totalChars).toBeGreaterThanOrEqual(20_000);
    expect(stats.totalChars).toBeLessThanOrEqual(20_000 + stats.chapters * 30); // 段末标点余量
    expect(stats.megaPath).toBeNull();

    const gateway = new ProjectGateway(dir);
    const snapshot = await gateway.readDoc(stats.firstChapterPath);
    expect(readChapterFile(snapshot.content).body.length).toBeGreaterThan(1_000);
    const outline = parseOutline((await gateway.readDoc("outline/outline.yaml")).content);
    const chapters = outline.volumes.flatMap((volume) => volume.chapters);
    expect(chapters).toHaveLength(stats.chapters);
    expect(chapters.every((chapter) => Boolean(chapter.chapter_id))).toBe(true);
  });

  it("确定性：同 seed 同输出（正文逐字一致），不同 seed 不同", () => {
    const a1 = generateFixtureBody(2_000, makeRng(7));
    const a2 = generateFixtureBody(2_000, makeRng(7));
    const b = generateFixtureBody(2_000, makeRng(8));
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
    expect(a1.replace(/\s+/g, "").length).toBeGreaterThanOrEqual(2_000);
  });

  it("幂等复用：二次 ensure 扫描既有夹具（reused=true、字数一致、不重写）", async () => {
    const first = await ensureSynthFixture({ dir, ...SMALL });
    const second = await ensureSynthFixture({ dir, ...SMALL });
    expect(second.reused).toBe(true);
    expect(second.chapters).toBe(first.chapters);
    expect(second.totalChars).toBe(first.totalChars);
    expect(second.firstChapterPath).toBe(first.firstChapterPath);
    expect(synthFixtureExists(dir)).toBe(true);
  });

  it("大章靶子：megaChars 生成独立大章并从统计中识别", async () => {
    const stats = await ensureSynthFixture({ dir, ...SMALL, megaChars: 30_000 });
    expect(stats.megaPath).not.toBeNull();
    const gateway = new ProjectGateway(dir);
    const snapshot = await gateway.readDoc(stats.megaPath!);
    expect(readChapterFile(snapshot.content).body.replace(/\s+/g, "").length).toBeGreaterThanOrEqual(30_000);
    expect(stats.totalChars).toBeGreaterThanOrEqual(50_000 - 1_000);
  });
});