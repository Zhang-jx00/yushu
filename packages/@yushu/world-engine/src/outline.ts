import { YushuError, makeId } from "@yushu/core";
import {
  CORE_OUTLINE_SCHEMA_ID,
  SchemaValidationError,
  getDefaultRegistry,
} from "@yushu/schema";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/**
 * 三级大纲（docs/01 §4.4 / I02）：总纲 → 卷纲 → 章纲。
 * - outline/outline.yaml 为大纲唯一事实源；
 * - 模板生成 ≠ 写死：生成后作者可任意增删改，模板出处仅记录在 source_template；
 * - 章纲与 Chapter 双向映射：章纲 chapter_id ↔ 章节 frontmatter outline_ref。
 */

export const OUTLINE_API_VERSION = "yushu.outline/v1" as const;
export const OUTLINE_FORMAT_VERSION = 1;
/** 单项目单大纲：根 ID 固定，便于章纲/卷纲引用与外部工具定位 */
export const OUTLINE_DOC_ID = "outline-main";
/** 派系包 outline_templates 件套的 apiVersion（以包内文件为准，不得另起格式） */
export const OUTLINE_TEMPLATE_API_VERSION = "yushu.outlines/v1" as const;

export class OutlineError extends YushuError {
  constructor(message: string, options?: ErrorOptions) {
    super("E_OUTLINE", message, options);
  }
}

/** 章纲七要素（I02 细纲：谁/在哪/目标/阻碍/转折/结果/钩子） */
export interface ChapterBrief {
  who: string;
  where: string;
  goal: string;
  obstacle: string;
  turn: string;
  result: string;
  hook: string;
}

/** 总纲（全局） */
export interface OutlineMaster {
  title: string;
  logline: string;
  theme: string;
  notes: string;
  acts: { name: string; desc: string; chapters_hint?: string }[];
}

/** 章纲（一章细纲） */
export interface OutlineChapter {
  id: string;
  /** 卷内序号（从 1 起；作者重排后由 normalizeOutline 重编号） */
  idx: number;
  title: string;
  brief: ChapterBrief;
  /** 已一键创建草稿章节时回填（与 Chapter.outline_ref 双向映射） */
  chapter_id?: string;
  scene_ids: string[];
}

/** 卷纲（一卷） */
export interface OutlineVolume {
  id: string;
  title: string;
  /** 所属幕（总纲 acts 的 name，如"起/承/合"；允许自定义） */
  act: string;
  desc: string;
  climax?: string;
  hook?: string;
  checklist?: string[];
  chapters: OutlineChapter[];
}

/** outline/outline.yaml 根（三级大纲唯一事实源） */
export interface Outline {
  apiVersion: typeof OUTLINE_API_VERSION;
  format_version: number;
  id: string;
  /** 生成来源模板（如 "xuanhuan-xitong/three-act-upgrade"；仅记录出处） */
  source_template?: string;
  master: OutlineMaster;
  volumes: OutlineVolume[];
}

/** 派系包大纲模板的运行时形态（yushu.outlines/v1） */
export interface OutlineTemplate {
  /** 模板本地 ID，如 three-act-upgrade */
  id: string;
  title?: string;
  description?: string;
  /** 幕结构：act1/act2/act3 → { name, desc, chapters_hint } */
  template: Record<string, unknown>;
  /** 卷模板：suggested_volumes / per_volume{climax,hook,checklist} */
  volume_template?: Record<string, unknown>;
  notes?: string;
}

export const BRIEF_KEYS = [
  "who",
  "where",
  "goal",
  "obstacle",
  "turn",
  "result",
  "hook",
] as const;

const ACT_DEFAULT_NAMES = ["起", "承", "合"] as const;

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** 取模板提示中的下限整数：优先区间（"3-6"→3、"10-20"→10），其次 "X章"；"60% 总篇幅"等比例描述不算 */
function lowerBoundHint(text: string): number | null {
  const range = /(\d+)\s*[-~～—]\s*\d+/.exec(text);
  if (range?.[1] !== undefined) return Number.parseInt(range[1], 10);
  const single = /^\s*(\d+)\s*章/.exec(text);
  if (single?.[1] !== undefined) return Number.parseInt(single[1], 10);
  return null;
}

export function emptyBrief(): ChapterBrief {
  return { who: "", where: "", goal: "", obstacle: "", turn: "", result: "", hook: "" };
}

/**
 * 解析派系包大纲模板文本（yushu.outlines/v1）并做最小结构校验。
 * 调用方负责读取文件（引擎包不做 fs，保持可测试边界）。
 */
