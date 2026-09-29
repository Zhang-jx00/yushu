import {
  makeId,
  parseFrontmatter,
  serializeCard,
  type Chapter,
  type ChapterStatus,
} from "@yushu/core";
import {
  CORE_CHAPTER_SCHEMA_ID,
  SchemaValidationError,
  getDefaultRegistry,
} from "@yushu/schema";

/**
 * 章节草稿（docs/03 §5.3 Chapter）：与三级大纲双向映射——
 * 章节 frontmatter 的 outline_ref 指向章纲 ID，章纲 chapter_id 回指章节实体。
 * M1 仅交付草稿创建/读取（编辑器在 M2 稳定化）。
 */

export interface CreateChapterDraftInput {
  /** 所属卷（卷纲 ID） */
  volume: string;
  idx: number;
  title: string;
  /** 章纲 ID（章纲.chapter_id 反向回填由调用方完成） */
  outlineRef: string;
  pov?: string;
}

/** 创建章节草稿（ID 按 卷+章纲 派生，重复调用得到同一 ID，保证幂等） */
export function createChapterDraft(input: CreateChapterDraftInput): Chapter {
  if (!input.title.trim()) {
    throw new SchemaValidationError(CORE_CHAPTER_SCHEMA_ID, [
      { path: "/title", message: "章节标题不能为空", keyword: "custom" },
    ]);
  }
  const chapter: Chapter = {
    id: makeId("ch", `${input.volume}:${input.outlineRef}`),
    volume: input.volume,
    idx: input.idx,
    title: input.title,
    pov: input.pov ?? "",
    word_count: 0,
    status: "draft" satisfies ChapterStatus,
    outline_ref: input.outlineRef,
    scene_ids: [],
    summary: "",
    summary_rev: 0,
  };
  assertChapterValid(chapter);
  return chapter;
}

export function assertChapterValid(chapter: unknown): asserts chapter is Chapter {
  const result = getDefaultRegistry().validate(CORE_CHAPTER_SCHEMA_ID, chapter);
  if (!result.valid) {
    throw new SchemaValidationError(CORE_CHAPTER_SCHEMA_ID, result.issues);
  }
}

/** 读取章节文件（Markdown + YAML frontmatter），含校验 */
export function readChapterFile(text: string): { chapter: Chapter; body: string } {
  const parsed = parseFrontmatter<Chapter>(text);
  assertChapterValid(parsed.data);
  return { chapter: parsed.data, body: parsed.body };
}

/** 序列化章节文件（写入前校验） */
export function serializeChapterFile(chapter: Chapter, body = ""): string {
  assertChapterValid(chapter);
  return serializeCard(chapter, body);
}