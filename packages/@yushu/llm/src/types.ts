/**
 * LLM 接入的跨包类型（docs/03 §9 / J01）。
 *
 * v2（M3 / T3-1）：Provider 描述升级为「kind + protocol + models（能力矩阵 + limits）」——
 * 云 / 本地同抽象，能力声明驱动请求前校验与自动降级（T3-3），limits 驱动预算裁剪（T3-7）与
 * 请求参数上限。v1 简表（单 model + openai-compatible）由 config.ts 自动迁移（幂等）。
 */

import type { ReliabilityConfig } from "./routing.js";
import type { ReliabilityGate } from "./reliability.js";

export const LLM_API_VERSION = "yushu.llm/v1" as const;
/** 配置数据格式版本：1 = M1 单 model 简表；2 = M3 Provider 能力矩阵 */
export const LLM_FORMAT_VERSION = 2;

export type ProviderKind = "cloud" | "local";

/** 协议（docs/03 §9：OpenAI 兼容为事实标准主干；Anthropic / Gemini 原生适配） */
export type LlmProtocol = "openai_chat" | "anthropic_messages" | "gemini_generate";

/** 模型档位（任务路由按档位偏好选择；T3-2） */
export type ModelTier = "small" | "flagship" | "reasoning";

/** prompt caching 能力描述（docs/03 §9） */
export interface ModelCacheCapability {
  mode: "explicit" | "automatic";
  min_tokens?: number;
  read_mult?: number;
  write_mult?: number;
}

/**
 * 能力矩阵（驱动请求前校验与自动降级；`cache` 未声明 = 不支持）。
 * 声明为 false / 缺省即视为不支持——「未声明不得假定支持」。
 */
export interface ModelCapabilities {
  tools: boolean;
  structured_output: boolean;
  stream: boolean;
  usage: boolean;
  reasoning: boolean;
  vision: boolean;
  /** 未声明 = 无 prompt caching */
  cache?: ModelCacheCapability;
  batch: boolean;
}

/**
 * 保守默认（T3-1）：可流式、可回传 usage 是 OpenAI 兼容端点的普遍能力；
 * tools / structured_output / reasoning / vision / batch 一律默认 false——降级路径（T3-3）据此判断。
 */
export const DEFAULT_MODEL_CAPABILITIES: Readonly<ModelCapabilities> = Object.freeze({
  tools: false,
  structured_output: false,
  stream: true,
  usage: true,
  reasoning: false,
  vision: false,
  batch: false,
});

/** 模型限额（docs/03 §9）：context / max_output 驱动预算与请求上限；rpm / tpm 为可靠性节流预留（T3-2） */
export interface ModelLimits {
  context?: number;
  max_output?: number;
  rpm?: number;
  tpm?: number;
}

/**
 * 模型定价（T3-12，J09 §5）：**单价按每 1M tokens 计**（对齐各官方价格页的 per_mtok 口径）。
 * - 缺省即「未配置价格」——成本一律返回 null，UI 如实标注，**绝不按市场价猜**；
 * - `cache_read` / `cache_write` 缺省时与 `input` 同价（即声明了价格但未声明缓存折扣 → 不打折）；
 * - `currency` 缺省 CNY；多币种记录禁止强行合计（见 summarizeCosts）。
 */
export interface ModelPricing {
  currency?: string;
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

export interface LlmModelSpec {
  name: string;
  tier: ModelTier;
  /** 部分声明；读取时经 resolveCapabilities 合并保守默认 */
  capabilities?: Partial<ModelCapabilities>;
  limits?: ModelLimits;
  /** 成本面板的计价来源（T3-12）；未配置 = 不核算金额 */
  pricing?: ModelPricing;
}

/** Provider 描述（config/llm.yaml；providers 顺序即 fallback 优先级） */
export interface LlmProviderSpec {
  id: string;
  kind: ProviderKind;
  protocol: LlmProtocol;
  /** 协议端点前缀（不含具体路径）：如 https://api.openai.com/v1、http://127.0.0.1:11434/v1 */
  base_url: string;
  /** ≥1 个模型；models[0] 为该 provider 的默认模型（fallback 落入时使用） */
  models: LlmModelSpec[];
  /**
   * 读取 API Key 的环境变量名。
   * 安全红线（docs/03 §13）：配置/日志/项目文件禁止明文 key；空或缺省 = 无鉴权（本地端点常见）。
   * safeStorage 加密引用（key_ref）见 T3-14。
   */
  api_key_env?: string;
  temperature?: number;
  max_tokens?: number;
}

/** config/llm.yaml 根（providers 顺序即 fallback 优先级） */
export interface LlmConfig {
  apiVersion: typeof LLM_API_VERSION;
  format_version: number;
  providers: LlmProviderSpec[];
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** 以下均可覆盖 provider 默认值 */
  model?: string;
  temperature?: number;
  max_tokens?: number;
  /** AbortController.signal：中止时抛 LlmAbortError（携带已生成部分） */
  signal?: AbortSignal;
}

/**
 * 用量回报（计费核对的唯一实报来源，T3-12）。
 *
 * **跨协议归一口径**（各协议的缓存语义不一致，适配器负责收敛，见 openai/anthropic/gemini.ts）：
 * - `prompt_tokens` = **未命中缓存的常规输入**（OpenAI / Gemini 的命中数是 prompt 的子集，已扣出；
 *   Anthropic 的 input_tokens 本就与缓存读写互斥）；
 * - `cached_tokens` / `cache_write_tokens` 单列，三者互不重叠；
 * - `total_tokens` = 上述四项之和（协议给了原值时以原值为准）。
 * 归一的目的：成本折算 `prompt×input + cached×cache_read + cache_write×cache_write价 + completion×output`
 * 不重复计价——这是 A3「预估 vs 实付偏差可核对」的前提。
 */
export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** 命中 prompt caching 的输入 token（单列，不含在 prompt_tokens 内） */
  cached_tokens?: number;
  /** 写入缓存的输入 token（Anthropic cache_creation；无此概念的协议不填） */
  cache_write_tokens?: number;
}

