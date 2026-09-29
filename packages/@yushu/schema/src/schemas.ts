import { LAYER_KEYS, WORLD_API_VERSION } from "@yushu/core";

/**
 * 核心 JSON Schema（纯数据对象，可被导出为 .json 供外部工具使用）。
 * 注意：实体 ID 均为稳定命名空间形式（见 @yushu/core ids）。
 */

export type JsonSchemaObject = Record<string, unknown>;

const ID_PATTERN = "^[a-z]{2,8}-[a-z0-9][a-z0-9-]*$";
const QUALIFIED_PATTERN = "^[a-z0-9][a-z0-9-]*\\/[a-z0-9][a-z0-9-]*$";

export const CORE_WORLD_SCHEMA_ID = "yushu.core/world" as const;
export const CORE_SETTING_CARD_SCHEMA_ID = "yushu.core/setting-card" as const;
export const CORE_OUTLINE_SCHEMA_ID = "yushu.core/outline" as const;
export const CORE_CHAPTER_SCHEMA_ID = "yushu.core/chapter" as const;

/** world/world.yaml（docs/03 §5.1） */
export const worldSchema: JsonSchemaObject = {
  $id: CORE_WORLD_SCHEMA_ID,
  title: "World 根配置",
  type: "object",
  required: ["apiVersion", "id", "title", "genre_axes", "layers"],
  properties: {
    apiVersion: { const: WORLD_API_VERSION },
    id: { type: "string", pattern: ID_PATTERN },
    title: { type: "string", minLength: 1 },
    genre_axes: {
      type: "object",
      required: ["channel", "world", "technique", "tone"],
      properties: {
        channel: { type: "array", items: { type: "string" }, minItems: 1 },
        world: { type: "array", items: { type: "string" }, minItems: 1 },
        technique: { type: "array", items: { type: "string" } },
        tone: { type: "array", items: { type: "string" } },
        romance_mode_default: {
          enum: ["有女主", "无女主", "单CP", "多CP", "无CP", "后宫"],
        },
      },
      additionalProperties: false,
    },
    layers: {
      type: "object",
      required: [...LAYER_KEYS],
      properties: Object.fromEntries(LAYER_KEYS.map((key) => [key, { type: "boolean" }])),
      additionalProperties: false,
    },
    required_fields: { type: "array", items: { type: "string" } },
  },
  additionalProperties: true,
};

/** 通用设定卡（EntityBase 的 frontmatter 形态，docs/03 §5.2） */
export const settingCardSchema: JsonSchemaObject = {
  $id: CORE_SETTING_CARD_SCHEMA_ID,
  title: "设定卡 frontmatter",
  type: "object",
  required: ["id", "type", "name", "format_version"],
  properties: {
    id: { type: "string", pattern: ID_PATTERN },
    type: { type: "string", minLength: 1 },
    layer: { enum: [...LAYER_KEYS] },
    name: { type: "string", minLength: 1 },
    aliases: { type: "array", items: { type: "string" } },
    refs: {
      type: "array",
      items: {
        type: "object",
        required: ["relation", "target"],
        properties: {
          relation: { type: "string", minLength: 1 },
          target: { type: "string", minLength: 1 },
        },
        additionalProperties: false,
      },
    },
    source_chapters: {
      type: "array",
      items: { type: "string", pattern: ID_PATTERN },
    },
    visibility: { enum: ["written_unrevealed", "foreshadowed", "revealed", "hidden"] },
    format_version: { type: "integer", minimum: 1 },
    extensions: { type: "object" },
  },
  // 允许派系包扩展字段与作者自填字段；未知字段策略由 genre-engine 处理（ignore_with_warning）
  additionalProperties: true,
};

