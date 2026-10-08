import { YushuError } from "@yushu/core";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  LLM_API_VERSION,
  LLM_FORMAT_VERSION,
  resolveCapabilities,
  type LlmConfig,
  type LlmModelSpec,
  type LlmProtocol,
  type LlmProviderSpec,
  type ModelCacheCapability,
  type ModelCapabilities,
  type ModelLimits,
  type ModelPricing,
  type ModelTier,
  type ProviderKind,
} from "./types.js";

/** LLM 配置与调用错误（code：E_LLM_CONFIG / E_LLM_NETWORK / E_LLM_HTTP / E_LLM_ABORTED / E_LLM_ROUTE） */
export class LlmError extends YushuError {
  /** HTTP 状态码（仅 E_LLM_HTTP 携带；驱动重试分类与冷却记账，T3-2） */
  readonly httpStatus?: number;

  constructor(code: string, message: string, options?: ErrorOptions & { httpStatus?: number }) {
    super(code, message, options);
    this.httpStatus = options?.httpStatus;
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

const PROVIDER_KINDS: readonly ProviderKind[] = ["cloud", "local"];
const LLM_PROTOCOLS: readonly LlmProtocol[] = [
  "openai_chat",
  "anthropic_messages",
  "gemini_generate",
];
const MODEL_TIERS: readonly ModelTier[] = ["small", "flagship", "reasoning"];
const CAPABILITY_BOOLEAN_KEYS = [
  "tools",
  "structured_output",
  "stream",
  "usage",
  "reasoning",
  "vision",
  "batch",
] as const;
const LIMIT_KEYS = ["context", "max_output", "rpm", "tpm"] as const;
const PRICING_KEYS = ["currency", "input", "output", "cache_read", "cache_write"] as const;

/** 本机地址判定：迁移时用于推断 kind（cloud | local） */
export function isLocalBaseUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(url);
}

/** 默认配置：云端主干（能力矩阵齐全声明）+ 本地端点兜底（key 均不落盘） */
export function defaultLlmConfig(): LlmConfig {
  return {
    apiVersion: LLM_API_VERSION,
    format_version: LLM_FORMAT_VERSION,
    providers: [
      {
        id: "primary",
        kind: "cloud",
        protocol: "openai_chat",
        base_url: "https://api.openai.com/v1",
        models: [
          {
            name: "gpt-4o-mini",
            tier: "small",
            capabilities: {
              tools: true,
              structured_output: true,
              stream: true,
              usage: true,
              reasoning: false,
              vision: true,
              batch: true,
            },
            limits: { context: 128000, max_output: 16384 },
          },
        ],
        api_key_env: "YUSHU_LLM_API_KEY",
        temperature: 0.8,
        max_tokens: 2048,
      },
      {
        id: "local",
        kind: "local",
        protocol: "openai_chat",
        base_url: "http://127.0.0.1:11434/v1",
        models: [
          {
            name: "qwen3:14b",
            tier: "flagship",
            limits: { context: 32768, max_output: 8192 },
          },
        ],
        temperature: 0.8,
        max_tokens: 2048,
      },
    ],
  };
}

function fail(message: string): never {
  throw new LlmError("E_LLM_CONFIG", message);
}

function readOptionalString(
  record: Record<string, unknown>,
  key: string,
  label: string,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") fail(`${label} 应为字符串`);
  return value;
}

function readOptionalNumber(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} 应为有限数字`);
  return value;
}

function assertCapabilities(raw: unknown, label: string): Partial<ModelCapabilities> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${label} 应为映射`);
  }
  const record = raw as Record<string, unknown>;
  const capabilities: Partial<ModelCapabilities> = {};
  for (const key of CAPABILITY_BOOLEAN_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "boolean") fail(`${label}.${key} 应为布尔值`);
    capabilities[key] = value;
  }
  const cache = record["cache"];
  if (cache !== undefined && cache !== false) {
    // cache: false 等同未声明（无 prompt caching），不写字段
    if (cache === null || typeof cache !== "object" || Array.isArray(cache)) {
      fail(`${label}.cache 应为映射（mode / min_tokens / read_mult / write_mult）`);
    }
    const cacheRecord = cache as Record<string, unknown>;
    const mode = cacheRecord["mode"];
    if (mode !== "explicit" && mode !== "automatic") {
      fail(`${label}.cache.mode 必须为 explicit 或 automatic`);
    }
    const parsedCache: ModelCacheCapability = { mode };
    for (const key of ["min_tokens", "read_mult", "write_mult"] as const) {
      const value = cacheRecord[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(`${label}.cache.${key} 应为有限数字`);
      }
      parsedCache[key] = value;
    }
    capabilities.cache = parsedCache;
  }
  return capabilities;
}