export interface LlmFallbackInfo {
  provider_id: string;
  reason: string;
}

export interface ChatResult {
  text: string;
  provider_id: string;
  model: string;
  finish_reason?: string;
  usage?: ChatUsage;
  /** 被跳过的主 provider 记录（M3 可靠性面板用） */
  fallbacks: LlmFallbackInfo[];
  /** 是否被 AbortController 中止（中止时保留已生成部分） */
  aborted: boolean;
  /** 本次调用内成功前额外重试的次数（T3-2；未启用可靠性时为 0） */
  retries?: number;
}

export interface StreamCallbacks {
  /** 每收到一个增量文本块回调（index 从 0 递增） */
  onDelta?: (delta: { text: string; index: number }) => void;
}

export interface LlmCallOptions {
  /** provider.id → 会话内存 key（优先级高于环境变量；不落盘） */
  sessionKeys?: Record<string, string | undefined>;
  /** 环境变量来源（默认 process.env；测试可注入） */
  env?: Record<string, string | undefined>;
  /** fetch 实现（默认全局 fetch；测试注入或本地 mock） */
  fetchImpl?: typeof fetch;
  /** provider 切换（fallback）时回调，便于 UI 提示 */
  onFallback?: (info: LlmFallbackInfo) => void;
  /**
   * 可靠性（T3-2）：重试（按错误类别）/ 冷却熔断 / 并发限制。
   * gate 为跨调用共享的状态（冷却与并发计数），config 为本次调用的配置。
   */
  reliability?: { config: ReliabilityConfig; gate: ReliabilityGate };
}

/**
 * 解析本次请求实际使用的模型：优先请求指定的模型名，未命中回落到 provider 默认模型（models[0]）。
 * 语义说明：`request.model` 是「模型名偏好」——fallback 到不同 provider 时，对方的默认模型即目标
 * （跨 provider 的模型名大概率不同，不能作为硬筛选）。
 */
export function resolveModelSpec(provider: LlmProviderSpec, requestedName?: string): LlmModelSpec {
  if (requestedName) {
    const hit = provider.models.find((model) => model.name === requestedName);
    if (hit) return hit;
  }
  return provider.models[0]!;
}

/** 合并保守默认后的完整能力矩阵（T3-1：未声明不得假定支持） */
export function resolveCapabilities(model: LlmModelSpec): ModelCapabilities {
  const declared = model.capabilities ?? {};
  return {
    ...DEFAULT_MODEL_CAPABILITIES,
    ...declared,
    ...(declared.cache ? { cache: declared.cache } : {}),
  };
}

/** 单项能力查询（cache 为对象能力，声明即视为支持） */
export function hasCapability(model: LlmModelSpec, key: keyof ModelCapabilities): boolean {
  return Boolean(resolveCapabilities(model)[key]);
}

/**
 * 请求级 max_tokens：请求参数 ?? provider 默认 ?? 模型上限兜底，且不超过模型 max_output。
 * 返回 undefined 表示不显式下发（由服务端默认决定）。
 */
export function effectiveMaxTokens(
  provider: LlmProviderSpec,
  model: LlmModelSpec,
  requested?: number,
): number | undefined {
  const base = requested ?? provider.max_tokens ?? model.limits?.max_output;
  if (base === undefined) return undefined;
  const cap = model.limits?.max_output;
  const value = cap !== undefined ? Math.min(base, cap) : base;
  return Math.max(1, Math.floor(value));
}