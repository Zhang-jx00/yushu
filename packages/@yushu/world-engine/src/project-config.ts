import { YushuError } from "@yushu/core";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

/**
 * project.toml 项目配置（docs/01 技术基线：TOML 稳定配置格式）。
 * 记录项目元信息 + 已确认的四维与派系包选择（融合预演确认后写入，docs/03 §8.3）。
 */

export const PROJECT_FORMAT_VERSION = 1;

export class ProjectConfigError extends YushuError {
  constructor(message: string, options?: ErrorOptions) {
    super("E_PROJECT_CONFIG", message, options);
  }
}

export interface FusionConflictNote {
  kind: string;
  severity: string;
  message: string;
}

export interface ProjectConfig {
  project: {
    name: string;
    format_version: number;
    created_at: string;
  };
  genre: {
    packs: string[];
    channel: string[];
    world: string[];
    technique: string[];
    tone: string[];
    romance_mode_default?: string;
  };
  fusion: {
    confirmed_at: string;
    conflicts: FusionConflictNote[];
  };
}

export interface CreateProjectConfigInput {
  name: string;
  packIds: string[];
  axes: {
    channel: string[];
    world: string[];
    technique: string[];
    tone: string[];
    romance_mode_default?: string;
  };
  /** 融合预演中已向用户展示的冲突（含 warn）：留档以便追溯 */
  conflicts?: FusionConflictNote[];
  createdAt?: string;
}

export function createProjectConfig(input: CreateProjectConfigInput): ProjectConfig {
  if (!input.name.trim()) {
    throw new ProjectConfigError("项目名不能为空");
  }
  const now = input.createdAt ?? new Date().toISOString();
  return {
    project: {
      name: input.name.trim(),
      format_version: PROJECT_FORMAT_VERSION,
      created_at: now,
    },
    genre: {
      packs: [...input.packIds],
      channel: [...input.axes.channel],
      world: [...input.axes.world],
      technique: [...input.axes.technique],
      tone: [...input.axes.tone],
      ...(input.axes.romance_mode_default
        ? { romance_mode_default: input.axes.romance_mode_default }
        : {}),
    },
    fusion: {
      confirmed_at: now,
      conflicts: (input.conflicts ?? []).map((c) => ({ ...c })),
    },
  };
}

export function serializeProjectConfig(config: ProjectConfig): string {
  return stringifyToml(config);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ProjectConfigError(`${what} 应为 TOML 表（table）`);
  }
  return value as Record<string, unknown>;
}

function toStringArray(value: unknown, what: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
    throw new ProjectConfigError(`${what} 应为字符串数组`);
  }
  return value as string[];
}

/** 解析并做最小结构校验（含格式版本上限检查） */
export function parseProjectConfig(text: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = parseToml(text) as unknown;
  } catch (err) {
    throw new ProjectConfigError("project.toml 解析失败", { cause: err });
  }
  const root = asRecord(raw, "project.toml");
  const project = asRecord(root["project"] ?? {}, "[project]");
  const name = project["name"];
  const formatVersion = project["format_version"];
  if (typeof name !== "string" || name.trim() === "") {
    throw new ProjectConfigError("[project].name 缺失或为空");
  }
  if (typeof formatVersion !== "number" || !Number.isInteger(formatVersion)) {
    throw new ProjectConfigError("[project].format_version 缺失或非整数");
  }
  if (formatVersion > PROJECT_FORMAT_VERSION) {
    throw new ProjectConfigError(
      `project.toml 格式版本过新（${formatVersion} > 引擎支持 ${PROJECT_FORMAT_VERSION}），请升级御书`,
    );
  }
  const genre = asRecord(root["genre"] ?? {}, "[genre]");
  const fusion = asRecord(root["fusion"] ?? {}, "[fusion]");
  const conflictsRaw = fusion["conflicts"];
  const conflicts: FusionConflictNote[] = Array.isArray(conflictsRaw)
    ? conflictsRaw.map((item) => {
        const c = asRecord(item, "[fusion].conflicts 条目");
        return {
          kind: String(c["kind"] ?? ""),
          severity: String(c["severity"] ?? ""),
          message: String(c["message"] ?? ""),
        };
      })
    : [];
  return {
    project: {
      name: name.trim(),
      format_version: formatVersion,
      created_at: typeof project["created_at"] === "string" ? project["created_at"] : "",
    },
    genre: {
      packs: toStringArray(genre["packs"], "[genre].packs"),
      channel: toStringArray(genre["channel"], "[genre].channel"),
      world: toStringArray(genre["world"], "[genre].world"),
      technique: toStringArray(genre["technique"], "[genre].technique"),
      tone: toStringArray(genre["tone"], "[genre].tone"),
      ...(typeof genre["romance_mode_default"] === "string"
        ? { romance_mode_default: genre["romance_mode_default"] }
        : {}),
    },
    fusion: {
      confirmed_at: typeof fusion["confirmed_at"] === "string" ? fusion["confirmed_at"] : "",
      conflicts,
    },
  };
}