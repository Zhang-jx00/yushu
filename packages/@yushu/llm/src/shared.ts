import { LlmAbortError, LlmError, resolveApiKey } from "./config.js";
import type { LlmCallOptions, LlmProviderSpec } from "./types.js";

/**
 * 协议适配器共享工具（T3-1）：三个协议（openai_chat / anthropic_messages / gemini_generate）
 * 在鉴权、错误归一与 SSE 读取上的公共部分收敛到本文件，避免各适配器语义漂移。
 */

export interface TransportOptions {
  options: LlmCallOptions;
  fetchImpl: typeof fetch;
}

export function isAbortError(err: unknown): boolean {
  return (
    err instanceof LlmAbortError ||
    (err instanceof Error && (err.name === "AbortError" || err.message.includes("aborted")))
  );
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 校验 key：声明了 api_key_env 但两处都没有 → 提前给出可操作的错误（而非等 401） */
export function requireApiKey(provider: LlmProviderSpec, options: LlmCallOptions): string | undefined {
  const key = resolveApiKey(provider, options);
  if (!key && provider.api_key_env) {
    throw new LlmError(
      "E_LLM_CONFIG",
      `provider「${provider.id}」未提供 API Key：请设置环境变量 ${provider.api_key_env}，或在 AI 副驾面板输入会话 Key（不落盘）`,
    );
  }
  return key;
}

/** 发起请求：网络错误归一为 E_LLM_NETWORK，中止归一为 LlmAbortError（partial 由调用方补） */
export async function postJson(
  provider: LlmProviderSpec,
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal | undefined,
  transport: TransportOptions,
): Promise<Response> {
  try {
    const response = await transport.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
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

/**
 * SSE 逐行读取：只处理 `data:` 行（容忍心跳 / 非 JSON 行由回调自行决定）。
 * 读取中断原样抛出（abort / 网络错误由调用方归一，因为需要拼接各自的部分文本）。
 */
export async function readSseStream(
  response: Response,
  onData: (data: string) => void,
): Promise<void> {
  if (!response.body) {
    throw new LlmError("E_LLM_RESPONSE", "响应无 body（不支持流式）");
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        onData(trimmed.slice(5).trim());
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** 拼接 system 消息；其余消息按角色合并相邻同角色（三个协议均要求/偏好交替角色） */
export function splitSystemAndTurns(messages: { role: string; content: string }[]): {
  system: string;
  turns: { role: "user" | "assistant"; content: string }[];
} {
  const systemParts: string[] = [];
  const turns: { role: "user" | "assistant"; content: string }[] = [];
  for (const message of messages) {
    if (message.role === "system") {
      if (message.content.trim() !== "") systemParts.push(message.content);
      continue;
    }
    const role = message.role === "assistant" ? "assistant" : "user";
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n\n${message.content}`;
    else turns.push({ role, content: message.content });
  }
  return { system: systemParts.join("\n\n"), turns };
}