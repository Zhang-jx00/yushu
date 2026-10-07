import { chat } from "./chat.js";
import { extractJson, JSON_CONSTRAINT_SUFFIX } from "./downgrade.js";
import type { ChatMessage, ChatRequest, LlmCallOptions, LlmProviderSpec } from "./types.js";

/**
 * 结构化输出（T3-10，J06）：JSON Schema 契约 + 抽取-校验-修复闭环。
 * - **约束路线**：把 JSON Schema 作为「唯一契约」注入请求末尾（提示词约束档）；
 *   provider 声明 structured_output 能力时可走原生 JSON Schema 强约束（J01 三路线，
 *   本函数即第一档「提示词约束」的落地，能力满足时由调用方直连——见 T3-3 降级映射）；
 * - **后校验**：`extractJson` 容忍围栏 / 前后解释文本；`validate` 由调用方提供
 *   （引擎不依赖具体 schema 包——如 @yushu/schema 注册表校验 + 领域清洗）；
 * - **修复**：校验失败把错误摘要回喂模型（缺省上限 2 次——J06 校验-重试闭环），
 *   仍失败如实返回 issues（调用方落失败池，**绝不静默采用**）。
 */

export interface StructuredValidation {
  valid: boolean;
  issues: string[];
}

export interface StructuredExtractOptions extends LlmCallOptions {
  /** 基础对话（system + 正文等）；schema 约束与修复轮由本函数追加 */
  messages: ChatMessage[];
  /** JSON Schema（唯一契约；序列化后随约束注入提示词） */
  schema: unknown;
  /** 后校验（App 侧提供；缺省不校验——仅有 JSON 解析合法性门槛） */
  validate?: (value: unknown) => StructuredValidation;
  /** 修复重试上限（缺省 2——J06：校验失败回喂错误再试，上限用尽即如实失败） */
  maxRepair?: number;
  /** 中止信号（透传 chat；中止抛 LlmAbortError） */
  signal?: AbortSignal;
}

export interface StructuredExtractResult<T = unknown> {
  ok: boolean;
  value?: T;
  /** 失败时的校验 / 解析问题清单（成功为空） */
  issues: string[];
  /** 实际请求次数（1 = 首次即通过） */
  attempts: number;
  /** 最后一次原始输出（诊断 / 失败池用） */
  raw: string;
  provider_id: string;
  model: string;
}

/** 生成 schema 约束提示词（追加到每次请求末尾——契约与修复轮同时生效） */
export function buildSchemaConstraint(schema: unknown): string {
  return (
    `${JSON_CONSTRAINT_SUFFIX}\n【JSON Schema（唯一契约，字段名与类型必须严格符合）】\n` +
    JSON.stringify(schema)
  );
}

function repairMessage(attempt: number, issues: string[]): string {
  return (
    `本次输出未通过校验（第 ${attempt} 次）：\n${issues.map((issue) => `- ${issue}`).join("\n")}\n` +
    "请仅修正上述问题，重新输出完整的 JSON 对象（其余字段保持原样，不要输出任何解释或围栏）。"
  );
}

/**
 * 结构化抽取：chat（非流式）→ extractJson → 后校验 → 失败回喂修复（≤ maxRepair）→ 如实返回。
 * 全程确定性控制流（请求次数可预期；内容依赖模型，测试以本地 mock 覆盖）。
 */
export async function extractStructured<T = unknown>(
  providers: LlmProviderSpec[],
  options: StructuredExtractOptions,
): Promise<StructuredExtractResult<T>> {
  const maxRepair = Math.max(0, Math.floor(options.maxRepair ?? 2));
  const limit = 1 + maxRepair;
  const constraint = buildSchemaConstraint(options.schema);
  const conversation: ChatMessage[] = [...options.messages];

  let issues: string[] = [];
  let raw = "";
  let provider_id = "";
  let model = "";

  for (let attempt = 1; attempt <= limit; attempt += 1) {
    const request: ChatRequest = {
      messages: [...conversation, { role: "user", content: constraint }],
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const result = await chat(providers, request, options);
    raw = result.text;
    provider_id = result.provider_id;
    model = result.model;

    const parsed = extractJson(raw);
    if (!parsed.ok) {
      issues = [`JSON 解析失败：${parsed.error}`];
    } else {
      const validation = options.validate ? options.validate(parsed.value) : { valid: true, issues: [] };
      if (validation.valid) {
        return { ok: true, value: parsed.value as T, issues: [], attempts: attempt, raw, provider_id, model };
      }
      issues = validation.issues.length > 0 ? validation.issues : ["输出未通过校验（原因未明）"];
    }
    if (attempt < limit) {
      conversation.push({ role: "assistant", content: raw }, { role: "user", content: repairMessage(attempt, issues) });
    }
  }

  return { ok: false, issues, attempts: limit, raw, provider_id, model };
}