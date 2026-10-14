/* SPDX-License-Identifier: Apache-2.0 */
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { YushuError } from "@yushu/core";

/**
 * 规则豁免率与可校准阈值（M4 / T4-11 的后半）。
 *
 * 第 55 轮把 T4-11 留在"未勾选"，理由是**阈值仍是测试里写死的 0**。本轮补的是"可配置"这一半，
 * 但先把一件事说清楚，免得将来有人拿这个数当准确率用：
 *
 * 产品里真正拿得到的信号是**作者把哪些结论豁免掉了**（`config/consistency.yaml`，
 * 每条必须写 reason，是 A6 的审计入口），**不是**"作者标注了这条是误报"。
 * 豁免既可能是"报错了"（真误报），也可能是"确实有问题但我选择留白"。
 * 所以本模块的指标叫**豁免率（suppression rate）**，不叫误报率——
 * 名字撒谎的代价是：等将来真有语料时，历史数字说不清是按哪个口径攒下来的。
 *
 * 四条判定纪律（都是"没判的不能显示成没问题"的具体化）：
 * ① 未配置阈值 ⇒ `not-configured`，**但率照样算出来给作者看**（有数据没结论 ≠ 没数据）；
 * ② 样本不足 ⇒ `insufficient-sample`（两条里豁免一条就是 50%，那不该被当成结论）；
 * ③ 分母为 0 ⇒ `rate: null`（不编造 0%；"从没报过"与"报了且都对"是两回事）；
 * ④ 判定用**严格大于**：正好等于阈值算"还行"，越线才判吵。
 */

export const RULE_STATS_API_VERSION = "yushu.consistency-thresholds/v1";

/**
 * 阈值配置文件路径（**可选文件**，不存在 = 不判）。
 *
 * 为什么不塞进 `config/consistency.yaml`：那份是**作者的豁免决策**（A6 审计入口，逐条带理由与时间），
 * 这份是**判定尺度**。两者生命周期不同——决策会一条条累积，尺度一年调一两次，
 * 混在一个文件里会让"我豁免了什么"被"阈值是多少"淹掉，也让严格解析的未知键规则互相绊住。
 */
export const CONSISTENCY_THRESHOLDS_PATH = "config/consistency-thresholds.yaml";

/** 判定所需的最小样本数缺省值（报出 + 豁免 的总数） */
export const DEFAULT_MIN_SAMPLES = 5;

export interface RuleThresholds {
  /** 豁免率上限（0–1]；缺省 = 不判（只给数据，不下结论） */
  suppression_rate?: number;
  /** 低于该样本数不下结论；缺省见 `DEFAULT_MIN_SAMPLES` */
  min_samples?: number;
}

export interface RuleThresholdConfig extends RuleThresholds {
  apiVersion: string;
}

class RuleStatsError extends YushuError {
  constructor(message: string) {
    super("E_RULE_STATS", message);
  }
}

const TOP_KEYS: readonly string[] = ["apiVersion", "suppression_rate", "min_samples"];

/**
 * 解析 `config/consistency-thresholds.yaml`（**可选文件**，不存在 = 不判）。
 * 与 llm / routing / budget / consistency-allow 同一套严格约定：apiVersion 必须、
 * 未知键一律拒绝（拼错的键被静默忽略，会让护栏以为"未配置"，那比报错更坏）。
 */
