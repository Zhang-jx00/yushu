import { describe, expect, it } from "vitest";
import {
  LLM_API_VERSION,
  LLM_FORMAT_VERSION,
  detectPlaintextSecrets,
  redactPlaintextSecrets,
  emptySecretsStore,
  findSecret,
  maskSecret,
  parseLlmConfig,
  parseSecretsStore,
  removeSecret,
  resolveApiKey,
  serializeLlmConfig,
  serializeSecretsStore,
  upsertSecret,
  type LlmConfig,
  type LlmProviderSpec,
  type SecretEntry,
} from "@yushu/llm";

/**
 * T3-14 密钥安全（K12）：明文 Key 禁止落盘 / 禁止进错误信息；
 * 真源里只允许 `api_key_env`（环境变量名）或 `key_ref`（凭据库引用），密文存 `.yushu/secrets.json`（派生物）。
 */

function providerOf(extra: Partial<LlmProviderSpec> = {}): LlmProviderSpec {
  return {
    id: "primary",
    kind: "cloud",
    protocol: "openai_chat",
    base_url: "https://api.openai.com/v1",
    models: [{ name: "m", tier: "flagship" }],
    ...extra,
  };
}

function configWith(provider: LlmProviderSpec): LlmConfig {
  return {
    apiVersion: LLM_API_VERSION,
    format_version: LLM_FORMAT_VERSION,
    providers: [provider],
  };
}

