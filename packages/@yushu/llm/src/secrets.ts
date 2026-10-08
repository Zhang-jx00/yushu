import { YushuError } from "@yushu/core";

/**
 * 密钥安全（T3-14，K12）——**纯逻辑层**：明文扫描 + 凭据库信封的格式与操作。
 *
 * 边界（与主进程分工）：
 * - 真正的加解密只在主进程用 Electron `safeStorage` 完成（本模块不碰密文语义，只管信封格式）；
 * - 真源 `config/llm.yaml` 里**只允许**出现 `api_key_env`（环境变量名）或 `key_ref`（凭据库引用）；
 *   密文条目落在 `.yushu/secrets.json`——派生物，可删可重建、不入 Git、不入索引、不进快照；
 * - 本模块的**一切输出（含错误信息）都只携带去标识化证据**（前缀 + 长度），绝不回显密钥本体。
 */

/** 疑似明文密钥的检测证据（field = 命中的字段名；evidence 已去标识化） */
export interface SecretFinding {
  field: string;
  evidence: string;
  /** 命中文本所属的 provider（按扫描时最近的 `- id:` 行归属；全局命中时为 undefined） */
  provider_id?: string;
}

/** 明文密钥的高置信模式（K12：`sk-` / `Bearer` / 32+ 随机串）——宁缺勿误报，避免把 sha256 之类判成密钥 */
const SECRET_PATTERNS: readonly { readonly field: string; readonly re: RegExp }[] = [
  { field: "*", re: /\bsk-[A-Za-z0-9_\-]{8,}/ },
  { field: "*", re: /\bAIza[0-9A-Za-z_\-]{20,}/ },
  { field: "*", re: /\bBearer\s+[A-Za-z0-9._\-]{12,}/i },
  { field: "*", re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}/ },
  { field: "*", re: /\b[0-9a-fA-F]{32,}\b/ },
  { field: "api_key", re: /\S{12,}/ },
  { field: "apikey", re: /\S{12,}/ },
  { field: "secret_key", re: /\S{12,}/ },
  { field: "access_key", re: /\S{12,}/ },
];

/** 视为「密钥字段」的名字（这些字段一旦带字面值即判明文；`api_key_env` / `key_ref` 是引用，不算） */
const SECRET_FIELD_NAMES = new Set([
  "api_key",
  "apikey",
  "key",
  "token",
  "secret",
  "password",
  "access_key",
  "secret_key",
  "authorization",
]);

/** 允许出现在配置文件里的引用型字段（本项目推荐的两种写法） */
const REFERENCE_FIELD_NAMES = new Set(["api_key_env", "key_ref"]);

/** 去标识化：保留 ≤4 位前缀 + 长度（短串只留 len-1，至少 2 位） */
export function maskSecret(value: string): string {
  const keep = Math.min(4, Math.max(2, value.length - 1));
  return `${value.slice(0, keep)}…(len=${value.length})`;
}

