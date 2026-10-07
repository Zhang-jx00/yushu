import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_CAPABILITIES,
  LLM_FORMAT_VERSION,
  defaultLlmConfig,
  detectLlmConfigVersion,
  effectiveMaxTokens,
  hasCapability,
  lintLlmConfig,
  migrateLlmConfigV1ToV2,
  parseLlmConfig,
  resolveCapabilities,
  resolveModelSpec,
  serializeLlmConfig,
  type LlmConfig,
  type LlmProviderSpec,
} from "@yushu/llm";

/**
 * T3-1：Provider 描述 v2（cloud | local、protocol、capabilities、limits）——
 * 覆盖解析校验、v1→v2 幂等迁移、能力矩阵解析与请求级参数上限。
 */

const V2_SAMPLE: LlmConfig = {
  apiVersion: "yushu.llm/v1",
  format_version: LLM_FORMAT_VERSION,
  providers: [
    {
      id: "openai",
      kind: "cloud",
      protocol: "openai_chat",
      base_url: "https://api.openai.com/v1",
      models: [
        {
          name: "gpt-5.6-luna",
          tier: "flagship",
          capabilities: {
            tools: true,
            structured_output: true,
            stream: true,
            usage: true,
            reasoning: false,
            vision: true,
            cache: { mode: "explicit", min_tokens: 1024, read_mult: 0.1, write_mult: 1.25 },
            batch: true,
          },
          limits: { context: 270000, max_output: 16384, rpm: 500, tpm: 900000 },
        },
        { name: "gpt-5.6-mini", tier: "small" },
      ],
      api_key_env: "OPENAI_API_KEY",
      temperature: 0.8,
      max_tokens: 4096,
    },
  ],
};

describe("config v2 解析与校验（T3-1）", () => {
  it("默认配置：云端主干 + 本地兜底，均声明 kind / protocol / models；序列化-解析往返一致", () => {
    const config = defaultLlmConfig();
    expect(config.format_version).toBe(2);
    expect(config.providers.map((provider) => provider.id)).toEqual(["primary", "local"]);
    expect(config.providers[0]?.kind).toBe("cloud");
    expect(config.providers[0]?.protocol).toBe("openai_chat");
    expect(config.providers[0]?.models[0]?.tier).toBe("small");
    expect(config.providers[1]?.kind).toBe("local");
    expect(parseLlmConfig(serializeLlmConfig(config))).toEqual(config);
  });

  it("v2 配置完整解析（含 cache / limits / 多模型）并可往返", () => {
    const parsed = parseLlmConfig(serializeLlmConfig(V2_SAMPLE));
    expect(parsed).toEqual(V2_SAMPLE);
    const model = parsed.providers[0]!.models[0]!;
    expect(model.capabilities?.cache?.mode).toBe("explicit");
    expect(model.limits?.context).toBe(270000);
  });

  it("非法配置给出明确错误", () => {
    const base = ["apiVersion: yushu.llm/v1", "format_version: 2", "providers:"];
    const provider = (fields: string[]) =>
      [...base, "  - id: a", ...fields].join("\n");
    expect(() => parseLlmConfig("apiVersion: yushu.llm/v2\nproviders: []\n")).toThrowError(
      /apiVersion/,
    );
    expect(() => parseLlmConfig("apiVersion: yushu.llm/v1\nformat_version: 2\nproviders: []\n")).toThrowError(
      /缺少 providers/,
    );
    expect(() => parseLlmConfig("apiVersion: yushu.llm/v1\nformat_version: 9\nproviders: []\n")).toThrowError(
      /高于当前支持/,
    );
    expect(() =>
      parseLlmConfig(provider(["    kind: cloud", "    protocol: openai_chat", "    base_url: ftp://x", "    models: [{name: m}]"])),
    ).toThrowError(/base_url/);
    expect(() =>
      parseLlmConfig(provider(["    kind: edge", "    protocol: openai_chat", "    base_url: 'http://127.0.0.1:1/v1'", "    models: [{name: m}]"])),
    ).toThrowError(/kind/);
    expect(() =>
      parseLlmConfig(provider(["    kind: cloud", "    protocol: gemini_web", "    base_url: 'http://127.0.0.1:1/v1'", "    models: [{name: m}]"])),
    ).toThrowError(/protocol/);
    expect(() =>
      parseLlmConfig(provider(["    kind: cloud", "    protocol: openai_chat", "    base_url: 'http://127.0.0.1:1/v1'", "    models: []"])),
    ).toThrowError(/models/);
    expect(() =>
      parseLlmConfig(
        provider(["    kind: cloud", "    protocol: openai_chat", "    base_url: 'http://127.0.0.1:1/v1'", "    models: [{name: m}, {name: m}]"]),
      ),
    ).toThrowError(/name 重复/);
    expect(() =>
      parseLlmConfig(
        provider(["    kind: cloud", "    protocol: openai_chat", "    base_url: 'http://127.0.0.1:1/v1'", "    models: [{name: m, tier: giant}]"]),
      ),
    ).toThrowError(/tier/);
    expect(() =>
      parseLlmConfig(
        provider(["    kind: cloud", "    protocol: openai_chat", "    base_url: 'http://127.0.0.1:1/v1'", "    models: [{name: m, capabilities: {stream: yes}}]"]),
      ),
    ).toThrowError(/stream/);
    expect(() =>
      parseLlmConfig(
        provider([
          "    kind: cloud",
          "    protocol: openai_chat",
          "    base_url: 'http://127.0.0.1:1/v1'",
          "    models: [{name: m, capabilities: {cache: {mode: magic}}}]",
        ]),
      ),
    ).toThrowError(/cache.mode/);
    expect(() =>
      parseLlmConfig(
        provider(["    kind: cloud", "    protocol: openai_chat", "    base_url: 'http://127.0.0.1:1/v1'", "    models: [{name: m, limits: {context: -1}}]"]),
      ),
    ).toThrowError(/context/);
    expect(() =>
      parseLlmConfig(
        [
          ...base,
          "  - {id: a, kind: cloud, protocol: openai_chat, base_url: 'http://127.0.0.1:1/v1', models: [{name: m}]}",
          "  - {id: a, kind: local, protocol: openai_chat, base_url: 'http://127.0.0.1:2/v1', models: [{name: m}]}",
        ].join("\n"),
      ),
    ).toThrowError(/id 重复/);
  });
});

