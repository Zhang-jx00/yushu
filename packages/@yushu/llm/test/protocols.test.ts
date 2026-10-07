import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { chat, stream, type LlmProviderSpec } from "@yushu/llm";

/**
 * T3-1 协议适配器：anthropic_messages 与 gemini_generate 的线格式（请求形状 / 鉴权头 /
 * 流式事件解析 / usage 映射 / 错误路径），以及跨协议 fallback（主协议失败 → 备协议接管）。
 */

interface MockHandle {
  server: Server;
  baseUrl: string;
  requests: { url?: string; headers: Record<string, unknown>; body: Record<string, unknown> }[];
}

let handles: MockHandle[] = [];

afterEach(async () => {
  await Promise.all(
    handles.map((handle) => new Promise<void>((resolve) => handle.server.close(() => resolve()))),
  );
  handles = [];
});

async function startServer(
  handler: (req: { url: string; headers: Record<string, unknown>; body: Record<string, unknown> }, res: import("node:http").ServerResponse) => void,
  prefix: string,
): Promise<MockHandle> {
  const requests: MockHandle["requests"] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      requests.push({ url: req.url, headers: req.headers as Record<string, unknown>, body });
      handler({ url: req.url ?? "", headers: req.headers as Record<string, unknown>, body }, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const handle: MockHandle = { server, baseUrl: `http://127.0.0.1:${port}${prefix}`, requests };
  handles.push(handle);
  return handle;
}

/** Anthropic 风格 mock：/v1/messages；x-api-key 鉴权；命名 SSE 事件 */
async function startAnthropicMock(): Promise<MockHandle> {
  return startServer((req, res) => {
    if (req.url !== "/v1/messages") {
      res.writeHead(404).end();
      return;
    }
    if (req.headers["x-api-key"] !== "anthropic-key" || req.headers["anthropic-version"] !== "2023-06-01") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "authentication_error", message: "bad key" } }));
      return;
    }
    if (req.body["stream"] === true) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const send = (event: string, data: unknown) =>
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", { type: "message_start", message: { usage: { input_tokens: 11 } } });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "天启" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "夜色" } });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } });
      send("message_stop", { type: "message_stop" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: "msg_1",
        model: "claude-x-2026",
        content: [
          { type: "text", text: "非流式回复" },
          { type: "thinking", thinking: "（忽略非 text 块）" },
          { type: "text", text: "（第二块）" },
        ],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 2 },
      }),
    );
  }, "/v1");
}

