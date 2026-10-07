import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { LlmError } from "./config.js";
import { hasCapability, type LlmProviderSpec, type ModelTier } from "./types.js";

/**
 * 任务路由与可靠性配置（docs/03 §9；T3-2）：
 * - `routes`：任务 → 模型档位偏好（prefer）与能力要求（require）；
 * - `fallback`：任务 → provider id 链（顺序即优先级；**禁止成环**——重复 id / 未知 id 直接报错）；
 * - `reliability`：重试（按错误类别）、冷却（熔断）、并发限制。
 * 配置缺省内置（defaultRoutingConfig）；`config/routing.yaml` 存在时以其为准。
 */

export const ROUTING_API_VERSION = "yushu.llm/v1" as const;
export const ROUTING_FORMAT_VERSION = 1;

/** 能力键（与 ModelCapabilities 一致；require 用） */
export type CapabilityKey =
  | "tools"
  | "structured_output"
  | "stream"
  | "usage"
  | "reasoning"
  | "vision"
  | "cache"
  | "batch";

const CAPABILITY_KEYS: readonly CapabilityKey[] = [
  "tools",
  "structured_output",
  "stream",
  "usage",
  "reasoning",
  "vision",
  "cache",
  "batch",
];

const TIERS: readonly ModelTier[] = ["small", "flagship", "reasoning"];
const FAILURE_KINDS = ["RateLimitError", "InternalServerError", "NetworkError"] as const;
export type FailureKindName = (typeof FAILURE_KINDS)[number];

export interface TaskRoute {
  /** 档位偏好（按序取第一个命中的档位） */
  prefer?: ModelTier[];
  /** 能力要求（未满足时由 T3-3 走「提示词约束 + JSON 后校验」降级，不直接报错） */
  require?: CapabilityKey[];
}

export interface RetryRule {
  max_retries: number;
  /** 退避方式：exp = 指数（base × 2^n，上限 max_delay_ms±抖动）；fixed = 固定间隔 */
  backoff: "exp" | "fixed";
  base_delay_ms: number;
  max_delay_ms: number;
}

export interface ReliabilityConfig {
  /** 全局兜底重试次数（错误类别未在 retry_policy 声明时使用） */
  num_retries: number;
  retry_policy: Record<FailureKindName, RetryRule>;
  cooldown: { allowed_fails: number; window_s: number; cooldown_s: number };
  concurrency: { global: number; per_provider: Record<string, number> };
}

export interface RoutingConfig {
  apiVersion: typeof ROUTING_API_VERSION;
  format_version: number;
  routes: Record<string, TaskRoute>;
  fallback: Record<string, string[]>;
  reliability: ReliabilityConfig;
}

/** 内置默认路由（docs/03 §9：outline/naming/polish → small、drafting → flagship(require stream)、review → reasoning；summarize 为 T3-5 记忆摘要——压缩类任务走小模型；extract 为 T3-10 设定抽取——便宜档 + 结构化输出，未满足走 T3-3 降级） */
export const DEFAULT_TASK_ROUTES: Readonly<Record<string, TaskRoute>> = Object.freeze({
  outline: { prefer: ["small"], require: ["structured_output"] },
  naming: { prefer: ["small"] },
  polish: { prefer: ["small"] },
  drafting: { prefer: ["flagship"], require: ["stream"] },
  review: { prefer: ["reasoning"] },
  summarize: { prefer: ["small"] },
  extract: { prefer: ["small"], require: ["structured_output"] },
});