export function parseOutlineTemplate(text: string): OutlineTemplate {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new OutlineError("大纲模板 YAML 解析失败", { cause: err });
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new OutlineError("大纲模板内容非法（应为 YAML 映射）");
  }
  const record = data as Record<string, unknown>;
  if (record["apiVersion"] !== OUTLINE_TEMPLATE_API_VERSION) {
    throw new OutlineError(
      `大纲模板 apiVersion 必须为 ${OUTLINE_TEMPLATE_API_VERSION}，实际为 ${String(record["apiVersion"])}`,
    );
  }
  const id = record["id"];
  if (typeof id !== "string" || id.trim() === "") {
    throw new OutlineError("大纲模板缺少 id");
  }
  const template = record["template"];
  if (template === null || typeof template !== "object" || Array.isArray(template)) {
    throw new OutlineError(`大纲模板「${id}」缺少 template 幕结构`);
  }
  const acts = Object.entries(template as Record<string, unknown>).filter(
    ([key, value]) => key !== "chapters_hint" && value !== null && typeof value === "object",
  );
  if (acts.length === 0) {
    throw new OutlineError(`大纲模板「${id}」的 template 无可用的幕条目`);
  }
  const volumeTemplate = record["volume_template"];
  return {
    id,
    ...(typeof record["title"] === "string" ? { title: record["title"] } : {}),
    ...(typeof record["description"] === "string"
      ? { description: record["description"] }
      : {}),
    template: template as Record<string, unknown>,
    ...(volumeTemplate !== null && typeof volumeTemplate === "object" && !Array.isArray(volumeTemplate)
      ? { volume_template: volumeTemplate as Record<string, unknown> }
      : {}),
    ...(typeof record["notes"] === "string" ? { notes: record["notes"] } : {}),
  };
}

/** 解析模板的幕结构（按 YAML 中的出现顺序） */
export function templateActs(
  template: OutlineTemplate,
): { name: string; desc: string; chapters_hint?: string }[] {
  const acts: { name: string; desc: string; chapters_hint?: string }[] = [];
  for (const [key, value] of Object.entries(template.template)) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    acts.push({
      name: asString(record["name"]) || key,
      desc: asString(record["desc"]),
      ...(typeof record["chapters_hint"] === "string"
        ? { chapters_hint: record["chapters_hint"] }
        : {}),
    });
  }
  return acts;
}

/** 模板默认卷数：suggested_volumes（"3-6"）下限，clamp 1..8，缺省 3 */
export function templateVolumeCount(template: OutlineTemplate): number {
  const suggested = lowerBoundHint(asString(template.volume_template?.["suggested_volumes"]));
  return Math.min(Math.max(suggested ?? 3, 1), 8);
}

/** 模板默认每卷章数：各幕 chapters_hint 下限最小值，clamp 1..50，缺省 3 */
export function templateChaptersPerVolume(template: OutlineTemplate): number {
  const hints = templateActs(template)
    .map((act) => (act.chapters_hint ? lowerBoundHint(act.chapters_hint) : null))
    .filter((n): n is number => n !== null);
  const fallback = hints.length > 0 ? Math.min(...hints) : 3;
  return Math.min(Math.max(fallback, 1), 50);
}

/** 卷数 → 各幕卷数分配（三幕结构：首幕 1 卷、中幕占多、末幕 1 卷） */
function distributeVolumes(volumeCount: number, actCount: number): number[] {
  if (actCount <= 0) return [];
  if (volumeCount <= actCount) {
    return Array.from({ length: actCount }, (_, i) => (i < volumeCount ? 1 : 0));
  }
  if (actCount === 3) return [1, volumeCount - 2, 1];
  const base = Math.floor(volumeCount / actCount);
  const remainder = volumeCount % actCount;
  return Array.from({ length: actCount }, (_, i) => base + (i < remainder ? 1 : 0));
}

export interface CreateOutlineFromTemplateInput {
  projectTitle: string;
  template: OutlineTemplate;
  /** 记录在 source_template 的出处（桌面端传 "packId/templateId"） */
  sourceRef?: string;
  volumeCount?: number;
  chaptersPerVolume?: number;
}

/**
 * 按派系包大纲模板一键生成三级大纲骨架（生成 ≠ 写死）：
 * - 总纲：模板幕结构 + 项目名 + 模板 notes 提示；
 * - 卷纲：按幕分配卷数，卷末高潮/钩子/自检清单来自 volume_template.per_volume；
 * - 章纲：占位标题 + 七要素留空，作者可任意增删改与重排。
 */