export function parseRuleThresholds(text: string): RuleThresholdConfig {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new RuleStatsError(
      `config/consistency-thresholds.yaml 无法解析：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new RuleStatsError("config/consistency-thresholds.yaml 顶层应为映射");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!TOP_KEYS.includes(key)) {
      throw new RuleStatsError(`config/consistency-thresholds.yaml 含未知键「${key}」（拒绝静默忽略）`);
    }
  }
  if (record["apiVersion"] !== RULE_STATS_API_VERSION) {
    throw new RuleStatsError(
      `apiVersion 应为 ${RULE_STATS_API_VERSION}，实际 ${String(record["apiVersion"])}`,
    );
  }
  const config: RuleThresholdConfig = { apiVersion: RULE_STATS_API_VERSION };
  const rate = record["suppression_rate"];
  if (rate !== undefined) {
    if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 1) {
      throw new RuleStatsError(`suppression_rate 应为 (0,1] 内的数值，实际 ${String(rate)}`);
    }
    config.suppression_rate = rate;
  }
  const minSamples = record["min_samples"];
  if (minSamples !== undefined) {
    if (typeof minSamples !== "number" || !Number.isInteger(minSamples) || minSamples < 1) {
      throw new RuleStatsError(`min_samples 应为正整数，实际 ${String(minSamples)}`);
    }
    config.min_samples = minSamples;
  }
  return config;
}

/** 写回配置文件：没写的键**不落盘**（把默认值显式写出来等于把契约钉死在文件里） */
export function serializeRuleThresholds(config: RuleThresholds & { apiVersion?: string }): string {
  const out: Record<string, unknown> = { apiVersion: config.apiVersion ?? RULE_STATS_API_VERSION };
  if (config.suppression_rate !== undefined) out["suppression_rate"] = config.suppression_rate;
  if (config.min_samples !== undefined) out["min_samples"] = config.min_samples;
  return stringifyYaml(out, { lineWidth: 0 });
}

export interface RuleNoiseInput {
  rule: string;
  /** 本次**报出**的条目数（未被豁免的） */
  reported: number;
  /** 本次被豁免掉的条目数 */
  suppressed: number;
}

export type RuleNoiseVerdict = "noisy" | "ok" | "insufficient-sample" | "not-configured";

export interface RuleNoiseRow {
  rule: string;
  reported: number;
  suppressed: number;
  /** 豁免率；分母为 0 时为 null（不编造 0%） */
  rate: number | null;
  verdict: RuleNoiseVerdict;
}

function assertCount(value: number, where: string): void {
  if (!Number.isFinite(value)) {
    throw new RuleStatsError(`${where} 不是有限数值：${String(value)}`);
  }
  if (value < 0) {
    throw new RuleStatsError(`${where} 为负数：${String(value)}（不夹成 0 后继续算，那会把调用方的 bug 藏起来）`);
  }
}

/**
 * 按规则逐条算豁免率并给结论。
 *
 * 排序：豁免率降序（吵的在前），并列按规则 id 的**码点序**（本项目红线：不用 `localeCompare`）。
 */
export function computeRuleNoise(
  rows: readonly RuleNoiseInput[],
  thresholds: RuleThresholds = {},
): RuleNoiseRow[] {
  const minSamples = thresholds.min_samples ?? DEFAULT_MIN_SAMPLES;
  const configured = typeof thresholds.suppression_rate === "number";
  const out: RuleNoiseRow[] = rows.map((row) => {
    assertCount(row.reported, `规则「${row.rule}」的 reported`);
    assertCount(row.suppressed, `规则「${row.rule}」的 suppressed`);
    const total = row.reported + row.suppressed;
    const rate = total === 0 ? null : Math.round((row.suppressed / total) * 10000) / 10000;
    let verdict: RuleNoiseVerdict;
    if (total < minSamples || rate === null) {
      verdict = "insufficient-sample";
    } else if (!configured) {
      verdict = "not-configured";
    } else {
      verdict = rate > (thresholds.suppression_rate as number) ? "noisy" : "ok";
    }
    return { rule: row.rule, reported: row.reported, suppressed: row.suppressed, rate, verdict };
  });
  out.sort((a, b) => {
    const left = a.rate ?? -1;
    const right = b.rate ?? -1;
    if (left !== right) return right - left;
    if (a.rule === b.rule) return 0;
    return a.rule < b.rule ? -1 : 1;
  });
  return out;
}

/**
 * 把逐条规则计数汇总成"每条规则一行"的输入（调用方手上通常只有报告条目）。
 * 分流规则：`suppressed` 侧计数进 suppressed，其余进 reported——**同一 id 两侧都有就分两行计**，
 * 不合并（合并等于把"报了又被豁免"这条最有信息量的情形抹平）。
 */
export function noiseRowsFromEntries(
  entries: readonly { rule: string }[],
  suppressed: readonly { rule: string }[],
): RuleNoiseInput[] {
  const tally = new Map<string, { reported: number; suppressed: number }>();
  const bucket = (rule: string): { reported: number; suppressed: number } => {
    const hit = tally.get(rule);
    if (hit) return hit;
    const fresh = { reported: 0, suppressed: 0 };
    tally.set(rule, fresh);
    return fresh;
  };
  for (const entry of entries) bucket(entry.rule).reported += 1;
  for (const entry of suppressed) bucket(entry.rule).suppressed += 1;
  return [...tally.entries()].map(([rule, counts]) => ({
    rule,
    reported: counts.reported,
    suppressed: counts.suppressed,
  }));
}