export function defaultRoutingConfig(): RoutingConfig {
  return {
    apiVersion: ROUTING_API_VERSION,
    format_version: ROUTING_FORMAT_VERSION,
    routes: Object.fromEntries(
      Object.entries(DEFAULT_TASK_ROUTES).map(([task, route]) => [
        task,
        {
          ...(route.prefer ? { prefer: [...route.prefer] } : {}),
          ...(route.require ? { require: [...route.require] } : {}),
        },
      ]),
    ),
    fallback: {},
    reliability: {
      num_retries: 3,
      retry_policy: {
        RateLimitError: { max_retries: 5, backoff: "exp", base_delay_ms: 500, max_delay_ms: 8000 },
        InternalServerError: { max_retries: 3, backoff: "exp", base_delay_ms: 500, max_delay_ms: 8000 },
        NetworkError: { max_retries: 3, backoff: "exp", base_delay_ms: 500, max_delay_ms: 8000 },
      },
      cooldown: { allowed_fails: 3, window_s: 60, cooldown_s: 30 },
      concurrency: { global: 4, per_provider: {} },
    },
  };
}

function fail(message: string): never {
  throw new LlmError("E_LLM_ROUTE", message);
}

function assertTaskRoute(raw: unknown, task: string): TaskRoute {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    fail(`routes.${task} 应为映射（prefer / require）`);
  }
  const record = raw as Record<string, unknown>;
  const route: TaskRoute = {};
  const prefer = record["prefer"];
  if (prefer !== undefined) {
    if (!Array.isArray(prefer) || prefer.some((tier) => typeof tier !== "string" || !TIERS.includes(tier as ModelTier))) {
      fail(`routes.${task}.prefer 应为档位数组（${TIERS.join(" / ")}）`);
    }
    route.prefer = prefer as ModelTier[];
  }
  const require = record["require"];
  if (require !== undefined) {
    if (
      !Array.isArray(require) ||
      require.some((key) => typeof key !== "string" || !CAPABILITY_KEYS.includes(key as CapabilityKey))
    ) {
      fail(`routes.${task}.require 应为能力数组（${CAPABILITY_KEYS.join(" / ")}）`);
    }
    route.require = require as CapabilityKey[];
  }
  return route;
}

function assertRetryRule(raw: unknown, label: string): RetryRule {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail(`${label} 应为映射`);
  const record = raw as Record<string, unknown>;
  const maxRetries = record["max_retries"];
  if (typeof maxRetries !== "number" || !Number.isInteger(maxRetries) || maxRetries < 0) {
    fail(`${label}.max_retries 应为非负整数`);
  }
  const backoff = record["backoff"] ?? "exp";
  if (backoff !== "exp" && backoff !== "fixed") fail(`${label}.backoff 必须为 exp 或 fixed`);
  const readPositive = (key: string, fallbackValue: number): number => {
    const value = record[key];
    if (value === undefined) return fallbackValue;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      fail(`${label}.${key} 应为正数`);
    }
    return value;
  };
  return {
    max_retries: maxRetries,
    backoff,
    base_delay_ms: readPositive("base_delay_ms", 500),
    max_delay_ms: readPositive("max_delay_ms", 8000),
  };
}

