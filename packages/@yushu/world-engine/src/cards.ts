import {
  IdError,
  makeId,
  parseFrontmatter,
  serializeCard,
  type EntityBase,
  type IdPrefix,
  type LayerKey,
  type RelationRef,
  type Visibility,
} from "@yushu/core";
import {
  CORE_SETTING_CARD_SCHEMA_ID,
  SchemaValidationError,
  getDefaultRegistry,
} from "@yushu/schema";

/** 核心六类实体 + 世界设定类 → ID 前缀（docs/01 §4.3） */
export const TYPE_PREFIXES: Record<string, IdPrefix> = {
  character: "char",
  location: "loc",
  faction: "fac",
  item: "itm",
  skill: "skl",
  event: "ev",
  law: "law",
  lore: "lore",
  species: "spe",
};

export const SETTING_CARD_FORMAT_VERSION = 1;

export interface CreateCardInput {
  /** 实体类型（character/location/faction/item/skill/event，或派系包注册的自定义类型） */
  type: string;
  name: string;
  layer?: LayerKey;
  /** 未提供时按 type 映射前缀 + 名称派生稳定 ID；自定义类型必须显式提供 */
  id?: string;
  aliases?: string[];
  refs?: RelationRef[];
  sourceChapters?: string[];
  visibility?: Visibility;
  extensions?: Record<string, unknown>;
}

/** 创建设定卡（frontmatter 数据体），返回前通过核心 schema 校验 */
export function createSettingCard(input: CreateCardInput): EntityBase {
  const prefix = TYPE_PREFIXES[input.type];
  let id = input.id;
  if (!id) {
    if (!prefix) {
      throw new IdError(
        `未知实体类型「${input.type}」无法自动生成 ID：请显式提供 id，或在派系包中注册类型前缀`,
      );
    }
    id = makeId(prefix, input.name);
  }
  const card: EntityBase = {
    id,
    type: input.type,
    layer: input.layer ?? "characters",
    name: input.name,
    aliases: input.aliases ?? [],
    refs: input.refs ?? [],
    source_chapters: input.sourceChapters ?? [],
    // 新建设定卡默认"尚未在正文出现"（冰山原则的保守默认；作者可在卡上提升可见性）
    visibility: input.visibility ?? "hidden",
    format_version: SETTING_CARD_FORMAT_VERSION,
    ...(input.extensions ? { extensions: input.extensions } : {}),
  };
  assertCardValid(card);
  return card;
}

export function assertCardValid(card: unknown): asserts card is EntityBase {
  const result = getDefaultRegistry().validate(CORE_SETTING_CARD_SCHEMA_ID, card);
  if (!result.valid) {
    throw new SchemaValidationError(CORE_SETTING_CARD_SCHEMA_ID, result.issues);
  }
}

/** 读取设定卡文件（Markdown + YAML frontmatter），含校验 */
export function readCardFile(text: string): { card: EntityBase; body: string } {
  const parsed = parseFrontmatter<EntityBase>(text);
  assertCardValid(parsed.data);
  return { card: parsed.data, body: parsed.body };
}

/** 序列化设定卡文件（写入前校验） */
export function serializeCardFile(card: EntityBase, body = ""): string {
  assertCardValid(card);
  return serializeCard(card, body);
}