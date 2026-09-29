import { IdError } from "./errors.js";

/**
 * 稳定 ID 与命名空间（docs/03 §5）。
 * - 实体 ID 形如 `char-linyuan`（前缀-本地段）；
 * - 派系包元素采用 `pack_id/element_id` 命名空间隔离（G06）。
 */

export type IdPrefix =
  | "world"
  | "char"
  | "loc"
  | "fac"
  | "itm"
  | "skl"
  | "ev"
  | "ch"
  | "vol"
  | "co"
  | "fs"
  | "tl"
  | "sl"
  | "rel"
  | "cal"
  | "law"
  | "lore"
  | "spe";

export const ID_PREFIXES: readonly IdPrefix[] = [
  "world",
  "char",
  "loc",
  "fac",
  "itm",
  "skl",
  "ev",
  "ch",
  "vol",
  "co",
  "fs",
  "tl",
  "sl",
  "rel",
  "cal",
  "law",
  "lore",
  "spe",
] as const;

const LOCAL_RE = /^[a-z0-9][a-z0-9-]*$/;
const ENTITY_ID_RE = /^([a-z]{2,8})-([a-z0-9][a-z0-9-]*)$/;
const QUALIFIED_RE = /^([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/;

function djb2(input: string): number {
  let hash = 5381;
  for (const ch of input) {
    hash = ((hash << 5) + hash + (ch.codePointAt(0) ?? 0)) >>> 0;
  }
  return hash;
}

function randomSegment(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID().replace(/-/g, "").slice(0, 8);
  }
  // 退路：非加密随机（仅测试环境兜底）
  return Math.random().toString(36).slice(2, 10);
}

/**
 * 生成稳定实体 ID。
 * @param prefix 实体前缀
 * @param seed 可选种子：给定后输出确定（同一 seed 永远得到同一 ID，便于测试与包生成）
 */
export function makeId(prefix: IdPrefix, seed?: string): string {
  const local = seed !== undefined && seed !== "" ? djb2(seed).toString(36) : randomSegment();
  return `${prefix}-${local}`;
}

export function isValidLocalId(local: string): boolean {
  return LOCAL_RE.test(local);
}

/** 校验实体 ID（前缀-本地段） */
export function isValidEntityId(id: string): boolean {
  const m = ENTITY_ID_RE.exec(id);
  return m !== null && (ID_PREFIXES as readonly string[]).includes(m[1] as string);
}

/** 解析实体 ID（前缀-本地段）；前缀必须在已知词表内，否则返回 null。 */
export function parseId(id: string): { prefix: string; local: string } | null {
  const m = ENTITY_ID_RE.exec(id);
  if (!m || !m[1] || !m[2]) return null;
  if (!(ID_PREFIXES as readonly string[]).includes(m[1])) return null;
  return { prefix: m[1], local: m[2] };
}

/** 组装命名空间元素 ID：`pack_id/element_id` */
export function qualifyId(namespace: string, elementId: string): string {
  if (!LOCAL_RE.test(namespace)) {
    throw new IdError(`命名空间非法：${namespace}（要求小写字母/数字/连字符）`);
  }
  if (!LOCAL_RE.test(elementId)) {
    throw new IdError(`元素 ID 非法：${elementId}（要求小写字母/数字/连字符）`);
  }
  return `${namespace}/${elementId}`;
}

export function splitQualifiedId(qualified: string): { namespace: string; elementId: string } | null {
  const m = QUALIFIED_RE.exec(qualified);
  if (!m || !m[1] || !m[2]) return null;
  return { namespace: m[1], elementId: m[2] };
}