import { LlmAbortError, LlmError } from "./config.js";
import {
  isAbortError,
  postJson,
  readSseStream,
  requireApiKey,
  splitSystemAndTurns,
  type TransportOptions,
} from "./shared.js";
import {
  effectiveMaxTokens,
  resolveModelSpec,
  type ChatRequest,
  type ChatResult,
  type ChatUsage,
  type LlmProviderSpec,
  type StreamCallbacks,
} from "./types.js";

/**
 * Anthropic Messages 协议适配器（T3-1）。
 * - POST {base_url}/messages；鉴权 x-api-key + anthropic-version；
 * - system 消息提取为顶层 system 字段；user/assistant 相邻同角色合并；
 * - max_tokens 为必填：请求 ?? provider 默认 ?? 模型上限 ?? 4096；
 * - 流式为命名 SSE 事件（message_start / content_block_delta / message_delta / message_stop）。
 */

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;

function headers(provider: LlmProviderSpec, transport: TransportOptions): Record<string, string> {
  const key = requireApiKey(provider, transport.options);
  return {
    "Content-Type": "application/json",
    "anthropic-version": ANTHROPIC_VERSION,
    ...(key ? { "x-api-key": key } : {}),
  };
}

function buildBody(
  provider: LlmProviderSpec,
  request: ChatRequest,
  streamMode: boolean,
): Record<string, unknown> {
  const model = resolveModelSpec(provider, request.model);
  const { system, turns } = splitSystemAndTurns(request.messages);
  if (turns.length === 0) {
    throw new LlmError(
      "E_LLM_CONFIG",
      `provider「${provider.id}」请求缺少 user/assistant 消息（system 不能单独成请求）`,
    );
  }
  const maxTokens =
    effectiveMaxTokens(provider, model, request.max_tokens) ??
    model.limits?.max_output ??
    DEFAULT_MAX_TOKENS;
  const temperature = request.temperature ?? provider.temperature;
  return {
    model: model.name,
    max_tokens: maxTokens,
    messages: turns,
    stream: streamMode,
    ...(system ? { system } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
  };
}

/**
 * 流式 usage 合并（T3-12）：`message_start` 给输入与缓存读写，`message_delta` 给输出。
 * 部分网关会把整张 usage 回填、未变化的输入侧带 0——直接 Object.assign 会用 0 抹掉已知真值，
 * 因此输入类字段只在「尚未取得」时写入，输出字段以最后一条为准；非有限数一律不采。
 */
function mergeStreamUsage(
  target: Record<string, unknown>,
  incoming: Record<string, unknown> | undefined,
): void {
  if (!incoming) return;
  const overwriteKeys = ["output_tokens"] as const;
  const keepFirstKeys = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const;
  for (const key of overwriteKeys) {
    const value = incoming[key];
    if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
  }
  for (const key of keepFirstKeys) {
    const value = incoming[key];
    if (target[key] !== undefined) continue;
    if (typeof value === "number" && Number.isFinite(value)) target[key] = value;
  }
}

/**
 * usage 归一（T3-12）：Anthropic 的 `input_tokens` 与 `cache_read_input_tokens` /
 * `cache_creation_input_tokens` **互斥**（缓存部分本就单列），因此直接映射即可；
 * total 取四段之和。缺字段不伪造。
 */
function mapUsage(record: Record<string, unknown>): ChatUsage | undefined {
  const numeric = (key: string): number | undefined => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
  };
  const usage: ChatUsage = {};
  const input = numeric("input_tokens");
  const cached = numeric("cache_read_input_tokens");
  const cacheWrite = numeric("cache_creation_input_tokens");
  const output = numeric("output_tokens");
  if (input !== undefined) usage.prompt_tokens = input;
  if (cached !== undefined) usage.cached_tokens = cached;
  if (cacheWrite !== undefined) usage.cache_write_tokens = cacheWrite;
  if (output !== undefined) usage.completion_tokens = output;
  const parts = [
    usage.prompt_tokens,
    usage.cached_tokens,
    usage.cache_write_tokens,
    usage.completion_tokens,
  ].filter((value): value is number => value !== undefined);
  if (parts.length > 0) usage.total_tokens = parts.reduce((sum, value) => sum + value, 0);
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** 非流式：POST /messages 一次返回 */
export async function callAnthropicMessages(
  provider: LlmProviderSpec,
  request: ChatRequest,
  transport: TransportOptions,
): Promise<ChatResult> {
  const model = resolveModelSpec(provider, request.model);
  const response = await postJson(
    provider,
    `${provider.base_url}/messages`,
    headers(provider, transport),
    buildBody(provider, request, false),
    request.signal,
    transport,
  );
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new LlmError("E_LLM_RESPONSE", `provider「${provider.id}」响应不是合法 JSON`, { cause: err });
  }
  const record = json as Record<string, unknown>;
  const content = record["content"];
  if (!Array.isArray(content)) {
    throw new LlmError("E_LLM_RESPONSE", `provider「${provider.id}」响应缺少 content 数组`);
  }
  const text = content
    .filter(
      (block): block is Record<string, unknown> =>
        block !== null &&
        typeof block === "object" &&
        (block as Record<string, unknown>)["type"] === "text",
    )
    .map((block) => (typeof block["text"] === "string" ? block["text"] : ""))
    .join("");
  const usageRaw = (record["usage"] ?? {}) as Record<string, unknown>;
  const usage = mapUsage(usageRaw);
  return {
    text,
    provider_id: provider.id,
    model: typeof record["model"] === "string" ? record["model"] : model.name,
    ...(typeof record["stop_reason"] === "string"
      ? { finish_reason: record["stop_reason"] as string }
      : {}),
    ...(usage ? { usage } : {}),
    fallbacks: [],
    aborted: false,
  };
}

