import { LlmAbortError, LlmError } from "./config.js";
import {
  isAbortError,
  postJson,
  readSseStream,
  requireApiKey,
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
 * OpenAI Chat Completions 兼容传输层（协议主干；本地 Ollama / LM Studio / vLLM 同构）。
 * 只负责单 provider 的一次调用；fallback 编排见 chat.ts / stream.ts。
 * T3-1：模型经 resolveModelSpec 解析（models[0] 为默认），max_tokens 不超过模型 limits.max_output。
 */

function buildRequestBody(
  provider: LlmProviderSpec,
  request: ChatRequest,
  streamMode: boolean,
): { body: Record<string, unknown>; modelName: string } {
  const model = resolveModelSpec(provider, request.model);
  const body: Record<string, unknown> = {
    model: model.name,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    stream: streamMode,
  };
  const temperature = request.temperature ?? provider.temperature;
  if (temperature !== undefined) body["temperature"] = temperature;
  const maxTokens = effectiveMaxTokens(provider, model, request.max_tokens);
  if (maxTokens !== undefined) body["max_tokens"] = maxTokens;
  if (streamMode) body["stream_options"] = { include_usage: true };
  return { body, modelName: model.name };
}

async function postChatCompletions(
  provider: LlmProviderSpec,
  request: ChatRequest,
  streamMode: boolean,
  transport: TransportOptions,
): Promise<Response> {
  const apiKey = requireApiKey(provider, transport.options);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  const { body } = buildRequestBody(provider, request, streamMode);
  return postJson(
    provider,
    `${provider.base_url}/chat/completions`,
    headers,
    body,
    request.signal,
    transport,
  );
}

function mapUsage(raw: unknown): ChatUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const usage: ChatUsage = {};
  if (typeof record["prompt_tokens"] === "number") usage.prompt_tokens = record["prompt_tokens"];
  if (typeof record["completion_tokens"] === "number") {
    usage.completion_tokens = record["completion_tokens"];
  }
  if (typeof record["total_tokens"] === "number") usage.total_tokens = record["total_tokens"];
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/** 非流式调用（chat 动词的单次实现） */
export async function callChatCompletion(
  provider: LlmProviderSpec,
  request: ChatRequest,
  transport: TransportOptions,
): Promise<ChatResult> {
  const response = await postChatCompletions(provider, request, false, transport);
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new LlmError("E_LLM_RESPONSE", `provider「${provider.id}」响应不是合法 JSON`, { cause: err });
  }
  const body = json as Record<string, unknown>;
  const choice = (body["choices"] as unknown[] | undefined)?.[0] as
    | Record<string, unknown>
    | undefined;
  const message = choice?.["message"] as Record<string, unknown> | undefined;
  const text = message?.["content"];
  if (typeof text !== "string") {
    throw new LlmError("E_LLM_RESPONSE", `provider「${provider.id}」响应缺少 choices[0].message.content`);
  }
  const fallbackModel = resolveModelSpec(provider, request.model).name;
  const usage = mapUsage(body["usage"]);
  return {
    text,
    provider_id: provider.id,
    model: typeof body["model"] === "string" ? body["model"] : fallbackModel,
    ...(typeof choice?.["finish_reason"] === "string"
      ? { finish_reason: choice["finish_reason"] as string }
      : {}),
    ...(usage ? { usage } : {}),
    fallbacks: [],
    aborted: false,
  };
}

/** 流式调用（stream 动词的单次实现）：SSE 逐块解析，中止时抛 LlmAbortError（携带已生成文本） */
export async function callChatCompletionStream(
  provider: LlmProviderSpec,
  request: ChatRequest,
  callbacks: StreamCallbacks,
  transport: TransportOptions,
): Promise<ChatResult> {
  const response = await postChatCompletions(provider, request, true, transport);

  let text = "";
  let index = 0;
  let usage: ChatUsage | undefined;
  let finishReason: string | undefined;
  let done = false;

  try {
    await readSseStream(response, (data) => {
      if (done) return;
      if (data === "[DONE]") {
        done = true;
        return;
      }
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        return; // 容忍非 JSON 心跳行
      }
      const body = event as Record<string, unknown>;
      const choice = (body["choices"] as unknown[] | undefined)?.[0] as
        | Record<string, unknown>
        | undefined;
      const delta = (choice?.["delta"] as Record<string, unknown> | undefined)?.["content"];
      if (typeof delta === "string" && delta !== "") {
        text += delta;
        callbacks.onDelta?.({ text: delta, index });
        index += 1;
      }
      if (typeof choice?.["finish_reason"] === "string") {
        finishReason = choice["finish_reason"] as string;
      }
      const chunkUsage = mapUsage(body["usage"]);
      if (chunkUsage) usage = chunkUsage;
    });
  } catch (err) {
    if (isAbortError(err)) throw new LlmAbortError(text);
    throw new LlmError("E_LLM_NETWORK", `provider「${provider.id}」流式读取中断：${String(err)}`, {
      cause: err,
    });
  }

  return {
    text,
    provider_id: provider.id,
    model: resolveModelSpec(provider, request.model).name,
    ...(finishReason ? { finish_reason: finishReason } : {}),
    ...(usage ? { usage } : {}),
    fallbacks: [],
    aborted: false,
  };
}