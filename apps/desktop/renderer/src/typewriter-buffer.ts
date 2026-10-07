/**
 * 打字机缓冲（T3-11，J08 实践 3 / 6）：token 缓冲 + rAF 每帧 flush。
 * - 生成视图用单一"待渲染缓冲"：每个 delta 只 push（不触发渲染），每帧由 rAF 驱动 flush 一次
 *   （`typewriter-token-rerender` 反模式的正面实现——未 flush 内容不计入 React 提交）；
 * - 两档显示：`smooth` 匀速（每帧上限，缺省 48 字——长文不追帧、稳定打字机手感）与
 *   `instant` 瞬时（整块直出，用于长文补全 / 低端机降级）；
 * - 纯逻辑（无 DOM）——rAF 由调用方驱动，单测以假帧覆盖。
 */

export type TypewriterMode = "smooth" | "instant";

export interface TypewriterOptions {
  mode?: TypewriterMode;
  /** 匀速模式每帧最多显示的字符数（缺省 48） */
  maxCharsPerFrame?: number;
}

export class TypewriterBuffer {
  private readonly pendingChunks: string[] = [];
  private pendingChars = 0;
  private flushed = "";
  private received = "";
  private mode: TypewriterMode;
  private readonly maxCharsPerFrame: number;

  constructor(options: TypewriterOptions = {}) {
    this.mode = options.mode ?? "smooth";
    this.maxCharsPerFrame = Math.max(1, Math.floor(options.maxCharsPerFrame ?? 48));
  }

  /** 收到增量（不触发渲染） */
  push(chunk: string): void {
    if (chunk === "") return;
    this.pendingChunks.push(chunk);
    this.pendingChars += chunk.length;
    this.received += chunk;
  }

  /** 每帧 flush：返回本帧应追加显示的文本（无待显示内容时返回空串） */
  flushFrame(): string {
    if (this.pendingChars === 0) return "";
    const take = this.mode === "instant" ? this.pendingChars : Math.min(this.maxCharsPerFrame, this.pendingChars);
    const merged = this.pendingChunks.join("");
    const piece = merged.slice(0, take);
    const rest = merged.slice(take);
    this.pendingChunks.length = 0;
    if (rest !== "") this.pendingChunks.push(rest);
    this.pendingChars = rest.length;
    this.flushed += piece;
    return piece;
  }

  /** 停止 / 完成时整块直出（返回剩余全部文本，等价瞬时 flush） */
  flushAll(): string {
    const merged = this.pendingChunks.join("");
    this.pendingChunks.length = 0;
    this.pendingChars = 0;
    this.flushed += merged;
    return merged;
  }

  setMode(mode: TypewriterMode): void {
    this.mode = mode;
  }

  getMode(): TypewriterMode {
    return this.mode;
  }

  /** 已显示（已 flush）文本 */
  get text(): string {
    return this.flushed;
  }

  /** 已收到的全部文本（含未 flush 缓冲） */
  get fullText(): string {
    return this.received;
  }

  /** 未 flush 的字符数 */
  get pending(): number {
    return this.pendingChars;
  }
}