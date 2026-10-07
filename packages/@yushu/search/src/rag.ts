import type { DatabaseSync } from "node:sqlite";
import { buildMatchQuery, chunkHitFromRow, unspaceCjk } from "./index-db.js";
import type { ChunkHit } from "./types.js";
import { embedText, ensureChunkVectors, openVectorStore, type VectorStoreOptions } from "./vector.js";

/**
 * RAG 混合检索（T3-8；docs/03 §10.2 检索一路）：
 * - 向量路（sqlite-vec KNN；扩展不可用时本地确定性嵌入 + 余弦兜底）与
 *   关键词路（FTS5 bm25，中文按 CJK unigram 短语匹配）**并行**；
 * - **RRF（k=60，加权）** 融合取 top-20，可选重排至 top-6；
 * - 结果带出处（`chapter_id + 字符区间 + 摘录 hash`）交 §10.2 组装 / 预览器；
 * - 全程确定性（同输入同输出——快照复现的前提）。
 */

/** 关键词路命中（`bm25` 为 FTS5 原文：负值、越小越相关；回执展示 `-bm25` 使「越大越好」） */
export interface Bm25ChunkHit extends ChunkHit {
  bm25: number;
}

/** FTS5 bm25 检索（关键词路）：与 `queryChunks` 同款中文预处理，附 bm25 分值 */
export function queryChunksBm25(db: DatabaseSync, query: string, limit: number): Bm25ChunkHit[] {
  if (query.trim() === "" || limit <= 0) return [];
  const match = buildMatchQuery(query);
  if (match === "") return [];
  const rows = db
    .prepare(
      `SELECT c.id AS chunk_id, c.path, c.kind, c.chapter_id, c.volume, c.char_start, c.char_end,
              c.text_hash, c.entities,
              snippet(chunks_fts, 0, '【', '】', '…', 12) AS snip,
              bm25(chunks_fts) AS score
       FROM chunks_fts
       JOIN chunks c ON c.rowid = chunks_fts.rowid
       WHERE chunks_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(match, limit) as Record<string, unknown>[];
  return rows.map((row) => ({ ...chunkHitFromRow(row, unspaceCjk), bm25: Number(row["score"] ?? 0) }));
}

export interface RagHit {
  chunkId: string;
  path: string;
  kind: string;
  /** 出处：章节实体 id（正文块）；设定卡 / 大纲块无章节时缺省 */
  chapterId?: string;
  volume?: string;
  /** 出处：块在源文件中的字符区间 [charStart, charEnd) */
  charStart: number;
  charEnd: number;
  /** 出处：块文本 sha256（正文改动 → 出处失效可检出） */
  textHash: string;
  entities: string[];
  /** 块全文（UI 自行截断展示） */
  text: string;
  /** 关键词路命中片段（含 FTS5 高亮标记；仅关键词路命中时有） */
  snippet?: string;
  /** RRF 融合分（越大越好） */
  score: number;
  /** 融合名次（1 起） */
  rank: number;
  /** 各路来源明细（vector.score = 余弦；keyword.score = -bm25） */
  sources: {
    vector?: { rank: number; score: number };
    keyword?: { rank: number; score: number };
  };
  /** 本地启发式重排结果（启用时） */
  rerank?: { rank: number; score: number; reason: string };
}

export interface RagSearchOptions {
  /** 每路原始召回上限（缺省 50） */
  pathLimit?: number;
  /** 融合输出条数（缺省 20） */
  limit?: number;
  /** RRF k（缺省 60） */
  rrfK?: number;
  /** 两路权重（缺省各 1） */
  weights?: { vector?: number; keyword?: number };
  /** >0 启用本地启发式重排（缺省 0=关闭；组装建议 6） */
  rerankTopK?: number;
  /** 向量存储选项（sqlite-vec 扩展路径；缺省环境变量 YUSHU_SQLITE_VEC） */
  vector?: VectorStoreOptions;
}

export interface RagSearchResult {
  query: string;
  /** 向量实现（sqlite-vec / cosine 兜底——如实回执） */
  store: "sqlite-vec" | "cosine";
  storeNote: string;
  dim: number;
  /** 向量库存量 */
  vectorRows: number;
  /** 本次查询惰性补齐的向量条数（0 = 无缺失） */
  repairedVectors: number;
  rrfK: number;
  weights: { vector: number; keyword: number };
  /** 两路原始命中数 */
  paths: { vector: number; keyword: number };
  /** RRF 融合 top-（缺省 20） */
  fused: RagHit[];
  /** 可选重排 top-（缺省关闭时为空数组） */
  reranked: RagHit[];
}

/**
 * RRF（Reciprocal Rank Fusion；docs/03 §10.2：k=60，加权）：
 * `score(d) = Σ weight_i / (k + rank_i(d))`，rank 从 1 起；同分按 id 升序（确定性）。
 * 纯函数（rank 列表进、融合分序出）——单测直接覆盖公式与权重。
 */
export function rrfFuse(
  lists: { ids: string[]; weight: number }[],
  k = 60,
): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.ids.forEach((id, index) => {
      scores.set(id, (scores.get(id) ?? 0) + list.weight / (k + index + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** 查询 bigram 覆盖：查询字符 bigram 集合命中文本 bigram 集合的比例（0-1） */
export function queryCoverage(query: string, text: string): number {
  const bigrams = (value: string) => {
    const normalized = value.replace(/\s+/g, "");
    const set = new Set<string>();
    for (let index = 0; index + 1 < normalized.length; index += 1) set.add(normalized.slice(index, index + 2));
    if (set.size === 0 && normalized !== "") set.add(normalized);
    return set;
  };
  const queryGrams = bigrams(query);
  if (queryGrams.size === 0) return 0;
  const textGrams = bigrams(text);
  let hit = 0;
  for (const gram of queryGrams) if (textGrams.has(gram)) hit += 1;
  return hit / queryGrams.size;
}

/**
 * 本地启发式重排（可选 top-6；docs/03 §10.2 的 bge-reranker 为后续经 provider 的替换点）：
 * 词面覆盖（查询 bigram 在块文本前 500 字中的覆盖率）× 0.8 + 双路命中加成 0.15 + 融合名次微先验；
 * 全确定性（同输入同输出），排序总序（分 → 融合名次 → id）便于快照复现。
 */
export function rerankHits(hits: RagHit[], query: string, topK: number): RagHit[] {
  if (topK <= 0 || hits.length === 0) return [];
  const trimmed = query.trim();
  const scored = hits.map((hit) => {
    const coverage = trimmed === "" ? 0 : queryCoverage(trimmed, hit.text.slice(0, 500));
    const dual = hit.sources.vector && hit.sources.keyword ? 1 : 0;
    const prior = 1 / (60 + hit.rank);
    const score = Number((Math.min(1, coverage * 0.8 + dual * 0.15 + prior)).toFixed(6));
    const route = dual ? "双路命中" : hit.sources.vector ? "仅向量路" : "仅关键词路";
    const reason = `词面覆盖 ${coverage.toFixed(3)} · ${route} · 融合 #${hit.rank}`;
    return { hit, score, reason };
  });
  scored.sort((a, b) => b.score - a.score || a.hit.rank - b.hit.rank || a.hit.chunkId.localeCompare(b.hit.chunkId));
  return scored.slice(0, topK).map((entry, index) => ({
    ...entry.hit,
    rerank: { rank: index + 1, score: entry.score, reason: entry.reason },
  }));
}

