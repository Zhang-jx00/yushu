import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  CooldownTracker,
  ConcurrencyGate,
  LlmAbortError,
  LlmError,
  ReliabilityGate,
  chat,
  classifyFailure,
  computeBackoffDelay,
  defaultRoutingConfig,
  retryWithPolicy,
  stream,
  type LlmProviderSpec,
  type ReliabilityConfig,
} from "@yushu/llm";

/**
 * T3-2 可靠性内核：错误分类、按类别退避重试、冷却熔断、并发闸门，以及 chat/stream 集成。
 * 单测通过注入 sleep / random / now 保证确定性与零真实等待；集成用例用极小退避参数。
 */

function testConfig(overrides: Partial<ReliabilityConfig> = {}): ReliabilityConfig {
  const base = defaultRoutingConfig().reliability;
  return {
    ...base,
    num_retries: 2,
    retry_policy: {
      RateLimitError: { max_retries: 2, backoff: "exp", base_delay_ms: 1, max_delay_ms: 2 },
      InternalServerError: { max_retries: 2, backoff: "exp", base_delay_ms: 1, max_delay_ms: 2 },
      NetworkError: { max_retries: 2, backoff: "exp", base_delay_ms: 1, max_delay_ms: 2 },
    },
    ...overrides,
  };
}

interface MockHandle {
  server: Server;
  baseUrl: string;
  requests: number;
  maxActive: number;
}

interface MockOptions {
  /** 前 N 次请求返回错误（默认 0） */
  failFirst?: number;
  failAlways?: boolean;
  failStatus?: number;
  /** 首块增量后断开（模拟流中途断链） */
  breakAfterDelta?: boolean;
  delayMs?: number;
}

let handles: MockHandle[] = [];

async function startMock(options: MockOptions = {}): Promise<MockHandle> {
  const handle = { requests: 0, maxActive: 0 } as MockHandle;
  let active = 0;
  const server = createServer((req, res) => {
    active += 1;
    handle.maxActive = Math.max(handle.maxActive, active);
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      handle.requests += 1;
      const body = JSON.parse(raw || "{}") as Record<string, unknown>;
      const fail = options.failAlways === true || handle.requests <= (options.failFirst ?? 0);
      const finish = (fn: () => void) => {
        active -= 1;
        fn();
      };
      if (fail) {
        finish(() => {
          res.writeHead(options.failStatus ?? 429, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "rate limited" } }));
        });
        return;
      }
      if (body["stream"] === true) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        setTimeout(() => {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "天启" } }] })}\n\n`);
          if (options.breakAfterDelta) {
            setTimeout(() => finish(() => res.socket?.destroy()), 5);
            return;
          }
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "夜色" } }] })}\n\n`);
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          finish(() => res.end());
        }, options.delayMs ?? 0);
        return;
      }
      setTimeout(() => {
        finish(() => {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              model: body["model"],
              choices: [{ message: { role: "assistant", content: "回复" }, finish_reason: "stop" }],
            }),
          );
        });
      }, options.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  handle.server = server;
  handle.baseUrl = `http://127.0.0.1:${port}/v1`;
  handles.push(handle);
  return handle;
}

afterEach(async () => {
  await Promise.all(handles.map((handle) => new Promise<void>((resolve) => handle.server.close(() => resolve()))));
  handles = [];
});

function providerAt(id: string, baseUrl: string, tier: "small" | "flagship" = "small"): LlmProviderSpec {
  return {
    id,
    kind: "local",
    protocol: "openai_chat",
    base_url: baseUrl,
    models: [{ name: `${id}-model`, tier }],
  };
}

describe("错误分类与退避计算（T3-2）", () => {
  it("classifyFailure：429 → rate_limit；5xx → server_error；网络 → network；4xx → other（不重试）", () => {
    expect(classifyFailure(new LlmError("E_LLM_HTTP", "x", { httpStatus: 429 }))).toBe("rate_limit");
    expect(classifyFailure(new LlmError("E_LLM_HTTP", "x", { httpStatus: 503 }))).toBe("server_error");
    expect(classifyFailure(new LlmError("E_LLM_NETWORK", "x"))).toBe("network");
    expect(classifyFailure(new LlmError("E_LLM_HTTP", "x", { httpStatus: 400 }))).toBe("other");
    expect(classifyFailure(new Error("boom"))).toBe("other");
  });

  it("computeBackoffDelay：exp 指数增长并受 max_delay_ms 截断；fixed 固定；抖动 ±20%", () => {
    const exp = { max_retries: 5, backoff: "exp" as const, base_delay_ms: 100, max_delay_ms: 250 };
    expect(computeBackoffDelay(exp, 0, () => 0.5)).toBe(100);
    expect(computeBackoffDelay(exp, 1, () => 0.5)).toBe(200);
    expect(computeBackoffDelay(exp, 2, () => 0.5)).toBe(250); // 400 截断到 250
    expect(computeBackoffDelay(exp, 0, () => 0)).toBe(80); // 抖动下限
    expect(computeBackoffDelay(exp, 0, () => 0.999)).toBe(120);
    const fixed = { max_retries: 2, backoff: "fixed" as const, base_delay_ms: 50, max_delay_ms: 100 };
    expect(computeBackoffDelay(fixed, 3, () => 0.5)).toBe(50);
  });
});

