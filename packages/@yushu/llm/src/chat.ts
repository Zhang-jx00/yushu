import { callProtocolChat } from "./dispatch.js";
import { LlmAbortError, LlmError } from "./config.js";
import { retryWithPolicy } from "./reliability.js";
import type { ChatRequest, ChatResult, LlmCallOptions, LlmProviderSpec } from "./types.js";

/**
 * chat 动词：非流式。按 providers 顺序逐个尝试（fallback 链）。
 * - T3-1：每次尝试按 provider.protocol 分发到对应协议适配器；
 * - T3-2：启用可靠性时——冷却中的 provider 直接跳过（记 fallback），单 provider 内按错误类别
 *   退避重试，并发额度在每次 HTTP 尝试层面获取/释放，成功清空冷却、失败计入熔断。
 * 全部失败时抛最后一个错误；中止透传 LlmAbortError。
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
    try {
      const run = async (): Promise<ChatResult> => {
        if (!reliability) return callProtocolChat(provider, request, { options, fetchImpl });
        const release = await reliability.gate.acquire(provider.id, reliability.config);
        try {
          return await callProtocolChat(provider, request, { options, fetchImpl });
        } finally {
          release();
        }
      };
      const outcome = reliability
        ? await retryWithPolicy(run, { config: reliability.config, signal: request.signal })
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
      // 仅当后面还有备选时才提示"降级切换"
      if (index < providers.length - 1) options.onFallback?.(info);
    }
  }

  if (!lastError && skippedByCooldown > 0) {
    throw new LlmError("E_LLM_COOLDOWN", "全部 provider 处于冷却中：请稍后重试（冷却随失败窗口自动恢复）");
  }
  throw lastError ?? new Error("无可用 provider");
}