/**
 * 御书 LLM 接入（M1 最小版 T1-15；M3 升级为 Provider 能力矩阵与协议分发）：
 * - 两动词：`chat()`（非流式）与 `stream()`（流式 + AbortController 停止）；
 * - Provider 描述 v2：kind（cloud | local）+ protocol（openai_chat | anthropic_messages |
 *   gemini_generate）+ models（tier / capabilities / limits）；v1 配置自动迁移（幂等）；
 * - providers 数组顺序即 fallback 优先级（主干 → 本地兜底）；
 * - T3-2：任务路由（config/routing.yaml）+ 可靠性（重试 / 冷却 / 并发，见 routing.ts / reliability.ts）；
 * - 能力矩阵驱动的自动降级见 T3-3。
 */

export * from "./types.js";
export * from "./config.js";
export * from "./routing.js";
export * from "./reliability.js";
export * from "./presets.js";
export * from "./downgrade.js";
export * from "./chat.js";
export * from "./stream.js";