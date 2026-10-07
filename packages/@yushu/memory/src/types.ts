/**
 * 五层记忆的类型（docs/03 §10.1；T3-5）：
 * world_core（世界核心设定卡，常驻——由既有设定卡层提供）→ volume_summary（卷摘要）→
 * chapter_summary（章摘要）→ fact（事实级记忆，带出处）→ rag（全文检索层，检索实现见 T3-8）。
 *
 * 真源约定（数据主权）：摘要与事实均为项目内 Markdown（YAML frontmatter + 正文），
 * SQLite 只做索引；每条记录携带 `project_id` 命名空间（跨项目泄漏为红线 error）。
 */

export const MEMORY_API_VERSION = "yushu.memory/v1" as const;
export const MEMORY_FORMAT_VERSION = 1;

export type MemoryLayer = "world_core" | "volume_summary" | "chapter_summary" | "fact" | "rag";

/** 事实级记忆的出处：章节 + 字符区间 + 摘录 hash（可验证，A6 出处链） */
export interface FactSource {
  chapter_id: string;
  /** 字符区间（含） */
  start: number;
  /** 字符区间（不含） */
  end: number;
  /** sha256(正文.slice(start, end))——正文改动后可检出出处失效 */
  hash: string;
}

/** 卷 / 章摘要记录（summary_rev > 0 = 人工已修订，AI 不得覆盖） */
export interface SummaryRecord {
  layer: "volume_summary" | "chapter_summary";
  /** 卷摘要 = 卷纲 id（vol-*）；章摘要 = 章节实体 id（ch-*） */
  id: string;
  project_id: string;
  /** 章摘要所属卷（便于分组展示） */
  volume_id?: string;
  /** 人工修订次数（0 = 纯 AI 生成 / 未修订） */
  summary_rev: number;
  updated_at: string;
  text: string;
}

/** 事实级记忆（keys 为触发关键词：实体名 / 别名等） */
export interface FactRecord {
  layer: "fact";
  id: string;
  project_id: string;
  keys: string[];
  text: string;
  /** 出处（提取自正文时必填；手工登记可缺省——lint 会给 warn） */
  source?: FactSource;
  updated_at: string;
}

export type MemoryRecord = SummaryRecord | FactRecord;

/** 记录体检（lintMemory）结果：error 级（如跨项目泄漏）必须阻断；warn 级仅提示 */
export interface MemoryLintFinding {
  severity: "error" | "warn";
  code: string;
  record_id: string;
  message: string;
}