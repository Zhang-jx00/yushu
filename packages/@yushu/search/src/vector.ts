import { existsSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";

/**
 * 向量路存储（T3-8；docs/03 §10.2 检索一路 / §5.3 VectorStore 抽象）：
 * - `VectorStore` 接口把「向量存取 + KNN」与检索融合解耦——换实现只改适配层 + 全量重建；
 * - 首选 **sqlite-vec**（锁版本，docs/03 §10.2）：经 `YUSHU_SQLITE_VEC` 环境变量或显式路径加载扩展，
 *   以 `vec_distance_cosine` 标量函数对 `chunk_vectors` 做 KNN；
 * - 扩展不可用（未安装 / 平台缺预编译 / 运行时未开启扩展加载）→ **本地确定性嵌入 + JS 余弦 KNN 兜底**：
 *   离线可用、零依赖、结果可复现（同输入同输出；派生数据，可随索引全量重建）；
 * - 向量与正文块同事务写入 `chunk_vectors`（SQLite 仅作索引，真源永远是项目文件）。
 * 注：本地嵌入为**字面共现型**（非语义）——只保证字面相近的文本更相似；
 * 云端语义嵌入（如 bge-m3）经同一 `VectorStore` 适配层替换（docs/03 §677）。
 */

export const LOCAL_EMBED_DIM = 256;

/** 单码元 FNV-1a（与 fnv1a(单字符) 等价；避免逐字 slice 的海量临时字符串——重建路径热点） */
function fnv1aCode(code: number): number {
  return Math.imul(0x811c9dc5 ^ code, 0x01000193) >>> 0;
}

/** 双码元 FNV-1a（与 fnv1a(双字符) 等价；同上） */
function fnv1aPair(a: number, b: number): number {
  return Math.imul(Math.imul(0x811c9dc5 ^ a, 0x01000193) ^ b, 0x01000193) >>> 0;
}

/**
 * 本地确定性嵌入（缺省 256 维）：
 * CJK 单字（权重 1）+ 相邻双字（权重 2，更具区分度）+ ASCII / 数字小写词（权重 2），
 * FNV-1a 哈希入桶后 L2 归一化；空文本返回零向量（KNN 侧视为无命中）。
 */
export function embedText(text: string, dim = LOCAL_EMBED_DIM): Float32Array {
  const vec = new Float32Array(dim);
  const lower = text.toLowerCase();
  const cjkRuns = lower.match(/[\u3400-\u9fff\uf900-\ufaff]+/g) ?? [];
  for (const run of cjkRuns) {
    for (let index = 0; index < run.length; index += 1) {
      const unigram = fnv1aCode(run.charCodeAt(index)) % dim;
      vec[unigram] = (vec[unigram] ?? 0) + 1;
      if (index + 1 < run.length) {
        const bigram = fnv1aPair(run.charCodeAt(index), run.charCodeAt(index + 1)) % dim;
        vec[bigram] = (vec[bigram] ?? 0) + 2;
      }
    }
  }
  const words = lower.match(/[a-z0-9]+/g) ?? [];
  for (const word of words) {
    let hash = 0x811c9dc5;
    for (let index = 0; index < word.length; index += 1) {
      hash = Math.imul(hash ^ word.charCodeAt(index), 0x01000193) >>> 0;
    }
    const bucket = hash % dim;
    vec[bucket] = (vec[bucket] ?? 0) + 2;
  }
  let norm = 0;
  for (let index = 0; index < dim; index += 1) norm += vec[index]! * vec[index]!;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let index = 0; index < dim; index += 1) vec[index] = vec[index]! / norm;
  }
  return vec;
}

/** 余弦相似度（对未归一化向量同样正确；任一零向量返回 0） */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! * a[index]!;
    normB += b[index]! * b[index]!;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/** Float32Array → BLOB（显式小端写入；跨平台确定，读取侧同规则） */
export function vecToBlob(vec: Float32Array): Uint8Array {
  const bytes = new Uint8Array(vec.length * 4);
  const view = new DataView(bytes.buffer);
  for (let index = 0; index < vec.length; index += 1) view.setFloat32(index * 4, vec[index]!, true);
  return bytes;
}

/** BLOB → Float32Array（显式小端读取，与 vecToBlob 对偶） */
export function blobToVec(bytes: Uint8Array): Float32Array {
  const out = new Float32Array(Math.floor(bytes.byteLength / 4));
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < out.length; index += 1) out[index] = view.getFloat32(index * 4, true);
  return out;
}

export interface VectorKnnHit {
  chunkId: string;
  /** 余弦相似度（越大越相似） */
  score: number;
}

