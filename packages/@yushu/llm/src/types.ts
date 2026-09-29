/** LLM 接入的跨包类型（docs/03 §9 / J01：OpenAI 兼容为事实标准，本地端点同抽象） */

export const LLM_API_VERSION = "yushu.llm/v1" as const;
export const LLM_FORMAT_VERSION = 1;

/** M1 仅 openai-compatible（本地端点为同一抽象的不同 base_url） */
export type ProviderKind = "openai-compatible";

export interface LlmProviderSpec {
  id: string;
  kind: ProviderKind;
  /** 形如 https://api.openai.com/v1 或 http://127.0.0.1:11434/v1（不含 /chat/completions） */
  base_url: string;
  model: string;
  /**
   * 读取 API Key 的环境变量名。
   * 安全红线（docs/03 §13）：配置/日志/项目文件禁止明文 key；空或缺省 = 无鉴权（本地端点常见）。
   */
  api_key_env?: string;
  temperature?: number;
  max_tokens?: number;
  /** 上下文窗口（token；M3 预算裁剪用，M1 仅透传展示） */
  context_window?: number;
}

/** config/llm.yaml 根（providers 顺序即 fallback 优先级） */
export interface LlmConfig {
  apiVersion: typeof LLM_API_VERSION;
  format_version: number;
  providers: LlmProviderSpec[];
}

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** 以下均可覆盖 provider 默认值 */
  model?: string;
  temperature?: number;
  max_tokens?: number;
  /** AbortController.signal：中止时抛 LlmAbortError（携带已生成部分） */
  signal?: AbortSignal;
}

export interface ChatUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface LlmFallbackInfo {
  provider_id: string;
  reason: string;
}

export interface ChatResult {
  text: string;
  provider_id: string;
  model: string;
  finish_reason?: string;
  usage?: ChatUsage;
  /** 被跳过的主 provider 记录（M3 可靠性面板用） */
  fallbacks: LlmFallbackInfo[];
  /** 是否被 AbortController 中止（中止时保留已生成部分） */
  aborted: boolean;
}

export interface StreamCallbacks {
  /** 每收到一个增量文本块回调（index 从 0 递增） */
  onDelta?: (delta: { text: string; index: number }) => void;
}

export interface LlmCallOptions {
  /** provider.id → 会话内存 key（优先级高于环境变量；不落盘） */
  sessionKeys?: Record<string, string | undefined>;
  /** 环境变量来源（默认 process.env；测试可注入） */
  env?: Record<string, string | undefined>;
  /** fetch 实现（默认全局 fetch；测试注入或本地 mock） */
  fetchImpl?: typeof fetch;
  /** provider 切换（fallback）时回调，便于 UI 提示 */
  onFallback?: (info: LlmFallbackInfo) => void;
}