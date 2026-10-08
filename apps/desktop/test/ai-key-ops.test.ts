import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AiProviderPayload } from "../src/shared/ipc.js";
import {
  clearProviderKey,
  installKeyCipher,
  keyBackendAvailable,
  readAiConfig,
  saveAiConfig,
  saveProviderKey,
  sessionKeySnapshot,
  setSessionKey,
} from "../src/main/ai-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { type KeyCipher } from "../src/main/secrets-ops.js";
import { createProject } from "../src/main/project-ops.js";

/**
 * T3-14 桌面端密钥接线（第 43 轮）：`saveProviderKey` / `clearProviderKey` 是「密文进凭据库 + 真源只落 key_ref」
 * 这条链路的唯一入口，安全属性与「不抹掉用户已有配置」两条一起在这里钉住：
 * ① 明文既不落 `.yushu/secrets.json`，也不落 `config/llm.yaml`；
 * ② 真源改写走 readAiConfig → saveAiConfig，providers 全量替换语义下的定价 / 能力矩阵必须原样保住；
 * ③ 后端不可用即拒存（`E_SECRETS_BACKEND`），且**不留下半个 key_ref**；
 * ④ 空 Key 与未知 provider 是拒绝而不是"顺手清除"；清除幂等。
 */

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

const SECRET = "sk-unit-test-abcdefghijklmnop1234567890";

function fakeCipher(): KeyCipher {
  return {
    available: true,
    encrypt: (plain: string) => Buffer.from(`enc:${plain}`, "utf8").toString("base64"),
    decrypt: (text: string) => {
      const raw = Buffer.from(text, "base64").toString("utf8");
      if (!raw.startsWith("enc:")) throw new Error("密文格式非法");
      return raw.slice(4);
    },
  };
}

const unavailableCipher: KeyCipher = {
  available: false,
  encrypt: () => {
    throw new Error("后端不可用时不该被调用");
  },
  decrypt: () => {
    throw new Error("后端不可用时不该被调用");
  },
};

let dir: string;
let gateway: ProjectGateway;