/**
 * RAG 混合检索（T3-8 核心）：向量路 + 关键词路并行 → RRF 融合 → 可选重排 → 结果带出处。
 * 空查询返回空结果（不抛错——调用方负责提示）；索引与向量库的孤儿行跳过、不影响其余结果。
 */
export function ragSearch(db: DatabaseSync, query: string, options: RagSearchOptions = {}): RagSearchResult {
  const pathLimit = Math.max(1, Math.floor(options.pathLimit ?? 50));
  const limit = Math.max(0, Math.floor(options.limit ?? 20));
  const rrfK = Math.max(1, Math.floor(options.rrfK ?? 60));
  const weights = { vector: options.weights?.vector ?? 1, keyword: options.weights?.keyword ?? 1 };
  const rerankTopK = Math.max(0, Math.floor(options.rerankTopK ?? 0));

  const repairedVectors = ensureChunkVectors(db);
  const store = openVectorStore(db, options.vector ?? {});
  const vectorHits = query.trim() === "" ? [] : store.knn(embedText(query), pathLimit);
  const keywordHits = queryChunksBm25(db, query, pathLimit);

  const vectorRanks = new Map(vectorHits.map((hit, index) => [hit.chunkId, { rank: index + 1, score: hit.score }]));
  const keywordRanks = new Map(keywordHits.map((hit, index) => [hit.chunkId, { rank: index + 1, score: -hit.bm25 }]));
  const fusedRaw = rrfFuse(
    [
      { ids: vectorHits.map((hit) => hit.chunkId), weight: weights.vector },
      { ids: keywordHits.map((hit) => hit.chunkId), weight: weights.keyword },
    ],
    rrfK,
  );

  // 补水正文与出处（一次取全，保持融合名次）
  const selected = fusedRaw.slice(0, limit);
  const rowsById = new Map<string, Record<string, unknown>>();
  if (selected.length > 0) {
    const placeholders = selected.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT id, path, kind, chapter_id, volume, char_start, char_end, text_hash, entities, text
         FROM chunks WHERE id IN (${placeholders})`,
      )
      .all(...selected.map((entry) => entry.id)) as Record<string, unknown>[];
    for (const row of rows) rowsById.set(String(row["id"] ?? ""), row);
  }
  const snippetById = new Map(keywordHits.map((hit) => [hit.chunkId, hit.snippet]));

  const fused: RagHit[] = [];
  selected.forEach((entry, index) => {
    const row = rowsById.get(entry.id);
    if (!row) return; // 孤儿行（索引与向量不一致）：跳过，不影响其余结果
    fused.push({
      chunkId: entry.id,
      path: String(row["path"] ?? ""),
      kind: String(row["kind"] ?? ""),
      ...(row["chapter_id"] ? { chapterId: String(row["chapter_id"]) } : {}),
      ...(row["volume"] ? { volume: String(row["volume"]) } : {}),
      charStart: Number(row["char_start"] ?? 0),
      charEnd: Number(row["char_end"] ?? 0),
      textHash: String(row["text_hash"] ?? ""),
      entities: String(row["entities"] ?? "")
        .split("、")
        .filter(Boolean),
      text: String(row["text"] ?? ""),
      ...(snippetById.has(entry.id) ? { snippet: snippetById.get(entry.id)! } : {}),
      score: entry.score,
      rank: index + 1,
      sources: {
        ...(vectorRanks.has(entry.id) ? { vector: vectorRanks.get(entry.id)! } : {}),
        ...(keywordRanks.has(entry.id) ? { keyword: keywordRanks.get(entry.id)! } : {}),
      },
    });
  });

  const reranked = rerankTopK > 0 ? rerankHits(fused, query, rerankTopK) : [];
  return {
    query,
    store: store.kind,
    storeNote: store.note,
    dim: store.dim,
    vectorRows: store.size(),
    repairedVectors,
    rrfK,
    weights,
    paths: { vector: vectorHits.length, keyword: keywordHits.length },
    fused,
    reranked,
  };
}