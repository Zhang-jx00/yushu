import { YushuError } from "@yushu/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { LLM_API_VERSION, LLM_FORMAT_VERSION, type LlmConfig, type LlmProviderSpec } from "./types.js";

/** LLM 配置与调用错误（code：E_LLM_CONFIG / E_LLM_NETWORK / E_LLM_HTTP / E_LLM_ABORTED） */
export class LlmError extends YushuError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
  }
}

/** 中止错误：携带已生成的部分文本（M1 的中止保留语义） */
export class LlmAbortError extends LlmError {
  readonly partial: string;

  constructor(partial: string, options?: ErrorOptions) {
    super("E_LLM_ABORTED", "生成已被用户中止", options);
    this.partial = partial;
  }
}

/** 默认配置：OpenAI 兼容主干 + 本地端点兜底（key 均不落盘） */
export function defaultLlmConfig(): LlmConfig {
  return {
    apiVersion: LLM_API_VERSION,
    format_version: LLM_FORMAT_VERSION,
    providers: [
      {
        id: "primary",
        kind: "openai-compatible",
        base_url: "https://api.openai.com/v1",
        model: "gpt-4o-mini",
        api_key_env: "YUSHU_LLM_API_KEY",
        temperature: 0.8,
        max_tokens: 2048,
        context_window: 128000,
      },
      {
        id: "local",
        kind: "openai-compatible",
        base_url: "http://127.0.0.1:11434/v1",
        model: "qwen3:14b",
        temperature: 0.8,
        max_tokens: 2048,
        context_window: 32768,
      },
    ],
  };
}

function assertProvider(raw: unknown, index: number): LlmProviderSpec {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LlmError("E_LLM_CONFIG", `providers[${index}] 应为映射`);
  }
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  const baseUrl = record["base_url"];
  const model = record["model"];
  if (typeof id !== "string" || id.trim() === "") {
    throw new LlmError("E_LLM_CONFIG", `providers[${index}].id 缺失`);
  }
  if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
    throw new LlmError("E_LLM_CONFIG", `providers[${index}].base_url 必须是 http(s) 地址`);
  }
  if (typeof model !== "string" || model.trim() === "") {
    throw new LlmError("E_LLM_CONFIG", `providers[${index}].model 缺失`);
  }
  const kind = record["kind"];
  if (kind !== undefined && kind !== "openai-compatible") {
    throw new LlmError("E_LLM_CONFIG", `providers[${index}].kind 暂仅支持 openai-compatible`);
  }
  return {
    id,
    kind: "openai-compatible",
    base_url: baseUrl.replace(/\/+$/, ""),
    model,
    ...(typeof record["api_key_env"] === "string" && record["api_key_env"] !== ""
      ? { api_key_env: record["api_key_env"] }
      : {}),
    ...(typeof record["temperature"] === "number" ? { temperature: record["temperature"] } : {}),
    ...(typeof record["max_tokens"] === "number" ? { max_tokens: record["max_tokens"] } : {}),
    ...(typeof record["context_window"] === "number"
      ? { context_window: record["context_window"] }
      : {}),
  };
}

/** 解析并校验 config/llm.yaml 文本（缺 providers 时给出明确错误） */
export function parseLlmConfig(text: string): LlmConfig {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new LlmError("E_LLM_CONFIG", "config/llm.yaml YAML 解析失败", { cause: err });
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new LlmError("E_LLM_CONFIG", "config/llm.yaml 内容非法（应为 YAML 映射）");
  }
  const record = data as Record<string, unknown>;
  if (record["apiVersion"] !== LLM_API_VERSION) {
    throw new LlmError(
      "E_LLM_CONFIG",
      `config/llm.yaml 的 apiVersion 必须为 ${LLM_API_VERSION}，实际为 ${String(record["apiVersion"])}`,
    );
  }
  const providersRaw = record["providers"];
  if (!Array.isArray(providersRaw) || providersRaw.length === 0) {
    throw new LlmError("E_LLM_CONFIG", "config/llm.yaml 缺少 providers（至少配置一个）");
  }
  const providers = providersRaw.map((item, index) => assertProvider(item, index));
  const ids = new Set(providers.map((provider) => provider.id));
  if (ids.size !== providers.length) {
    throw new LlmError("E_LLM_CONFIG", "providers[].id 重复（fallback 链禁止成环的前提是 ID 唯一）");
  }
  return {
    apiVersion: LLM_API_VERSION,
    format_version:
      typeof record["format_version"] === "number" ? record["format_version"] : LLM_FORMAT_VERSION,
    providers,
  };
}

export function serializeLlmConfig(config: LlmConfig): string {
  return stringifyYaml(config, { lineWidth: 0 });
}

/** 解析某 provider 的可用 key：会话内存 > 环境变量；均无则 undefined */
export function resolveApiKey(
  provider: LlmProviderSpec,
  options: { sessionKeys?: Record<string, string | undefined>; env?: Record<string, string | undefined> },
): string | undefined {
  const sessionKey = options.sessionKeys?.[provider.id];
  if (sessionKey && sessionKey.trim() !== "") return sessionKey.trim();
  if (provider.api_key_env) {
    const env = options.env ?? (globalThis.process?.env as Record<string, string | undefined> | undefined);
    const value = env?.[provider.api_key_env];
    if (value && value.trim() !== "") return value.trim();
  }
  return undefined;
}