/** 流式：命名 SSE 事件逐块累积（abort 时保留已生成文本） */
export async function callAnthropicMessagesStream(
  provider: LlmProviderSpec,
  request: ChatRequest,
  callbacks: StreamCallbacks,
  transport: TransportOptions,
): Promise<ChatResult> {
  const model = resolveModelSpec(provider, request.model);
  const response = await postJson(
    provider,
    `${provider.base_url}/messages`,
    headers(provider, transport),
    buildBody(provider, request, true),
    request.signal,
    transport,
  );

  let text = "";
  let index = 0;
  /** 跨事件累积的 usage 字段（message_start 给输入与缓存，message_delta 给输出，T3-12） */
  const usageFields: Record<string, unknown> = {};
  let finishReason: string | undefined;
  try {
    await readSseStream(response, (data) => {
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        return; // 容忍心跳 / 非 JSON 行
      }
      const record = event as Record<string, unknown>;
      const type = record["type"];
      if (type === "message_start") {
        const message = record["message"] as Record<string, unknown> | undefined;
        const usage = message?.["usage"] as Record<string, unknown> | undefined;
        mergeStreamUsage(usageFields, usage);
        return;
      }
      if (type === "content_block_delta") {
        const delta = record["delta"] as Record<string, unknown> | undefined;
        if (
          delta?.["type"] === "text_delta" &&
          typeof delta["text"] === "string" &&
          delta["text"] !== ""
        ) {
          text += delta["text"];
          callbacks.onDelta?.({ text: delta["text"], index });
          index += 1;
        }
        return;
      }
      if (type === "message_delta") {
        const delta = record["delta"] as Record<string, unknown> | undefined;
        if (typeof delta?.["stop_reason"] === "string") finishReason = delta["stop_reason"] as string;
        const usage = record["usage"] as Record<string, unknown> | undefined;
        mergeStreamUsage(usageFields, usage);
        return;
      }
      if (type === "error") {
        const error = record["error"] as Record<string, unknown> | undefined;
        throw new LlmError(
          "E_LLM_RESPONSE",
          `provider「${provider.id}」流式返回错误事件：${String(error?.["message"] ?? "unknown")}`,
        );
      }
      // message_stop / content_block_start / content_block_stop / ping：忽略
    });
  } catch (err) {
    if (isAbortError(err)) throw new LlmAbortError(text);
    if (err instanceof LlmError) throw err;
    throw new LlmError("E_LLM_NETWORK", `provider「${provider.id}」流式读取中断：${String(err)}`, {
      cause: err,
    });
  }

  const usage = mapUsage(usageFields);
  return {
    text,
    provider_id: provider.id,
    model: model.name,
    ...(finishReason ? { finish_reason: finishReason } : {}),
    ...(usage ? { usage } : {}),
    fallbacks: [],
    aborted: false,
  };
}