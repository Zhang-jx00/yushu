import { parseFrontmatter, serializeCard } from "@yushu/core";
import { MemoryError } from "./errors.js";
import {
  MEMORY_FORMAT_VERSION,
  type FactRecord,
  type FactSource,
  type MemoryLintFinding,
  type MemoryRecord,
  type SummaryRecord,
} from "./types.js";

/**
 * 记忆记录的解析 / 序列化与写入规则（T3-5）：
 * - 真源 = Markdown（YAML frontmatter + 摘要/事实正文），人可读、可 diff；
 * - AI 写入规则：`summary_rev > 0`（人工已修订）时 **AI 不得覆盖**（E_MEMORY_REV_PROTECTED），
 *   只能作为候选展示；人工编辑每次 rev+1；
 * - `lintMemory`：跨项目泄漏（`project_id` 不匹配）= **error**；无出处事实 / 空 keys = warn。
 */

function fail(message: string, options?: ErrorOptions): never {
  throw new MemoryError("E_MEMORY_MALFORMED", message, options);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${what} 应为映射`);
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") fail(`${label} 缺失或非字符串`);
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string, label: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(`${label} 应为字符串`);
  return value;
}

function readNonNegativeInteger(record: Record<string, unknown>, key: string, label: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(`${label} 应为非负整数`);
  }
  return value;
}

function parseSummaryFrom(data: unknown, layer: "volume_summary" | "chapter_summary", body: string): SummaryRecord {
  const record = asRecord(data, `${layer} frontmatter`);
  if (record["layer"] !== layer) {
    fail(`layer 必须为 ${layer}（实际 ${String(record["layer"])}）`);
  }
  const volumeId = readOptionalString(record, "volume_id", "volume_id");
  const formatVersion = record["format_version"];
  if (formatVersion !== undefined && formatVersion !== MEMORY_FORMAT_VERSION) {
    fail(`format_version 不支持：${String(formatVersion)}（当前 ${MEMORY_FORMAT_VERSION}）`);
  }
  return {
    layer,
    id: readString(record, "id", "id"),
    project_id: readString(record, "project_id", "project_id"),
    ...(volumeId !== undefined ? { volume_id: volumeId } : {}),
    summary_rev: readNonNegativeInteger(record, "summary_rev", "summary_rev"),
    updated_at: readString(record, "updated_at", "updated_at"),
    text: body.replace(/\n+$/, "\n"),
  };
}

/** 解析卷摘要（Markdown + frontmatter） */
export function parseVolumeSummary(source: string): SummaryRecord {
  const { data, body } = parseFrontmatter(source);
  return parseSummaryFrom(data, "volume_summary", body);
}

/** 解析章摘要（Markdown + frontmatter） */
export function parseChapterSummary(source: string): SummaryRecord {
  const { data, body } = parseFrontmatter(source);
  return parseSummaryFrom(data, "chapter_summary", body);
}

export function serializeSummary(record: SummaryRecord): string {
  return serializeCard(
    {
      format_version: MEMORY_FORMAT_VERSION,
      layer: record.layer,
      id: record.id,
      project_id: record.project_id,
      ...(record.volume_id ? { volume_id: record.volume_id } : {}),
      summary_rev: record.summary_rev,
      updated_at: record.updated_at,
    },
    record.text,
  );
}

function parseFactSource(raw: unknown, label: string): FactSource | undefined {
  if (raw === undefined) return undefined;
  const record = asRecord(raw, label);
  const start = readNonNegativeInteger(record, "start", `${label}.start`);
  const end = readNonNegativeInteger(record, "end", `${label}.end`);
  if (end <= start) fail(`${label} 的字符区间非法（end 必须大于 start）`);
  return {
    chapter_id: readString(record, "chapter_id", `${label}.chapter_id`),
    start,
    end,
    hash: readString(record, "hash", `${label}.hash`),
  };
}

/** 解析事实级记忆（Markdown + frontmatter；keys 必填，source 可缺省） */
export function parseFact(source: string): FactRecord {
  const { data, body } = parseFrontmatter(source);
  const record = asRecord(data, "fact frontmatter");
  if (record["layer"] !== "fact") fail(`layer 必须为 fact（实际 ${String(record["layer"])}）`);
  const rawKeys = record["keys"];
  if (!Array.isArray(rawKeys) || rawKeys.some((key) => typeof key !== "string" || key.trim() === "")) {
    fail("keys 应为非空字符串数组");
  }
  const factSource = parseFactSource(record["source"], "source");
  return {
    layer: "fact",
    id: readString(record, "id", "id"),
    project_id: readString(record, "project_id", "project_id"),
    keys: (rawKeys as string[]).map((key) => key.trim()),
    text: body.replace(/\n+$/, "\n"),
    ...(factSource ? { source: factSource } : {}),
    updated_at: readString(record, "updated_at", "updated_at"),
  };
}

export function serializeFact(record: FactRecord): string {
  return serializeCard(
    {
      format_version: MEMORY_FORMAT_VERSION,
      layer: "fact",
      id: record.id,
      project_id: record.project_id,
      keys: [...record.keys],
      updated_at: record.updated_at,
      ...(record.source
        ? {
            source: {
              chapter_id: record.source.chapter_id,
              start: record.source.start,
              end: record.source.end,
              hash: record.source.hash,
            },
          }
        : {}),
    },
    record.text,
  );
}

export interface SummaryUpsertInput {
  id: string;
  project_id: string;
  volume_id?: string;
  text: string;
}

/** AI 是否可写入该摘要（无记录或 rev === 0） */
export function canAiWriteSummary(existing: SummaryRecord | null): boolean {
  return !existing || existing.summary_rev === 0;
}

/** AI 生成的摘要入库规则：`summary_rev > 0`（人工已修订）→ 拒绝覆盖（红线） */
export function applyAiSummary(
  layer: "volume_summary" | "chapter_summary",
  existing: SummaryRecord | null,
  input: SummaryUpsertInput,
  now: string,
): SummaryRecord {
  if (existing && existing.summary_rev > 0) {
    throw new MemoryError(
      "E_MEMORY_REV_PROTECTED",
      `摘要「${existing.id}」已经人工修订（rev ${existing.summary_rev}）：AI 不得覆盖，只能作为候选展示`,
    );
  }
  return {
    layer,
    id: input.id,
    project_id: input.project_id,
    ...(input.volume_id ? { volume_id: input.volume_id } : {}),
    summary_rev: existing?.summary_rev ?? 0,
    updated_at: now,
    text: normalizeText(input.text),
  };
}

/** 人工编辑：rev+1（冻结 AI 自动覆盖） */
export function applyHumanSummaryEdit(
  existing: SummaryRecord | null,
  input: SummaryUpsertInput,
  now: string,
  layer: "volume_summary" | "chapter_summary",
): SummaryRecord {
  return {
    layer,
    id: input.id,
    project_id: input.project_id,
    ...(input.volume_id ? { volume_id: input.volume_id } : {}),
    summary_rev: (existing?.summary_rev ?? 0) + 1,
    updated_at: now,
    text: normalizeText(input.text),
  };
}

function normalizeText(text: string): string {
  const trimmed = text.replace(/\r\n/g, "\n").trim();
  return `${trimmed}\n`;
}

/**
 * 记录体检：
 * - error：`project_id` 与当前项目不符（记忆不跨项目泄漏——红线，A5）；
 * - warn：事实无出处（source 缺省）；keys 为空。
 */
export function lintMemory(records: MemoryRecord[], projectId: string): MemoryLintFinding[] {
  const findings: MemoryLintFinding[] = [];
  for (const record of records) {
    if (record.project_id !== projectId) {
      findings.push({
        severity: "error",
        code: "memory-cross-project-leak",
        record_id: record.id,
        message: `记忆「${record.id}」属于其它项目（${record.project_id}）：不允许进入本项目记忆（跨项目泄漏）`,
      });
    }
    if (record.layer === "fact") {
      if (!record.source) {
        findings.push({
          severity: "warn",
          code: "memory-fact-no-source",
          record_id: record.id,
          message: `事实「${record.id}」缺少出处（source）：建议补登章节与字符区间`,
        });
      }
      if (record.keys.length === 0) {
        findings.push({
          severity: "warn",
          code: "memory-fact-no-keys",
          record_id: record.id,
          message: `事实「${record.id}」缺少触发关键词（keys）`,
        });
      }
    }
  }
  return findings;
}