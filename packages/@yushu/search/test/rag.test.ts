import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyIndexDelta,
  closeIndex,
  embedText,
  ensureChunkVectors,
  LOCAL_EMBED_DIM,
  openIndex,
  queryChunksBm25,
  ragSearch,
  rebuildIndex,
  rerankHits,
  rrfFuse,
  type IndexInput,
  type RagHit,
} from "@yushu/search";

/**
 * RAG 混合检索单测（T3-8）：
 * 向量路（本地确定性嵌入 + 余弦兜底；sqlite-vec 未配置时为缺省路径）、
 * FTS5 bm25 关键词路、RRF 融合（k=60 公式与权重）、重排 top-6、出处（chapter_id + 区间 + hash）、
 * 向量与正文块同事务（全量重建 / 增量），以及旧库惰性补齐。
 */

let dir: string;
let dbPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-rag-"));
  dbPath = join(dir, ".yushu", "index.db");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

function sampleInput(): IndexInput {
  return {
    files: [
      { path: "chapters/vol-1/ch-1.md", hash: "h1", bytes: 300 },
      { path: "chapters/vol-1/ch-2.md", hash: "h2", bytes: 300 },
    ],
    entities: [],
    refs: [],
    chunks: [
      {
        id: "chk-1",
        path: "chapters/vol-1/ch-1.md",
        chapterId: "ch-1",
        volume: "vol-1",
        kind: "chapter",
        text: "夜色压下来，林渊拔剑而起，剑光照亮整座山门。",
        charStart: 0,
        charEnd: 22,
        textHash: "th1",
        entities: ["林渊"],
      },
      {
        id: "chk-2",
        path: "chapters/vol-1/ch-2.md",
        chapterId: "ch-2",
        volume: "vol-1",
        kind: "chapter",
        text: "他登上青云山，拜入宗门，从此踏上修行路。",
        charStart: 0,
        charEnd: 20,
        textHash: "th2",
        entities: [],
      },
    ],
  };
}

describe("本地确定性嵌入（T3-8 向量路兜底）", () => {
  it("同输入同输出、L2 归一化，字面相近文本相似度更高", () => {
    const a = embedText("林渊拔剑而起");
    const b = embedText("林渊拔剑而起");
    expect(a).toEqual(b);
    expect(a.length).toBe(LOCAL_EMBED_DIM);
    let norm = 0;
    for (const value of a) norm += value * value;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 6);
    const similar = embedText("林渊拔剑");
    const unrelated = embedText("青云山拜入宗门");
    const dot = (x: Float32Array, y: Float32Array) => x.reduce((sum, value, index) => sum + value * y[index]!, 0);
    expect(dot(a, similar)).toBeGreaterThan(dot(a, unrelated));
  });

  it("空文本为零向量（KNN 视为无命中）", () => {
    const vec = embedText("");
    expect([...vec].every((value) => value === 0)).toBe(true);
  });
});

describe("关键词路 FTS5 bm25", () => {
  it("中文按 CJK unigram 短语命中，附 bm25 负分与 snippet 高亮", () => {
    const db = openIndex(dbPath);
    rebuildIndex(db, sampleInput());
    const hits = queryChunksBm25(db, "林渊拔剑", 20);
    expect(hits.length).toBe(1);
    expect(hits[0]!.chunkId).toBe("chk-1");
    expect(hits[0]!.bm25).toBeLessThan(0); // FTS5 bm25：负值、越小越相关
    expect(hits[0]!.snippet).toContain("【林渊");
    closeIndex(db);
  });
});

describe("RRF 融合（纯函数）", () => {
  it("k=60 公式：同分并列按 id；权重可把单路名次放大", () => {
    const fused = rrfFuse(
      [
        { ids: ["a", "b"], weight: 1 },
        { ids: ["b", "a"], weight: 1 },
      ],
      60,
    );
    // a: 1/61 + 1/62；b: 1/62 + 1/61 —— 同分 → 按 id 升序
    expect(fused.map((entry) => entry.id)).toEqual(["a", "b"]);
    expect(fused[0]!.score).toBeCloseTo(1 / 61 + 1 / 62, 10);
    const weighted = rrfFuse(
      [
        { ids: ["a", "b"], weight: 1 },
        { ids: ["b", "a"], weight: 2 },
      ],
      60,
    );
    // b: 1/62 + 2/61 > a: 1/61 + 2/62
    expect(weighted.map((entry) => entry.id)).toEqual(["b", "a"]);
  });
});

