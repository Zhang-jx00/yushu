import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { PackLoadError } from "./load.js";
import type { LoadedPack } from "./types.js";

/**
 * 派系包 schema 扩展点（G06：extends core/setting-card）。
 * 扩展卡是"设定卡 schema"的流派化补丁：定义新字段、注入语义与未知字段策略。
 */

export interface SchemaExtensionFieldDef {
  type?: string;
  required?: boolean;
  items?: { required?: string[]; properties?: Record<string, unknown> };
  [key: string]: unknown;
}

export interface SchemaExtension {
  /** 基础卡引用（当前仅支持 core/setting-card） */
  extends: string;
  /** 扩展 id（即使用该扩展的设定卡 type，如 realm-system） */
  id: string;
  title?: string;
  layer?: string;
  /** 未知字段策略：ignore_with_warning（默认）| reject */
  unknown_field_policy?: "ignore_with_warning" | "reject";
  fields: Record<string, SchemaExtensionFieldDef>;
  /** 注入语义（优先级/常驻/模板），供记忆系统使用（J03/J05） */
  inject?: Record<string, unknown>;
  /** 来源文件（供 lint/溯源） */
  source_file: string;
}

/** 加载派系包内的全部 schema 扩展文件（无扩展时返回空数组） */
export function loadSchemaExtensions(pack: LoadedPack): SchemaExtension[] {
  const files = pack.resolvedFiles.schema_extensions ?? [];
  const extensions: SchemaExtension[] = [];
  for (const file of files) {
    let raw: unknown;
    try {
      raw = parseYaml(readFileSync(file, "utf8")) as unknown;
    } catch (err) {
      throw new PackLoadError(`schema 扩展解析失败：${file}`, { cause: err });
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new PackLoadError(`schema 扩展内容非法（应为 YAML 映射）：${file}`);
    }
    const record = raw as Record<string, unknown>;
    const id = record["id"];
    if (typeof id !== "string" || id === "") {
      throw new PackLoadError(`schema 扩展缺少 id：${file}`);
    }
    extensions.push({
      extends: typeof record["extends"] === "string" ? record["extends"] : "core/setting-card",
      id,
      ...(typeof record["title"] === "string" ? { title: record["title"] } : {}),
      ...(typeof record["layer"] === "string" ? { layer: record["layer"] } : {}),
      ...(record["unknown_field_policy"] === "ignore_with_warning" ||
      record["unknown_field_policy"] === "reject"
        ? { unknown_field_policy: record["unknown_field_policy"] as "ignore_with_warning" | "reject" }
        : {}),
      fields:
        record["fields"] !== null && typeof record["fields"] === "object"
          ? (record["fields"] as Record<string, SchemaExtensionFieldDef>)
          : {},
      ...(record["inject"] !== null && typeof record["inject"] === "object"
        ? { inject: record["inject"] as Record<string, unknown> }
        : {}),
      source_file: file,
    });
  }
  return extensions;
}

export interface ExtensionValidationResult {
  errors: string[];
  warnings: string[];
}

/**
 * 用扩展定义校验设定卡的 extensions 数据。
 * 语义：未填写的扩展字段不强制（渐进披露）；数组字段逐项校验 items.required；
 * 未知字段按 unknown_field_policy 处理（默认 ignore_with_warning）。
 */
export function validateExtensionCard(
  extension: SchemaExtension,
  card: { type?: string; extensions?: Record<string, unknown> },
): ExtensionValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const policy = extension.unknown_field_policy ?? "ignore_with_warning";
  const data = card.extensions ?? {};

  for (const key of Object.keys(data)) {
    if (!(key in extension.fields)) {
      const message = `未知扩展字段「${key}」（策略：${policy}）`;
      if (policy === "reject") errors.push(message);
      else warnings.push(message);
    }
  }

  for (const [key, def] of Object.entries(extension.fields)) {
    const value = data[key];
    if (value === undefined || value === null) {
      if (def.required === true) {
        errors.push(`缺少必填扩展字段「${key}」`);
      }
      continue;
    }
    if (def.type === "array") {
      if (!Array.isArray(value)) {
        errors.push(`扩展字段「${key}」应为数组`);
        continue;
      }
      const itemRequired = def.items?.required ?? [];
      value.forEach((item, index) => {
        if (item === null || typeof item !== "object" || Array.isArray(item)) {
          errors.push(`「${key}[${index}]」应为对象`);
          return;
        }
        for (const requiredKey of itemRequired) {
          if (!(requiredKey in (item as Record<string, unknown>))) {
            errors.push(`「${key}[${index}]」缺少必填项 ${requiredKey}`);
          }
        }
      });
    } else if (def.type === "string" && typeof value !== "string") {
      errors.push(`扩展字段「${key}」应为字符串`);
    } else if (
      (def.type === "integer" || def.type === "number") &&
      typeof value !== "number"
    ) {
      errors.push(`扩展字段「${key}」应为数字`);
    }
  }

  return { errors, warnings };
}