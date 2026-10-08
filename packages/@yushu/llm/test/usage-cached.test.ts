import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { chat, stream, type LlmProviderSpec } from "@yushu/llm";

/**
 * T3-12 缓存 token 归一：三协议的 usage 语义不一致（OpenAI / Gemini 的缓存命中是 prompt 的**子集**，
 * Anthropic 的 input_tokens 与缓存读/写**互斥**）。适配器必须收敛成同一口径——
 * `prompt_tokens` = 未命中缓存的常规输入，`cached_tokens` / `cache_write_tokens` 单列，
 * 否则成本折算会重复计价（这是 A3「偏差可核对」的前提）。
 */

interface MockHandle {
  baseUrl: string;
  server: Server;
}

let handles: MockHandle[] = [];

afterEach(async () => {
  await Promise.all(
    handles.map((handle) => new Promise<void>((resolve) => handle.server.close(() => resolve()))),
  );
  handles = [];
});

async function mockEndpoint(path: string, body: Record<string, unknown>): Promise<MockHandle> {
  const server = createServer((req, res) => {
    req.on("data", () => undefined);
    req.on("end", () => {
      if (req.url !== path) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const handle: MockHandle = { server, baseUrl: `http://127.0.0.1:${port}/v1` };
  handles.push(handle);
  return handle;
}

/** OpenAI Chat Completions 响应壳（content 必填，usage 由用例给定） */
function openaiBody(usage: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "cmpl_1",
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: "回复" }, finish_reason: "stop" }],
    usage,
  };
}

function provider(protocol: LlmProviderSpec["protocol"], baseUrl: string): LlmProviderSpec {
  return {
    id: "p",
    kind: "cloud",
    protocol,
    base_url: baseUrl,
    models: [{ name: "m", tier: "flagship", limits: { max_output: 1024 } }],
    api_key_env: "TEST_KEY",
  };
}

const OPTIONS = { sessionKeys: { p: "k" }, env: {} };

describe("usage 缓存字段归一（T3-12）", () => {
  it("openai_chat：prompt_tokens_details.cached_tokens 是子集 → 从常规输入中扣出", async () => {
    const mock = await mockEndpoint(
      "/v1/chat/completions",
      openaiBody({
        prompt_tokens: 1000,
        completion_tokens: 200,
        total_tokens: 1200,
        prompt_tokens_details: { cached_tokens: 600 },
      }),
    );
    const result = await chat(
      [provider("openai_chat", mock.baseUrl)],
      { messages: [{ role: "user", content: "写" }] },
      OPTIONS,
    );
    expect(result.usage).toEqual({
      prompt_tokens: 400,
      cached_tokens: 600,
      completion_tokens: 200,
      total_tokens: 1200,
    });
  });

  it("openai_chat：无 details 时不伪造缓存字段", async () => {
    const mock = await mockEndpoint(
      "/v1/chat/completions",
      openaiBody({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 }),
    );
    const result = await chat(
      [provider("openai_chat", mock.baseUrl)],
      { messages: [{ role: "user", content: "写" }] },
      OPTIONS,
    );
    expect(result.usage).toEqual({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
  });

  it("anthropic_messages：input / cache_read / cache_creation 互斥 → 直接映射并补齐合计", async () => {
    const server = createServer((req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_1",
            model: "claude-x",
            content: [{ type: "text", text: "回复" }],
            usage: {
              input_tokens: 300,
              cache_read_input_tokens: 600,
              cache_creation_input_tokens: 100,
              output_tokens: 50,
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    handles.push({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    const result = await chat(
      [provider("anthropic_messages", `http://127.0.0.1:${port}/v1`)],
      { messages: [{ role: "user", content: "写" }] },
      OPTIONS,
    );
    expect(result.usage).toEqual({
      prompt_tokens: 300,
      cached_tokens: 600,
      cache_write_tokens: 100,
      completion_tokens: 50,
      total_tokens: 1050,
    });
  });

  it("gemini_generate：cachedContentTokenCount 是 promptTokenCount 子集 → 扣出后单列", async () => {
    const server = createServer((req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            candidates: [{ content: { role: "model", parts: [{ text: "回复" }] } }],
            usageMetadata: {
              promptTokenCount: 800,
              cachedContentTokenCount: 500,
              candidatesTokenCount: 100,
              totalTokenCount: 900,
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    handles.push({ server, baseUrl: `http://127.0.0.1:${port}/v1beta` });
    const result = await chat(
      [provider("gemini_generate", `http://127.0.0.1:${port}/v1beta`)],
      { messages: [{ role: "user", content: "写" }] },
      OPTIONS,
    );
    expect(result.usage).toEqual({
      prompt_tokens: 300,
      cached_tokens: 500,
      completion_tokens: 100,
      total_tokens: 900,
    });
  });

  it("anthropic 流式：message_delta 带 input_tokens:0 不得抹掉 message_start 的正确值", async () => {
    const server = createServer((req, res) => {
      req.on("data", () => undefined);
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (event: string, data: unknown) =>
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        send("message_start", {
          type: "message_start",
          message: { usage: { input_tokens: 11, cache_read_input_tokens: 600 } },
        });
        send("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "天启" },
        });
        // 真实网关常把全部字段回填，未变化的输入侧会带 0 —— 不能用 0 覆盖已知的 11 / 600
        send("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 },
        });
        send("message_stop", { type: "message_stop" });
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    handles.push({ server, baseUrl: `http://127.0.0.1:${port}/v1` });
    const result = await stream(
      [provider("anthropic_messages", `http://127.0.0.1:${port}/v1`)],
      { messages: [{ role: "user", content: "写" }] },
      { onDelta: () => undefined },
      OPTIONS,
    );
    // 断言的是「0 不得抹掉 message_start 的真值」这一属性；delta 回填的 cache_write 0 原样保留（对成本无影响）
    expect(result.usage!.prompt_tokens).toBe(11);
    expect(result.usage!.cached_tokens).toBe(600);
    expect(result.usage!.completion_tokens).toBe(5);
    expect(result.usage!.total_tokens).toBe(616);
  });

  it("缓存字段异常（cached > prompt）保守夹到 0 而非负数输入", async () => {
    const mock = await mockEndpoint(
      "/v1/chat/completions",
      openaiBody({
        prompt_tokens: 100,
        completion_tokens: 10,
        total_tokens: 110,
        prompt_tokens_details: { cached_tokens: 500 },
      }),
    );
    const result = await chat(
      [provider("openai_chat", mock.baseUrl)],
      { messages: [{ role: "user", content: "写" }] },
      OPTIONS,
    );
    expect(result.usage!.prompt_tokens).toBe(0);
    expect(result.usage!.cached_tokens).toBe(100);
  });
});