describe("RAG 混合检索（T3-8）", () => {
  it("双路并行 → RRF 融合 → 结果带出处（chapter_id + 区间 + hash）且融合分有序", () => {
    const db = openIndex(dbPath);
    rebuildIndex(db, sampleInput());
    const result = ragSearch(db, "林渊拔剑", { rerankTopK: 6 });
    expect(result.store).toBe("cosine"); // 未配置 sqlite-vec：如实回退本地余弦
    expect(result.storeNote).toContain("sqlite-vec");
    expect(result.paths.keyword).toBeGreaterThanOrEqual(1);
    expect(result.paths.vector).toBeGreaterThanOrEqual(1);
    expect(result.fused.length).toBeGreaterThanOrEqual(1);
    const top = result.fused[0]!;
    expect(top.chunkId).toBe("chk-1");
    expect(top.chapterId).toBe("ch-1");
    expect(top.charEnd).toBeGreaterThan(top.charStart);
    expect(top.textHash).toBe("th1");
    expect(top.sources.vector).toBeDefined();
    expect(top.sources.keyword).toBeDefined();
    for (let index = 1; index < result.fused.length; index += 1) {
      expect(result.fused[index - 1]!.score).toBeGreaterThanOrEqual(result.fused[index]!.score);
    }
    // 重排 top-6：条数受限、带名次与依据
    expect(result.reranked.length).toBeGreaterThanOrEqual(1);
    expect(result.reranked.length).toBeLessThanOrEqual(6);
    expect(result.reranked[0]!.rerank!.rank).toBe(1);
    expect(result.reranked[0]!.rerank!.reason).toContain("词面覆盖");
    closeIndex(db);
  });

  it("重排确定性：同输入两次结果完全一致", () => {
    const db = openIndex(dbPath);
    rebuildIndex(db, sampleInput());
    const first = ragSearch(db, "林渊 青云山", { rerankTopK: 6 });
    const second = ragSearch(db, "林渊 青云山", { rerankTopK: 6 });
    expect(JSON.stringify(second)).toEqual(JSON.stringify(first));
    closeIndex(db);
  });

  it("空查询返回空结果（不抛错）；limit / pathLimit 生效", () => {
    const db = openIndex(dbPath);
    rebuildIndex(db, sampleInput());
    const empty = ragSearch(db, "   ");
    expect(empty.fused).toEqual([]);
    expect(empty.reranked).toEqual([]);
    const limited = ragSearch(db, "林渊", { limit: 1 });
    expect(limited.fused.length).toBeLessThanOrEqual(1);
    closeIndex(db);
  });

  it("旧库（缺向量行）首个查询惰性补齐；补齐后向量路恢复命中", () => {
    const db = openIndex(dbPath);
    rebuildIndex(db, sampleInput());
    db.exec("DELETE FROM chunk_vectors;");
    const repaired = ragSearch(db, "林渊拔剑");
    expect(repaired.repairedVectors).toBe(2);
    expect(repaired.paths.vector).toBeGreaterThanOrEqual(1);
    expect(repaired.vectorRows).toBe(2);
    const again = ragSearch(db, "林渊拔剑");
    expect(again.repairedVectors).toBe(0);
    closeIndex(db);
  });
});

describe("向量与正文块同事务（全量重建 / 增量）", () => {
  it("增量更新：块文本改变 → 旧向量随路径清理、新向量可命中新词", () => {
    const db = openIndex(dbPath);
    rebuildIndex(db, sampleInput());
    const delta: IndexInput = {
      ...sampleInput(),
      files: [sampleInput().files[0]!],
      chunks: [
        {
          ...sampleInput().chunks[0]!,
          text: "夜色压下来，林渊御剑而行，直上九霄。",
          textHash: "th1b",
        },
      ],
    };
    applyIndexDelta(db, {
      removedPaths: [],
      files: delta.files,
      touchedFiles: [],
      entities: [],
      refs: [],
      chunks: delta.chunks,
    });
    const vectorRows = db.prepare("SELECT count(*) AS c FROM chunk_vectors").get() as { c: number };
    expect(vectorRows.c).toBe(2); // 旧向量已删、新向量已写（chk-2 保留）
    const result = ragSearch(db, "御剑而行");
    expect(result.fused.some((hit) => hit.chunkId === "chk-1")).toBe(true);
    closeIndex(db);
  });

  it("移除文件：向量行随正文块一并清理", () => {
    const db = openIndex(dbPath);
    rebuildIndex(db, sampleInput());
    applyIndexDelta(db, { removedPaths: ["chapters/vol-1/ch-2.md"], files: [], touchedFiles: [], entities: [], refs: [], chunks: [] });
    const vectorRows = db.prepare("SELECT count(*) AS c FROM chunk_vectors").get() as { c: number };
    expect(vectorRows.c).toBe(1);
    closeIndex(db);
  });
});

describe("重排（本地启发式；bge-reranker 为后续替换点）", () => {
  it("词面覆盖高者优先、top-6 截断、输出确定性", () => {
    const hit = (id: string, text: string, rank: number): RagHit => ({
      chunkId: id,
      path: `chapters/${id}.md`,
      kind: "chapter",
      chapterId: id,
      charStart: 0,
      charEnd: text.length,
      textHash: "hash",
      entities: [],
      text,
      score: 0,
      rank,
      sources: { keyword: { rank, score: -1 } },
    });
    const hits = [hit("chk-b", "与查询无关的段落内容", 1), hit("chk-a", "林渊拔剑而起剑光冲霄", 2)];
    const reranked = rerankHits(hits, "林渊拔剑", 6);
    expect(reranked[0]!.chunkId).toBe("chk-a");
    expect(reranked[0]!.rerank!.score).toBeGreaterThan(reranked[1]!.rerank!.score);
    const again = rerankHits(hits, "林渊拔剑", 6);
    expect(JSON.stringify(again)).toEqual(JSON.stringify(reranked));
    expect(rerankHits(hits, "林渊拔剑", 0)).toEqual([]);
  });
});