/** 向量存储接口（KNN 查询；写入由索引写路径与正文块同事务完成） */
export interface VectorStore {
  /** sqlite-vec = 扩展加载成功；cosine = 本地确定性嵌入 + JS 余弦兜底 */
  readonly kind: "sqlite-vec" | "cosine";
  /** 实现说明（回执 / UI 如实标注原因） */
  readonly note: string;
  dim: number;
  /** 向量库存量（参与 KNN 的行数） */
  size(): number;
  knn(query: Float32Array, limit: number): VectorKnnHit[];
}

export interface VectorStoreOptions {
  /** sqlite-vec 扩展文件路径（缺省读环境变量 YUSHU_SQLITE_VEC） */
  extensionPath?: string;
}

type SqliteVecProbe = { ok: true; version: string } | { ok: false; reason: string };

function vectorRowCount(db: DatabaseSync): number {
  const row = db.prepare("SELECT count(*) AS c FROM chunk_vectors").get() as { c?: number } | undefined;
  return typeof row?.c === "number" ? row.c : 0;
}

/** sqlite-vec 探测：加载扩展并取版本；任何不可用都如实返回原因（绝不抛出——回退兜底） */
function probeSqliteVec(db: DatabaseSync, extensionPath?: string): SqliteVecProbe {
  const path = extensionPath ?? process.env["YUSHU_SQLITE_VEC"] ?? "";
  if (path === "") return { ok: false, reason: "未配置 sqlite-vec 扩展路径（环境变量 YUSHU_SQLITE_VEC）" };
  if (!existsSync(path)) return { ok: false, reason: `sqlite-vec 扩展文件不存在：${path}` };
  const load = (db as unknown as { loadExtension?: (file: string) => void }).loadExtension;
  if (typeof load !== "function") {
    return { ok: false, reason: "当前运行时 node:sqlite 不支持扩展加载（openIndex 已尝试开启 allowExtension）" };
  }
  try {
    load.call(db, path);
    const row = db.prepare("SELECT vec_version() AS v").get() as { v?: string } | undefined;
    return { ok: true, version: typeof row?.v === "string" ? row.v : "unknown" };
  } catch (err) {
    return { ok: false, reason: `sqlite-vec 加载失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

/** 打开向量库：优先 sqlite-vec；不可用回退本地余弦（note 说明原因，不静默） */
export function openVectorStore(db: DatabaseSync, options: VectorStoreOptions = {}): VectorStore {
  const probe = probeSqliteVec(db, options.extensionPath);
  if (probe.ok) {
    return {
      kind: "sqlite-vec",
      note: `sqlite-vec ${probe.version}（vec_distance_cosine KNN）`,
      dim: LOCAL_EMBED_DIM,
      size: () => vectorRowCount(db),
      knn: (query, limit) => {
        if (query.length === 0 || limit <= 0) return [];
        const rows = db
          .prepare(
            "SELECT chunk_id, vec_distance_cosine(vec, ?) AS distance FROM chunk_vectors ORDER BY distance ASC LIMIT ?",
          )
          .all(vecToBlob(query), limit) as Record<string, unknown>[];
        return rows.map((row) => ({
          chunkId: String(row["chunk_id"] ?? ""),
          score: 1 - Number(row["distance"] ?? 1),
        }));
      },
    };
  }
  return {
    kind: "cosine",
    note: `本地确定性嵌入（${LOCAL_EMBED_DIM} 维，字面 bigram 哈希）+ 余弦 KNN 兜底：${probe.reason}`,
    dim: LOCAL_EMBED_DIM,
    size: () => vectorRowCount(db),
    knn: (query, limit) => {
      if (query.length === 0 || limit <= 0) return [];
      const rows = db.prepare("SELECT chunk_id, vec FROM chunk_vectors").all() as Record<string, unknown>[];
      const scored = rows.map((row) => ({
        chunkId: String(row["chunk_id"] ?? ""),
        score: cosineSimilarity(query, blobToVec(row["vec"] as Uint8Array)),
      }));
      scored.sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));
      return scored.slice(0, limit);
    },
  };
}

/**
 * 惰性补齐向量（schema v1 → v2 的自愈口）：为缺失向量的正文块补算并写入。
 * 幂等（已存在不动）；返回补齐条数（回执如实标注）。手工改库 / 旧索引升级后由 ragSearch 首个查询触发。
 */
export function ensureChunkVectors(db: DatabaseSync, dim = LOCAL_EMBED_DIM): number {
  const rows = db
    .prepare(
      `SELECT c.id AS id, c.text AS text FROM chunks c
       LEFT JOIN chunk_vectors v ON v.chunk_id = c.id
       WHERE v.chunk_id IS NULL`,
    )
    .all() as Record<string, unknown>[];
  if (rows.length === 0) return 0;
  const insert = db.prepare("INSERT OR REPLACE INTO chunk_vectors(chunk_id, dim, vec) VALUES (?, ?, ?)");
  db.exec("BEGIN");
  try {
    for (const row of rows) {
      insert.run(String(row["id"] ?? ""), dim, vecToBlob(embedText(String(row["text"] ?? ""), dim)));
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return rows.length;
}