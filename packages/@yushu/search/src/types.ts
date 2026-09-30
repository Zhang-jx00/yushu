/**
 * 索引输入结构（生产侧声明：@yushu/world-engine 的 collectIndexInput 产出本结构；
 * @yushu/search 消费同形结构——两边各自声明、结构兼容，避免引擎包互相依赖）。
 */

export interface IndexFileRow {
  path: string;
  /** 文件 mtime（ISO；读取源未提供时可空） */
  mtime?: string;
  /** 内容 sha256 */
  hash: string;
  bytes: number;
}

export interface IndexEntityRow {
  id: string;
  type: string;
  layer: string;
  name: string;
  aliases: string[];
  visibility: string;
  filePath: string;
}

export interface IndexRefRow {
  /** 引用方实体 ID */
  referrer: string;
  relation: string;
  target: string;
}

export interface IndexChunkRow {
  id: string;
  /** 来源文件（相对路径；溯源与增量更新用） */
  path: string;
  /** 章节实体 ID（章节正文块） */
  chapterId?: string;
  /** 所属卷（章节正文块） */
  volume?: string;
  /** card | chapter | outline */
  kind: string;
  text: string;
  charStart: number;
  charEnd: number;
  /** 块文本 sha256 */
  textHash: string;
  /** 块内提及的实体名（提及追踪基础；M2 细化到别名触发） */
  entities: string[];
}

export interface IndexInput {
  files: IndexFileRow[];
  entities: IndexEntityRow[];
  refs: IndexRefRow[];
  chunks: IndexChunkRow[];
}

export interface IndexStats {
  schemaVersion: number;
  builtAt: string;
  files: number;
  entities: number;
  refs: number;
  chunks: number;
  /**
   * FTS5 真实索引行数（影子表 `chunks_fts_docsize` 每已索引文档一行；应与 chunks 一致）。
   * 注意：不能取 `count(*) FROM chunks_fts`——external content 表会回落到 content 表（恒等于 chunks，
   * 掩盖"索引缺行"）；不一致即视为索引滞后/损坏（`checkIntegrity` 为完整校验）。
   */
  ftsRows: number;
}

export interface ChunkHit {
  chunkId: string;
  path: string;
  kind: string;
  chapterId?: string;
  volume?: string;
  charStart: number;
  charEnd: number;
  textHash: string;
  entities: string[];
  /** 命中片段（含 FTS5 snippet 标记） */
  snippet: string;
}

export interface EntityHit {
  id: string;
  type: string;
  layer: string;
  name: string;
  aliases: string[];
  filePath: string;
}