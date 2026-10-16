/* SPDX-License-Identifier: Apache-2.0 */
import { parse } from "yaml";

/**
 * 视角策略配置（`config/pov.yaml`，M4 / T4-2 第三批，R102）。
 *
 * 判据出处 docs/research/F-叙事与故事构建/F04-视角与人称.md §3.1 / §3.2 / §3.6 与 §5 的数据结构建议
 * （`pov_config`：mode / distance / default_pov / allowed_povs / switch_policy / exemptions）。
 *
 * 两条口径：
 * ① **没有这个文件就是"没声明"，不是"按默认判"**——F04 说的五种模式里挑一个当默认，
 *    就等于替作者决定了他这本书是限知还是全知，然后据这个猜测发一堆警告。缺文件时
 *    `pov-check` 只报一条"策略未声明"的 info；
 * ② **未知键与非法取值一律读错**（与豁免清单、阈值表、平台包同一条路子）：一个代码不认识
 *    却被悄悄忽略的字段，比报错危险得多——作者会以为它生效了。
 */

export const POV_CONFIG_PATH = "config/pov.yaml";

/** F04 §3.1 的五种模式（mixed 要求附说明，本层只认取值） */
export const POV_MODES: readonly string[] = ["first", "second", "third_limited", "third_omniscient", "mixed"];

/** 叙事距离（F04 §5 的"贴近 / 中性 / 疏离"，对应内聚焦深浅） */
export const POV_DISTANCES: readonly string[] = ["贴近", "中性", "疏离"];

/** 切换粒度：按场景还是按章数算间隔 */
export const POV_GRANULARITIES: readonly string[] = ["scene", "chapter"];

const TOP_KEYS = ["mode", "distance", "default_pov", "allowed_povs", "switch_policy", "exemptions"];
const POLICY_KEYS = ["granularity", "min_gap_chapters", "signal_required"];
const EXEMPTION_KEYS = ["scope", "id", "reason"];

export interface PovSwitchPolicy {
  granularity?: string;
  /** 同一角色再次担任视角之间至少隔几章（F04 §3.6 的"最小切换间隔"） */
  min_gap_chapters?: number;
  /** 切换处是否必须有分隔信号；true 时检查会升级提示 */
  signal_required?: boolean;
}

export interface PovExemption {
  scope: string;
  id: string;
  /** 豁免必须写理由（与一致性豁免清单同一条规矩） */
  reason: string;
}

export interface PovConfig {
  mode?: string;
  distance?: string;
  default_pov?: string;
  allowed_povs?: string[];
  switch_policy?: PovSwitchPolicy;
  exemptions?: PovExemption[];
}

/** 读不下来的配置：调用方把它当"这条检查本轮没跑"处理，不许降级成"没问题" */
export class PovConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PovConfigError";
  }
}

function scalar(value: string): string {
  // JSON 字符串本身就是合法的 YAML 双引号标量：书名带 : 或 # 也不会撑坏配置块
  return JSON.stringify(value);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PovConfigError(`${label} 必须是键值映射`);
  }
  return value as Record<string, unknown>;
}

function checkKeys(keys: readonly string[], allowed: readonly string[], label: string): void {
  const unknown = keys.filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new PovConfigError(`${label} 有代码不认识的键：${unknown.join(", ")}（允许的是 ${allowed.join(" / ")}）`);
  }
}

function optionalString(source: Record<string, unknown>, key: string, label: string): string | undefined {
  const raw = source[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    throw new PovConfigError(`${label}.${key} 必须是非空字符串`);
  }
  return raw.trim();
}

/**
 * 解析 `config/pov.yaml`。
 *
 * 空文本 ⇒ `null`（= 作者还没声明策略），不是空对象：两者在检查层给的结论不同，
 * 空对象会被读成"声明了但没有模式"，那反而更像在猜。
 */