function assertReliability(raw: unknown): ReliabilityConfig {
  const defaults = defaultRoutingConfig().reliability;
  if (raw === undefined) return defaults;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) fail("reliability 应为映射");
  const record = raw as Record<string, unknown>;
  const numRetries = record["num_retries"] ?? defaults.num_retries;
  if (typeof numRetries !== "number" || !Number.isInteger(numRetries) || numRetries < 0) {
    fail("reliability.num_retries 应为非负整数");
  }
  const policyRaw = record["retry_policy"];
  const retryPolicy = { ...defaults.retry_policy };
  if (policyRaw !== undefined) {
    if (policyRaw === null || typeof policyRaw !== "object" || Array.isArray(policyRaw)) {
      fail("reliability.retry_policy 应为映射");
    }
    for (const kind of FAILURE_KINDS) {
      const rule = (policyRaw as Record<string, unknown>)[kind];
      if (rule !== undefined) retryPolicy[kind] = assertRetryRule(rule, `reliability.retry_policy.${kind}`);
    }
  }
  const cooldownRaw = record["cooldown"];
  const cooldown = { ...defaults.cooldown };
  if (cooldownRaw !== undefined) {
    if (cooldownRaw === null || typeof cooldownRaw !== "object" || Array.isArray(cooldownRaw)) {
      fail("reliability.cooldown 应为映射");
    }
    const cooldownRecord = cooldownRaw as Record<string, unknown>;
    for (const key of ["allowed_fails", "window_s", "cooldown_s"] as const) {
      const value = cooldownRecord[key];
      if (value === undefined) continue;
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        fail(`reliability.cooldown.${key} 应为正数`);
      }
      cooldown[key] = value;
    }
  }
  const concurrencyRaw = record["concurrency"];
  const concurrency = { global: defaults.concurrency.global, per_provider: { ...defaults.concurrency.per_provider } };
  if (concurrencyRaw !== undefined) {
    if (concurrencyRaw === null || typeof concurrencyRaw !== "object" || Array.isArray(concurrencyRaw)) {
      fail("reliability.concurrency 应为映射");
    }
    const concurrencyRecord = concurrencyRaw as Record<string, unknown>;
    const global = concurrencyRecord["global"];
    if (global !== undefined) {
      if (typeof global !== "number" || !Number.isInteger(global) || global < 1) {
        fail("reliability.concurrency.global 应为正整数");
      }
      concurrency.global = global;
    }
    const perProvider = concurrencyRecord["per_provider"];
    if (perProvider !== undefined) {
      if (
        perProvider === null ||
        typeof perProvider !== "object" ||
        Array.isArray(perProvider)
      ) {
        fail("reliability.concurrency.per_provider 应为 provider id → 正整数 的映射");
      }
      for (const [providerId, value] of Object.entries(perProvider as Record<string, unknown>)) {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
          fail(`reliability.concurrency.per_provider.${providerId} 应为正整数`);
        }
        concurrency.per_provider[providerId] = value;
      }
    }
  }
  return { num_retries: numRetries, retry_policy: retryPolicy, cooldown, concurrency };
}

/** 解析并校验 config/routing.yaml（缺省字段回落内置默认） */
export function parseRoutingConfig(text: string): RoutingConfig {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new LlmError("E_LLM_ROUTE", "config/routing.yaml YAML 解析失败", { cause: err });
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new LlmError("E_LLM_ROUTE", "config/routing.yaml 内容非法（应为 YAML 映射）");
  }
  const record = data as Record<string, unknown>;
  if (record["apiVersion"] !== ROUTING_API_VERSION) {
    throw new LlmError(
      "E_LLM_ROUTE",
      `config/routing.yaml 的 apiVersion 必须为 ${ROUTING_API_VERSION}，实际为 ${String(record["apiVersion"])}`,
    );
  }
  const defaults = defaultRoutingConfig();
  const routes: Record<string, TaskRoute> = {};
  const routesRaw = record["routes"];
  if (routesRaw !== undefined) {
    if (routesRaw === null || typeof routesRaw !== "object" || Array.isArray(routesRaw)) {
      fail("routes 应为映射");
    }
    for (const [task, route] of Object.entries(routesRaw as Record<string, unknown>)) {
      routes[task] = assertTaskRoute(route, task);
    }
  }
  const fallback: Record<string, string[]> = {};
  const fallbackRaw = record["fallback"];
  if (fallbackRaw !== undefined) {
    if (fallbackRaw === null || typeof fallbackRaw !== "object" || Array.isArray(fallbackRaw)) {
      fail("fallback 应为映射（任务 → provider id 链）");
    }
    for (const [task, chain] of Object.entries(fallbackRaw as Record<string, unknown>)) {
      if (!Array.isArray(chain) || chain.some((item) => typeof item !== "string" || item.trim() === "")) {
        fail(`fallback.${task} 应为 provider id 数组`);
      }
      const ids = chain as string[];
      const unique = new Set(ids);
      if (unique.size !== ids.length) {
        fail(`fallback.${task} 链存在重复 provider（fallback 链禁止成环）`);
      }
      fallback[task] = ids;
    }
  }
  return {
    apiVersion: ROUTING_API_VERSION,
    format_version: typeof record["format_version"] === "number" ? record["format_version"] : ROUTING_FORMAT_VERSION,
    routes: Object.keys(routes).length > 0 ? routes : defaults.routes,
    fallback,
    reliability: assertReliability(record["reliability"]),
  };
}