function provider(id: string): AiProviderPayload {
  return {
    id,
    kind: "local",
    protocol: "openai_chat",
    base_url: "http://127.0.0.1:11434/v1",
    models: [
      {
        name: "mock-model",
        tier: "flagship",
        capabilities: {
          tools: false,
          structured_output: true,
          stream: true,
          usage: true,
          reasoning: false,
          vision: false,
          batch: false,
        },
        // 手写在真源里的价格：UI 保存绝不能抹掉（saveConfig 是 providers 全量替换）
        pricing: { currency: "CNY", input: 12, output: 36, cache_read: 1.2 },
      },
    ],
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-key-"));
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(dir);
  installKeyCipher(unavailableCipher); // 默认按「后端不可用」起步：每个用例显式声明自己测哪条分支
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

async function seedProvider(id = "mock"): Promise<void> {
  await saveAiConfig(gateway, { providers: [provider(id)] });
}

describe("加密保存 / 清除 provider 凭据（T3-14 接线）", () => {
  it("后端可用：密文进凭据库、真源只多 key_ref，两个文件都不含明文", async () => {
    installKeyCipher(fakeCipher());
    await seedProvider();

    const state = await saveProviderKey(gateway, "mock", SECRET);
    const secrets = await readFile(join(dir, ".yushu", "secrets.json"), "utf8");
    const yaml = await readFile(join(dir, "config", "llm.yaml"), "utf8");

    expect(secrets).toContain("safe-storage");
    expect(secrets).not.toContain(SECRET);
    expect(yaml).toContain("key_ref: mock");
    expect(yaml).not.toContain(SECRET);
    expect(state.keyStates.find((s) => s.provider_id === "mock")?.has_stored_key).toBe(true);
    expect(state.canGenerate).toBe(true);
  });

  it("保存 Key 不抹掉既有配置（定价 / 能力矩阵 / base_url 原样往返）", async () => {
    installKeyCipher(fakeCipher());
    await seedProvider();

    const after = await saveProviderKey(gateway, "mock", SECRET);
    const model = after.config.providers[0]!.models[0]!;
    expect(model.pricing?.input).toBe(12);
    expect(model.pricing?.cache_read).toBe(1.2);
    expect(model.capabilities.stream).toBe(true);
    expect(after.config.providers[0]!.base_url).toBe("http://127.0.0.1:11434/v1");
    expect(after.config.providers[0]!.api_key_env).toBeUndefined();
  });

  it("保存前失效旧会话 Key：否则内存 Key 盖住刚存的密文（用户以为新 Key 生效）", async () => {
    installKeyCipher(fakeCipher());
    await seedProvider();
    setSessionKey("mock", "sk-old-session-key-999999");
    expect(sessionKeySnapshot().mock).toBe("sk-old-session-key-999999");

    const state = await saveProviderKey(gateway, "mock", SECRET);
    expect(sessionKeySnapshot().mock).toBeUndefined();
    expect(state.keyStates.find((s) => s.provider_id === "mock")?.has_session_key).toBe(false);
    expect(state.keyStates.find((s) => s.provider_id === "mock")?.has_stored_key).toBe(true);
  });

  it("空 Key 是拒绝而不是清除：报错且不动凭据库与真源", async () => {
    installKeyCipher(fakeCipher());
    await seedProvider();
    await saveProviderKey(gateway, "mock", SECRET);
    const yamlBefore = await readFile(join(dir, "config", "llm.yaml"), "utf8");

    await expect(saveProviderKey(gateway, "mock", "   ")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    const state = await readAiConfig(gateway);
    expect(state.keyStates.find((s) => s.provider_id === "mock")?.has_stored_key).toBe(true);
    expect(await readFile(join(dir, "config", "llm.yaml"), "utf8")).toBe(yamlBefore);
  });

  it("未知 provider 拒存（key_ref 只能挂在真源已存在的 provider 上）", async () => {
    installKeyCipher(fakeCipher());
    await seedProvider();
    await expect(saveProviderKey(gateway, "ghost", SECRET)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    let created = true;
    await readFile(join(dir, ".yushu", "secrets.json"), "utf8").catch(() => {
      created = false;
    });
    expect(created).toBe(false);
  });

  it("后端不可用：拒存且真源不被改出半个 key_ref（绝不降级写明文）", async () => {
    await seedProvider();
    await expect(saveProviderKey(gateway, "mock", SECRET)).rejects.toMatchObject({ code: "E_SECRETS_BACKEND" });

    const yaml = await readFile(join(dir, "config", "llm.yaml"), "utf8");
    expect(yaml).not.toContain("key_ref");
    expect(yaml).not.toContain(SECRET);
    expect(keyBackendAvailable()).toBe(false);
  });

  it("清除凭据：密文条目与 key_ref 一并移除；重复清除幂等", async () => {
    installKeyCipher(fakeCipher());
    await seedProvider();
    await saveProviderKey(gateway, "mock", SECRET);
    expect(await readFile(join(dir, "config", "llm.yaml"), "utf8")).toContain("key_ref: mock");

    const cleared = await clearProviderKey(gateway, "mock");
    const secrets = await readFile(join(dir, ".yushu", "secrets.json"), "utf8");
    const yaml = await readFile(join(dir, "config", "llm.yaml"), "utf8");
    expect(JSON.parse(secrets).entries).toEqual([]);
    expect(yaml).not.toContain("key_ref");
    expect(yaml).not.toContain(SECRET);
    expect(cleared.keyStates.find((s) => s.provider_id === "mock")?.has_stored_key).toBe(false);

    const again = await clearProviderKey(gateway, "mock");
    expect(again.config.providers[0]!.key_ref).toBeUndefined();
  });

  it("清除未知 provider 不报错也不写盘（面板可能对已删除的 provider 补发一次清除）", async () => {
    installKeyCipher(fakeCipher());
    await seedProvider();
    await mkdir(join(dir, ".yushu"), { recursive: true });
    const state = await clearProviderKey(gateway, "ghost");
    expect(state.config.providers.map((p) => p.id)).toEqual(["mock"]);
  });

  it("keyBackendAvailable 跟随注入的后端（UI 据此禁用「加密保存」）", async () => {
    installKeyCipher(fakeCipher());
    expect(keyBackendAvailable()).toBe(true);
    const state = await readAiConfig(gateway);
    expect(state.keyBackendAvailable).toBe(true);
    installKeyCipher(unavailableCipher);
    expect((await readAiConfig(gateway)).keyBackendAvailable).toBe(false);
  });
});
