/**
 * 御书核心类型（docs/03 §5 数据模型的 TypeScript 落地）。
 * 原则：所有实体 ID 采用稳定命名空间形式，引用一律写 ID、不写显示名。
 */

/** 世界构建层级键（docs/03 §5.1，自上而下推演的层级开关） */
export type LayerKey =
  | "genesis"
  | "laws"
  | "geography"
  | "ecology"
  | "eras"
  | "civilizations"
  | "factions"
  | "characters"
  | "events"
  | "storylines"
  | "chapters";

export const LAYER_KEYS: readonly LayerKey[] = [
  "genesis",
  "laws",
  "geography",
  "ecology",
  "eras",
  "civilizations",
  "factions",
  "characters",
  "events",
  "storylines",
  "chapters",
] as const;

/** 感情线形态（独立开关，不绑频道，docs/01 §3.1） */
export type RomanceMode = "有女主" | "无女主" | "单CP" | "多CP" | "无CP" | "后宫";

/** 四维派系取值（docs/01 §3.1 / docs/05 词表；多维数组，允许同维多选） */
export interface GenreAxes {
  channel: string[];
  world: string[];
  technique: string[];
  tone: string[];
  romance_mode_default?: RomanceMode;
}

/** 叙事可见性（冰山原则：已写未揭示 / 已埋伏笔 / 已揭示 / 隐藏） */
export type Visibility = "written_unrevealed" | "foreshadowed" | "revealed" | "hidden";

/** 外键式引用（写 ID，不写显示名） */
export interface RelationRef {
  relation: string;
  target: string;
}

/** 通用实体头（docs/03 §5.2） */
export interface EntityBase {
  /** 稳定 ID，如 char-linyuan */
  id: string;
  /** 实体类型，由派系包 schema 扩展点注册（G06） */
  type: string;
  layer: LayerKey;
  name: string;
  /** 别名 / 尊称 / 外号 → 提及追踪与触发注入（J03） */
  aliases: string[];
  /** 外键式引用 */
  refs: RelationRef[];
  /** 出场章节 */
  source_chapters: string[];
  visibility: Visibility;
  format_version: number;
  /** 派系包注入字段（境界 / 威胁等级 / 公司商业…） */
  extensions?: Record<string, unknown>;
}

/** 实体间关系（血缘/效忠/敌对/隶属/师徒…，relation 词表可被派系包扩展） */
export interface Relation {
  id: string;
  from: string;
  to: string;
  kind: string;
  directed: boolean;
  strength?: number;
  since_chapter?: string;
  note?: string;
}

/** 同一事件的多文化视角版本（"伪史书"，F05/C02） */
export interface PovViewpoint {
  culture: string;
  account: string;
  source?: string;
}

/** 世界事件（内部统一数字刻度；多历法在渲染层映射） */
export interface Event {
  id: string;
  title: string;
  /** 内部统一数字刻度（虚构纪年以锚定事件为 Year 0） */
  year: number;
  timeline: string;
  participants: string[];
  location?: string;
  causes: string[];
  effects: string[];
  /** 多文化"伪史书"版本 */
  pov_viewpoints?: PovViewpoint[];
}

/** 语义别名：避免与宿主环境的 DOM Event 混淆 */
export type WorldEvent = Event;

/** 时间线（锚定事件 = Year 0） */
export interface Timeline {
  id: string;
  anchor_event: string;
  /** 多历法渲染层映射（F05） */
  calendar: string;
  scale: "numeric";
  events: string[];
}

/** 故事线节拍引用 */
export interface BeatRef {
  beat: string;
  chapter: string;
}

/** 故事线（与伏笔/悬念台账互链） */
export interface Storyline {
  id: string;
  kind: "main" | "sub" | "romance";
  beats: BeatRef[];
  promises: string[];
  status: "open" | "closed";
}

export type ChapterStatus = "draft" | "revised" | "published";

/** 章节（与三级大纲双向映射：outline_ref / scene_ids） */
export interface Chapter {
  id: string;
  volume: string;
  idx: number;
  title: string;
  pov: string;
  word_count: number;
  status: ChapterStatus;
  /** 章纲引用（I02） */
  outline_ref: string;
  scene_ids: string[];
  summary: string;
  /** summary_rev > 0 时 AI 不得覆盖（J03） */
  summary_rev: number;
}

export type ForeshadowCarrier = "道具" | "对白" | "意象" | "事件" | "传闻";
export type ForeshadowVisibility = "显写" | "半遮" | "藏枪";
export type ForeshadowState = "planted" | "reinforced" | "due" | "paid" | "abandoned";

/** 伏笔台账（承接 F08 全生命周期） */
export interface Foreshadow {
  id: string;
  name: string;
  promise: string;
  plant_chapters: string[];
  carrier: ForeshadowCarrier;
  visibility: ForeshadowVisibility;
  expected_payoff_chapter: string;
  payoff_type: string;
  is_red_herring: boolean;
  state: ForeshadowState;
  abandon_reason?: string;
  /** 每隔多少章复查一次 */
  recheck_after: number;
}

export const WORLD_API_VERSION = "yushu.world/v1" as const;

/** world/world.yaml 根配置（渐进披露，仅少量必填字段） */
export interface WorldConfig {
  apiVersion: typeof WORLD_API_VERSION;
  id: string;
  title: string;
  genre_axes: GenreAxes;
  /** 层级启用开关：未启用层不参与校验与传播 */
  layers: Record<LayerKey, boolean>;
  required_fields?: string[];
}