export function createOutlineFromTemplate(input: CreateOutlineFromTemplateInput): Outline {
  const { projectTitle, template } = input;
  if (!projectTitle.trim()) {
    throw new OutlineError("生成大纲需要项目名（总纲标题不能为空）");
  }
  const acts = templateActs(template);
  const clampedActs = acts.length > 0 ? acts : ACT_DEFAULT_NAMES.map((name) => ({ name, desc: "" }));
  const volumeCount = Math.min(Math.max(input.volumeCount ?? templateVolumeCount(template), 1), 8);
  const chaptersPerVolume = Math.min(
    Math.max(input.chaptersPerVolume ?? templateChaptersPerVolume(template), 1),
    50,
  );
  const perVolume = template.volume_template?.["per_volume"] as Record<string, unknown> | undefined;
  const checklist = Array.isArray(perVolume?.["checklist"])
    ? perVolume["checklist"].filter((item): item is string => typeof item === "string")
    : [];

  const distribution = distributeVolumes(volumeCount, clampedActs.length);
  const volumes: OutlineVolume[] = [];
  let volumeSeq = 0;
  clampedActs.forEach((act, actIndex) => {
    for (let i = 0; i < (distribution[actIndex] ?? 0); i++) {
      volumeSeq += 1;
      volumes.push({
        id: makeId("vol", `${projectTitle}-v${volumeSeq}`),
        title: `第${volumeSeq}卷·${act.name}`,
        act: act.name,
        desc: act.desc,
        ...(asString(perVolume?.["climax"]) ? { climax: asString(perVolume?.["climax"]) } : {}),
        ...(asString(perVolume?.["hook"]) ? { hook: asString(perVolume?.["hook"]) } : {}),
        ...(checklist.length > 0 ? { checklist: [...checklist] } : {}),
        chapters: Array.from({ length: chaptersPerVolume }, (_, c) => ({
          id: makeId("co", `${projectTitle}-v${volumeSeq}-c${c + 1}`),
          idx: c + 1,
          title: `第${c + 1}章（待拟题）`,
          brief: emptyBrief(),
          scene_ids: [],
        })),
      });
    }
  });

  const outline: Outline = {
    apiVersion: OUTLINE_API_VERSION,
    format_version: OUTLINE_FORMAT_VERSION,
    id: OUTLINE_DOC_ID,
    source_template: input.sourceRef ?? template.id,
    master: {
      title: projectTitle,
      logline: "",
      theme: "",
      notes: asString(template.notes),
      acts: clampedActs,
    },
    volumes,
  };
  assertOutlineValid(outline);
  return outline;
}

/** 空白大纲（不使用模板时）：默认三幕结构、零卷，由作者自建 */
export function createEmptyOutline(projectTitle: string): Outline {
  if (!projectTitle.trim()) {
    throw new OutlineError("创建大纲需要项目名（总纲标题不能为空）");
  }
  const outline: Outline = {
    apiVersion: OUTLINE_API_VERSION,
    format_version: OUTLINE_FORMAT_VERSION,
    id: OUTLINE_DOC_ID,
    master: {
      title: projectTitle,
      logline: "",
      theme: "",
      notes: "",
      acts: ACT_DEFAULT_NAMES.map((name) => ({ name, desc: "" })),
    },
    volumes: [],
  };
  assertOutlineValid(outline);
  return outline;
}

/**
 * 归一化（写入前统一调用）：补齐缺失 ID（空 id → 引擎生成）、重排卷内章序并重编号 idx。
 * 同时检出重复 ID（先补齐、再查重，避免把明显损坏的数据写入真源）。
 */
export function normalizeOutline(outline: Outline): Outline {
  const volumes = outline.volumes.map((volume) => {
    const chapters = volume.chapters.map((chapter, index) => ({
      ...chapter,
      id: chapter.id?.trim() ? chapter.id : makeId("co"),
      idx: index + 1,
    }));
    return {
      ...volume,
      id: volume.id?.trim() ? volume.id : makeId("vol"),
      chapters,
    };
  });
  const normalized: Outline = { ...outline, volumes };
  assertUniqueIds(normalized);
  return normalized;
}

function assertUniqueIds(outline: Outline): void {
  const volumeIds = new Set<string>();
  const chapterIds = new Set<string>();
  for (const volume of outline.volumes) {
    if (volumeIds.has(volume.id)) {
      throw new OutlineError(`卷纲 ID 重复：${volume.id}`);
    }
    volumeIds.add(volume.id);
    for (const chapter of volume.chapters) {
      if (chapterIds.has(chapter.id)) {
        throw new OutlineError(`章纲 ID 重复：${chapter.id}`);
      }
      chapterIds.add(chapter.id);
    }
  }
}

/** schema 校验 + ID 唯一性校验；失败抛 SchemaValidationError / OutlineError */
export function assertOutlineValid(outline: unknown): asserts outline is Outline {
  const result = getDefaultRegistry().validate(CORE_OUTLINE_SCHEMA_ID, outline);
  if (!result.valid) {
    throw new SchemaValidationError(CORE_OUTLINE_SCHEMA_ID, result.issues);
  }
  assertUniqueIds(outline as Outline);
}

/** 解析并校验 outline.yaml 文本 */
export function parseOutline(text: string): Outline {
  const data = parseYaml(text) as unknown;
  assertOutlineValid(data);
  return data;
}

/** 序列化 outline.yaml（写入前校验，不折行保持可读） */
export function serializeOutline(outline: Outline): string {
  assertOutlineValid(outline);
  return stringifyYaml(outline, { lineWidth: 0 });
}

/** 统计卷数 / 章纲总数（UI 概览用） */
export function outlineStats(outline: Outline): { volumes: number; chapters: number } {
  return {
    volumes: outline.volumes.length,
    chapters: outline.volumes.reduce((sum, volume) => sum + volume.chapters.length, 0),
  };
}