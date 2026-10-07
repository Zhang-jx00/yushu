import { LlmAbortError, LlmError } from "./config.js";
import type { FailureKindName, ReliabilityConfig, RetryRule } from "./routing.js";

/**
 * 可靠性内核（T3-2，docs/03 §9）：
 * - 错误分类（429 → RateLimitError；5xx → InternalServerError；网络 → NetworkError；其余不重试）；
 * - 重试（按类别的次数与退避：exp / fixed，带抖动；可注入 sleep / random 供确定性测试）；
 * - 冷却熔断（窗口内失败达到阈值 → provider 冷却期内被跳过，由 fallback 接管）；
 * - 并发闸门（全局 + 单 provider 上限；FIFO 队列一次申请两个额度，避免持有全局等 provider 的死锁）。
 */

export type FailureKind = "rate_limit" | "server_error" | "network" | "other";

const KIND_TO_POLICY: Record<Exclude<FailureKind, "other">, FailureKindName> = {
  rate_limit: "RateLimitError",
  server_error: "InternalServerError",
  network: "NetworkError",
};

/** 错误分类：驱动重试策略与冷却记账 */
export function classifyFailure(err: unknown): FailureKind {
  if (err instanceof LlmError) {
    if (err.httpStatus === 429) return "rate_limit";
    if (err.httpStatus !== undefined && err.httpStatus >= 500) return "server_error";
    if (err.code === "E_LLM_NETWORK") return "network";
  }
  return "other";
}

export interface ReliabilityHooks {
  /** 休眠实现（测试注入假实现以免真实等待） */
  sleep?: (ms: number) => Promise<void>;
  /** 时钟（默认 Date.now） */
  now?: () => number;
  /** 抖动随机源（默认 Math.random；返回 [0,1)） */
  random?: () => number;
}

