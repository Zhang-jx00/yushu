import type { LayerKey } from "@yushu/core";
import { SchemaRegistry, createRegistry, type JsonSchemaObject } from "@yushu/schema";
import { TYPE_PREFIXES, type CreateCardInput } from "./cards.js";

/**
 * 设定抽取（T3-10，J06）：从正文抽取实体候选（人物/地点/势力/物品/功法/事件/设定），
 * 产出**候选卡**（staging）——AI 结果一律 `status: candidate`，用户确认后才写入设定卡真源。
 * - **JSON Schema 唯一契约**：抽取输出经 `EXTRACT_OUTPUT_SCHEMA` 后校验（ajv；`additionalProperties:false`）；
 * - **出处即契约**：每条候选必须带 `quote`（无出处 = 抽取失败，不允许进入候选）；
 * - **冲突三分类**：与既有设定卡比对 → new（新增）/ augment（同名同类型：补充）/ conflict（同名异类型）；
 * - 纯逻辑（不读写文件）；candidate_id 由服务端按序生成（不信任模型）、`status` 服务端强制为 candidate。
 */

/** 抽取任务契约 id（注入提示词，供 mock / 诊断识别） */
export const EXTRACT_TASK_ID = "yushu.extract/entity_extraction/v1";
/** 候选输出 schema id */
export const EXTRACT_SCHEMA_ID = "yushu.extract/entity-candidates/v1";