describe("detectPlaintextSecrets：配置文本里的明文密钥扫描（K12 规则 key-plaintext-detected）", () => {
  it("命中 sk- 前缀、AIza、Bearer 与 key 类字段字面值", () => {
    expect(detectPlaintextSecrets("api_key: sk-proj-abcdefghijklmnop1234567890")).toHaveLength(1);
    expect(detectPlaintextSecrets("key: AIzaSyD-abcdefghijklmnopqrstuvwx1234567").length).toBe(1);
    expect(detectPlaintextSecrets("authorization: Bearer abcdefghijklmnop12345678").length).toBe(1);
    expect(detectPlaintextSecrets("token: 0123456789abcdef0123456789abcdef0123").length).toBe(1);
  });

  it("不误报环境变量名与凭据引用（这是本项目推荐的两种写法）", () => {
    expect(detectPlaintextSecrets("api_key_env: YUSHU_LLM_API_KEY")).toHaveLength(0);
    expect(detectPlaintextSecrets("key_ref: primary")).toHaveLength(0);
    expect(detectPlaintextSecrets("label: 云端主干")).toHaveLength(0);
    expect(detectPlaintextSecrets("base_url: https://api.openai.com/v1")).toHaveLength(0);
  });

  it("命中项给出去标识化的证据（含前缀与长度），且 evidence 里不含完整密钥", () => {
    const secret = "sk-proj-abcdefghijklmnop1234567890";
    const findings = detectPlaintextSecrets(`api_key: ${secret}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.field).toBe("api_key");
    expect(findings[0]!.evidence).not.toContain(secret);
    expect(findings[0]!.evidence).toContain("sk-p");
  });

  it("maskSecret 只保留 ≤4 位前缀并标注长度", () => {
    expect(maskSecret("sk-proj-abcdefghijklmnop1234567890")).toBe("sk-p…(len=34)");
    expect(maskSecret("abc")).toBe("ab…(len=3)");
  });
});

describe("parseLlmConfig：明文密钥一律拒绝（error 级，不静默忽略）", () => {
  it("YAML 文本里出现明文 key → E_LLM_CONFIG，且错误信息不回显密钥本体", () => {
    const secret = "sk-proj-abcdefghijklmnop1234567890";
    const text = [
      `apiVersion: ${LLM_API_VERSION}`,
      `format_version: ${LLM_FORMAT_VERSION}`,
      "providers:",
      "  - id: primary",
      "    kind: cloud",
      "    protocol: openai_chat",
      "    base_url: https://api.openai.com/v1",
      "    models:",
      "      - name: m",
      "        tier: flagship",
      `    api_key: ${secret}`,
      "",
    ].join("\n");
    let message = "";
    try {
      parseLlmConfig(text);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("明文");
    expect(message).not.toContain(secret);
    expect(message).toContain("primary");
  });

  it("key_ref 与 api_key_env 两种引用写法均通过，并随往返保留", () => {
    for (const provider of [providerOf({ key_ref: "primary" }), providerOf({ api_key_env: "OPENAI_KEY" })]) {
      const parsed = parseLlmConfig(serializeLlmConfig(configWith(provider)));
      const round = parsed.providers[0]!;
      expect(round.key_ref).toBe(provider.key_ref);
      expect(round.api_key_env).toBe(provider.api_key_env);
    }
  });
});

describe("凭据库信封（.yushu/secrets.json 的纯逻辑：密文条目、确定性、严格校验）", () => {
  const entry: SecretEntry = {
    key_ref: "primary",
    ciphertext: "Zm9vLWJhci1jaXBoZXJ0ZXh0",
    alg: "safe-storage",
    created_at: "2026-10-08T00:00:00.000Z",
    label: "云端主干",
  };

  it("upsert / find / remove 行为与幂等覆盖", () => {
    let store = emptySecretsStore();
    expect(findSecret(store, "primary")).toBeUndefined();
    store = upsertSecret(store, entry);
    expect(findSecret(store, "primary")?.ciphertext).toBe(entry.ciphertext);
    store = upsertSecret(store, { ...entry, ciphertext: "bmV3" });
    expect(store.entries).toHaveLength(1);
    expect(findSecret(store, "primary")?.ciphertext).toBe("bmV3");
    store = removeSecret(store, "primary");
    expect(store.entries).toHaveLength(0);
  });

  it("序列化按键名排序（确定性——同输入同输出，快照与 diff 才能比对）", () => {
    const store = upsertSecret(
      upsertSecret(emptySecretsStore(), { ...entry, key_ref: "zeta" }),
      { ...entry, key_ref: "alpha" },
    );
    expect(serializeSecretsStore(store)).toBe(
      serializeSecretsStore({ ...store, entries: [...store.entries].reverse() }),
    );
    expect(parseSecretsStore(serializeSecretsStore(store)).entries.map((item) => item.key_ref)).toEqual([
      "alpha",
      "zeta",
    ]);
  });

  it("非法条目一律拒绝（未知算法 / 空密文 / 缺 key_ref / 版本不符）", () => {
    const cases = [
      '{"version":1,"entries":[{"key_ref":"a","ciphertext":"","alg":"safe-storage","created_at":"t"}]}',
      '{"version":1,"entries":[{"ciphertext":"x","alg":"safe-storage","created_at":"t"}]}',
      '{"version":1,"entries":[{"key_ref":"a","ciphertext":"x","alg":"aes-gcm","created_at":"t"}]}',
      '{"version":2,"entries":[]}',
      "not json",
    ];
    for (const text of cases) {
      expect(() => parseSecretsStore(text)).toThrowError();
    }
  });

  it("密文为空表示「本地无需密钥」，允许显式清除而非留空串", () => {
    const store = upsertSecret(emptySecretsStore(), entry);
    expect(() => upsertSecret(store, { ...entry, ciphertext: "" })).toThrowError(/密文/);
  });
});

describe("resolveApiKey 取值顺序：本次会话 > 凭据库解密 > 环境变量", () => {
  it("三档来源按优先级取用，且空串不算有效值", () => {
    const provider = providerOf({ api_key_env: "OPENAI_KEY", key_ref: "primary" });
    expect(
      resolveApiKey(provider, {
        sessionKeys: { primary: "session-key" },
        storedKeys: { primary: "stored-key" },
        env: { OPENAI_KEY: "env-key" },
      }),
    ).toBe("session-key");
    expect(
      resolveApiKey(provider, { storedKeys: { primary: "stored-key" }, env: { OPENAI_KEY: "env-key" } }),
    ).toBe("stored-key");
    expect(resolveApiKey(provider, { env: { OPENAI_KEY: "env-key" } })).toBe("env-key");
    expect(
      resolveApiKey(provider, {
        sessionKeys: { primary: "   " },
        storedKeys: { primary: "" },
        env: { OPENAI_KEY: "env-key" },
      }),
    ).toBe("env-key");
  });

  it("无 key_ref 时不去查凭据库（本地无鉴权端点常见）", () => {
    const local = providerOf({ id: "ollama", api_key_env: undefined, key_ref: undefined });
    expect(
      resolveApiKey(local, { storedKeys: { ollama: "should-not-be-used" }, env: {} }),
    ).toBeUndefined();
  });
});

/**
 * 迁移备份的明文脱敏（R59 ②）。
 *
 * 场景：v1 的 config/llm.yaml 里带着明文 api_key，保存 v2 前系统会把 v1 原文备份成
 * `config/llm.yaml.bak-v1`（Git 跟踪路径）。逐字备份等于把同一把明文钥匙复制到第二个文件里——
 * 主文件按红线清了，副本还在。备份的意义是"结构可回滚"，不是"密钥可回滚"，所以脱敏要做在写盘之前。
 */
describe("redactPlaintextSecrets（迁移备份脱敏）", () => {
  const V1_WITH_KEY = [
    "apiVersion: yushu.llm/v1",
    "format_version: 1",
    "providers:",
    "  - id: openai",
    "    base_url: https://api.openai.com/v1",
    "    api_key: sk-abcdef0123456789",
    "    model: gpt-4o",
    "",
  ].join("\n");

  it("明文行换成注释并计数，且脱敏后的文本再扫一遍检不出", () => {
    const out = redactPlaintextSecrets(V1_WITH_KEY);
    expect(out.redacted).toBe(1);
    expect(out.text).not.toContain("sk-abcdef0123456789");
    expect(out.text).toContain("#");
    expect(detectPlaintextSecrets(out.text)).toEqual([]);
  });

  it("其余行逐字保留（备份还得能当 v1 结构回滚用）", () => {
    const out = redactPlaintextSecrets(V1_WITH_KEY);
    const kept = out.text.split("\n").filter((line) => !line.trimStart().startsWith("#"));
    expect(kept).toEqual(V1_WITH_KEY.split("\n").filter((line) => !line.includes("api_key")));
  });

  it("引用型写法一字不动、计数为 0（不能把合规配置改坏）", () => {
    const clean = ["providers:", "  - id: openai", "    api_key_env: OPENAI_KEY", "    key_ref: openai", ""].join("\n");
    const out = redactPlaintextSecrets(clean);
    expect(out.redacted).toBe(0);
    expect(out.text).toBe(clean);
  });

  it("密钥形状出现在非密钥字段名上也要脱敏（判定不只看字段名）", () => {
    const out = redactPlaintextSecrets(["note: use sk-zzzzyyyyxxxx1234 today", ""].join("\n"));
    expect(out.redacted).toBe(1);
    expect(out.text).not.toContain("sk-zzzzyyyyxxxx1234");
  });

  it("注释里留去标识化指纹，便于认出被移除的是哪把钥匙（不回显明文）", () => {
    const out = redactPlaintextSecrets(V1_WITH_KEY);
    const comment = out.text.split("\n").find((line) => line.trimStart().startsWith("#")) ?? "";
    expect(comment).toContain("api_key");
    expect(comment).toContain("len=");
    expect(comment).not.toContain("sk-abcdef0123456789");
  });
});
