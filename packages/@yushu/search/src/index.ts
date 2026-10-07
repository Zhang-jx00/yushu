/**
 * 御书检索索引（M1 最小版 T1-21；M3/T3-8 增补 RAG 混合检索）：
 * - SQLite（Node 内置 `node:sqlite`，零原生依赖）+ FTS5 external content；
 * - 表：entities / refs / chunks / file_index / chunk_vectors + chunks_fts（docs/03 §6）；
 * - 真源永不进 SQLite：库位于 `.yushu/index.db`，可删除、可全量重建；
 * - RAG（T3-8）：向量路（sqlite-vec，可回退本地余弦）+ FTS5 bm25 关键词路 → RRF(k=60) 融合 → 可选重排；
 * - 增量索引（保存即更新）、中文分词扩展（simple/拼音）留待后续。
 */

export * from "./types.js";
export * from "./index-db.js";
export * from "./vector.js";
export * from "./rag.js";