export function parsePovConfig(text: string): PovConfig | null {
  if (text.trim() === "") return null;
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new PovConfigError(`${POV_CONFIG_PATH} 不是合法 YAML：${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || raw === undefined) return null;
  const record = asRecord(raw, POV_CONFIG_PATH);
  checkKeys(Object.keys(record), TOP_KEYS, POV_CONFIG_PATH);

  const mode = optionalString(record, "mode", POV_CONFIG_PATH);
  if (mode !== undefined && !POV_MODES.includes(mode)) {
    throw new PovConfigError(`${POV_CONFIG_PATH} 的 mode「${mode}」不是五种之一：${POV_MODES.join(" / ")}`);
  }
  const distance = optionalString(record, "distance", POV_CONFIG_PATH);
  if (distance !== undefined && !POV_DISTANCES.includes(distance)) {
    throw new PovConfigError(`${POV_CONFIG_PATH} 的 distance「${distance}」不是 ${POV_DISTANCES.join(" / ")} 之一`);
  }

  let allowed: string[] | undefined;
  if (record.allowed_povs !== undefined && record.allowed_povs !== null) {
    if (!Array.isArray(record.allowed_povs) || record.allowed_povs.some((item) => typeof item !== "string")) {
      throw new PovConfigError(`${POV_CONFIG_PATH} 的 allowed_povs 必须是字符串列表`);
    }
    allowed = (record.allowed_povs as string[]).map((item) => item.trim()).filter((item) => item !== "");
  }

  let policy: PovSwitchPolicy | undefined;
  if (record.switch_policy !== undefined && record.switch_policy !== null) {
    const policyRecord = asRecord(record.switch_policy, `${POV_CONFIG_PATH}.switch_policy`);
    checkKeys(Object.keys(policyRecord), POLICY_KEYS, `${POV_CONFIG_PATH}.switch_policy`);
    const granularity = optionalString(policyRecord, "granularity", "switch_policy");
    if (granularity !== undefined && !POV_GRANULARITIES.includes(granularity)) {
      throw new PovConfigError(`switch_policy.granularity「${granularity}」不是 ${POV_GRANULARITIES.join(" / ")} 之一`);
    }
    const gapRaw = policyRecord.min_gap_chapters;
    let gap: number | undefined;
    if (gapRaw !== undefined && gapRaw !== null) {
      if (typeof gapRaw !== "number" || !Number.isInteger(gapRaw) || gapRaw < 0) {
        throw new PovConfigError(
          `switch_policy.min_gap_chapters 必须是 ≥ 0 的整数（拿到 ${JSON.stringify(gapRaw)}）：切换预算的阈值不能是文字或负数`,
        );
      }
      gap = gapRaw;
    }
    const signal = policyRecord.signal_required;
    if (signal !== undefined && signal !== null && typeof signal !== "boolean") {
      throw new PovConfigError("switch_policy.signal_required 必须是 true / false");
    }
    policy = {
      ...(granularity === undefined ? {} : { granularity }),
      ...(gap === undefined ? {} : { min_gap_chapters: gap }),
      ...(typeof signal === "boolean" ? { signal_required: signal } : {}),
    };
  }

  let exemptions: PovExemption[] | undefined;
  if (record.exemptions !== undefined && record.exemptions !== null) {
    if (!Array.isArray(record.exemptions)) {
      throw new PovConfigError(`${POV_CONFIG_PATH} 的 exemptions 必须是列表`);
    }
    exemptions = record.exemptions.map((item, index) => {
      const label = `exemptions[${String(index)}]`;
      const row = asRecord(item, label);
      checkKeys(Object.keys(row), EXEMPTION_KEYS, label);
      const scope = optionalString(row, "scope", label);
      const id = optionalString(row, "id", label);
      const reason = optionalString(row, "reason", label);
      if (scope === undefined || id === undefined) {
        throw new PovConfigError(`${label} 缺 scope 或 id：豁免要指到具体那一章`);
      }
      if (reason === undefined) {
        throw new PovConfigError(`${label} 没写 reason：豁免必须给理由（同一致性豁免清单）`);
      }
      return { scope, id, reason };
    });
  }

  const defaultPov = optionalString(record, "default_pov", POV_CONFIG_PATH);
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(distance === undefined ? {} : { distance }),
    ...(defaultPov === undefined ? {} : { default_pov: defaultPov }),
    ...(allowed === undefined ? {} : { allowed_povs: allowed }),
    ...(policy === undefined ? {} : { switch_policy: policy }),
    ...(exemptions === undefined ? {} : { exemptions }),
  };
}

/** 序列化（键序固定 ⇒ 同一份配置写两次字节一致；未设的字段整行不写） */
export function serializePovConfig(config: PovConfig): string {
  const lines: string[] = ["# 御书视角策略（F04；没有这个文件 = 不声明，检查不会替作者猜模式）"];
  if (config.mode !== undefined) lines.push(`mode: ${scalar(config.mode)}`);
  if (config.distance !== undefined) lines.push(`distance: ${scalar(config.distance)}`);
  if (config.default_pov !== undefined) lines.push(`default_pov: ${scalar(config.default_pov)}`);
  if (config.allowed_povs !== undefined) {
    if (config.allowed_povs.length === 0) lines.push("allowed_povs: []");
    else {
      lines.push("allowed_povs:");
      for (const id of config.allowed_povs) lines.push(`  - ${scalar(id)}`);
    }
  }
  const policy = config.switch_policy;
  if (policy !== undefined) {
    lines.push("switch_policy:");
    if (policy.granularity !== undefined) lines.push(`  granularity: ${scalar(policy.granularity)}`);
    if (policy.min_gap_chapters !== undefined) lines.push(`  min_gap_chapters: ${String(policy.min_gap_chapters)}`);
    if (policy.signal_required !== undefined) lines.push(`  signal_required: ${String(policy.signal_required)}`);
  }
  if (config.exemptions !== undefined && config.exemptions.length > 0) {
    lines.push("exemptions:");
    for (const row of config.exemptions) {
      lines.push(`  - {scope: ${scalar(row.scope)}, id: ${scalar(row.id)}, reason: ${scalar(row.reason)}}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
