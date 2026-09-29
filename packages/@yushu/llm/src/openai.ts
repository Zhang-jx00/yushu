import {
  LlmAbortError,
  LlmError,
  resolveApiKey,
} from "./config.js";
import type {
  ChatRequest,
  ChatResult,
  ChatUsage,
  LlmCallOptions,
  LlmProviderSpec,
  StreamCallbacks,
} from "./types.js";

/**
 * OpenAI Chat Completions 兼容传输层（主干实现；本地 Ollama / LM Studio 同构）。
 * 只负责单 provider 的一次调用；fallback 编排见 chat.ts / stream.ts。
 */

export interface TransportOptions {
  options: LlmCallOptions;
  fetchImpl: typeof fetch;
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof LlmAbortError ||
    (err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted")))
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 校验 key：声明了 api_key_env 但两处都没有 → 提前给出可操作的错误（而非等 401） */
function requireApiKey(provider: LlmProviderSpec, options: LlmCallOptions): string | undefined {
  const key = resolveApiKey(provider, options);
  if (!key && provider.api_key_env) {
    throw new LlmError(
      "E_LLM_CONFIG",
      `provider「${provider.id}」未提供 API Key：请设置环境变量 ${provider.api_key_env}，或在 AI 副驾面板输入会话 Key（不落盘）`,
    );
  }
  return key;
}

function buildRequestBody(
  provider: LlmProviderSpec,
  request: ChatRequest,
  streamMode: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: request.model ?? provider.model,
    messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    stream: streamMode,
  };
  const temperature = request.temperature ?? provider.temperature;
  if (temperature !== undefined) body["temperature"] = temperature;
  const maxTokens = request.max_tokens ?? provider.max_tokens;
  if (maxTokens !== undefined) body["max_tokens"] = maxTokens;
  if (streamMode) body["stream_options"] = { include_usage: true };
  return body;
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

  try {
    const response = await transport.fetchImpl(`${provider.base_url}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(buildRequestBody(provider, request, streamMode)),
      ...(request.signal ? { signal: request.signal } : {}),
    });
    if (!response.ok) {
      const snippet = (await response.text().catch(() => "")).slice(0, 300);
      throw new LlmError(
        "E_LLM_HTTP",
        `provider「${provider.id}」返回 HTTP ${response.status}${snippet ? `：${snippet}` : ""}`,
      );
    }
    return response;
  } catch (err) {
    if (isAbortError(err)) throw new LlmAbortError("");
    if (err instanceof LlmError) throw err;
    throw new LlmError(
      "E_LLM_NETWORK",
      `无法连接 provider「${provider.id}」（${provider.base_url}）：${errorMessage(err)}`,
      { cause: err },
    );
  }
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
  return {
    text,
    provider_id: provider.id,
    model: typeof body["model"] === "string" ? body["model"] : provider.model,
    ...(typeof choice?.["finish_reason"] === "string"
      ? { finish_reason: choice["finish_reason"] as string }
      : {}),
    ...(mapUsage(body["usage"]) ? { usage: mapUsage(body["usage"]) } : {}),
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
  if (!response.body) {
    throw new LlmError("E_LLM_RESPONSE", `provider「${provider.id}」响应无 body（不支持流式）`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let index = 0;
  let usage: ChatUsage | undefined;
  let finishReason: string | undefined;
  let done = false;

  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === "[DONE]") {
          done = true;
          break;
        }
        let event: unknown;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // 容忍非 JSON 心跳行
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
      }
    }
  } catch (err) {
    if (isAbortError(err)) throw new LlmAbortError(text);
    throw new LlmError("E_LLM_NETWORK", `provider「${provider.id}」流式读取中断：${errorMessage(err)}`, {
      cause: err,
    });
  } finally {
    reader.releaseLock();
  }

  return {
    text,
    provider_id: provider.id,
    model: provider.model,
    ...(finishReason ? { finish_reason: finishReason } : {}),
    ...(usage ? { usage } : {}),
    fallbacks: [],
    aborted: false,
  };
}