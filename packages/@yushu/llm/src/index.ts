/**
 * 御书 LLM 接入（M1 最小版，T1-15）：
 * - 只取两动词：`chat()`（非流式）与 `stream()`（流式 + AbortController 停止）；
 * - OpenAI Chat Completions 兼容主干（含 Ollama / LM Studio 等本地端点）；
 * - providers 数组顺序即 fallback 优先级（主干 → 本地兜底）；
 * - 重试/冷却/能力矩阵/任务路由/成本面板留待 M3。
 */

export * from "./types.js";
export * from "./config.js";
export * from "./chat.js";
export * from "./stream.js";