function assertLimits(raw: unknown, label: string): ModelLimits | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${label} 应为映射（context / max_output / rpm / tpm）`);
  }
  const record = raw as Record<string, unknown>;
  const limits: ModelLimits = {};
  for (const key of LIMIT_KEYS) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      fail(`${label}.${key} 应为正数`);
    }
    limits[key] = value;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

/**
 * 定价解析（T3-12）：input / output 必填正数；cache_read / cache_write 允许 0（免费读）但不得为负；
 * 未知键一律拒绝——避免拼错的单价字段被静默忽略而算出错误金额（缺省不猜价的前提是键名严格）。
 */
function assertPricing(raw: unknown, label: string): ModelPricing | undefined {
  if (raw === undefined) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`${label} 应为映射（currency / input / output / cache_read / cache_write）`);
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(PRICING_KEYS as readonly string[]).includes(key)) {
      fail(`${label}.${key} 未知（pricing 仅支持 ${PRICING_KEYS.join(" / ")}）`);
    }
  }
  const readUnitPrice = (key: "input" | "output"): number => {
    const value = record[key];
    // 允许 0：本地端点是零成本路径（J09 实践 8），面板显示 ¥0 而不是「未配置价格」
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      fail(`${label}.${key} 应为非负数字（每 1M tokens 单价；本地端点填 0 表示零成本）`);
    }
    return value;
  };
  const pricing: ModelPricing = {
    input: readUnitPrice("input"),
    output: readUnitPrice("output"),
  };
  const currency = record["currency"];
  if (currency !== undefined) {
    if (typeof currency !== "string" || currency.trim() === "") {
      fail(`${label}.currency 应为非空字符串（ISO 币种码，如 CNY / USD）`);
    }
    pricing.currency = currency.trim().toUpperCase();
  }
  for (const key of ["cache_read", "cache_write"] as const) {
    const value = record[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      fail(`${label}.${key} 应为非负数字（每 1M tokens 单价）`);
    }
    pricing[key] = value;
  }
  return pricing;
}

function assertModel(raw: unknown, providerIndex: number, modelIndex: number): LlmModelSpec {
  const label = `providers[${providerIndex}].models[${modelIndex}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} 应为映射`);
  const record = raw as Record<string, unknown>;
  const name = record["name"];
  if (typeof name !== "string" || name.trim() === "") fail(`${label}.name 缺失`);
  const tierRaw = record["tier"] ?? "flagship";
  if (typeof tierRaw !== "string" || !MODEL_TIERS.includes(tierRaw as ModelTier)) {
    fail(`${label}.tier 必须为 ${MODEL_TIERS.join(" / ")}`);
  }
  const capabilities =
    record["capabilities"] === undefined
      ? undefined
      : assertCapabilities(record["capabilities"], `${label}.capabilities`);
  const limits = assertLimits(record["limits"], `${label}.limits`);
  const pricing = assertPricing(record["pricing"], `${label}.pricing`);
  return {
    name,
    tier: tierRaw as ModelTier,
    ...(capabilities && Object.keys(capabilities).length > 0 ? { capabilities } : {}),
    ...(limits ? { limits } : {}),
    ...(pricing ? { pricing } : {}),
  };
}

function assertProviderV2(raw: unknown, index: number): LlmProviderSpec {
  const label = `providers[${index}]`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} 应为映射`);
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  if (typeof id !== "string" || id.trim() === "") fail(`${label}.id 缺失`);
  const kind = record["kind"];
  if (typeof kind !== "string" || !PROVIDER_KINDS.includes(kind as ProviderKind)) {
    fail(`${label}.kind 必须为 cloud 或 local`);
  }
  const protocol = record["protocol"];
  if (typeof protocol !== "string" || !LLM_PROTOCOLS.includes(protocol as LlmProtocol)) {
    fail(`${label}.protocol 必须为 ${LLM_PROTOCOLS.join(" / ")}`);
  }
  const baseUrl = record["base_url"];
  if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
    fail(`${label}.base_url 必须是 http(s) 地址`);
  }
  const modelsRaw = record["models"];
  if (!Array.isArray(modelsRaw) || modelsRaw.length === 0) {
    fail(`${label}.models 缺失（至少声明一个模型，models[0] 为默认模型）`);
  }
  const models = modelsRaw.map((item, modelIndex) => assertModel(item, index, modelIndex));
  const names = new Set(models.map((model) => model.name));
  if (names.size !== models.length) fail(`${label}.models[].name 重复`);
  const apiKeyEnv = readOptionalString(record, "api_key_env", `${label}.api_key_env`);
  const temperature = readOptionalNumber(record, "temperature", `${label}.temperature`);
  const maxTokens = readOptionalNumber(record, "max_tokens", `${label}.max_tokens`);
  return {
    id,
    kind: kind as ProviderKind,
    protocol: protocol as LlmProtocol,
    base_url: baseUrl.replace(/\/+$/, ""),
    models,
    ...(apiKeyEnv && apiKeyEnv !== "" ? { api_key_env: apiKeyEnv } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(maxTokens !== undefined ? { max_tokens: maxTokens } : {}),
  };
}