export function serializeRoutingConfig(config: RoutingConfig): string {
  return stringifyYaml(config, { lineWidth: 0 });
}

export interface RouteCandidate {
  provider_id: string;
  model: string;
  tier: ModelTier;
  /** 该候选缺失的 require 能力（空数组 = 满足要求） */
  missing: CapabilityKey[];
}

export interface ResolvedRoute {
  task: string;
  candidates: RouteCandidate[];
  /** 首选候选缺失的 require 能力（T3-3 据此走「提示词约束 + JSON 后校验」降级并提示用户） */
  unmet: CapabilityKey[];
}

/**
 * 解析任务路由（T3-2）：
 * - provider 顺序：fallback[task] 链（未声明则用 providers 原顺序）；
 * - 模型选择：按 prefer 档位顺序取第一个命中的模型；无命中回落该 provider 默认模型（models[0]）；
 * - require 不满足不报错（降级由 T3-3 处理），仅在候选上标出 missing / 路由级 unmet。
 */
export function resolveRoute(
  task: string,
  providers: LlmProviderSpec[],
  routing: RoutingConfig,
): ResolvedRoute {
  if (providers.length === 0) fail(`任务「${task}」路由失败：无可用 provider`);
  const chain = routing.fallback[task];
  let chainProviders: LlmProviderSpec[];
  if (chain) {
    const seen = new Set<string>();
    chainProviders = chain.map((id) => {
      if (seen.has(id)) fail(`fallback.${task} 链存在重复 provider「${id}」（fallback 链禁止成环）`);
      seen.add(id);
      const provider = providers.find((item) => item.id === id);
      if (!provider) fail(`fallback.${task} 引用了不存在的 provider「${id}」`);
      return provider;
    });
  } else {
    chainProviders = providers;
  }
  const route = routing.routes[task] ?? {};
  const prefer = route.prefer ?? [];
  const require = route.require ?? [];
  const candidates: RouteCandidate[] = chainProviders.map((provider) => {
    const model =
      prefer
        .map((tier) => provider.models.find((item) => item.tier === tier))
        .find((item) => item !== undefined) ?? provider.models[0]!;
    return {
      provider_id: provider.id,
      model: model.name,
      tier: model.tier,
      missing: require.filter((key) => !hasCapability(model, key)),
    };
  });
  return {
    task,
    candidates,
    unmet: candidates[0] ? [...candidates[0].missing] : [...require],
  };
}

/**
 * 把路由结果落到 provider 顺序上：被选中的模型提到 models[0]（fetch 时无须再传 request.model），
 * 未出现在路由链中的 provider 追加在末尾兜底（链是偏好而非白名单）。
 */
export function orderProvidersByRoute(
  providers: LlmProviderSpec[],
  route: ResolvedRoute,
): LlmProviderSpec[] {
  const used = new Set<string>();
  const ordered: LlmProviderSpec[] = [];
  for (const candidate of route.candidates) {
    if (used.has(candidate.provider_id)) continue;
    const provider = providers.find((item) => item.id === candidate.provider_id);
    if (!provider) continue;
    used.add(provider.id);
    const chosen = provider.models.find((item) => item.name === candidate.model) ?? provider.models[0]!;
    ordered.push({
      ...provider,
      models: [chosen, ...provider.models.filter((item) => item.name !== chosen.name)],
    });
  }
  for (const provider of providers) {
    if (!used.has(provider.id)) ordered.push(provider);
  }
  return ordered;
}