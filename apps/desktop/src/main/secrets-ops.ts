import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { YushuError } from "@yushu/core";
import { INDEX_DIR } from "@yushu/world-engine";
import {
  emptySecretsStore,
  findSecret,
  parseSecretsStore,
  removeSecret,
  serializeSecretsStore,
  upsertSecret,
  type SecretsStore,
} from "@yushu/llm";
import type { LlmProviderSpec } from "@yushu/llm";

/**
 * 凭据库（T3-14，K12）：API Key 的真身在磁盘上**只以 safeStorage 密文**存在
 * `.yushu/secrets.json`（派生物：可删可重建、不入 Git、不入索引、不进快照）。
 * 项目真源 `config/llm.yaml` 只写 `key_ref`（引用名）或 `api_key_env`（环境变量名）。
 *
 * 三条硬规矩（都有单测钉住）：
 * 1. 加密后端不可用时**拒绝保存**（`E_SECRETS_BACKEND`），绝不降级把明文写进文件；
 * 2. 凭据库文件损坏时报错而不是"顺手重建"，避免静默清空用户已有凭据；
 * 3. 任何返回列表的结果都不含密钥内容（只有 key_ref / label / 时间）。
 */

export const SECRETS_PATH = `${INDEX_DIR}/secrets.json`;

/** 加解密后端（抽象出来：单测注入替身，主进程用 safeStorage） */
export interface KeyCipher {
  available: boolean;
  encrypt(plain: string): string;
  decrypt(text: string): string;
}

/**
 * Electron `safeStorage` 的最小形状（由调用方注入——本模块不 import electron，
 * 这样单测无需 Electron 运行时，也杜绝了「测试里偷偷走明文分支」的可能）。
 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(ciphertext: Buffer): string;
}

/** 用 safeStorage 包一层 KeyCipher；传入 null（非 Electron 环境 / 旧运行时缺API）即视为不可用 */
export function createSafeStorageCipher(storage: SafeStorageLike | null): KeyCipher {
  const ready = (): boolean => {
    try {
      return storage !== null && storage.isEncryptionAvailable();
    } catch {
      return false;
    }
  };
  return {
    get available() {
      return ready();
    },
    encrypt(plain: string): string {
      if (!ready() || storage === null) {
        throw new YushuError("E_SECRETS_BACKEND", "系统凭据加密后端不可用（safeStorage 未就绪）");
      }
      return storage.encryptString(plain).toString("base64");
    },
    decrypt(text: string): string {
      if (!ready() || storage === null) {
        throw new YushuError("E_SECRETS_BACKEND", "系统凭据加密后端不可用（safeStorage 未就绪）");
      }
      return storage.decryptString(Buffer.from(text, "base64"));
    },
  };
}

/** key_ref 命名空间：默认与 provider.id 同名（可读、可手写进 yaml、且天然唯一） */
export function defaultKeyRefFor(providerId: string): string {
  return providerId;
}

function failStore(message: string): never {
  throw new YushuError("E_SECRETS_STORE", `凭据库不可用：${message}`);
}

/** 凭据库仓储（按项目根目录实例化；一切写入原子替换） */
export class SecretsRepository {
  constructor(
    private readonly rootDir: string,
    private readonly cipher: KeyCipher,
  ) {}

  private get absPath(): string {
    return join(this.rootDir, ...SECRETS_PATH.split("/"));
  }

  async exists(): Promise<boolean> {
    return (await fs.stat(this.absPath).catch(() => null)) !== null;
  }

  /** 读取信封：文件不存在 = 空库；内容非法 = 抛错（绝不"顺手清空"） */
  async load(): Promise<SecretsStore> {
    const text = await fs.readFile(this.absPath, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") return "";
      throw err;
    });
    if (text.trim() === "") return emptySecretsStore();
    try {
      return parseSecretsStore(text);
    } catch (err) {
      return failStore(`${SECRETS_PATH} 解析失败（保留原文件不覆写）：${(err as Error).message}`);
    }
  }

  private async save(store: SecretsStore): Promise<void> {
    const abs = this.absPath;
    await fs.mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, serializeSecretsStore(store), "utf8");
    await fs.rename(tmp, abs);
  }

  /** 保存（加密后写入）。后端不可用时直接拒绝——不写任何文件，不降级明文 */
  async put(keyRef: string, plain: string, label?: string): Promise<SecretsStore> {
    if (!this.cipher.available) {
      throw new YushuError(
        "E_SECRETS_BACKEND",
        "系统凭据加密后端（safeStorage）当前不可用，已拒绝保存以免明文落盘：请在本机钥匙串就绪后重试，或改用 api_key_env 环境变量注入",
      );
    }
    const trimmed = plain.trim();
    if (trimmed === "") failStore("密钥为空：请改用「清除凭据」移除条目");
    const store = await this.load();
    const next = upsertSecret(store, {
      key_ref: keyRef,
      ciphertext: this.cipher.encrypt(trimmed),
      alg: "safe-storage",
      created_at: new Date().toISOString(),
      ...(label && label.trim() !== "" ? { label: label.trim() } : {}),
    });
    await this.save(next);
    return next;
  }

  async remove(keyRef: string): Promise<boolean> {
    const store = await this.load();
    if (!findSecret(store, keyRef)) return false;
    await this.save(removeSecret(store, keyRef));
    return true;
  }

  /** 解密取值；未登记返回 undefined，密文坏掉则抛（让调用方明确提示重录） */
  async decrypt(keyRef: string): Promise<string | undefined> {
    const entry = findSecret(await this.load(), keyRef);
    if (!entry) return undefined;
    try {
      return this.cipher.decrypt(entry.ciphertext);
    } catch (err) {
      return failStore(`凭据「${keyRef}」解密失败（可能系统钥匙串已重置），请在「AI 副驾」重新录入：${String(err)}`);
    }
  }

  /** 列表（不含任何密钥内容——供 UI 显示"已加密保存"） */
  async list(): Promise<{ key_ref: string; created_at: string; label?: string }[]> {
    return (await this.load()).entries.map((entry) => ({
      key_ref: entry.key_ref,
      created_at: entry.created_at,
      ...(entry.label ? { label: entry.label } : {}),
    }));
  }

  /**
   * 为一组 provider 预备解密后的 key 表（按 key_ref 注入 llm 的 resolveApiKey）。
   * 单个 ref 解密失败时跳过它（该 provider 稍后会以「缺少 Key」的明确错误浮出，不静默当成无鉴权）。
   */
  async storedKeysFor(providers: LlmProviderSpec[]): Promise<Record<string, string>> {
    const store = await this.load();
    const keys: Record<string, string> = {};
    for (const provider of providers) {
      const ref = provider.key_ref;
      if (!ref || !findSecret(store, ref)) continue;
      try {
        const plain = this.cipher.decrypt(findSecret(store, ref)!.ciphertext);
        if (plain.trim() !== "") keys[ref] = plain;
      } catch {
        // 留空：调用侧按「无可用 Key」报错并指名 provider，避免把损坏凭据当无鉴权直连
      }
    }
    return keys;
  }
}