/** Gemini 风格 mock：/v1beta/models/{model}:generateContent[?alt=sse]；x-goog-api-key 鉴权 */
async function startGeminiMock(options: { blocked?: boolean } = {}): Promise<MockHandle> {
  return startServer((req, res) => {
    if (!/^\/v1beta\/models\/gemini-test(:generateContent|:streamGenerateContent\?alt=sse)$/.test(req.url)) {
      res.writeHead(404).end();
      return;
    }
    if (req.headers["x-goog-api-key"] !== "gemini-key") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { status: "UNAUTHENTICATED" } }));
      return;
    }
    if (options.blocked) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } }));
      return;
    }
    if (req.url.endsWith("alt=sse")) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "天启" }] } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts: [{ text: "夜色" }] } }] })}\n\n`);
      res.write(
        `data: ${JSON.stringify({
          candidates: [{ content: { role: "model", parts: [{ text: "" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
        })}\n\n`,
      );
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        candidates: [{ content: { role: "model", parts: [{ text: "非流式回复" }, { text: "（拼块）" }] }, finishReason: "STOP" }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
        modelVersion: "gemini-test-001",
      }),
    );
  }, "/v1beta");
}

function anthropicProvider(baseUrl: string, extra: Partial<LlmProviderSpec> = {}): LlmProviderSpec {
  return {
    id: "claude",
    kind: "cloud",
    protocol: "anthropic_messages",
    base_url: baseUrl,
    models: [{ name: "claude-x", tier: "flagship", limits: { context: 200000, max_output: 8192 } }],
    api_key_env: "ANTHROPIC_API_KEY",
    ...extra,
  };
}

function geminiProvider(baseUrl: string, extra: Partial<LlmProviderSpec> = {}): LlmProviderSpec {
  return {
    id: "gemini",
    kind: "cloud",
    protocol: "gemini_generate",
    base_url: baseUrl,
    models: [{ name: "gemini-test", tier: "flagship", limits: { context: 1000000, max_output: 8192 } }],
    api_key_env: "GEMINI_API_KEY",
    ...extra,
  };
}

describe("anthropic_messages 适配器（T3-1）", () => {
  it("非流式：system 提取 / 角色合并 / max_tokens 必填 / 文本拼接 / usage 映射", async () => {
    const mock = await startAnthropicMock();
    const result = await chat(
      [anthropicProvider(mock.baseUrl)],
      {
        messages: [
          { role: "system", content: "世界规则" },
          { role: "system", content: "风格：冷峻" },
          { role: "user", content: "写一段" },
          { role: "user", content: "继续写" },
          { role: "assistant", content: "上文" },
        ],
        max_tokens: 300,
      },
      { sessionKeys: { claude: "anthropic-key" } },
    );
    const sent = mock.requests[0]!;
    expect(sent.url).toBe("/v1/messages");
    expect(sent.headers["x-api-key"]).toBe("anthropic-key");
    expect(sent.headers["anthropic-version"]).toBe("2023-06-01");
    expect(sent.body["system"]).toBe("世界规则\n\n风格：冷峻");
    expect(sent.body["max_tokens"]).toBe(300);
    expect(sent.body["messages"]).toEqual([
      { role: "user", content: "写一段\n\n继续写" },
      { role: "assistant", content: "上文" },
    ]);
    // 响应：仅拼接 text 块（thinking 忽略）
    expect(result.text).toBe("非流式回复（第二块）");
    expect(result.model).toBe("claude-x-2026");
    expect(result.finish_reason).toBe("end_turn");
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it("非流式：未传 max_tokens 时用模型上限兜底（Anthropic 必填字段）", async () => {
    const mock = await startAnthropicMock();
    await chat(
      [anthropicProvider(mock.baseUrl)],
      { messages: [{ role: "user", content: "hi" }] },
      { sessionKeys: { claude: "anthropic-key" } },
    );
    expect(mock.requests[0]?.body["max_tokens"]).toBe(8192);
  });

  it("流式：命名 SSE 事件解析（增量 / usage / stop_reason）", async () => {
    const mock = await startAnthropicMock();
    const deltas: string[] = [];
    const result = await stream(
      [anthropicProvider(mock.baseUrl)],
      { messages: [{ role: "user", content: "写" }] },
      { onDelta: (delta) => deltas.push(delta.text) },
      { sessionKeys: { claude: "anthropic-key" } },
    );
    expect(deltas).toEqual(["天启", "夜色"]);
    expect(result.text).toBe("天启夜色");
    expect(result.finish_reason).toBe("end_turn");
    expect(result.usage).toEqual({ prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 });
  });

  it("鉴权缺失与 HTTP 错误：给出可操作错误", async () => {
    const mock = await startAnthropicMock();
    await expect(
      chat([anthropicProvider(mock.baseUrl)], { messages: [{ role: "user", content: "hi" }] }, { env: {} }),
    ).rejects.toMatchObject({ code: "E_LLM_CONFIG" });
  });
});

describe("gemini_generate 适配器（T3-1）", () => {
  it("非流式：端点路径 / x-goog-api-key / systemInstruction / 角色映射 / usageMetadata", async () => {
    const mock = await startGeminiMock();
    const result = await chat(
      [geminiProvider(mock.baseUrl)],
      {
        messages: [
          { role: "system", content: "世界规则" },
          { role: "user", content: "写一段" },
          { role: "assistant", content: "上文" },
        ],
      },
      { sessionKeys: { gemini: "gemini-key" } },
    );
    const sent = mock.requests[0]!;
    expect(sent.url).toBe("/v1beta/models/gemini-test:generateContent");
    expect(sent.headers["x-goog-api-key"]).toBe("gemini-key");
    expect(sent.body["systemInstruction"]).toEqual({ parts: [{ text: "世界规则" }] });
    expect(sent.body["contents"]).toEqual([
      { role: "user", parts: [{ text: "写一段" }] },
      { role: "model", parts: [{ text: "上文" }] },
    ]);
    expect(result.text).toBe("非流式回复（拼块）");
    expect(result.model).toBe("gemini-test-001");
    expect(result.finish_reason).toBe("STOP");
    expect(result.usage).toEqual({ prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
  });

  it("模型名带 models/ 前缀时归一化（避免路径重复）", async () => {
    const mock = await startGeminiMock();
    await chat(
      [geminiProvider(mock.baseUrl, { models: [{ name: "models/gemini-test", tier: "small" }] })],
      { messages: [{ role: "user", content: "hi" }] },
      { sessionKeys: { gemini: "gemini-key" } },
    );
    expect(mock.requests[0]?.url).toBe("/v1beta/models/gemini-test:generateContent");
  });

  it("流式：alt=sse 逐块累积 + 尾块 usage", async () => {
    const mock = await startGeminiMock();
    const deltas: string[] = [];
    const result = await stream(
      [geminiProvider(mock.baseUrl)],
      { messages: [{ role: "user", content: "写" }] },
      { onDelta: (delta) => deltas.push(delta.text) },
      { sessionKeys: { gemini: "gemini-key" } },
    );
    expect(mock.requests[0]?.url).toBe("/v1beta/models/gemini-test:streamGenerateContent?alt=sse");
    expect(deltas).toEqual(["天启", "夜色"]);
    expect(result.text).toBe("天启夜色");
    expect(result.finish_reason).toBe("STOP");
    expect(result.usage?.total_tokens).toBe(10);
  });

  it("promptFeedback.blockReason：安全策略拦截给出明确错误", async () => {
    const mock = await startGeminiMock({ blocked: true });
    await expect(
      chat(
        [geminiProvider(mock.baseUrl)],
        { messages: [{ role: "user", content: "hi" }] },
        { sessionKeys: { gemini: "gemini-key" } },
      ),
    ).rejects.toThrowError(/安全策略拦截/);
  });

  it("鉴权头错误：401 → E_LLM_HTTP", async () => {
    const mock = await startGeminiMock();
    await expect(
      chat(
        [geminiProvider(mock.baseUrl)],
        { messages: [{ role: "user", content: "hi" }] },
        { sessionKeys: { gemini: "wrong-key" } },
      ),
    ).rejects.toMatchObject({ code: "E_LLM_HTTP" });
  });
});

describe("跨协议 fallback（T3-1）", () => {
  it("主 provider（Anthropic 不可达）失败 → 备 provider（Gemini）接管，fallbacks 记录原因", async () => {
    const geminiMock = await startGeminiMock();
    const result = await chat(
      [
        anthropicProvider("http://127.0.0.1:9/v1", { id: "claude-dead" }),
        geminiProvider(geminiMock.baseUrl),
      ],
      { messages: [{ role: "user", content: "写" }] },
      {
        sessionKeys: { "claude-dead": "anthropic-key", gemini: "gemini-key" },
        onFallback: () => undefined,
      },
    );
    expect(result.provider_id).toBe("gemini");
    expect(result.text).toBe("非流式回复（拼块）");
    expect(result.fallbacks.map((item) => item.provider_id)).toEqual(["claude-dead"]);
  });
});