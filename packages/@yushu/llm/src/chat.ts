import { callProtocolChat } from "./dispatch.js";
import { LlmAbortError } from "./config.js";
import type { ChatRequest, ChatResult, LlmCallOptions, LlmProviderSpec } from "./types.js";

/**
 * chat 动词：非流式。按 providers 顺序逐个尝试（fallback 链）。
 * 全部失败时抛最后一个错误；中止透传 LlmAbortError。
 * T3-1：每次尝试按 provider.protocol 分发到对应协议适配器。
 */
export async function chat(
  providers: LlmProviderSpec[],
  request: ChatRequest,
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
    try {
      const result = await callProtocolChat(provider, request, { options, fetchImpl });
      return { ...result, fallbacks };
    } catch (err) {
      if (err instanceof LlmAbortError) throw err;
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;
      const info = { provider_id: provider.id, reason: error.message };
      fallbacks.push(info);
      // 仅当后面还有备选时才提示"降级切换"
      if (index < providers.length - 1) options.onFallback?.(info);
    }
  }

  throw lastError ?? new Error("无可用 provider");
}