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
 * Gemini generateContent 协议适配器（T3-1）。
 * - POST {base_url}/models/{model}:generateContent（流式 :streamGenerateContent?alt=sse）；
 * - 鉴权 x-goog-api-key；system 消息 → systemInstruction；assistant → role: model；
 * - usage 映射 usageMetadata（promptTokenCount / candidatesTokenCount / totalTokenCount；
 *   `cachedContentTokenCount` 为 prompt 的子集，T3-12 归一时扣出单列）；
 * - promptFeedback.blockReason 视为安全策略拦截，给出明确错误而非空正文。
 */

function normalizeModelName(name: string): string {
  return name.startsWith("models/") ? name.slice("models/".length) : name;
}

function headers(provider: LlmProviderSpec, transport: TransportOptions): Record<string, string> {
  const key = requireApiKey(provider, transport.options);
  return {
    "Content-Type": "application/json",
    ...(key ? { "x-goog-api-key": key } : {}),
  };
}

function buildBody(provider: LlmProviderSpec, request: ChatRequest): Record<string, unknown> {
  const model = resolveModelSpec(provider, request.model);
  const { system, turns } = splitSystemAndTurns(request.messages);
  if (turns.length === 0) {
    throw new LlmError(
      "E_LLM_CONFIG",
      `provider「${provider.id}」请求缺少 user/assistant 消息（system 不能单独成请求）`,
    );
  }
  const temperature = request.temperature ?? provider.temperature;
  const maxTokens = effectiveMaxTokens(provider, model, request.max_tokens);
  const generationConfig: Record<string, unknown> = {};
  if (temperature !== undefined) generationConfig["temperature"] = temperature;
  if (maxTokens !== undefined) generationConfig["maxOutputTokens"] = maxTokens;
  return {
    contents: turns.map((turn) => ({
      role: turn.role === "assistant" ? "model" : "user",
      parts: [{ text: turn.content }],
    })),
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };
}

/**
 * usageMetadata → ChatUsage（T3-12 归一）：`cachedContentTokenCount` 是 `promptTokenCount` 的**子集**
 * （命中部分已含在输入里），必须扣出后单列，否则缓存部分会被按全价重复计一次。
 * `totalTokenCount` 保留协议原值。
 */
function mapUsage(metadata: unknown): ChatUsage | undefined {
  if (metadata === null || typeof metadata !== "object") return undefined;
  const record = metadata as Record<string, unknown>;
  const numeric = (key: string): number | undefined => {
    const value = record[key];
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : undefined;
  };
  const usage: ChatUsage = {};
  const prompt = numeric("promptTokenCount");
  const cached = numeric("cachedContentTokenCount");
  if (prompt !== undefined) {
    usage.prompt_tokens = cached === undefined ? prompt : Math.max(0, prompt - cached);
    if (cached !== undefined) usage.cached_tokens = Math.min(cached, prompt);
  }
  const completion = numeric("candidatesTokenCount");
  if (completion !== undefined) usage.completion_tokens = completion;
  const total = numeric("totalTokenCount");
  if (total !== undefined) usage.total_tokens = total;
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function joinCandidateParts(candidates: unknown): { text: string; finishReason?: string; blocked?: string } {
  if (!Array.isArray(candidates) || candidates.length === 0) return { text: "" };
  const first = candidates[0] as Record<string, unknown>;
  const content = first["content"] as Record<string, unknown> | undefined;
  const parts = content?.["parts"];
  const text = Array.isArray(parts)
    ? parts
        .map((part) =>
          part !== null && typeof part === "object" && typeof (part as Record<string, unknown>)["text"] === "string"
            ? ((part as Record<string, unknown>)["text"] as string)
            : "",
        )
        .join("")
    : "";
  return {
    text,
    ...(typeof first["finishReason"] === "string" ? { finishReason: first["finishReason"] as string } : {}),
  };
}

function blockedReason(body: Record<string, unknown>): string | undefined {
  const feedback = body["promptFeedback"];
  if (feedback === null || typeof feedback !== "object") return undefined;
  const reason = (feedback as Record<string, unknown>)["blockReason"];
  return typeof reason === "string" ? reason : undefined;
}

/** 非流式：GET 语义的 generateContent（POST 一次返回） */
export async function callGeminiGenerate(
  provider: LlmProviderSpec,
  request: ChatRequest,
  transport: TransportOptions,
): Promise<ChatResult> {
  const model = resolveModelSpec(provider, request.model);
  const url = `${provider.base_url}/models/${normalizeModelName(model.name)}:generateContent`;
  const response = await postJson(provider, url, headers(provider, transport), buildBody(provider, request), request.signal, transport);
  let json: unknown;
  try {
    json = await response.json();
  } catch (err) {
    throw new LlmError("E_LLM_RESPONSE", `provider「${provider.id}」响应不是合法 JSON`, { cause: err });
  }
  const record = json as Record<string, unknown>;
  const { text, finishReason } = joinCandidateParts(record["candidates"]);
  if (text === "") {
    const reason = blockedReason(record);
    if (reason) {
      throw new LlmError("E_LLM_RESPONSE", `provider「${provider.id}」请求被安全策略拦截（${reason}）`);
    }
  }
  const usage = mapUsage(record["usageMetadata"]);
  return {
    text,
    provider_id: provider.id,
    model: typeof record["modelVersion"] === "string" ? record["modelVersion"] : model.name,
    ...(finishReason ? { finish_reason: finishReason } : {}),
    ...(usage ? { usage } : {}),
    fallbacks: [],
    aborted: false,
  };
}

/** 流式：streamGenerateContent?alt=sse（逐块累积；abort 保留已生成文本） */
export async function callGeminiGenerateStream(
  provider: LlmProviderSpec,
  request: ChatRequest,
  callbacks: StreamCallbacks,
  transport: TransportOptions,
): Promise<ChatResult> {
  const model = resolveModelSpec(provider, request.model);
  const url = `${provider.base_url}/models/${normalizeModelName(model.name)}:streamGenerateContent?alt=sse`;
  const response = await postJson(provider, url, headers(provider, transport), buildBody(provider, request), request.signal, transport);

  let text = "";
  let index = 0;
  let finishReason: string | undefined;
  let usage: ChatUsage | undefined;
  try {
    await readSseStream(response, (data) => {
      let event: unknown;
      try {
        event = JSON.parse(data);
      } catch {
        return; // 容忍心跳 / 非 JSON 行
      }
      const record = event as Record<string, unknown>;
      const candidate = joinCandidateParts(record["candidates"]);
      if (candidate.text !== "") {
        text += candidate.text;
        callbacks.onDelta?.({ text: candidate.text, index });
        index += 1;
      }
      if (candidate.finishReason) finishReason = candidate.finishReason;
      const chunkUsage = mapUsage(record["usageMetadata"]);
      if (chunkUsage) usage = chunkUsage;
    });
  } catch (err) {
    if (isAbortError(err)) throw new LlmAbortError(text);
    if (err instanceof LlmError) throw err;
    throw new LlmError("E_LLM_NETWORK", `provider「${provider.id}」流式读取中断：${String(err)}`, {
      cause: err,
    });
  }

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