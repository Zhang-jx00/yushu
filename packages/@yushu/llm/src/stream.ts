import { callChatCompletionStream } from "./openai.js";
import { LlmAbortError } from "./config.js";
import type {
  ChatRequest,
  ChatResult,
  LlmCallOptions,
  LlmProviderSpec,
  StreamCallbacks,
} from "./types.js";

/**
 * stream 动词：流式 + AbortController 停止。
 * - fallback 与 chat 一致，但**已经流出增量文本后不再切换 provider**（避免重复文本）；
 * - 中止时抛 LlmAbortError（携带已生成部分，由调用方决定是否保留为候选）。
 */
export async function stream(
  providers: LlmProviderSpec[],
  request: ChatRequest,
  callbacks: StreamCallbacks,
  options: LlmCallOptions,
): Promise<ChatResult> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch?.bind(globalThis);
  if (typeof fetchImpl !== "function") {
    throw new Error("当前环境没有 fetch：请注入 fetchImpl（Node ≥18 内置）");
  }

  const fallbacks: ChatResult["fallbacks"] = [];
  let lastError: Error | null = null;

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index]!;
    let emitted = false;
    const proxied: StreamCallbacks = {
      onDelta: (delta) => {
        emitted = true;
        callbacks.onDelta?.(delta);
      },
    };
    try {
      const result = await callChatCompletionStream(provider, request, proxied, {
        options,
        fetchImpl,
      });
      return { ...result, fallbacks };
    } catch (err) {
      if (err instanceof LlmAbortError) throw err;
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;
      const info = { provider_id: provider.id, reason: error.message };
      fallbacks.push(info);
      if (emitted) {
        // 已流出内容：切换 provider 会拼接出重复正文，直接失败交由用户重试
        throw error;
      }
      if (index < providers.length - 1) options.onFallback?.(info);
    }
  }

  throw lastError ?? new Error("无可用 provider");
}