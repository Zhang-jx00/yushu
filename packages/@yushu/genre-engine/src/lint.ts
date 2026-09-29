import { ROMANCE_MODES, WORDLIST } from "./wordlist.js";
import {
  ELEVEN_PIECE_KEYS,
  PACK_API_VERSION,
  PACK_KIND,
  type LoadedPack,
} from "./types.js";

export type LintSeverity = "error" | "warn" | "info";

export interface LintIssue {
  /** 规则 id（与 docs/03 §8 规则 DSL 命名风格一致） */
  rule: string;
  severity: LintSeverity;
  message: string;
}

export interface LintReport {
  packId: string;
  /** 无 error 级问题即为通过 */
  ok: boolean;
  issues: LintIssue[];
}

const SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NAMESPACE_RE = /^[a-z0-9][a-z0-9-]*$/;
const RANGE_HINT_RE = /[<>=^~]/;

/**
 * 派系包 lint：分享/融合前的强制关卡（docs/03 §8.3）。
 * 规则集（M1 版）：apiVersion / kind / 元数据 / 命名空间 / 语义化版本 /
 * 四维词表一致性 / 11 件套齐全 / 引用文件存在 / 演化字段 / 融合声明格式。
 */
export function lintPack(pack: LoadedPack): LintReport {
  const issues: LintIssue[] = [];
  const add = (rule: string, severity: LintSeverity, message: string) =>
    issues.push({ rule, severity, message });

  const manifest = pack.manifest;
  const meta = (manifest?.metadata ?? {}) as unknown as Record<string, unknown>;

  if (manifest?.apiVersion !== PACK_API_VERSION) {
    add(
      "pack-api-version",
      "error",
      `apiVersion 必须为 ${PACK_API_VERSION}，实际为 ${String(manifest?.apiVersion)}`,
    );
  }
  if (manifest?.kind !== PACK_KIND) {
    add("pack-kind", "error", `kind 必须为 ${PACK_KIND}，实际为 ${String(manifest?.kind)}`);
  }

  for (const field of ["id", "name", "version", "license"] as const) {
    if (typeof meta[field] !== "string" || (meta[field] as string).trim() === "") {
      add("pack-meta-required", "error", `metadata.${field} 缺失或为空`);
    }
  }
  const requires = meta["requires"] as Record<string, unknown> | undefined;
  if (!requires || typeof requires["yushu"] !== "string" || requires["yushu"] === "") {
    add("pack-requires-yushu", "error", "metadata.requires.yushu 缺失（需声明引擎兼容区间）");
  } else if (!RANGE_HINT_RE.test(requires["yushu"] as string)) {
    add(
      "pack-requires-range",
      "warn",
      `requires.yushu 应使用 semver 区间（如 ">=0.4.0"），实际为 "${String(requires["yushu"])}"`,
    );
  }

  if (typeof meta["id"] === "string" && !NAMESPACE_RE.test(meta["id"] as string)) {
    add("pack-id-namespace", "error", `metadata.id "${String(meta["id"])}" 不符合命名空间规范（小写字母/数字/连字符）`);
  }
  if (typeof meta["version"] === "string" && !SEMVER_RE.test(meta["version"] as string)) {
    add("pack-version-semver", "error", `metadata.version "${String(meta["version"])}" 不是合法 semver`);
  }
  if (typeof meta["license"] === "string" && meta["license"].trim() === "") {
    add("pack-license", "warn", "未声明 license，不利于社区分享");
  }

  // 四维词表一致性（docs/03 锁定风险：genre_axes 与 docs/05 词表脱钩）
  const axes = manifest?.genre_axes as unknown as Record<string, unknown> | undefined;
  if (!axes) {
    add("pack-genre-axes", "error", "genre_axes 缺失");
  } else {
    for (const [axis, words] of Object.entries(WORDLIST)) {
      const values = axes[axis];
      if (axis === "channel" || axis === "world") {
        if (!Array.isArray(values) || values.length === 0) {
          add("pack-genre-axes", "error", `genre_axes.${axis} 不能为空`);
          continue;
        }
      }
      if (values === undefined || values === null) continue;
      if (!Array.isArray(values)) {
        add("pack-genre-axes", "error", `genre_axes.${axis} 应为数组（支持同维多选）`);
        continue;
      }
      for (const v of values) {
        if (typeof v !== "string" || !words.includes(v)) {
          add("pack-wordlist-drift", "error", `genre_axes.${axis} 出现词表外取值：${String(v)}`);
        }
      }
    }
    const romance = axes["romance_mode_default"];
    if (romance !== undefined && !ROMANCE_MODES.includes(romance as string)) {
      add("pack-romance-mode", "error", `romance_mode_default 取值非法：${String(romance)}`);
    }
  }

  // 11 件套齐全（docs/01 §3.2）
  const content = (manifest?.content ?? {}) as unknown as Record<string, unknown>;
  for (const key of ELEVEN_PIECE_KEYS) {
    const value = content[key];
    const present = value !== undefined && value !== null;
    const empty = Array.isArray(value) && value.length === 0;
    if (!present || empty) {
      add("pack-eleven-piece", "error", `11 件套缺少：content.${key}`);
    }
  }

  // 引用文件存在性
  for (const missing of pack.missingFiles) {
    add("pack-file-missing", "error", `引用文件缺失：${missing}`);
  }

  // 演化字段（docs/05 §6：开山作 / 年代 / 演化链）
  const evolution = content["evolution"] as Record<string, unknown> | undefined;
  if (evolution && typeof evolution === "object") {
    if (!evolution["origin_work"] || !evolution["era"]) {
      add("pack-evolution-fields", "warn", "evolution 建议填写 origin_work 与 era（流派生命周期依据）");
    }
    if (!Array.isArray(evolution["chain"]) || evolution["chain"].length === 0) {
      add("pack-evolution-fields", "info", "evolution.chain 为空：建议补充 开山作→仿作→反套路 演化链");
    }
  }

  // 融合声明格式
  const conflicts = manifest?.fusions?.conflicts_with;
  if (Array.isArray(conflicts)) {
    for (const item of conflicts) {
      if (!item || typeof item.pack !== "string" || typeof item.reason !== "string") {
        add("pack-fusions-format", "warn", "fusions.conflicts_with 条目应含 {pack, reason}");
      }
    }
  }

  const ok = !issues.some((i) => i.severity === "error");
  return { packId: typeof meta["id"] === "string" ? (meta["id"] as string) : "(unknown)", ok, issues };
}