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

function mapUsage(
  inputTokens: unknown,
  outputTokens: unknown,
): ChatUsage | undefined {
  const usage: ChatUsage = {};
  if (typeof inputTokens === "number") usage.prompt_tokens = inputTokens;
  if (typeof outputTokens === "number") usage.completion_tokens = outputTokens;
  if (usage.prompt_tokens !== undefined && usage.completion_tokens !== undefined) {
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
  }
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
  const usage = mapUsage(usageRaw["input_tokens"], usageRaw["output_tokens"]);
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
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
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
        const usage = (message?.["usage"] ?? {}) as Record<string, unknown>;
        if (typeof usage["input_tokens"] === "number") promptTokens = usage["input_tokens"];
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
        if (typeof usage?.["output_tokens"] === "number") completionTokens = usage["output_tokens"];
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

  const usage = mapUsage(promptTokens, completionTokens);
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