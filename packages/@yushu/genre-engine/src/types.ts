import type { GenreAxes } from "@yushu/core";

/** 派系包格式版本（G06 §5.4 为唯一输入，不得另起格式） */
export const PACK_API_VERSION = "yushu.pack/v1" as const;
export const PACK_KIND = "GenrePack" as const;

/** 11 件套键名（docs/01 §3.2；G06 manifest content 段） */
export const ELEVEN_PIECE_KEYS = [
  "world_preset",
  "schema_extensions",
  "rules",
  "beat_sheets",
  "satisfaction_patterns",
  "prompt_templates",
  "glossary",
  "taboos",
  "outline_templates",
  "evolution",
  "platform_mapping",
] as const;

export type ElevenPieceKey = (typeof ELEVEN_PIECE_KEYS)[number];

export interface GenrePackMetadata {
  /** 全局唯一，作命名空间前缀 */
  id: string;
  name: string;
  version: string;
  license: string;
  /** 引擎兼容区间（semver range） */
  requires: { yushu: string };
}

export interface GenrePackEvolution {
  origin_work?: string;
  era?: number;
  chain?: string[];
}

export interface GenrePackContent {
  world_preset: string;
  schema_extensions: string[];
  rules: string[];
  beat_sheets: string[];
  satisfaction_patterns: string[];
  prompt_templates: string[];
  glossary: string;
  taboos: string;
  outline_templates: string[];
  evolution: GenrePackEvolution;
  platform_mapping: string;
}

export interface GenrePackFusions {
  compatible_with?: string[];
  conflicts_with?: { pack: string; reason: string }[];
}

export interface GenrePackManifest {
  apiVersion: string;
  kind: string;
  metadata: GenrePackMetadata;
  genre_axes: GenreAxes;
  content: GenrePackContent;
  fusions?: GenrePackFusions;
}

/** 已加载的派系包：manifest + 各件套解析后的绝对路径 */
export interface LoadedPack {
  /** 包目录绝对路径 */
  dir: string;
  manifest: GenrePackManifest;
  /** 件套键 → 绝对路径列表（标量件套为单元素数组） */
  resolvedFiles: Partial<Record<ElevenPieceKey, string[]>>;
  /** 引用了但缺失的文件相对路径 */
  missingFiles: string[];
}