/** 章纲七要素（I02 细纲：谁/在哪/目标/阻碍/转折/结果/钩子） */
const chapterBriefSchema: JsonSchemaObject = {
  type: "object",
  required: ["who", "where", "goal", "obstacle", "turn", "result", "hook"],
  properties: {
    who: { type: "string" },
    where: { type: "string" },
    goal: { type: "string" },
    obstacle: { type: "string" },
    turn: { type: "string" },
    result: { type: "string" },
    hook: { type: "string" },
  },
  additionalProperties: true,
};

/** outline/outline.yaml：三级大纲（总纲→卷纲→章纲，docs/01 §4.4 / I02） */
export const outlineSchema: JsonSchemaObject = {
  $id: CORE_OUTLINE_SCHEMA_ID,
  title: "三级大纲",
  type: "object",
  required: ["apiVersion", "format_version", "id", "master", "volumes"],
  properties: {
    apiVersion: { const: "yushu.outline/v1" },
    format_version: { type: "integer", minimum: 1 },
    id: { type: "string", pattern: ID_PATTERN },
    /** 来源模板（生成≠写死：仅记录出处，用户可任意增删改） */
    source_template: { type: "string" },
    master: {
      type: "object",
      required: ["title", "logline", "theme", "acts", "notes"],
      properties: {
        title: { type: "string" },
        logline: { type: "string" },
        theme: { type: "string" },
        notes: { type: "string" },
        acts: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "desc"],
            properties: {
              name: { type: "string", minLength: 1 },
              desc: { type: "string" },
              chapters_hint: { type: "string" },
            },
            additionalProperties: true,
          },
        },
      },
      additionalProperties: true,
    },
    volumes: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "title", "act", "desc", "chapters"],
        properties: {
          id: { type: "string", pattern: "^vol-[a-z0-9][a-z0-9-]*$" },
          title: { type: "string", minLength: 1 },
          act: { type: "string" },
          desc: { type: "string" },
          climax: { type: "string" },
          hook: { type: "string" },
          checklist: { type: "array", items: { type: "string" } },
          chapters: {
            type: "array",
            items: {
              type: "object",
              required: ["id", "idx", "title", "brief", "scene_ids"],
              properties: {
                id: { type: "string", pattern: "^co-[a-z0-9][a-z0-9-]*$" },
                idx: { type: "integer", minimum: 1 },
                title: { type: "string", minLength: 1 },
                brief: chapterBriefSchema,
                /** 已一键创建草稿章节时回填（与 Chapter.outline_ref 双向映射） */
                chapter_id: { type: "string", pattern: ID_PATTERN },
                scene_ids: { type: "array", items: { type: "string", pattern: ID_PATTERN } },
              },
              additionalProperties: true,
            },
          },
        },
        additionalProperties: true,
      },
    },
  },
  // 允许作者补充自定义字段（如情绪曲线备注）；已知字段仍严格校验
  additionalProperties: true,
};

/** 章节草稿 frontmatter（docs/03 §5.3 Chapter） */
export const chapterSchema: JsonSchemaObject = {
  $id: CORE_CHAPTER_SCHEMA_ID,
  title: "章节 frontmatter",
  type: "object",
  required: ["id", "volume", "idx", "title", "word_count", "status", "outline_ref"],
  properties: {
    id: { type: "string", pattern: ID_PATTERN },
    volume: { type: "string", minLength: 1 },
    idx: { type: "integer", minimum: 1 },
    title: { type: "string", minLength: 1 },
    pov: { type: "string" },
    word_count: { type: "integer", minimum: 0 },
    status: { enum: ["draft", "revised", "published"] },
    outline_ref: { type: "string", minLength: 1 },
    scene_ids: { type: "array", items: { type: "string", pattern: ID_PATTERN } },
    summary: { type: "string" },
    summary_rev: { type: "integer", minimum: 0 },
  },
  additionalProperties: true,
};

/** 核心 schema 全量清单（供注册表预加载） */
export const CORE_SCHEMAS: readonly JsonSchemaObject[] = [
  worldSchema,
  settingCardSchema,
  outlineSchema,
  chapterSchema,
] as const;

export { ID_PATTERN, QUALIFIED_PATTERN };