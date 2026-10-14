import { describe, expect, it } from "vitest";
import { postJson, type TransportOptions } from "../src/shared.js";
import { redactSecretsInText } from "../src/secrets.js";
import { DEFAULT_TASK_ROUTES, defaultRoutingConfig, resolveRoute } from "../src/routing.js";
import type { LlmProviderSpec } from "../src/types.js";

/**
 * provider 的错误回显不能把密钥带出来（R80）。
 *
 * 为什么盯这一处：`postJson` 把响应体前 300 字符拼进 `E_LLM_HTTP` 的消息里，而这条消息会
 * 进 UI、进 `.yushu/ai-usage.jsonl`、进日志、进截图。有些网关 / 反代会把**收到的请求头**原样
 * 回显在 401 的 body 里——那正好带着 `Authorization: Bearer sk-...` 或 `x-api-key`。
 * 本项目其余各处都守着"错误信息不含密钥本体"（`maskSecret` 的注释就是这么写的），
 * 唯独这条外部文本的通道没守，等于留了一扇没关的窗。
 */

const provider = {
  id: "leaky",
  kind: "cloud",
  protocol: "openai_chat",
  base_url: "https://example.invalid/v1",
  models: [{ name: "m", tier: "flagship" }],
} as unknown as LlmProviderSpec;

/** 假的 fetch：只回一个带密钥回显的 401 */
const failingFetch = (body: string, status = 401): typeof fetch =>
  (async () =>
    ({
      ok: false,
      status,
      text: async () => body,
      json: async () => ({ error: body }),
    }) as unknown as Response) as unknown as typeof fetch;

const transportOf = (body: string, status?: number): TransportOptions => ({
  options: {},
  fetchImpl: failingFetch(body, status),
});

describe("redactSecretsInText：只动密钥形态，不动别的字", () => {
  it("sk- / Bearer / github PAT / AIza / xox 五类形态各被换掉", () => {
    const input =
      "auth failed: sk-abcdefghij0123456789 / Bearer abcdefghijklmnopQRSTUV / " +
      "ghp_abcdefghijklmnopqrstuvwxyz123456 / AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ12345 / xoxb-1234567890123";
    const out = redactSecretsInText(input);
    expect(out).not.toContain("sk-abcdefghij0123456789");
    expect(out).not.toContain("abcdefghijklmnopQRSTUV");
    expect(out).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz123456");
    expect(out).not.toContain("AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ12345");
    expect(out).not.toContain("xoxb-1234567890123");
    expect(out).toContain("已脱敏");
  });

  it("密钥字段带字面值（api_key: xxx / x-api-key: xxx）⇒ 字段名留下、值换掉", () => {
    const out = redactSecretsInText('echo of request: "api_key":"supersecretvalue123" and x-api-key: anothersecretvalue456');
    expect(out).not.toContain("supersecretvalue123");
    expect(out).not.toContain("anothersecretvalue456");
    expect(out.toLowerCase()).toContain("api_key");
  });

  it("32 位以上的十六进制串按密钥处理（回显体里宁可多脱敏，也不放过 Key）", () => {
    expect(redactSecretsInText(`key=${"0123456789abcdef".repeat(2)}`)).not.toContain("0123456789abcdef");
  });

  it("没有密钥的诊断文本原样返回——脱敏不能把错误信息变成不可读", () => {
    const input = "rate limit exceeded for project alpha, retry after 30s";
    expect(redactSecretsInText(input)).toBe(input);
  });

  it("空串与纯中文原样返回（不误伤）", () => {
    expect(redactSecretsInText("")).toBe("");
    expect(redactSecretsInText("服务端返回：额度不足，请检查计费账户")).toBe("服务端返回：额度不足，请检查计费账户");
  });
});

describe("postJson：HTTP 错误消息里不带出回显体中的密钥", () => {
  it("401 回显请求头 ⇒ 消息里读不到 Key 本体，但状态码与 provider id 还在", async () => {
    await expect(
      postJson(
        provider,
        "https://example.invalid/v1/chat/completions",
        { "content-type": "application/json" },
        { messages: [] },
        undefined,
        transportOf('echo: Authorization: Bearer sk-abcdefghij0123456789 x-api-key "supersecretvalue123"'),
      ),
    ).rejects.toThrow(/已脱敏/);
    let message = "";
    try {
      await postJson(
        provider,
        "https://example.invalid/v1/chat/completions",
        {},
        { messages: [] },
        undefined,
        transportOf('echo: Authorization: Bearer sk-abcdefghij0123456789'),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toContain("sk-abcdefghij0123456789");
    expect(message).toContain("HTTP 401");
    expect(message).toContain("leaky");
  });

  it("正常错误体（不含密钥）原文保留，不为了安全牺牲可诊断性", async () => {
    let message = "";
    try {
      await postJson(
        provider,
        "https://example.invalid/v1/chat/completions",
        {},
        { messages: [] },
        undefined,
        transportOf("upstream model overloaded, try again later", 503),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("upstream model overloaded");
    expect(message).toContain("HTTP 503");
  });
});

describe("audit 任务在默认路由表里（R58 的采样核验此前对路由不可见）", () => {
  it("默认路由带 audit：便宜档 + 要求结构化输出", () => {
    expect(DEFAULT_TASK_ROUTES["audit"]).toBeDefined();
    expect(DEFAULT_TASK_ROUTES["audit"]?.prefer).toEqual(["small"]);
    expect(DEFAULT_TASK_ROUTES["audit"]?.require).toEqual(["structured_output"]);
  });

  it("默认配置生成出来就带 audit（不是只在常量里，用户改得到）", () => {
    expect(defaultRoutingConfig().routes["audit"]).toBeDefined();
  });

  it("端点没声明 structured_output 时，audit 路由标出 unmet 而不是假定支持", () => {
    const smallNoSchema = {
      id: "cheap",
      kind: "local",
      protocol: "openai_chat",
      base_url: "http://127.0.0.1:1/v1",
      models: [{ name: "m", tier: "small", capabilities: { structured_output: false } }],
    } as unknown as LlmProviderSpec;
    const route = resolveRoute("audit", [smallNoSchema], defaultRoutingConfig());
    expect(route.unmet).toContain("structured_output");
  });

  it("声明了 structured_output 的端点不报 unmet（负例，防恒真）", () => {
    const ok = {
      id: "cheap2",
      kind: "local",
      protocol: "openai_chat",
      base_url: "http://127.0.0.1:1/v1",
      models: [{ name: "m", tier: "small", capabilities: { structured_output: true } }],
    } as unknown as LlmProviderSpec;
    expect(resolveRoute("audit", [ok], defaultRoutingConfig()).unmet).not.toContain("structured_output");
  });
});
