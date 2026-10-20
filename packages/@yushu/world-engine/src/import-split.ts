/* SPDX-License-Identifier: Apache-2.0 */
import { SchemaRegistry, createRegistry, type JsonSchemaObject } from "@yushu/schema";

/**
 * AI 二次筛选切分的**输出契约**（M5 / T5-7 第二段，R107；判据回源 I09 §3.4）。
 *
 * I09 §3.4：自动分章 = **两段式「规则海选 → AI 筛选」**，正则匹配率低时回退 AI。
 * 这里的"第二段"就是 AI 筛选那一段：正则（海选）捞出一批**疑似章节标题**的行，
 * 由 AI 在这批里挑出**真正的章节标题**。
 *
 * 三条口径（与 T3-10 抽取任务、`audit-sample` 的 rejected 口径同源）：
 * ① **AI 只能指认候选表里的序号**——不给行号、不给原文。模型自己编的序号一律丢弃；
 * ② **越界与重复逐条丢弃并计数**，不是"整份作废"：一个跑偏的条目不该带走同批有效结论；
 * ③ **schema 不过 = 本轮筛失败**（keeps 空 + issues 非空），调用方据此回退正则切分并把话说清楚。
 *
 * 放在 world-engine 而不是 @yushu/text：JSON Schema 校验需要 `@yushu/schema`，
 * 而记忆/文本包刻意保持零依赖（新增依赖是要停牌问的事，不为这一处破例）。
 */

/** 任务契约 id（注入提示词，供 mock / 诊断识别） */
export const IMPORT_SPLIT_TASK_ID = "yushu.import/split_filter/v1";
/** 输出 schema id */
export const IMPORT_SPLIT_SCHEMA_ID = "yushu.import/split-decisions/v1";

export const IMPORT_SPLIT_OUTPUT_SCHEMA: JsonSchemaObject = {
  $id: IMPORT_SPLIT_SCHEMA_ID,
  type: "object",
  required: ["keeps"],
  additionalProperties: false,
  properties: {
    keeps: {
      type: "array",
      maxItems: 400,
      items: {
        type: "object",
        required: ["index"],
        additionalProperties: false,
        properties: {
          /** 候选在候选表里的序号（0 起）：服务端按序编号，模型只报序号，不报行号 */
          index: { type: "integer", minimum: 0 },
          /** 模型给的理由（可选，只用于面板显示） */
          reason: { type: "string", maxLength: 120 },
        },
      },
    },
  },
};

let splitRegistry: SchemaRegistry | undefined;

function getSplitRegistry(): SchemaRegistry {
  if (!splitRegistry) {
    const registry = createRegistry();
    if (!registry.has(IMPORT_SPLIT_SCHEMA_ID)) registry.add(IMPORT_SPLIT_OUTPUT_SCHEMA);
    splitRegistry = registry;
  }
  return splitRegistry;
}

export interface ImportSplitParseResult {
  /** 保留的候选序号（去重、按序升） */
  keeps: number[];
  /** 被丢弃的条目（越界 / 重复）逐条点名 */
  rejected: string[];
  /** schema / 语义问题清单（非空即视为本轮筛失败） */
  issues: string[];
}

/**
 * 解析 + schema 后校验。
 *
 * `candidateCount` 是**我们给模型的候选条数**——模型指认的序号超出它就是越界，
 * 那一律丢弃并点名（模型看不见没给过的东西）。
 */
export function parseImportSplitOutput(value: unknown, candidateCount: number): ImportSplitParseResult {
  const result = getSplitRegistry().validate(IMPORT_SPLIT_SCHEMA_ID, value);
  if (!result.valid) {
    return {
      keeps: [],
      rejected: [],
      issues: result.issues.slice(0, 8).map((issue) => `${issue.path} ${issue.message}`),
    };
  }
  const record = value as { keeps: Record<string, unknown>[] };
  const keeps: number[] = [];
  const rejected: string[] = [];
  const seen = new Set<number>();
  for (const item of record.keeps) {
    const index = Number(item["index"]);
    if (!Number.isInteger(index) || index < 0) {
      rejected.push(`序号 ${String(item["index"])} 不是合法候选序号`);
      continue;
    }
    if (index >= candidateCount) {
      rejected.push(`序号 ${String(index)} 超出候选范围（0…${String(candidateCount - 1)}）`);
      continue;
    }
    if (seen.has(index)) {
      rejected.push(`序号 ${String(index)} 重复`);
      continue;
    }
    seen.add(index);
    keeps.push(index);
  }
  keeps.sort((a, b) => a - b);
  return { keeps, rejected, issues: [] };
}
