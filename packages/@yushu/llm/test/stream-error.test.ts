/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { callChatCompletionStream } from "../src/openai.js";
import { callProtocolStream } from "../src/dispatch.js";
import type { LlmProviderSpec } from "../src/types.js";

/**
 * 流式路径的两个错误出口（R82 复核结果）。
 *
 * 复核 R80 那条"错误回显要脱敏"时顺着 SSE 这条路往下看，撞见两件比泄漏更常发生的事：
 * ① **provider 在流里回 `{"error": …}` 时，御书把它当心跳丢掉了**——既不报错也不标记，
 *    调用方拿到一段被截断的文本、`ok` 为真，于是半截稿子被当成完整候选显示出来、
 *    甚至被采纳进正文。静默截断比明确失败坏得多：作者不知道少了什么。
 * ② 流读取中断时消息里拼的是 `String(err)`，**没过脱敏**（R80 只补了非流式那一处收口）。
 *
 * 所以这里钉三件事：错误要响、响的时候不带密钥、以及**不能把正常的心跳与 `[DONE]` 也响成错误**。
 */

const provider = {
  id: "streamy",
  kind: "cloud",
  protocol: "openai_chat",
  base_url: "https://example.invalid/v1",
  models: [{ name: "m", tier: "flagship" }],
} as unknown as LlmProviderSpec;

/** 造一个 SSE 响应体：每行一段，读完后 done */
function sseResponse(lines: string[]): Response {
  const encoder = new TextEncoder();
  const chunks = lines.map((line) => encoder.encode(line + "\n"));
  let cursor = 0;
  const body = {
    getReader: () => ({
      read: async () =>
        cursor < chunks.length ? { done: false, value: chunks[cursor++] } : { done: true, value: undefined },
      releaseLock: () => undefined,
    }),
  };
  return { ok: true, status: 200, body } as unknown as Response;
}

const transportReturning = (response: Response) => ({
  options: {},
  fetchImpl: (async () => response) as unknown as typeof fetch,
});

const request = { messages: [{ role: "user" as const, content: "写一段" }] };

/** 读取即抛的响应体（模拟连接中途断掉） */
function brokenBody() {
  return {
    getReader: () => ({
      read: async () => {
        throw new Error("socket closed while Authorization: Bearer sk-abcdefghij0123456789 was in flight");
      },
      releaseLock: () => undefined,
    }),
  };
}