describe("v1 → v2 迁移（T3-1；幂等、可回滚前提下）", () => {
  const V1_TEXT = [
    "apiVersion: yushu.llm/v1",
    "format_version: 1",
    "providers:",
    "  - id: primary",
    "    kind: openai-compatible",
    "    base_url: https://api.openai.com/v1",
    "    model: gpt-4o-mini",
    "    api_key_env: YUSHU_LLM_API_KEY",
    "    temperature: 0.8",
    "    max_tokens: 2048",
    "    context_window: 128000",
    "  - id: local",
    "    kind: openai-compatible",
    "    base_url: http://127.0.0.1:11434/v1",
    "    model: qwen3:14b",
    "  - id: lan",
    "    base_url: http://192.168.1.9:8000/v1",
    "    model: m",
  ].join("\n");

  it("单 model 简表迁移：kind 按地址推断 / protocol=openai_chat / limits 承接 / tier 默认 flagship", () => {
    const config = parseLlmConfig(V1_TEXT);
    expect(config.format_version).toBe(2);
    const primary = config.providers[0]!;
    expect(primary.kind).toBe("cloud");
    expect(primary.protocol).toBe("openai_chat");
    expect(primary.models).toEqual([
      { name: "gpt-4o-mini", tier: "flagship", limits: { context: 128000, max_output: 2048 } },
    ]);
    expect(primary.api_key_env).toBe("YUSHU_LLM_API_KEY");
    expect(primary.temperature).toBe(0.8);
    expect(primary.max_tokens).toBe(2048);

    const local = config.providers[1]!;
    expect(local.kind).toBe("local");
    expect(local.models[0]?.limits).toBeUndefined();

    // 局域网地址（非本机回环）按 cloud 处理，避免"本地隐私模式"误判
    expect(config.providers[2]?.kind).toBe("cloud");
  });

  it("迁移幂等：v1 → v2 → 序列化 → 解析结果稳定", () => {
    const once = parseLlmConfig(V1_TEXT);
    const twice = parseLlmConfig(serializeLlmConfig(once));
    expect(twice).toEqual(once);
    expect(serializeLlmConfig(once)).toContain("format_version: 2");
  });

  it("migrateLlmConfigV1ToV2 纯函数：输入不改写、输出可被 v2 校验", () => {
    const record = { apiVersion: "yushu.llm/v1", format_version: 1, providers: [{ id: "a", base_url: "http://127.0.0.1:1/v1", model: "m" }] };
    const migrated = migrateLlmConfigV1ToV2(record as unknown as Record<string, unknown>);
    expect(record.format_version).toBe(1);
    expect(migrated["format_version"]).toBe(2);
    expect(parseLlmConfig(serializeLlmConfig({ apiVersion: "yushu.llm/v1", format_version: 2, providers: migrated["providers"] } as LlmConfig)).providers[0]?.kind).toBe("local");
  });

  it("detectLlmConfigVersion：v1 / v2 / 缺省 / 不可解析", () => {
    expect(detectLlmConfigVersion(V1_TEXT)).toBe(1);
    expect(detectLlmConfigVersion(serializeLlmConfig(V2_SAMPLE))).toBe(2);
    expect(detectLlmConfigVersion("apiVersion: yushu.llm/v1\nproviders:\n  - id: a\n")).toBe(1);
    expect(detectLlmConfigVersion("::: not yaml :::")).toBe(0);
  });
});