describe("retryWithPolicy（T3-2）", () => {
  it("429 按 exp 退避重试直至成功；retries 计数与退避序列正确", async () => {
    const delays: number[] = [];
    let calls = 0;
    const outcome = await retryWithPolicy(
      async () => {
        calls += 1;
        if (calls < 3) throw new LlmError("E_LLM_HTTP", "429", { httpStatus: 429 });
        return "ok";
      },
      {
        config: testConfig({
          retry_policy: {
            ...testConfig().retry_policy,
            RateLimitError: { max_retries: 5, backoff: "exp", base_delay_ms: 100, max_delay_ms: 10_000 },
          },
        }),
        hooks: { sleep: async (ms) => void delays.push(ms), random: () => 0.5 },
      },
    );
    expect(outcome).toEqual({ result: "ok", retries: 2 });
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("不可重试错误（400）立即抛出；重试耗尽后抛最后一个错误", async () => {
    let calls = 0;
    await expect(
      retryWithPolicy(
        async () => {
          calls += 1;
          throw new LlmError("E_LLM_HTTP", "bad request", { httpStatus: 400 });
        },
        { config: testConfig(), hooks: { sleep: async () => undefined } },
      ),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      retryWithPolicy(
        async () => {
          calls += 1;
          throw new LlmError("E_LLM_HTTP", "500", { httpStatus: 500 });
        },
        {
          config: testConfig({
            retry_policy: {
              ...testConfig().retry_policy,
              InternalServerError: { max_retries: 1, backoff: "fixed", base_delay_ms: 1, max_delay_ms: 2 },
            },
          }),
          hooks: { sleep: async () => undefined },
        },
      ),
    ).rejects.toMatchObject({ httpStatus: 500 });
    expect(calls).toBe(2);
  });

  it("中止：预先中止的 signal 在退避等待时抛 LlmAbortError；retryGuard 阻止重试", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    await expect(
      retryWithPolicy(
        async () => {
          calls += 1;
          throw new LlmError("E_LLM_HTTP", "429", { httpStatus: 429 });
        },
        { config: testConfig(), signal: controller.signal, hooks: { sleep: async () => undefined } },
      ),
    ).rejects.toBeInstanceOf(LlmAbortError);
    expect(calls).toBe(1);

    calls = 0;
    await expect(
      retryWithPolicy(
        async () => {
          calls += 1;
          throw new LlmError("E_LLM_HTTP", "429", { httpStatus: 429 });
        },
        { config: testConfig(), retryGuard: () => true, hooks: { sleep: async () => undefined } },
      ),
    ).rejects.toMatchObject({ httpStatus: 429 });
    expect(calls).toBe(1);
  });
});

describe("冷却熔断（T3-2）", () => {
  const cooldown = { allowed_fails: 2, window_s: 60, cooldown_s: 10 };

  it("窗口内失败达阈值进入冷却；到期恢复；成功清空记录", () => {
    const tracker = new CooldownTracker();
    expect(tracker.recordFailure("a", cooldown, 1000).cooling).toBe(false);
    const second = tracker.recordFailure("a", cooldown, 2000);
    expect(second).toEqual({ cooling: true, remainingMs: 10_000 });
    expect(tracker.isCooling("a", cooldown, 2000)).toBe(10_000);
    expect(tracker.isCooling("a", cooldown, 6000)).toBe(6000);
    expect(tracker.isCooling("a", cooldown, 12_001)).toBe(0);

    // 成功清空失败记录：再次失败一次不会冷却
    tracker.recordSuccess("b");
    expect(tracker.recordFailure("b", cooldown, 1000).cooling).toBe(false);
    tracker.recordSuccess("b");
    expect(tracker.recordFailure("b", cooldown, 1500).cooling).toBe(false);
  });

  it("窗口过期：旧的失败记录被丢弃（不会累计触发冷却）", () => {
    const tracker = new CooldownTracker();
    expect(tracker.recordFailure("a", cooldown, 1000).cooling).toBe(false);
    // 61s 后（超出 window_s）再失败一次：旧记录过期 → 仍只有 1 次
    expect(tracker.recordFailure("a", cooldown, 62_001).cooling).toBe(false);
    expect(tracker.recordFailure("a", cooldown, 62_002).cooling).toBe(true);
  });
});

describe("并发闸门（T3-2）", () => {
  const tick = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  it("单 provider 限额：第二个请求等待第一个释放", async () => {
    const gate = new ConcurrencyGate();
    const release1 = await gate.acquire("a", 4, 1);
    let secondGranted = false;
    const second = gate.acquire("a", 4, 1).then((release) => {
      secondGranted = true;
      release();
    });
    await tick();
    expect(secondGranted).toBe(false);
    release1();
    await second;
    expect(secondGranted).toBe(true);
    expect(gate.inUse.global).toBe(0);
  });

  it("全局限额：不同 provider 也受全局约束；FIFO 释放不造成死锁", async () => {
    const gate = new ConcurrencyGate();
    const releaseA = await gate.acquire("a", 1, 1);
    let bGranted = false;
    const waitingB = gate.acquire("b", 1, 1).then((release) => {
      bGranted = true;
      release();
    });
    await tick();
    expect(bGranted).toBe(false); // 全局额度被 a 占用
    releaseA();
    await waitingB;
    expect(bGranted).toBe(true);
    expect(gate.inUse.global).toBe(0);
  });

  it("全局 2：两个不同 provider 可并行占用", async () => {
    const gate = new ConcurrencyGate();
    const releaseA = await gate.acquire("a", 2, 1);
    const releaseB = await gate.acquire("b", 2, 1);
    expect(gate.inUse.global).toBe(2);
    releaseA();
    releaseB();
    expect(gate.inUse.global).toBe(0);
  });
});

describe("chat / stream 集成（T3-2）", () => {
  it("chat：429 一次后成功，retries=1；请求计数证明发生了重试", async () => {
    const mock = await startMock({ failFirst: 1, failStatus: 429 });
    const result = await chat(
      [providerAt("mock", mock.baseUrl)],
      { messages: [{ role: "user", content: "hi" }] },
      { reliability: { config: testConfig(), gate: new ReliabilityGate() } },
    );
    expect(result.text).toBe("回复");
    expect(result.retries).toBe(1);
    expect(mock.requests).toBe(2);
  });

  it("stream：首块前 429 重试成功；已输出增量后断链不重试不切换", async () => {
    const retried = await startMock({ failFirst: 1, failStatus: 429 });
    const deltas: string[] = [];
    const result = await stream(
      [providerAt("mock", retried.baseUrl)],
      { messages: [{ role: "user", content: "hi" }] },
      { onDelta: (delta) => deltas.push(delta.text) },
      { reliability: { config: testConfig(), gate: new ReliabilityGate() } },
    );
    expect(deltas).toEqual(["天启", "夜色"]);
    expect(result.retries).toBe(1);
    expect(retried.requests).toBe(2);

    const broken = await startMock({ breakAfterDelta: true });
    await expect(
      stream(
        [providerAt("mock", broken.baseUrl)],
        { messages: [{ role: "user", content: "hi" }] },
        { onDelta: () => undefined },
        { reliability: { config: testConfig(), gate: new ReliabilityGate() } },
      ),
    ).rejects.toBeTruthy();
    expect(broken.requests).toBe(1); // 已输出增量：不重试
  });

  it("冷却：失败达阈值后跳过该 provider 走 fallback；全部冷却给出 E_LLM_COOLDOWN", async () => {
    const bad = await startMock({ failAlways: true, failStatus: 429 });
    const good = await startMock();
    let now = 1_000_000;
    const gate = new ReliabilityGate({ now: () => now });
    const config = testConfig({
      retry_policy: {
        ...testConfig().retry_policy,
        RateLimitError: { max_retries: 0, backoff: "fixed", base_delay_ms: 1, max_delay_ms: 1 },
      },
      cooldown: { allowed_fails: 1, window_s: 60, cooldown_s: 30 },
    });

    // 第一次：bad 失败并进入冷却（单 provider 时抛错）
    await expect(
      chat([providerAt("bad", bad.baseUrl)], { messages: [{ role: "user", content: "hi" }] }, { reliability: { config, gate } }),
    ).rejects.toBeTruthy();
    expect(bad.requests).toBe(1);

    // 第二次：bad 冷却中 → 直接跳过（不再发请求）→ good 接管
    const result = await chat(
      [providerAt("bad", bad.baseUrl), providerAt("good", good.baseUrl)],
      { messages: [{ role: "user", content: "hi" }] },
      { reliability: { config, gate } },
    );
    expect(result.provider_id).toBe("good");
    expect(bad.requests).toBe(1);
    expect(result.fallbacks[0]?.reason).toContain("冷却中");

    // 全部冷却：只给 bad 一个 provider → 明确错误码
    await expect(
      chat([providerAt("bad", bad.baseUrl)], { messages: [{ role: "user", content: "hi" }] }, { reliability: { config, gate } }),
    ).rejects.toMatchObject({ code: "E_LLM_COOLDOWN" });

    // 冷却到期（推进时钟）→ 恢复使用；成功后清空冷却状态
    now += 31_000;
    const recovered = await chat(
      [providerAt("good", good.baseUrl)],
      { messages: [{ role: "user", content: "hi" }] },
      { reliability: { config, gate } },
    );
    expect(recovered.provider_id).toBe("good");
    expect(gate.coolingRemaining("good", config)).toBe(0);
  });

  it("并发：全局 1 时两个并发调用串行执行（实测并发峰值 = 1）", async () => {
    const mock = await startMock({ delayMs: 40 });
    const config = testConfig({ concurrency: { global: 1, per_provider: {} } });
    const gate = new ReliabilityGate();
    const options = { reliability: { config, gate } };
    const call = () =>
      chat([providerAt("mock", mock.baseUrl)], { messages: [{ role: "user", content: "hi" }] }, options);
    await Promise.all([call(), call(), call()]);
    expect(mock.maxActive).toBe(1);
  });
});