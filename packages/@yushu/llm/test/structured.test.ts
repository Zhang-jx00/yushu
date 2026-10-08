import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSchemaConstraint,
  extractStructured,
  type LlmProviderSpec,
} from "@yushu/llm";

/**
 * T3-10 结构化输出：JSON Schema 契约注入、抽取-校验-修复闭环（错误回喂）、
 * 上限用尽如实失败（绝不静默采用）。
 */

interface MockHandle {
  server: Server;
  baseUrl: string;
  requests: Record<string, unknown>[];
}

/** 本地 mock：按序返回 contents（不足时重复最后一条）；记录每次请求体 */
async function startMock(
  contents: string[],
  options: { omitUsage?: boolean } = {},
): Promise<MockHandle> {
  const requests: Record<string, unknown>[] = [];
  let call = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      requests.push(body);
      const content = contents[Math.min(call, contents.length - 1)]!;
      call += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: body["model"],
          choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
          ...(options.omitUsage
            ? {}
            : { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } }),
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { server, baseUrl: `http://127.0.0.1:${port}/v1`, requests };
}

const handles: MockHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.map((handle) => new Promise<void>((resolve) => handle.server.close(() => resolve()))));
  handles.length = 0;
});

function providerAt(baseUrl: string): LlmProviderSpec {
  return {
    id: "mock",
    kind: "local",
    protocol: "openai_chat",
    base_url: baseUrl,
    models: [{ name: "mock-model", tier: "small", limits: { context: 32768, max_output: 2048 } }],
  };
}

async function mockProvider(
  contents: string[],
  options: { omitUsage?: boolean } = {},
): Promise<{ provider: LlmProviderSpec; mock: MockHandle }> {
  const mock = await startMock(contents, options);
  handles.push(mock);
  return { provider: providerAt(mock.baseUrl), mock };
}

const schema = { $id: "yushu.test/out/v1", type: "object", required: ["candidates"] };
const validJson = JSON.stringify({ candidates: [{ name: "林渊" }] });

function lastMessages(mock: MockHandle, index: number): { role: string; content: string }[] {
  const messages = mock.requests[index]!["messages"];
  return messages as { role: string; content: string }[];
}

describe("结构化抽取闭环（T3-10）", () => {
  it("首次即通过：schema 契约随请求注入、attempts=1", async () => {
    const { provider, mock } = await mockProvider([validJson]);
    const result = await extractStructured([provider], {
      messages: [{ role: "system", content: "抽取任务" }],
      schema,
      validate: () => ({ valid: true, issues: [] }),
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.provider_id).toBe("mock");
    const messages = lastMessages(mock, 0);
    expect(messages[messages.length - 1]!.content).toContain("JSON Schema（唯一契约");
    expect(messages[messages.length - 1]!.content).toContain("yushu.test/out/v1");
    expect(buildSchemaConstraint(schema)).toContain("只输出一个合法的 JSON 对象");
  });

  it("解析失败 → 回喂修复：第二次请求携带原始输出与错误清单", async () => {
    const { provider, mock } = await mockProvider(["这不是 JSON", validJson]);
    const result = await extractStructured([provider], {
      messages: [{ role: "user", content: "正文" }],
      schema,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    const messages = lastMessages(mock, 1);
    const flat = messages.map((message) => message.content).join("\n");
    expect(flat).toContain("这不是 JSON");
    expect(flat).toContain("未通过校验（第 1 次）");
    expect(flat).toContain("JSON 解析失败");
  });

  it("领域校验失败 → 错误回喂后修正成功（issues 文本进入修复轮）", async () => {
    const { provider, mock } = await mockProvider([JSON.stringify({ candidates: [] }), validJson]);
    let calls = 0;
    const result = await extractStructured([provider], {
      messages: [{ role: "user", content: "正文" }],
      schema,
      validate: () => {
        calls += 1;
        return calls === 1 ? { valid: false, issues: ["/candidates 候选为空：无出处不得进入候选"] } : { valid: true, issues: [] };
      },
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(lastMessages(mock, 1).map((message) => message.content).join("\n")).toContain("无出处不得进入候选");
  });

  it("上限用尽（maxRepair=2）→ attempts=3、如实失败并带 issues", async () => {
    const { provider, mock } = await mockProvider(["仍然不是 JSON"]);
    const result = await extractStructured([provider], {
      messages: [{ role: "user", content: "正文" }],
      schema,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.raw).toContain("仍然不是 JSON");
    expect(mock.requests).toHaveLength(3);
    expect(result.value).toBeUndefined();
  });
});

/**
 * T3-12：修复轮同样是真花钱的请求——usage 必须按全部轮次累加，
 * 否则抽取成本会被系统性低估（一次抽取最多 1+maxRepair 次请求）。
 */
describe("结构化抽取的 usage 聚合（T3-12）", () => {
  it("多轮修复的 token 逐轮累加（不是只记最后一轮）", async () => {
    const { provider } = await mockProvider(["这不是 JSON", validJson]);
    const result = await extractStructured([provider], {
      messages: [{ role: "user", content: "正文" }],
      schema,
    });
    expect(result.attempts).toBe(2);
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 });
  });

  it("上限用尽仍如实返回累计用量（失败也要记账）", async () => {
    const { provider } = await mockProvider(["仍然不是 JSON"]);
    const result = await extractStructured([provider], {
      messages: [{ role: "user", content: "正文" }],
      schema,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.usage).toEqual({ prompt_tokens: 15, completion_tokens: 9, total_tokens: 24 });
  });

  it("provider 不回传 usage → usage 缺省（不伪造 token）", async () => {
    const { provider } = await mockProvider([validJson], { omitUsage: true });
    const result = await extractStructured([provider], {
      messages: [{ role: "user", content: "正文" }],
      schema,
      validate: () => ({ valid: true, issues: [] }),
    });
    expect(result.ok).toBe(true);
    expect(result.usage).toBeUndefined();
  });
});