describe("流里的 provider 错误必须响", () => {
  it('SSE 出现 {"error":…} ⇒ 抛错并带上 provider id，消息里的密钥被脱敏', async () => {
    await expect(
      callChatCompletionStream(
        provider,
        request,
        {},
        transportReturning(
          sseResponse([
            'data: {"choices":[{"delta":{"content":"夜色"}}]}',
            'data: {"error":{"message":"quota exceeded, key sk-abcdefghij0123456789 rejected"}}',
          ]),
        ),
      ),
    ).rejects.toMatchObject({ code: "E_LLM_STREAM" });

    let message = "";
    try {
      await callChatCompletionStream(
        provider,
        request,
        {},
        transportReturning(
          sseResponse(['data: {"error":{"message":"bad credentials sk-abcdefghij0123456789"}}']),
        ),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("streamy");
    expect(message).not.toContain("sk-abcdefghij0123456789");
    expect(message).toContain("已脱敏");
  });

  it("正常流（增量 + [DONE]）不受影响：文本完整聚合、不抛错", async () => {
    const result = await callChatCompletionStream(
      provider,
      request,
      {},
      transportReturning(
        sseResponse([
          'data: {"choices":[{"delta":{"content":"夜色"}}]}',
          'data: {"choices":[{"delta":{"content":"压下来"}}]}',
          "data: [DONE]",
        ]),
      ),
    );
    expect(result.text).toBe("夜色压下来");
    expect(result.provider_id).toBe("streamy");
  });

  it("心跳与非 JSON 行仍然容忍（别把新逻辑写成一见不懂就报错）", async () => {
    const result = await callChatCompletionStream(
      provider,
      request,
      {},
      transportReturning(
        sseResponse([
          ": keep-alive",
          "data:",
          'data: not-json-at-all',
          'data: {"choices":[{"delta":{"content":"剑光"}}]}',
          "data: [DONE]",
        ]),
      ),
    );
    expect(result.text).toBe("剑光");
  });

  it("错误事件之后的增量不再计入（已经坏了的流不该继续拼正文）", async () => {
    let message = "";
    try {
      await callChatCompletionStream(
        provider,
        request,
        {},
        transportReturning(
          sseResponse([
            'data: {"choices":[{"delta":{"content":"前半段"}}]}',
            'data: {"error":{"message":"upstream cut"}}',
            'data: {"choices":[{"delta":{"content":"不该出现"}}]}',
          ]),
        ),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("upstream cut");
    expect(message).not.toContain("不该出现");
  });
});

describe("流读取中断的消息也要过脱敏", () => {
  it("底层抛出的异常文本里有密钥 ⇒ 消息里读不到本体，但原因还在", async () => {
    let message = "";
    try {
      await callChatCompletionStream(
        provider,
        request,
        {},
        { options: {}, fetchImpl: (async () => ({ ok: true, status: 200, body: brokenBody() })) as unknown as typeof fetch },
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("流式读取中断");
    expect(message).not.toContain("sk-abcdefghij0123456789");
    expect(message).toContain("socket closed");
  });
});

/**
 * 三个协议都要守同一条：流里的 provider 错误必须响，且响的时候不带密钥。
 * openai_chat 与 anthropic 的差别是 anthropic 本来就抛（只是没脱敏），
 * gemini 与 openai 一样是**静默丢**——所以 gemini 那两条是行为修正，不只是加脱敏。
 */
describe("anthropic / gemini 的同一条口径", () => {
  const anthropicProvider = {
    id: "anth",
    kind: "cloud",
    protocol: "anthropic_messages",
    base_url: "https://example.invalid/v1",
    models: [{ name: "claude-x", tier: "flagship" }],
  } as unknown as LlmProviderSpec;

  const geminiProvider = {
    id: "gem",
    kind: "cloud",
    protocol: "gemini_generate",
    base_url: "https://example.invalid/v1",
    models: [{ name: "gemini-x", tier: "flagship" }],
  } as unknown as LlmProviderSpec;

  it("anthropic 的 error 事件：抛错且消息里的密钥被脱敏", async () => {
    let message = "";
    try {
      await callProtocolStream(
        anthropicProvider,
        { messages: [{ role: "user", content: "写一段" }] },
        {},
        transportReturning(
          sseResponse(['data: {"type":"error","error":{"type":"overloaded_error","message":"busy key sk-abcdefghij0123456789"}}']),
        ),
      );
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("anth");
    expect(message).not.toContain("sk-abcdefghij0123456789");
    expect(message).toContain("已脱敏");
  });

  it("gemini 的 error 事件：不能静默返回半截文本", async () => {
    await expect(
      callProtocolStream(
        geminiProvider,
        { messages: [{ role: "user", content: "写一段" }] },
        {},
        transportReturning(
          sseResponse([
            'data: {"candidates":[{"content":{"parts":[{"text":"夜色"}]}}]}',
            'data: {"error":{"code":429,"message":"resource exhausted sk-abcdefghij0123456789"}}',
          ]),
        ),
      ),
    ).rejects.toMatchObject({ code: "E_LLM_STREAM" });
  });

  it("gemini 正常流不受影响（负例，防把 blockReason 之类判成错误）", async () => {
    const result = await callProtocolStream(
      geminiProvider,
      { messages: [{ role: "user", content: "写一段" }] },
      {},
      transportReturning(
        sseResponse(['data: {"candidates":[{"content":{"parts":[{"text":"剑光"}]},"finishReason":"STOP"}]}']),
      ),
    );
    expect(result.text).toBe("剑光");
  });
});
