import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INDEX_SCHEMA_VERSION,
  closeIndex,
  estimateTokens,
  lookupEntities,
  openIndex,
  queryChunks,
  readStats,
  rebuildIndex,
  removeIndexFiles,
  type IndexInput,
  type RebuildProgress,
} from "@yushu/search";

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-index-"));
  dbPath = join(dir, ".yushu", "index.db");
});

afterEach(async () => {
  // Windows 上 WAL 句柄释放有延迟；断言失败时可能残留打开连接 → 删除失败不掩盖主错误
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

function sampleInput(): IndexInput {
  return {
    files: [
      { path: "world/cards/character/char-linyuan.md", hash: "h1", bytes: 120, mtime: "2026-09-29T00:00:00.000Z" },
      { path: "chapters/vol-1/ch-1.md", hash: "h2", bytes: 300 },
    ],
    entities: [
      {
        id: "char-linyuan",
        type: "character",
        layer: "characters",
        name: "林渊",
        aliases: ["小渊"],
        visibility: "hidden",
        filePath: "world/cards/character/char-linyuan.md",
      },
    ],
    refs: [{ referrer: "char-linyuan", relation: "师从", target: "fac-qingyun" }],
    chunks: [
      {
        id: "chk-aaaaaaaa-001",
        path: "chapters/vol-1/ch-1.md",
        chapterId: "ch-1",
        volume: "vol-1",
        kind: "chapter",
        text: "夜色压下来，林渊拔剑而起。",
        charStart: 0,
        charEnd: 13,
        textHash: "th1",
        entities: ["林渊"],
      },
      {
        id: "chk-aaaaaaaa-002",
        path: "chapters/vol-1/ch-1.md",
        chapterId: "ch-1",
        volume: "vol-1",
        kind: "chapter",
        text: "他登上青云山，拜入宗门。",
        charStart: 13,
        charEnd: 26,
        textHash: "th2",
        entities: [],
      },
    ],
  };
}

describe("索引重建（T1-21）", () => {
  it("重建写入四表 + FTS 行数一致；统计含 schema_version 与 built_at", () => {
    const db = openIndex(dbPath);
    const stats = rebuildIndex(db, sampleInput(), "2026-09-29T10:00:00.000Z");
    expect(stats.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(stats.builtAt).toBe("2026-09-29T10:00:00.000Z");
    expect(stats).toMatchObject({ files: 2, entities: 1, refs: 1, chunks: 2, ftsRows: 2 });
    closeIndex(db);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("重复重建幂等（结果与统计不变）", () => {
    const db = openIndex(dbPath);
    const first = rebuildIndex(db, sampleInput(), "2026-09-29T10:00:00.000Z");
    const second = rebuildIndex(db, sampleInput(), "2026-09-29T10:00:00.000Z");
    expect(second).toEqual(first);
    closeIndex(db);
  });

  it("删除索引库后全量重建：查询结果与统计完全一致（零丢失实测）", async () => {
    const db = openIndex(dbPath);
    rebuildIndex(db, sampleInput(), "2026-09-29T10:00:00.000Z");
    const before = queryChunks(db, "林渊");
    const beforeStats = readStats(db);
    closeIndex(db);

    // 模拟"删除索引库"（真源文件不受影响）
    await removeIndexFiles(dbPath);
    expect(existsSync(dbPath)).toBe(false);

    const db2 = openIndex(dbPath);
    expect(readStats(db2)).toBeNull(); // 新库尚未构建
    rebuildIndex(db2, sampleInput(), "2026-09-29T10:00:00.000Z");
    expect(readStats(db2)).toEqual(beforeStats);
    expect(queryChunks(db2, "林渊")).toEqual(before);
    closeIndex(db2);
  });
});

describe("FTS5 external content 查询", () => {
  it("中文短语命中并返回 snippet 高亮与出处", () => {
    const db = openIndex(dbPath);
    rebuildIndex(db, sampleInput());
    const hits = queryChunks(db, "林渊");
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.chapterId).toBe("ch-1");
    expect(hit.path).toBe("chapters/vol-1/ch-1.md");
    expect(hit.snippet).toContain("【林渊】");
    expect(hit.charStart).toBe(0);

    const none = queryChunks(db, "不存在的词");
    expect(none).toEqual([]);
    const empty = queryChunks(db, "   ");
    expect(empty).toEqual([]);
    closeIndex(db);
  });

  it("实体名/别名包含匹配（lookupEntities）", () => {
    const db = openIndex(dbPath);
    rebuildIndex(db, sampleInput());
    expect(lookupEntities(db, "林渊").map((item) => item.id)).toEqual(["char-linyuan"]);
    expect(lookupEntities(db, "小渊").map((item) => item.id)).toEqual(["char-linyuan"]);
    expect(lookupEntities(db, "张三")).toEqual([]);
    closeIndex(db);
  });

  it("查询串含 FTS 操作符时不抛错（按短语转义）", () => {
    const db = openIndex(dbPath);
    rebuildIndex(db, sampleInput());
    expect(() => queryChunks(db, '林渊 OR "')).not.toThrow();
    closeIndex(db);
  });
});

describe("token 粗估", () => {
  it("CJK 字符 + ASCII 词计数", () => {
    expect(estimateTokens("天启界夜色")).toBe(5);
    expect(estimateTokens("hello 世界 2026")).toBe(1 + 2 + 1);
  });
});

describe("分片写入与进度（T2-5 切片 B）", () => {
  it("重建按批推进进度（files → chunks → merge）：chunks 事件数 = 分片数；查询与统计不受分片影响", () => {
    const db = openIndex(dbPath);
    const events: RebuildProgress[] = [];
    const stats = rebuildIndex(db, sampleInput(), undefined, {
      batchSize: 1, // 每批 1 块：2 块 → 2 个分片事件
      onProgress: (progress) => events.push(progress),
    });
    expect(stats).toMatchObject({ files: 2, chunks: 2, ftsRows: 2 });

    const chunkEvents = events.filter((event) => event.phase === "chunks");
    expect(chunkEvents).toHaveLength(2);
    expect(chunkEvents.map((event) => event.done)).toEqual([1, 2]);
    expect(chunkEvents[1]!.total).toBe(2);
    expect(events.some((event) => event.phase === "files")).toBe(true);
    expect(events[events.length - 1]!.phase).toBe("merge");

    // 分片写入后 FTS 与内容对齐、中文检索正常
    expect(queryChunks(db, "林渊")).toHaveLength(1);
    expect(readStats(db)!.ftsRows).toBe(2);
    closeIndex(db);
  });

  it("重建覆盖旧 FTS 索引（delete-all + 分片写入）：旧内容不再命中、新内容可查", () => {
    const db = openIndex(dbPath);
    rebuildIndex(db, sampleInput());
    expect(queryChunks(db, "林渊")).toHaveLength(1);

    const modified = sampleInput();
    modified.chunks = modified.chunks.map((chunk) => ({ ...chunk, text: "铁马冰河入梦来。", entities: [] }));
    rebuildIndex(db, modified);

    // 旧索引段必须已被清空（不先 delete-all 会残留或报内容不一致）
    expect(queryChunks(db, "林渊")).toEqual([]);
    expect(queryChunks(db, "铁马")).toHaveLength(2); // 两块同文，均命中
    closeIndex(db);
  });
});