import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  LlmAbortError,
  chat,
  stream,
  type LlmProviderSpec,
} from "@yushu/llm";

/**
 * OpenAI 兼容主干（openai_chat 协议）的既有行为回归：
 * 非流式、流式、鉴权、fallback、AbortController 中止保留部分文本、模型解析与输出上限。
 * （配置解析 / v1 迁移 / 能力矩阵见 config.test.ts；另两协议见 protocols.test.ts。）
 */

interface MockHandle {
  server: Server;
  baseUrl: string;
  requests: { url?: string; headers: Record<string, unknown>; body: Record<string, unknown> }[];
}

interface MockOptions {
  requireAuth?: boolean;
  /** 先发一块文本，再销毁连接（模拟流中途断链） */
  breakMidway?: boolean;
}

async function startMock(options: MockOptions = {}): Promise<MockHandle> {
  const requests: MockHandle["requests"] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      requests.push({ url: req.url, headers: req.headers as Record<string, unknown>, body });
      if (options.requireAuth && !req.headers["authorization"]) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "unauthorized" } }));
        return;
      }
      if (body["stream"] === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const chunks = ["天启", "界的", "夜色"];
        let sent = 0;
        const writeNext = () => {
          if (sent >= chunks.length) {
            res.write(
              `data: ${JSON.stringify({
                choices: [{ delta: {}, finish_reason: "stop" }],
                usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
              })}\n\n`,
            );
            res.write("data: [DONE]\n\n");
            res.end();
            return;
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[sent] } }] })}\n\n`);
          sent += 1;
          if (options.breakMidway && sent === 1) {
            setTimeout(() => res.socket?.destroy(), 10);
            return;
          }
          setTimeout(writeNext, 5);
        };
        writeNext();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: body["model"],
          choices: [{ message: { role: "assistant", content: "非流式回复" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

let handles: MockHandle[] = [];

afterEach(async () => {
  await Promise.all(
    handles.map((handle) => new Promise<void>((resolve) => handle.server.close(() => resolve()))),
  );
  handles = [];
});

/** v2 provider：mock 端点（local / openai_chat） */
function providerAt(baseUrl: string, extra: Partial<LlmProviderSpec> = {}): LlmProviderSpec {
  return {
    id: "mock",
    kind: "local",
    protocol: "openai_chat",
    base_url: baseUrl,
    models: [{ name: "mock-model", tier: "small", limits: { context: 32768, max_output: 2048 } }],
    ...extra,
  };
}

async function mockProvider(overrides: Partial<LlmProviderSpec> = {}): Promise<LlmProviderSpec> {
  const mock = await startMock();
  handles.push(mock);
  return providerAt(mock.baseUrl, overrides);
}

describe("chat 动词（非流式，T1-15）", () => {
  it("OpenAI 兼容主干返回文本 / usage / 模型名", async () => {
    const provider = await mockProvider();
    const result = await chat(
      [provider],
      {
        messages: [
          { role: "system", content: "你是写作助手" },
          { role: "user", content: "写一段开头" },
        ],
      },
      {},
    );
    expect(result.text).toBe("非流式回复");
    expect(result.provider_id).toBe("mock");
    expect(result.model).toBe("mock-model");
    expect(result.usage?.total_tokens).toBe(7);
    expect(result.fallbacks).toEqual([]);
  });

  it("模型解析：请求指定第二个模型时随请求下发；max_tokens 不超过模型 limits.max_output", async () => {
    const mock = await startMock();
    handles.push(mock);
    const provider = providerAt(mock.baseUrl, {
      max_tokens: 4096,
      models: [
        { name: "m-big", tier: "flagship", limits: { max_output: 2048 } },
        { name: "m-small", tier: "small", limits: { max_output: 512 } },
      ],
    });
    await chat(
      [provider],
      { messages: [{ role: "user", content: "hi" }], model: "m-small" },
      {},
    );
    expect(mock.requests[0]?.body["model"]).toBe("m-small");
    expect(mock.requests[0]?.body["max_tokens"]).toBe(512);
  });

  it("HTTP 错误（401）抛 E_LLM_HTTP", async () => {
    const mock = await startMock({ requireAuth: true });
    handles.push(mock);
    await expect(
      chat([providerAt(mock.baseUrl)], { messages: [{ role: "user", content: "hi" }] }, {}),
    ).rejects.toMatchObject({ code: "E_LLM_HTTP" });
  });

  it("声明 api_key_env 但两处都没有 key → 提前抛 E_LLM_CONFIG", async () => {
    await expect(
      chat(
        [providerAt("http://127.0.0.1:9/v1", { api_key_env: "YUSHU_TEST_KEY_MISSING" })],
        { messages: [{ role: "user", content: "hi" }] },
        { env: {} },
      ),
    ).rejects.toMatchObject({ code: "E_LLM_CONFIG" });
  });

  it("会话 Key 优先于环境变量，并随请求下发", async () => {
    const mock = await startMock({ requireAuth: true });
    handles.push(mock);
    await chat(
      [providerAt(mock.baseUrl, { api_key_env: "YUSHU_TEST_KEY" })],
      { messages: [{ role: "user", content: "hi" }] },
      { sessionKeys: { mock: "session-key" }, env: { YUSHU_TEST_KEY: "env-key" } },
    );
    expect(mock.requests[0]?.headers["authorization"]).toBe("Bearer session-key");
  });

  it("主 provider 不可用时降级到本地端点，并记录 fallbacks", async () => {
    const provider = await mockProvider();
    const onFallback: string[] = [];
    const result = await chat(
      [providerAt("http://127.0.0.1:9/v1", { id: "dead" }), provider],
      { messages: [{ role: "user", content: "hi" }] },
      { onFallback: (info) => onFallback.push(info.provider_id) },
    );
    expect(result.provider_id).toBe("mock");
    expect(result.fallbacks.map((item) => item.provider_id)).toEqual(["dead"]);
    expect(onFallback).toEqual(["dead"]);
  });
});

describe("stream 动词（流式 + 停止，T1-16）", () => {
  it("SSE 增量回调、汇总文本与 usage；请求带 stream:true", async () => {
    const provider = await mockProvider();
    const deltas: string[] = [];
    const result = await stream(
      [provider],
      { messages: [{ role: "user", content: "写一段" }] },
      { onDelta: (delta) => deltas.push(delta.text) },
      {},
    );
    expect(deltas).toEqual(["天启", "界的", "夜色"]);
    expect(result.text).toBe("天启界的夜色");
    expect(result.finish_reason).toBe("stop");
    expect(result.usage?.completion_tokens).toBe(3);
    expect(result.aborted).toBe(false);
  });

  it("AbortController 中止：抛 LlmAbortError 且携带已生成部分", async () => {
    const mock = await startMock();
    handles.push(mock);
    const controller = new AbortController();
    const deltas: string[] = [];
    const failure = stream(
      [providerAt(mock.baseUrl)],
      { messages: [{ role: "user", content: "写" }], signal: controller.signal },
      {
        onDelta: (delta) => {
          deltas.push(delta.text);
          controller.abort();
        },
      },
      {},
    );
    await expect(failure).rejects.toBeInstanceOf(LlmAbortError);
    try {
      await failure;
    } catch (err) {
      expect((err as LlmAbortError).partial).toBe("天启");
    }
    expect(deltas).toEqual(["天启"]);
  });

  it("流中途断链且已输出内容时不再切换 provider（避免重复正文）", async () => {
    const mock = await startMock({ breakMidway: true });
    handles.push(mock);
    const backup = await mockProvider();
    const deltas: string[] = [];
    await expect(
      stream(
        [providerAt(mock.baseUrl, { id: "flaky" }), backup],
        { messages: [{ role: "user", content: "写" }] },
        { onDelta: (delta) => deltas.push(delta.text) },
        {},
      ),
    ).rejects.toBeTruthy();
    expect(deltas).toEqual(["天启"]);
  });
});