describe("能力矩阵与请求参数（T3-1）", () => {
  it("resolveCapabilities：缺省合并保守默认；未声明不得假定支持", () => {
    const model = { name: "m", tier: "small" as const };
    expect(resolveCapabilities(model)).toEqual(DEFAULT_MODEL_CAPABILITIES);
    expect(hasCapability(model, "stream")).toBe(true);
    expect(hasCapability(model, "structured_output")).toBe(false);
    const declared = { name: "m", tier: "small" as const, capabilities: { structured_output: true, cache: { mode: "automatic" as const } } };
    expect(hasCapability(declared, "structured_output")).toBe(true);
    expect(hasCapability(declared, "cache")).toBe(true);
    expect(hasCapability(declared, "tools")).toBe(false);
  });

  it("resolveModelSpec：请求指定模型优先，未命中回落 models[0]（fallback 语义）", () => {
    const provider: LlmProviderSpec = V2_SAMPLE.providers[0]!;
    expect(resolveModelSpec(provider).name).toBe("gpt-5.6-luna");
    expect(resolveModelSpec(provider, "gpt-5.6-mini").name).toBe("gpt-5.6-mini");
    expect(resolveModelSpec(provider, "other-provider-model").name).toBe("gpt-5.6-luna");
  });

  it("effectiveMaxTokens：请求 ?? provider 默认 ?? 模型上限兜底，且不超过 limits.max_output", () => {
    const provider = defaultLlmConfig().providers[0]!;
    const model = provider.models[0]!; // max_output: 16384
    expect(effectiveMaxTokens(provider, model)).toBe(2048);
    expect(effectiveMaxTokens(provider, model, 100)).toBe(100);
    expect(effectiveMaxTokens(provider, model, 999999)).toBe(16384);
    const noDefaults: LlmProviderSpec = { ...provider, max_tokens: undefined, models: [{ name: "m", tier: "small", limits: { max_output: 512 } }] };
    expect(effectiveMaxTokens(noDefaults, noDefaults.models[0]!)).toBe(512);
    const noLimits: LlmProviderSpec = { ...provider, max_tokens: undefined, models: [{ name: "m", tier: "small" }] };
    expect(effectiveMaxTokens(noLimits, noLimits.models[0]!)).toBeUndefined();
  });

  it("lintLlmConfig：kind 与地址不符 / 未声明 capabilities / 未声明 context 给出提示", () => {
    const warnings = lintLlmConfig({
      apiVersion: "yushu.llm/v1",
      format_version: 2,
      providers: [
        { id: "a", kind: "cloud", protocol: "openai_chat", base_url: "http://127.0.0.1:1/v1", models: [{ name: "m", tier: "small" }] },
        { id: "b", kind: "local", protocol: "openai_chat", base_url: "https://api.example.com/v1", models: [{ name: "r", tier: "reasoning", capabilities: { reasoning: false, stream: true }, limits: { context: 1 } }] },
      ],
    });
    const messages = warnings.map((warning) => warning.message).join("\n");
    expect(messages).toContain("cloud 但 base_url 指向本机");
    expect(messages).toContain("local 但 base_url 并非本机");
    expect(messages).toContain("未声明 limits.context");
    expect(messages).toContain("reasoning 但未声明 reasoning 能力");
    // 已声明 capabilities 且非 reasoning tier 的模型不产生这两条
    expect(warnings.filter((warning) => warning.model === "r" && warning.message.includes("未声明 capabilities"))).toHaveLength(0);
  });
});