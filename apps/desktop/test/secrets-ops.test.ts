import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretsRepository, defaultKeyRefFor, type KeyCipher } from "../src/main/secrets-ops.js";
import { resolveApiKey, type LlmProviderSpec } from "@yushu/llm";

/**
 * T3-14 凭据库（主进程侧）：密钥只能以密文形式落在 `.yushu/secrets.json`。
 * 这里盯三件安全属性：**明文不落盘**、**后端不可用时拒绝保存（不降级为明文）**、
 * **文件损坏时不静默覆写**（避免把用户凭据库悄悄清空）。
 */

/** 可逆的测试替身：明确标记前缀，便于断言"落盘的是密文形态而非明文" */
function fakeCipher(): KeyCipher & { calls: number } {
  const cipher = {
    calls: 0,
    available: true,
    encrypt(plain: string): string {
      cipher.calls += 1;
      return Buffer.from(`enc:${plain}`, "utf8").toString("base64");
    },
    decrypt(text: string): string {
      const raw = Buffer.from(text, "base64").toString("utf8");
      if (!raw.startsWith("enc:")) throw new Error("密文格式非法");
      return raw.slice(4);
    },
  };
  return cipher;
}

const unavailableCipher: KeyCipher = {
  available: false,
  encrypt: () => {
    throw new Error("不该被调用");
  },
  decrypt: () => {
    throw new Error("不该被调用");
  },
};

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-secrets-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const secretsFile = (): string => join(dir, ".yushu", "secrets.json");

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

describe("凭据库读写（密文信封）", () => {
  it("保存后文件里只有密文与 key_ref，明文字符串不出现在任何字节里", async () => {
    const repo = new SecretsRepository(dir, fakeCipher());
    const secret = "sk-proj-abcdefghijklmnop1234567890";
    await repo.put(defaultKeyRefFor("primary"), secret, "云端主干");

    const raw = await readFile(secretsFile(), "utf8");
    expect(raw).not.toContain(secret);
    expect(raw).toContain("safe-storage");
    expect(JSON.parse(raw).entries[0].key_ref).toBe("primary");
    expect(await repo.decrypt(defaultKeyRefFor("primary"))).toBe(secret);
  });

  it("同一 provider 重复保存只覆盖一条（key_ref 命名空间唯一）", async () => {
    const repo = new SecretsRepository(dir, fakeCipher());
    await repo.put("primary", "old-secret-value-123");
    await repo.put("primary", "new-secret-value-456");
    const store = await repo.load();
    expect(store.entries).toHaveLength(1);
    expect(await repo.decrypt("primary")).toBe("new-secret-value-456");
  });

  it("删除凭据：存在则移除并落盘，不存在时幂等返回 false", async () => {
    const repo = new SecretsRepository(dir, fakeCipher());
    await repo.put("primary", "some-secret-value-1");
    expect(await repo.remove("primary")).toBe(true);
    expect(await repo.decrypt("primary")).toBeUndefined();
    expect(await repo.remove("primary")).toBe(false);
  });

  it("加密后端不可用 → 拒绝保存并给可操作错误（绝不降级写明文）", async () => {
    const repo = new SecretsRepository(dir, unavailableCipher);
    await expect(repo.put("primary", "some-secret-value-1")).rejects.toMatchObject({ code: "E_SECRETS_BACKEND" });
    let exists = true;
    await readFile(secretsFile(), "utf8").catch(() => {
      exists = false;
    });
    expect(exists).toBe(false);
  });

  it("文件损坏 → 读取报错且保存被挡住，不静默清空既有凭据", async () => {
    const repo = new SecretsRepository(dir, fakeCipher());
    await mkdir(dirname(secretsFile()), { recursive: true });
    await writeFile(secretsFile(), "{ not json", "utf8");
    await expect(repo.load()).rejects.toMatchObject({ code: "E_SECRETS_STORE" });
    await expect(repo.put("primary", "some-secret-value-1")).rejects.toMatchObject({ code: "E_SECRETS_STORE" });
    expect(await readFile(secretsFile(), "utf8")).toBe("{ not json");
  });

  it("列出全部 key_ref（供 UI 显示「已加密保存」，不含任何密钥内容）", async () => {
    const repo = new SecretsRepository(dir, fakeCipher());
    await repo.put("primary", "one-secret-value-123", "云端主干");
    await repo.put("backup", "two-secret-value-456");
    const refs = await repo.list();
    expect(refs.map((item) => item.key_ref)).toEqual(["backup", "primary"]);
    expect(refs[0]!.label).toBeUndefined();
    expect(JSON.stringify(refs)).not.toContain("one-secret-value-123");
    expect(JSON.stringify(refs)).not.toContain("two-secret-value-456");
  });
});

describe("取值顺序与 key_ref 缺省", () => {
  it("defaultKeyRefFor 用 provider.id（可读、可预测，便于手工写在 yaml 里）", () => {
    expect(defaultKeyRefFor("primary")).toBe("primary");
  });

  it("声明了 key_ref 才解密注入；未声明的 provider 不受凭据库影响", async () => {
    const repo = new SecretsRepository(dir, fakeCipher());
    await repo.put("primary", "stored-secret-123456");
    const storedKeys = await repo.storedKeysFor([providerOf({ key_ref: "primary" }), providerOf({ id: "ollama" })]);
    expect(
      resolveApiKey(providerOf({ key_ref: "primary" }), { storedKeys, env: {} }),
    ).toBe("stored-secret-123456");
    expect(resolveApiKey(providerOf({ id: "ollama" }), { storedKeys, env: {} })).toBeUndefined();
  });
});