/** 解析一行 `key: value`（YAML 简形；带引号与缩进都剥掉） */
function parseLine(line: string): { key: string; value: string } | null {
  const match = /^\s*-?\s*([A-Za-z_][A-Za-z0-9_\-]*)\s*:\s*(.*)$/.exec(line);
  if (!match) return null;
  const value = match[2]!.trim().replace(/^["']|["']$/g, "");
  return { key: match[1]!.toLowerCase(), value };
}

/**
 * 扫描配置文本中的疑似明文密钥（K12 规则 `key-plaintext-detected`，error 级）。
 * 只做**高置信**判定：已知密钥形状、或密钥类字段带 ≥12 字符字面值；
 * 引用型写法（`api_key_env: YUSHU_LLM_API_KEY`、`key_ref: primary`）与非密钥字段一律放行。
 */
export function detectPlaintextSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  let providerId: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    const idMatch = /^\s*-\s*id:\s*(\S+)/.exec(line);
    if (idMatch) {
      providerId = idMatch[1]!.replace(/^["']|["']$/g, "");
      continue;
    }
    const parsed = parseLine(line);
    if (!parsed || parsed.value === "") continue;
    if (REFERENCE_FIELD_NAMES.has(parsed.key)) continue;
    const hit = SECRET_PATTERNS.find(
      (item) => (item.field === "*" || item.field === parsed.key) && item.re.test(parsed.value),
    );
    const isSecretField = SECRET_FIELD_NAMES.has(parsed.key) && parsed.value.length >= 12;
    if (!hit && !isSecretField) continue;
    findings.push({
      field: parsed.key,
      evidence: maskSecret(parsed.value),
      ...(providerId ? { provider_id: providerId } : {}),
    });
  }
  return findings;
}

/** 凭据库信封的密文条目（`ciphertext` 为 safeStorage 产物的 base64；本模块不解其义） */
export interface SecretEntry {
  key_ref: string;
  ciphertext: string;
  /** 目前只支持 Electron safeStorage 后端（可扩展，但必须显式声明，不猜） */
  alg: "safe-storage";
  created_at: string;
  label?: string;
}

export interface SecretsStore {
  version: 1;
  entries: SecretEntry[];
}

export function emptySecretsStore(): SecretsStore {
  return { version: 1, entries: [] };
}

function failSecretStore(message: string): never {
  throw new YushuError("E_SECRETS_STORE", `凭据库文件非法：${message}`);
}

function assertEntry(raw: unknown, index: number): SecretEntry {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) failSecretStore(`entries[${index}] 应为映射`);
  const record = raw as Record<string, unknown>;
  const keyRef = record["key_ref"];
  if (typeof keyRef !== "string" || keyRef.trim() === "") failSecretStore(`entries[${index}].key_ref 缺失`);
  const ciphertext = record["ciphertext"];
  if (typeof ciphertext !== "string" || ciphertext === "") {
    failSecretStore(`entries[${index}].ciphertext 为空（清除凭据请用 removeSecret，不保留空密文条目）`);
  }
  const alg = record["alg"];
  if (alg !== "safe-storage") failSecretStore(`entries[${index}].alg 仅支持 safe-storage，实际为 ${String(alg)}`);
  const createdAt = record["created_at"];
  if (typeof createdAt !== "string" || createdAt.trim() === "") {
    failSecretStore(`entries[${index}].created_at 缺失`);
  }
  const label = record["label"];
  return {
    key_ref: keyRef.trim(),
    ciphertext,
    alg: "safe-storage",
    created_at: createdAt,
    ...(typeof label === "string" && label.trim() !== "" ? { label: label.trim() } : {}),
  };
}

/** 解析 `.yushu/secrets.json`（严格：版本 / 算法 / 空密文一律拒绝；损坏时由调用方决定隔离还是重建） */
export function parseSecretsStore(text: string): SecretsStore {
  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch (err) {
    failSecretStore(`JSON 不可解析（${String(err)}）`);
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) failSecretStore("根节点应为映射");
  const record = data as Record<string, unknown>;
  if (record["version"] !== 1) failSecretStore(`version 必须为 1，实际为 ${String(record["version"])}`);
  if (!Array.isArray(record["entries"])) failSecretStore("entries 应为数组");
  const entries = record["entries"].map(assertEntry);
  const refs = new Set(entries.map((entry) => entry.key_ref));
  if (refs.size !== entries.length) failSecretStore("key_ref 重复");
  return { version: 1, entries: [...entries].sort((a, b) => (a.key_ref < b.key_ref ? -1 : a.key_ref > b.key_ref ? 1 : 0)) };
}

/** 序列化（按键名排序输出——同输入同字节，便于 diff 与可复现核对） */
export function serializeSecretsStore(store: SecretsStore): string {
  const sorted = [...store.entries].sort((a, b) => (a.key_ref < b.key_ref ? -1 : a.key_ref > b.key_ref ? 1 : 0));
  return `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`;
}

/** 写入 / 覆盖一条凭据（返回新对象，不改入参） */
export function upsertSecret(store: SecretsStore, entry: SecretEntry): SecretsStore {
  const checked = assertEntry({ ...entry }, 0);
  return parseSecretsStore(
    serializeSecretsStore({
      version: 1,
      entries: [...store.entries.filter((item) => item.key_ref !== checked.key_ref), checked],
    }),
  );
}

/** 删除一条凭据（幂等：不存在即原样返回） */
export function removeSecret(store: SecretsStore, keyRef: string): SecretsStore {
  return { version: 1, entries: store.entries.filter((entry) => entry.key_ref !== keyRef) };
}

export function findSecret(store: SecretsStore, keyRef: string): SecretEntry | undefined {
  return store.entries.find((entry) => entry.key_ref === keyRef);
}