/** 计算退避时长：exp = base × 2^attempt（上限截断）±20% 抖动；fixed = base */
export function computeBackoffDelay(rule: RetryRule, attempt: number, random: () => number): number {
  const raw = rule.backoff === "exp" ? rule.base_delay_ms * 2 ** attempt : rule.base_delay_ms;
  const capped = Math.min(raw, rule.max_delay_ms);
  const jitter = 0.8 + random() * 0.4; // ±20%
  return Math.max(1, Math.round(capped * jitter));
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** 可中止休眠：中止时抛 LlmAbortError（与请求中止同语义） */
async function sleepAbortable(
  ms: number,
  signal: AbortSignal | undefined,
  sleepImpl: (ms: number) => Promise<void>,
): Promise<void> {
  if (!signal) {
    await sleepImpl(ms);
    return;
  }
  if (signal.aborted) throw new LlmAbortError("");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(new LlmAbortError(""));
    signal.addEventListener("abort", onAbort, { once: true });
    void sleepImpl(ms).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

export interface RetryOptions {
  config: ReliabilityConfig;
  signal?: AbortSignal;
  hooks?: ReliabilityHooks;
  /** 返回 true 时不再重试（如流式已输出增量文本——重试会拼接重复正文），直接抛错 */
  retryGuard?: () => boolean;
}

export interface RetryOutcome<T> {
  result: T;
  /** 额外尝试次数（成功前重试了几次） */
  retries: number;
}

/**
 * 按错误类别执行重试：可重试错误（429 / 5xx / 网络）按策略退避重试；
 * 其余错误直接抛出；中止错误立即抛出（不重试）。
 */
export async function retryWithPolicy<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
): Promise<RetryOutcome<T>> {
  const { config, signal, hooks } = options;
  const sleepImpl = hooks?.sleep ?? defaultSleep;
  const random = hooks?.random ?? Math.random;
  let attempt = 0;
  for (;;) {
    try {
      return { result: await fn(), retries: attempt };
    } catch (err) {
      if (err instanceof LlmAbortError) throw err;
      const kind = classifyFailure(err);
      if (kind === "other") throw err;
      const rule = config.retry_policy[KIND_TO_POLICY[kind]];
      const maxRetries = rule ? rule.max_retries : config.num_retries;
      const canRetry = attempt < maxRetries && !(options.retryGuard?.() ?? false);
      if (!canRetry) throw err;
      const delay = computeBackoffDelay(
        rule ?? { max_retries: maxRetries, backoff: "exp", base_delay_ms: 500, max_delay_ms: 8000 },
        attempt,
        random,
      );
      await sleepAbortable(delay, signal, sleepImpl);
      attempt += 1;
    }
  }
}

/**
 * 冷却熔断状态（跨调用共享；只存状态，配置每次查询时传入）。
 * - recordFailure：窗口内失败达阈值 → 进入冷却（cooldown_s）；
 * - recordSuccess：清空失败记录与冷却；
 * - isCooling：返回剩余冷却毫秒（0 = 可用）。
 */
export class CooldownTracker {
  private failures = new Map<string, number[]>();
  private cooldownUntil = new Map<string, number>();

  isCooling(providerId: string, cooldown: ReliabilityConfig["cooldown"], nowMs: number): number {
    const until = this.cooldownUntil.get(providerId) ?? 0;
    if (until <= nowMs) {
      if (until > 0) this.cooldownUntil.delete(providerId);
      return 0;
    }
    return until - nowMs;
  }

  recordFailure(
    providerId: string,
    cooldown: ReliabilityConfig["cooldown"],
    nowMs: number,
  ): { cooling: boolean; remainingMs: number } {
    const windowMs = cooldown.window_s * 1000;
    const recent = (this.failures.get(providerId) ?? []).filter((ts) => nowMs - ts < windowMs);
    recent.push(nowMs);
    this.failures.set(providerId, recent);
    if (recent.length >= cooldown.allowed_fails) {
      const until = nowMs + cooldown.cooldown_s * 1000;
      this.cooldownUntil.set(providerId, until);
      this.failures.set(providerId, []);
      return { cooling: true, remainingMs: cooldown.cooldown_s * 1000 };
    }
    return { cooling: false, remainingMs: 0 };
  }

  recordSuccess(providerId: string): void {
    this.failures.delete(providerId);
    this.cooldownUntil.delete(providerId);
  }
}

interface Waiter {
  providerId: string;
  globalLimit: number;
  providerLimit: number;
  grant: () => void;
}

/**
 * 并发闸门（全局 + 单 provider）：FIFO 队列、一次同时申请两个额度（避免死锁）。
 * acquire() 返回释放函数；并发释放时按队列顺序唤醒能同时满足的等待者。
 */
export class ConcurrencyGate {
  private globalInUse = 0;
  private providerInUse = new Map<string, number>();
  private waiters: Waiter[] = [];

  acquire(providerId: string, globalLimit: number, providerLimit: number): Promise<() => void> {
    return new Promise((resolve) => {
      const attempt = (): boolean => {
        if (this.canAcquire(providerId, globalLimit, providerLimit)) {
          this.doAcquire(providerId);
          resolve(() => this.release(providerId));
          return true;
        }
        return false;
      };
      if (attempt()) return;
      this.waiters.push({ providerId, globalLimit, providerLimit, grant: () => void attempt() });
    });
  }

  private canAcquire(providerId: string, globalLimit: number, providerLimit: number): boolean {
    return (
      this.globalInUse < globalLimit && (this.providerInUse.get(providerId) ?? 0) < providerLimit
    );
  }

  private doAcquire(providerId: string): void {
    this.globalInUse += 1;
    this.providerInUse.set(providerId, (this.providerInUse.get(providerId) ?? 0) + 1);
  }

  private release(providerId: string): void {
    this.globalInUse = Math.max(0, this.globalInUse - 1);
    this.providerInUse.set(providerId, Math.max(0, (this.providerInUse.get(providerId) ?? 0) - 1));
    this.drain();
  }

  private drain(): void {
    for (let index = 0; index < this.waiters.length; ) {
      const waiter = this.waiters[index]!;
      if (this.canAcquire(waiter.providerId, waiter.globalLimit, waiter.providerLimit)) {
        this.waiters.splice(index, 1);
        waiter.grant();
        // 继续扫描（新额度可能满足后续等待者）；不从 0 重扫即可保持 FIFO 近似公平
      } else {
        index += 1;
      }
    }
  }

  /** 当前占用（测试与诊断用） */
  get inUse(): { global: number; perProvider: Record<string, number> } {
    return {
      global: this.globalInUse,
      perProvider: Object.fromEntries(this.providerInUse),
    };
  }
}

/**
 * 可靠性闸门：冷却 + 并发状态（跨调用共享，绑进 LlmCallOptions.reliability）。
 * 配置每次调用传入（同一闸门可服务不同项目的配置）。
 */
export class ReliabilityGate {
  private readonly cooldown = new CooldownTracker();
  private readonly concurrency = new ConcurrencyGate();
  private readonly now: () => number;

  constructor(hooks: Pick<ReliabilityHooks, "now"> = {}) {
    this.now = hooks.now ?? Date.now;
  }

  nowMs(): number {
    return this.now();
  }

  /** 剩余冷却毫秒（0 = 可用） */
  coolingRemaining(providerId: string, config: ReliabilityConfig): number {
    return this.cooldown.isCooling(providerId, config.cooldown, this.now());
  }

  recordFailure(providerId: string, config: ReliabilityConfig): { cooling: boolean; remainingMs: number } {
    return this.cooldown.recordFailure(providerId, config.cooldown, this.now());
  }

  recordSuccess(providerId: string): void {
    this.cooldown.recordSuccess(providerId);
  }

  /** 获取并发额度（返回释放函数） */
  acquire(providerId: string, config: ReliabilityConfig): Promise<() => void> {
    const globalLimit = config.concurrency.global;
    const providerLimit = config.concurrency.per_provider[providerId] ?? Number.POSITIVE_INFINITY;
    return this.concurrency.acquire(providerId, globalLimit, providerLimit);
  }

  get concurrencyInUse(): { global: number; perProvider: Record<string, number> } {
    return this.concurrency.inUse;
  }
}