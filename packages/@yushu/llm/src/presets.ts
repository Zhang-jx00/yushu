import type { LlmProviderSpec } from "./types.js";

/**
 * 本地模型接入预设（T3-4，J10）：Ollama / LM Studio / llama.cpp / vLLM 均为 OpenAI 兼容端点——
 * 同一 openai_chat 抽象，仅 base_url / 默认模型不同。本地 provider 一律 `kind: local`（隐私模式：
 * 请求不出本机），能力声明走保守默认（stream / usage 支持，其余视为不支持，用户可显式覆盖）。
 */

export interface LocalProviderPreset {
  id: string;
  label: string;
  /** 默认端点（OpenAI 兼容前缀） */
  base_url: string;
  /** 默认模型名（占位：本地模型名以用户实际拉取的为准） */
  default_model: string;
  /** 能力差异说明（UI 标注用） */
  note: string;
}

export const LOCAL_PROVIDER_PRESETS: readonly LocalProviderPreset[] = Object.freeze([
  {
    id: "ollama",
    label: "Ollama",
    base_url: "http://127.0.0.1:11434/v1",
    default_model: "qwen3:14b",
    note: "本地推理：请求不出本机；能力以实际拉取模型为准（默认声明流式 / usage，其余视为不支持）",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    base_url: "http://127.0.0.1:1234/v1",
    default_model: "local-model",
    note: "本地推理：请求不出本机；能力以实际加载模型为准（默认声明流式 / usage，其余视为不支持）",
  },
  {
    id: "llamacpp",
    label: "llama.cpp",
    base_url: "http://127.0.0.1:8080/v1",
    default_model: "local-model",
    note: "本地推理：请求不出本机；llama.cpp server 的 OpenAI 兼容层能力较基础（默认声明流式 / usage）",
  },
  {
    id: "vllm",
    label: "vLLM",
    base_url: "http://127.0.0.1:8000/v1",
    default_model: "local-model",
    note: "本地推理：请求不出本机；vLLM 通常兼容较好（可按实际部署显式声明能力）",
  },
]);

export interface CreateLocalProviderOptions {
  /** 覆盖 provider id（默认取 preset id；重复时由调用方负责改名） */
  id?: string;
  /** 覆盖模型名 */
  model?: string;
  /** 覆盖端点 */
  base_url?: string;
  /** 覆盖档位（默认 flagship：本地模型多用于兜底，参与 drafting 的旗舰偏好） */
  tier?: "small" | "flagship" | "reasoning";
}

/** 由预设构造 v2 provider（本地 / openai_chat / 保守能力 + 常用 limits） */
export function createLocalProvider(
  presetId: string,
  options: CreateLocalProviderOptions = {},
): LlmProviderSpec {
  const preset = LOCAL_PROVIDER_PRESETS.find((item) => item.id === presetId);
  if (!preset) {
    throw new Error(`未知本地预设：${presetId}（可选：${LOCAL_PROVIDER_PRESETS.map((item) => item.id).join(" / ")}）`);
  }
  return {
    id: options.id ?? preset.id,
    kind: "local",
    protocol: "openai_chat",
    base_url: options.base_url ?? preset.base_url,
    models: [
      {
        name: options.model ?? preset.default_model,
        tier: options.tier ?? "flagship",
        limits: { context: 32768, max_output: 4096 },
      },
    ],
  };
}