export const EXTRACT_OUTPUT_SCHEMA: JsonSchemaObject = {
  $id: EXTRACT_SCHEMA_ID,
  type: "object",
  required: ["candidates"],
  additionalProperties: false,
  properties: {
    candidates: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        required: ["type", "name", "summary", "quote", "confidence"],
        additionalProperties: false,
        properties: {
          type: { enum: Object.keys(TYPE_PREFIXES) },
          name: { type: "string", minLength: 1, maxLength: 60 },
          aliases: {
            type: "array",
            maxItems: 8,
            items: { type: "string", minLength: 1, maxLength: 60 },
          },
          summary: { type: "string", minLength: 1, maxLength: 300 },
          /** 出处引文（J06「出处即契约」：无出处不得进入候选） */
          quote: { type: "string", minLength: 1, maxLength: 300 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

let extractRegistry: SchemaRegistry | undefined;

/** 抽取专用注册表（核心 schema + 抽取输出 schema；懒加载单例） */
function getExtractRegistry(): SchemaRegistry {
  if (!extractRegistry) {
    const registry = createRegistry();
    if (!registry.has(EXTRACT_SCHEMA_ID)) registry.add(EXTRACT_OUTPUT_SCHEMA);
    extractRegistry = registry;
  }
  return extractRegistry;
}

/** 抽取类型 → 世界构建层级缺省映射（作者可在档案页调整；无对应层级时归入 laws 兜底） */
export const EXTRACT_TYPE_LAYERS: Record<string, LayerKey> = {
  character: "characters",
  location: "geography",
  faction: "factions",
  event: "events",
  law: "laws",
  item: "laws",
  skill: "laws",
  lore: "genesis",
  species: "ecology",
};

/** 模型侧候选（schema 通过后的清洗形态） */
export interface ExtractedCandidateInput {
  type: string;
  name: string;
  aliases: string[];
  summary: string;
  /** 出处引文（原文片段） */
  quote: string;
  confidence: number;
}

export interface ExtractionParseResult {
  candidates: ExtractedCandidateInput[];
  /** schema / 语义问题清单（非空即视为抽取失败——调用方回喂修复或落失败池） */
  issues: string[];
}

/** 解析 + schema 后校验（J06 `extract-schema-invalid` → error：交由调用方修复重试） */
export function parseExtractionOutput(value: unknown): ExtractionParseResult {
  const result = getExtractRegistry().validate(EXTRACT_SCHEMA_ID, value);
  if (!result.valid) {
    return {
      candidates: [],
      issues: result.issues.slice(0, 8).map((issue) => `${issue.path} ${issue.message}`),
    };
  }
  const record = value as { candidates: Record<string, unknown>[] };
  const candidates: ExtractedCandidateInput[] = record.candidates.map((item) => ({
    type: String(item["type"] ?? ""),
    name: String(item["name"] ?? "").trim(),
    aliases: Array.isArray(item["aliases"])
      ? (item["aliases"] as unknown[]).map((alias) => String(alias).trim()).filter((alias) => alias !== "")
      : [],
    summary: String(item["summary"] ?? "").trim(),
    quote: String(item["quote"] ?? "").trim(),
    confidence: Number(item["confidence"] ?? 0),
  }));
  return { candidates, issues: [] };
}

export type CandidateDiffKind = "new" | "augment" | "conflict";

export interface CandidateDiff {
  kind: CandidateDiffKind;
  matched_card_id?: string;
  reason: string;
}

/** 既有卡比对输入（id / type / name / aliases——由应用层从档案页数据提供） */
export interface ExistingCardRef {
  id: string;
  type: string;
  name: string;
  aliases: string[];
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * 候选与既有设定卡的三分类比对（J06 实践 6；命名消歧用名称与别名集合）：
 * 同名/别名且类型一致 → augment（补充）；同名/别名但类型不同 → conflict（冲突，需人工处置）；无匹配 → new。
 */
export function classifyCandidate(
  candidate: ExtractedCandidateInput,
  existing: ExistingCardRef[],
): CandidateDiff {
  const candidateNames = new Set(
    [candidate.name, ...candidate.aliases].map(normalizeName).filter((name) => name !== ""),
  );
  for (const card of existing) {
    const cardNames = [card.name, ...card.aliases].map(normalizeName).filter((name) => name !== "");
    if (!cardNames.some((name) => candidateNames.has(name))) continue;
    if (card.type === candidate.type) {
      return {
        kind: "augment",
        matched_card_id: card.id,
        reason: `与既有卡「${card.name}」（${card.id}）同名/别名且类型一致：应补充而非重复建卡`,
      };
    }
    return {
      kind: "conflict",
      matched_card_id: card.id,
      reason: `与既有卡「${card.name}」（${card.id}）同名/别名但类型不同（${candidate.type} ≠ ${card.type}）：冲突，需人工处置`,
    };
  }
  return { kind: "new", reason: "未匹配到既有卡：新增候选" };
}

export interface ExtractionCandidate extends ExtractedCandidateInput {
  candidate_id: string;
  diff: CandidateDiff;
  /** 服务端强制：抽取结果一律候选（AI 不得直接入库——数据主权红线） */
  status: "candidate";
}

/** 组装候选列表：服务端生成 candidate_id（序）与差异分类，强制 status=candidate */
export function buildExtractionCandidates(
  candidates: ExtractedCandidateInput[],
  existing: ExistingCardRef[],
): ExtractionCandidate[] {
  return candidates.map((candidate, index) => ({
    ...candidate,
    candidate_id: `cand-${String(index + 1).padStart(4, "0")}`,
    diff: classifyCandidate(candidate, existing),
    status: "candidate" as const,
  }));
}

export interface CandidateCardDraft {
  card: CreateCardInput;
  body: string;
}

/**
 * 候选 → 设定卡草案（用户确认采纳时入库）：出处（章 + 引文 + 置信度）写入
 * `extensions.extract`（status=accepted——「用户确认后入库」的服务端凭据），
 * `source_chapters` 记来源章；正文 = 摘要 + 出处引用行。
 */
export function candidateToCardDraft(
  candidate: ExtractionCandidate,
  options: { chapterId: string; status?: "candidate" | "accepted" },
): CandidateCardDraft {
  return {
    card: {
      type: candidate.type,
      name: candidate.name,
      layer: EXTRACT_TYPE_LAYERS[candidate.type] ?? "laws",
      aliases: [...candidate.aliases],
      sourceChapters: [options.chapterId],
      extensions: {
        extract: {
          status: options.status ?? "accepted",
          candidate_id: candidate.candidate_id,
          confidence: candidate.confidence,
          quote: candidate.quote,
          chapter_id: options.chapterId,
        },
      },
    },
    body: `${candidate.summary}\n\n> 抽取出处（${options.chapterId}）：${candidate.quote}\n`,
  };
}