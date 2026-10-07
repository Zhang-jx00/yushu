import { describe, expect, it } from "vitest";
import {
  JSON_CONSTRAINT_SUFFIX,
  LOCAL_PROVIDER_PRESETS,
  createLocalProvider,
  extractJson,
  parseLlmConfig,
  planDowngrade,
  serializeLlmConfig,
} from "@yushu/llm";

/**
 * T3-3：能力矩阵驱动的自动降级（方案生成 + JSON 后校验）；
 * T3-4：本地模型预设（Ollama / LM Studio / llama.cpp / vLLM → openai_chat 同抽象）。
 */

describe("planDowngrade（T3-3）", () => {
  it("structured_output 缺失：提示词约束 + JSON 后校验", () => {
    const plan = planDowngrade(["structured_output"]);
    expect(plan.actions).toEqual([
      {
        capability: "structured_output",
        strategy: "prompt_constrained_json",
        message: "模型未声明结构化输出能力：已降级为「提示词约束 + JSON 后校验」",
      },
    ]);
    expect(plan.prompt_suffix).toBe(JSON_CONSTRAINT_SUFFIX);
    expect(plan.post_validate_json).toBe(true);
  });

  it("stream 缺失：一次性返回；tools 缺失：无降级路径；其余能力：继续执行提示", () => {
    const oneShot = planDowngrade(["stream"]);
    expect(oneShot.actions[0]?.strategy).toBe("one_shot");
    expect(oneShot.prompt_suffix).toBe("");
    expect(oneShot.post_validate_json).toBe(false);

    const unsupported = planDowngrade(["tools"]);
    expect(unsupported.actions[0]?.strategy).toBe("unsupported");
    expect(unsupported.actions[0]?.message).toContain("无降级路径");

    const note = planDowngrade(["vision"]);
    expect(note.actions[0]?.strategy).toBe("prompt_note");
    expect(note.actions[0]?.message).toContain("视觉输入");
  });

  it("多能力缺失：动作齐全；任一结构化缺失即带 JSON 约束", () => {
    const plan = planDowngrade(["stream", "structured_output", "batch"]);
    expect(plan.actions.map((action) => action.capability)).toEqual([
      "stream",
      "structured_output",
      "batch",
    ]);
    expect(plan.post_validate_json).toBe(true);
    expect(planDowngrade([])).toEqual({ actions: [], prompt_suffix: "", post_validate_json: false });
  });
});

describe("extractJson 后校验（T3-3）", () => {
  it("纯 JSON / 代码围栏 / 前后夹杂解释文本均可提取", () => {
    expect(extractJson('{"name": "林渊"}')).toEqual({ ok: true, value: { name: "林渊" } });
    expect(extractJson('```json\n{"a": 1}\n```')).toEqual({ ok: true, value: { a: 1 } });
    expect(extractJson('```\n[1, 2, 3]\n```')).toEqual({ ok: true, value: [1, 2, 3] });
    expect(extractJson('好的，结果如下：{"ok": true, "count": 2} 以上。')).toEqual({
      ok: true,
      value: { ok: true, count: 2 },
    });
    expect(extractJson('前缀 [{"id": "a"}] 后缀')).toEqual({ ok: true, value: [{ id: "a" }] });
  });

  it("字符串内的括号不干扰平衡扫描", () => {
    expect(extractJson('{"text": "include } and { braces", "n": 1}')).toEqual({
      ok: true,
      value: { text: "include } and { braces", n: 1 },
    });
    expect(extractJson('{"escaped": "quote \\" and }"}')).toEqual({
      ok: true,
      value: { escaped: 'quote " and }' },
    });
  });

  it("无法解析时给出明确错误（未闭合 / 非 JSON / 空）", () => {
    expect(extractJson("完全不是 JSON").ok).toBe(false);
    expect(extractJson('{"unclosed": ').ok).toBe(false);
    expect(extractJson("").ok).toBe(false);
    expect(extractJson("{bad json}").ok).toBe(false);
  });
});

describe("本地模型预设（T3-4）", () => {
  it("四个预设齐备且均为 local / openai_chat / 本机回环地址", () => {
    expect(LOCAL_PROVIDER_PRESETS.map((preset) => preset.id)).toEqual([
      "ollama",
      "lmstudio",
      "llamacpp",
      "vllm",
    ]);
    for (const preset of LOCAL_PROVIDER_PRESETS) {
      expect(preset.base_url).toMatch(/^http:\/\/(127\.0\.0\.1|localhost)/);
      expect(preset.note).toContain("请求不出本机");
    }
  });

  it("createLocalProvider：生成可被 v2 校验接受的 provider（保守能力 + limits）", () => {
    const ollama = createLocalProvider("ollama");
    expect(ollama).toMatchObject({
      id: "ollama",
      kind: "local",
      protocol: "openai_chat",
      base_url: "http://127.0.0.1:11434/v1",
      models: [{ name: "qwen3:14b", tier: "flagship", limits: { context: 32768, max_output: 4096 } }],
    });
    // 可与其他 provider 一起通过 v2 配置校验
    const config = parseLlmConfig(
      serializeLlmConfig({
        apiVersion: "yushu.llm/v1",
        format_version: 2,
        providers: [ollama],
      }),
    );
    expect(config.providers[0]?.kind).toBe("local");

    const custom = createLocalProvider("vllm", { id: "vllm-a", model: "Qwen2.5-32B", tier: "small" });
    expect(custom.id).toBe("vllm-a");
    expect(custom.models[0]).toMatchObject({ name: "Qwen2.5-32B", tier: "small" });
    expect(() => createLocalProvider("ghost")).toThrowError(/未知本地预设/);
  });
});