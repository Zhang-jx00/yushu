/**
 * 御书检索索引（M1 最小版，T1-21）：
 * - SQLite（Node 内置 `node:sqlite`，零原生依赖）+ FTS5 external content；
 * - 表：entities / refs / chunks / file_index + chunks_fts（docs/03 §6）；
 * - 真源永不进 SQLite：库位于 `.yushu/index.db`，可删除、可全量重建；
 * - 增量索引（保存即更新）、中文分词扩展（simple/拼音）、向量检索与 RRF 融合留待 M2/M3。
 */

export * from "./types.js";
export * from "./index-db.js";