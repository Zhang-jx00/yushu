import { callProtocolStream } from "./dispatch.js";
import { LlmAbortError, LlmError } from "./config.js";
import { retryWithPolicy } from "./reliability.js";
import type {
  ChatRequest,
  ChatResult,
  LlmCallOptions,
  LlmProviderSpec,
  StreamCallbacks,
} from "./types.js";

/**
 * stream 动词：流式 + AbortController 停止。
 * - fallback 与 chat 一致，但**已经流出增量文本后不再切换 / 重试**（避免重复文本）；
 * - 中止时抛 LlmAbortError（携带已生成部分，由调用方决定是否保留为候选）；
 * - T3-1：按 provider.protocol 分发；T3-2：冷却跳过 / 退避重试 / 并发额度 / 熔断记账。
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

  const reliability = options.reliability;
  const fallbacks: ChatResult["fallbacks"] = [];
  let lastError: Error | null = null;
  let skippedByCooldown = 0;

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index]!;
    if (reliability) {
      const remaining = reliability.gate.coolingRemaining(provider.id, reliability.config);
      if (remaining > 0) {
        skippedByCooldown += 1;
        const info = {
          provider_id: provider.id,
          reason: `冷却中（剩余 ${Math.ceil(remaining / 1000)}s）：窗口内失败达到阈值`,
        };
        fallbacks.push(info);
        if (index < providers.length - 1) options.onFallback?.(info);
        continue;
      }
    }
    let emitted = false;
    const proxied: StreamCallbacks = {
      onDelta: (delta) => {
        emitted = true;
        callbacks.onDelta?.(delta);
      },
    };
    try {
      const run = async (): Promise<ChatResult> => {
        if (!reliability) return callProtocolStream(provider, request, proxied, { options, fetchImpl });
        const release = await reliability.gate.acquire(provider.id, reliability.config);
        try {
          return await callProtocolStream(provider, request, proxied, { options, fetchImpl });
        } finally {
          release();
        }
      };
      const outcome = reliability
        ? await retryWithPolicy(run, {
            config: reliability.config,
            signal: request.signal,
            // 已流出内容：重试会拼接重复正文，直接失败交由用户重试
            retryGuard: () => emitted,
          })
        : { result: await run(), retries: 0 };
      reliability?.gate.recordSuccess(provider.id);
      return { ...outcome.result, fallbacks, retries: outcome.retries };
    } catch (err) {
      if (err instanceof LlmAbortError) throw err;
      const error = err instanceof Error ? err : new Error(String(err));
      lastError = error;
      reliability?.gate.recordFailure(provider.id, reliability.config);
      const info = { provider_id: provider.id, reason: error.message };
      fallbacks.push(info);
      if (emitted) {
        // 已流出内容：切换 provider 会拼接出重复正文，直接失败交由用户重试
        throw error;
      }
      if (index < providers.length - 1) options.onFallback?.(info);
    }
  }

  if (!lastError && skippedByCooldown > 0) {
    throw new LlmError("E_LLM_COOLDOWN", "全部 provider 处于冷却中：请稍后重试（冷却随失败窗口自动恢复）");
  }
  throw lastError ?? new Error("无可用 provider");
}