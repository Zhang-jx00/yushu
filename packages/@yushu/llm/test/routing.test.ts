import { describe, expect, it } from "vitest";
import {
  DEFAULT_TASK_ROUTES,
  defaultRoutingConfig,
  orderProvidersByRoute,
  parseRoutingConfig,
  resolveRoute,
  serializeRoutingConfig,
  type LlmProviderSpec,
  type RoutingConfig,
} from "@yushu/llm";

/**
 * T3-2：任务路由（config/routing.yaml）——解析校验、fallback 禁环、档位偏好解析与 requires 报告。
 */

function provider(id: string, models: { name: string; tier: string; capabilities?: Record<string, boolean> }[]): LlmProviderSpec {
  return {
    id,
    kind: id === "local" ? "local" : "cloud",
    protocol: "openai_chat",
    base_url: `https://${id}.example.com/v1`,
    models: models.map((model) => ({
      name: model.name,
      tier: model.tier as "small" | "flagship" | "reasoning",
      ...(model.capabilities ? { capabilities: model.capabilities } : {}),
    })),
  };
}

const PROVIDERS: LlmProviderSpec[] = [
  provider("cloud", [
    { name: "big", tier: "flagship", capabilities: { stream: true } },
    { name: "mini", tier: "small", capabilities: { stream: true, structured_output: true } },
  ]),
  provider("local", [{ name: "qwen", tier: "small", capabilities: { stream: true } }]),
];

describe("routing 配置解析（T3-2）", () => {
  it("内置默认：drafting → flagship（require stream）；可靠性默认（重试 3 / 冷却 30s / 并发 4）", () => {
    const config = defaultRoutingConfig();
    expect(config.routes["drafting"]).toEqual({ prefer: ["flagship"], require: ["stream"] });
    expect(config.routes["naming"]).toEqual({ prefer: ["small"] });
    expect(config.routes["review"]).toEqual({ prefer: ["reasoning"] });
    expect(config.routes["outline"]?.require).toEqual(["structured_output"]);
    expect(config.reliability.num_retries).toBe(3);
    expect(config.reliability.retry_policy.RateLimitError.max_retries).toBe(5);
    expect(config.reliability.cooldown).toEqual({ allowed_fails: 3, window_s: 60, cooldown_s: 30 });
    expect(config.reliability.concurrency.global).toBe(4);
  });

  it("解析完整配置（routes / fallback / reliability）并可往返", () => {
    const text = [
      "apiVersion: yushu.llm/v1",
      "format_version: 1",
      "routes:",
      "  drafting: {prefer: [flagship, small], require: [stream]}",
      "  review: {prefer: [reasoning]}",
      "fallback:",
      "  drafting: [cloud, local]",
      "reliability:",
      "  num_retries: 2",
      "  retry_policy:",
      "    RateLimitError: {max_retries: 5, backoff: exp, base_delay_ms: 400, max_delay_ms: 4000}",
      "  cooldown: {allowed_fails: 2, window_s: 30, cooldown_s: 10}",
      "  concurrency: {global: 2, per_provider: {cloud: 1}}",
    ].join("\n");
    const config = parseRoutingConfig(text);
    expect(config.routes["drafting"]).toEqual({ prefer: ["flagship", "small"], require: ["stream"] });
    expect(config.fallback["drafting"]).toEqual(["cloud", "local"]);
    expect(config.reliability.retry_policy.RateLimitError).toEqual({
      max_retries: 5,
      backoff: "exp",
      base_delay_ms: 400,
      max_delay_ms: 4000,
    });
    // 未声明的类别继承内置默认
    expect(config.reliability.retry_policy.NetworkError.max_retries).toBe(3);
    expect(config.reliability.concurrency.per_provider["cloud"]).toBe(1);
    const again = parseRoutingConfig(serializeRoutingConfig(config));
    expect(again).toEqual(config);
  });

  it("非法配置给出明确错误（含 fallback 链禁止成环）", () => {
    const base = ["apiVersion: yushu.llm/v1", "format_version: 1"];
    expect(() => parseRoutingConfig("apiVersion: yushu.llm/v2\nroutes: {}")).toThrowError(/apiVersion/);
    expect(() =>
      parseRoutingConfig([...base, "routes:", "  drafting: {prefer: [giant]}"].join("\n")),
    ).toThrowError(/prefer/);
    expect(() =>
      parseRoutingConfig([...base, "routes:", "  drafting: {require: [telepathy]}"].join("\n")),
    ).toThrowError(/require/);
    expect(() =>
      parseRoutingConfig([...base, "fallback:", "  drafting: [cloud, cloud]"].join("\n")),
    ).toThrowError(/禁止成环/);
    expect(() =>
      parseRoutingConfig([...base, "fallback:", "  drafting: cloud"].join("\n")),
    ).toThrowError(/provider id 数组/);
    expect(() =>
      parseRoutingConfig([...base, "reliability:", "  retry_policy:", "    RateLimitError: {max_retries: -1}"].join("\n")),
    ).toThrowError(/max_retries/);
    expect(() =>
      parseRoutingConfig([...base, "reliability:", "  concurrency: {global: 0}"].join("\n")),
    ).toThrowError(/global/);
  });

  it("DEFAULT_TASK_ROUTES 覆盖 docs/03 §9 的五个任务", () => {
    expect(Object.keys(DEFAULT_TASK_ROUTES).sort()).toEqual(["drafting", "naming", "outline", "polish", "review"]);
  });
});