function assertConfigV2(record: Record<string, unknown>): LlmConfig {
  const providersRaw = record["providers"];
  if (!Array.isArray(providersRaw) || providersRaw.length === 0) {
    fail("config/llm.yaml 缺少 providers（至少配置一个）");
  }
  const providers = providersRaw.map((item, index) => assertProviderV2(item, index));
  const ids = new Set(providers.map((provider) => provider.id));
  if (ids.size !== providers.length) {
    fail("providers[].id 重复（fallback 链禁止成环的前提是 ID 唯一）");
  }
  return { apiVersion: LLM_API_VERSION, format_version: LLM_FORMAT_VERSION, providers };
}

/** v1 单 provider 校验（迁移输入）：kind 仅允许缺省或 openai-compatible */
function assertProviderV1(raw: unknown, index: number): Record<string, unknown> {
  const label = `providers[${index}]（v1）`;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} 应为映射`);
  const record = raw as Record<string, unknown>;
  const id = record["id"];
  const baseUrl = record["base_url"];
  const model = record["model"];
  if (typeof id !== "string" || id.trim() === "") fail(`${label}.id 缺失`);
  if (typeof baseUrl !== "string" || !/^https?:\/\//.test(baseUrl)) {
    fail(`${label}.base_url 必须是 http(s) 地址`);
  }
  if (typeof model !== "string" || model.trim() === "") fail(`${label}.model 缺失`);
  const kind = record["kind"];
  if (kind !== undefined && kind !== "openai-compatible") {
    fail(`${label}.kind 仅支持 openai-compatible（v1）`);
  }
  return record;
}

/**
 * v1 → v2 迁移（幂等）：单 model 简表 → 能力矩阵。
 * - kind：按 base_url 推断（本机地址 → local，其余 → cloud）；
 * - protocol：v1 仅 OpenAI 兼容 → openai_chat；
 * - models[0]：name = v1 model；tier 默认 flagship；limits 承接 context_window / max_tokens；
 * - capabilities 不写字段（读取时合并保守默认，用户可显式声明）。
 */
export function migrateLlmConfigV1ToV2(record: Record<string, unknown>): Record<string, unknown> {
  const providersRaw = Array.isArray(record["providers"]) ? record["providers"] : [];
  const providers = providersRaw.map((item, index) => {
    const provider = assertProviderV1(item, index);
    const baseUrl = String(provider["base_url"]).replace(/\/+$/, "");
    const limits: Record<string, number> = {};
    const context = readOptionalNumber(provider, "context_window", `providers[${index}].context_window`);
    const maxTokens = readOptionalNumber(provider, "max_tokens", `providers[${index}].max_tokens`);
    if (context !== undefined) limits["context"] = context;
    if (maxTokens !== undefined) limits["max_output"] = maxTokens;
    return {
      id: provider["id"],
      kind: isLocalBaseUrl(baseUrl) ? "local" : "cloud",
      protocol: "openai_chat",
      base_url: baseUrl,
      models: [
        {
          name: provider["model"],
          tier: "flagship",
          ...(Object.keys(limits).length > 0 ? { limits } : {}),
        },
      ],
      ...(typeof provider["api_key_env"] === "string" && provider["api_key_env"] !== ""
        ? { api_key_env: provider["api_key_env"] }
        : {}),
      ...(typeof provider["temperature"] === "number" ? { temperature: provider["temperature"] } : {}),
      ...(typeof provider["max_tokens"] === "number" ? { max_tokens: provider["max_tokens"] } : {}),
    };
  });
  return {
    apiVersion: record["apiVersion"],
    format_version: LLM_FORMAT_VERSION,
    providers,
  };
}

/**
 * 探测配置文本的数据格式版本（迁移决策用；YAML 不可解析或缺失版本 → 0，由调用方决定备份策略）。
 * 只读探测，不校验内容合法性——合法性由 parseLlmConfig 保证。
 */
export function detectLlmConfigVersion(text: string): number {
  try {
    const data = parseYaml(text) as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data)) return 0;
    const version = (data as Record<string, unknown>)["format_version"];
    return typeof version === "number" ? version : 1;
  } catch {
    return 0;
  }
}

/**
 * 解析并校验 config/llm.yaml 文本（缺 providers 时给出明确错误）。
 * v1 文本按 migrateLlmConfigV1ToV2 迁移后返回 v2（幂等；不落盘——写回由保存路径显式完成）。
 */
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
  let record = data as Record<string, unknown>;
  if (record["apiVersion"] !== LLM_API_VERSION) {
    throw new LlmError(
      "E_LLM_CONFIG",
      `config/llm.yaml 的 apiVersion 必须为 ${LLM_API_VERSION}，实际为 ${String(record["apiVersion"])}`,
    );
  }
  const rawVersion = record["format_version"];
  const version = typeof rawVersion === "number" ? rawVersion : 1;
  if (version > LLM_FORMAT_VERSION) {
    throw new LlmError(
      "E_LLM_CONFIG",
      `config/llm.yaml 格式版本 ${version} 高于当前支持（${LLM_FORMAT_VERSION}）：请升级御书后再打开该项目`,
    );
  }
  if (version < LLM_FORMAT_VERSION) {
    record = migrateLlmConfigV1ToV2(record);
  }
  return assertConfigV2(record);
}

export function serializeLlmConfig(config: LlmConfig): string {
  return stringifyYaml(config, { lineWidth: 0 });
}

/** 配置体检（非阻断提示；Provider 管理页与迁移提示用，T3-1） */
export interface LlmConfigWarning {
  provider_id: string;
  model?: string;
  message: string;
}

export function lintLlmConfig(config: LlmConfig): LlmConfigWarning[] {
  const warnings: LlmConfigWarning[] = [];
  for (const provider of config.providers) {
    const unpriced: string[] = [];
    if (provider.kind === "cloud" && isLocalBaseUrl(provider.base_url)) {
      warnings.push({
        provider_id: provider.id,
        message: "声明为 cloud 但 base_url 指向本机地址（建议改为 local，避免凭据出网误判）",
      });
    }
    if (provider.kind === "local" && !isLocalBaseUrl(provider.base_url)) {
      warnings.push({
        provider_id: provider.id,
        message: "声明为 local 但 base_url 并非本机地址（本地隐私模式提示将不覆盖该端点）",
      });
    }
    for (const model of provider.models) {
      if (model.capabilities === undefined) {
        warnings.push({
          provider_id: provider.id,
          model: model.name,
          message: "未声明 capabilities：按保守默认处理（tools / structured_output / reasoning / vision / batch 视为不支持）",
        });
      }
      if (model.limits?.context === undefined) {
        warnings.push({
          provider_id: provider.id,
          model: model.name,
          message: "未声明 limits.context：上下文预算裁剪将退回默认窗口",
        });
      }
      if (model.tier === "reasoning" && !resolveCapabilities(model).reasoning) {
        warnings.push({
          provider_id: provider.id,
          model: model.name,
          message: "tier 为 reasoning 但未声明 reasoning 能力：任务路由可能选不中（T3-2）",
        });
      }
      // T3-12（J09）：缺省不猜价。按 provider 聚合成一条，避免逐模型刷屏「标注」区
      if (model.pricing === undefined) unpriced.push(model.name);
    }
    if (unpriced.length > 0) {
      warnings.push({
        provider_id: provider.id,
        message: `未配置价格（pricing）的模型：${unpriced.join("、")}——成本面板只报 token 不折算金额（按官方价格页补 input / output 单价）`,
      });
    }
  }
  return warnings;
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