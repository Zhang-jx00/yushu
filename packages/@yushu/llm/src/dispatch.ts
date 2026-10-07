import { callAnthropicMessages, callAnthropicMessagesStream } from "./anthropic.js";
import { callGeminiGenerate, callGeminiGenerateStream } from "./gemini.js";
import { callChatCompletion, callChatCompletionStream } from "./openai.js";
import type { TransportOptions } from "./shared.js";
import type { ChatRequest, ChatResult, LlmProviderSpec, StreamCallbacks } from "./types.js";

/**
 * 协议分发（T3-1）：按 provider.protocol 路由到对应适配器。
 * protocol 已由 config 解析校验（非法值在配置层拦截），此处 switch 穷尽联合类型。
 */
export async function callProtocolChat(
  provider: LlmProviderSpec,
  request: ChatRequest,
  transport: TransportOptions,
): Promise<ChatResult> {
  switch (provider.protocol) {
    case "openai_chat":
      return callChatCompletion(provider, request, transport);
    case "anthropic_messages":
      return callAnthropicMessages(provider, request, transport);
    case "gemini_generate":
      return callGeminiGenerate(provider, request, transport);
  }
}

export async function callProtocolStream(
  provider: LlmProviderSpec,
  request: ChatRequest,
  callbacks: StreamCallbacks,
  transport: TransportOptions,
): Promise<ChatResult> {
  switch (provider.protocol) {
    case "openai_chat":
      return callChatCompletionStream(provider, request, callbacks, transport);
    case "anthropic_messages":
      return callAnthropicMessagesStream(provider, request, callbacks, transport);
    case "gemini_generate":
      return callGeminiGenerateStream(provider, request, callbacks, transport);
  }
}