describe("resolveRoute 与 provider 排序（T3-2）", () => {
  it("drafting：优先旗舰档（big），require stream 满足；unmet 为空", () => {
    const route = resolveRoute("drafting", PROVIDERS, defaultRoutingConfig());
    expect(route.candidates.map((item) => [item.provider_id, item.model])).toEqual([
      ["cloud", "big"],
      ["local", "qwen"],
    ]);
    expect(route.unmet).toEqual([]);
    expect(route.candidates[0]?.tier).toBe("flagship");
  });

  it("naming：小模型档（cloud 有 mini 命中 small → mini；local 默认 qwen）", () => {
    const route = resolveRoute("naming", PROVIDERS, defaultRoutingConfig());
    expect(route.candidates.map((item) => item.model)).toEqual(["mini", "qwen"]);
  });

  it("无档位命中回落默认模型；require 不满足不报错但标出 missing / unmet（T3-3 降级依据）", () => {
    const providers: LlmProviderSpec[] = [
      provider("plain", [{ name: "only", tier: "small", capabilities: { stream: false } }]),
    ];
    const route = resolveRoute("review", providers, defaultRoutingConfig());
    expect(route.candidates[0]).toMatchObject({ model: "only", tier: "small" });
    const drafting = resolveRoute("drafting", providers, defaultRoutingConfig());
    expect(drafting.candidates[0]?.missing).toEqual(["stream"]);
    expect(drafting.unmet).toEqual(["stream"]);
  });

  it("fallback 链：按链顺序取 provider；引用不存在的 provider 报错", () => {
    const routing: RoutingConfig = {
      ...defaultRoutingConfig(),
      fallback: { drafting: ["local", "cloud"] },
    };
    const route = resolveRoute("drafting", PROVIDERS, routing);
    expect(route.candidates.map((item) => item.provider_id)).toEqual(["local", "cloud"]);
    const broken: RoutingConfig = { ...routing, fallback: { drafting: ["ghost", "cloud"] } };
    expect(() => resolveRoute("drafting", PROVIDERS, broken)).toThrowError(/不存在的 provider/);
    expect(() => resolveRoute("drafting", [], defaultRoutingConfig())).toThrowError(/无可用 provider/);
  });

  it("orderProvidersByRoute：选中模型提到 models[0]，链外 provider 追加兜底", () => {
    const routing: RoutingConfig = {
      ...defaultRoutingConfig(),
      fallback: { drafting: ["cloud"] },
    };
    const route = resolveRoute("drafting", PROVIDERS, routing);
    const ordered = orderProvidersByRoute(PROVIDERS, route);
    expect(ordered.map((item) => item.id)).toEqual(["cloud", "local"]);
    expect(ordered[0]?.models[0]?.name).toBe("big");
    // 原 provider 未被就地修改
    expect(PROVIDERS[0]?.models[0]?.name).toBe("big");
    const naming = orderProvidersByRoute(PROVIDERS, resolveRoute("naming", PROVIDERS, defaultRoutingConfig()));
    expect(naming[0]?.models[0]?.name).toBe("mini");
  });
});