import { MemoryError } from "./errors.js";
import { trackMentions } from "./mentions.js";

/**
 * 注入控制（T3-6；docs/03 §10.1 `injection`）：
 * - `mode`：always（常驻）/ trigger（别名 / 提及关键词命中才注入）/ manual（手动清单显式指定）；
 * - `priority`：预算耗尽时高者先留（0-100，默认 50）；
 * - `position`：after_system | near_start | near_end（组装落位，T3-7 消费）；
 * - `budget_tokens`：单项预算（token 估算，超限截断——绝不静默全量倾倒）；
 * - `reveal_gate`：叙事可见性门控——早于该章（章节实体 id）不注入（J05/A08，防剧透）。
 *
 * 本模块为纯逻辑：输入「可注入条目 + 注入上下文」→ 输出「注入计划（有序）+ 排除清单（带原因）」。
 */

export type InjectionMode = "always" | "trigger" | "manual";
export type InjectionPosition = "after_system" | "near_start" | "near_end";

export interface InjectionConfig {
  mode: InjectionMode;
  priority: number;
  position: InjectionPosition;
  budget_tokens: number;
  /** 叙事可见性门控：早于该章不注入（空 = 无门控） */
  reveal_gate?: string;
}

/** 缺省注入配置（记录未声明时由消费方按层合并；事实/卡片默认 trigger——按提及触发） */
export const DEFAULT_INJECTION: InjectionConfig = {
  mode: "trigger",
  priority: 50,
  position: "near_end",
  budget_tokens: 400,
};

const MODES: readonly InjectionMode[] = ["always", "trigger", "manual"];
const POSITIONS: readonly InjectionPosition[] = ["after_system", "near_start", "near_end"];

/** 落位分组顺序（T3-7 组装按此顺序拼接；同组内按 priority 降序） */
export const POSITION_ORDER: readonly InjectionPosition[] = ["after_system", "near_start", "near_end"];

export interface InjectableItem {
  id: string;
  /** 五层记忆层（world_core=设定卡；fact=事实级；volume_summary / chapter_summary） */
  layer: "world_core" | "fact" | "volume_summary" | "chapter_summary";
  title: string;
  text: string;
  /** 触发关键词（实体名 / 别名 / 事实 keys）——trigger 模式命中这些词才注入 */
  keys: string[];
  config: InjectionConfig;
}

export interface InjectionContext {
  /** 当前章序（全局 1-based；reveal_gate 判定） */
  chapterOrdinal: number;
  /** 门控章节解析：章节实体 id → 全局章序；解析不到返回 null（保守不注入，防剧透优先） */
  ordinalOf?: (chapterId: string) => number | null;
  /** 触发文本（最近正文 / 本章正文）：trigger 模式在此文本中找 keys */
  mentionText?: string;
  /** 手动清单（mode=manual 的显式指定；id 列表） */
  manualIds?: string[];
}

export interface InjectionPlanEntry {
  id: string;
  layer: InjectableItem["layer"];
  title: string;
  position: InjectionPosition;
  priority: number;
  mode: InjectionMode;
  /** 注入文本（按 budget_tokens 截断后的实际内容） */
  text: string;
  /** 截断后 token 估算 */
  tokens: number;
  truncated: boolean;
  /** trigger 模式命中的键（去重按命中顺序） */
  matched_keys: string[];
  /** 决策原因（可解释） */
  reason: string;
}

export interface InjectionExclusion {
  id: string;
  layer: InjectableItem["layer"];
  title: string;
  /** reveal_gate=门控未到 / 无法解析；no_trigger=未命中关键词；no_manual=不在手动清单 */
  code: "reveal_gate" | "no_trigger" | "no_manual";
  reason: string;
}

export interface InjectionPlan {
  entries: InjectionPlanEntry[];
  excluded: InjectionExclusion[];
  /** 注入合计 token 估算（截断后） */
  totalTokens: number;
}

function fail(message: string): never {
  throw new MemoryError("E_MEMORY_MALFORMED", message);
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${what} 应为映射`);
  }
  return value as Record<string, unknown>;
}

/**
 * 解析并校验注入配置（frontmatter `injection`；缺省字段用默认值补齐）。
 * 传入 undefined → 返回默认配置副本。
 */
export function parseInjectionConfig(raw: unknown, owner: string): InjectionConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_INJECTION };
  const record = asRecord(raw, `${owner}.injection`);
  const mode = record["mode"];
  if (mode !== undefined && (typeof mode !== "string" || !MODES.includes(mode as InjectionMode))) {
    fail(`${owner}.injection.mode 应为 ${MODES.join(" | ")}（实际 ${String(mode)}）`);
  }
  const priority = record["priority"];
  if (
    priority !== undefined &&
    (typeof priority !== "number" || !Number.isInteger(priority) || priority < 0 || priority > 100)
  ) {
    fail(`${owner}.injection.priority 应为 0-100 的整数`);
  }
  const position = record["position"];
  if (position !== undefined && (typeof position !== "string" || !POSITIONS.includes(position as InjectionPosition))) {
    fail(`${owner}.injection.position 应为 ${POSITIONS.join(" | ")}（实际 ${String(position)}）`);
  }
  const budget = record["budget_tokens"];
  if (
    budget !== undefined &&
    (typeof budget !== "number" || !Number.isInteger(budget) || budget < 1 || budget > 32768)
  ) {
    fail(`${owner}.injection.budget_tokens 应为 1-32768 的整数`);
  }
  const gate = record["reveal_gate"];
  if (gate !== undefined && (typeof gate !== "string" || gate.trim() === "")) {
    fail(`${owner}.injection.reveal_gate 应为非空章节 id（或省略）`);
  }
  return {
    mode: (mode as InjectionMode | undefined) ?? DEFAULT_INJECTION.mode,
    priority: (priority as number | undefined) ?? DEFAULT_INJECTION.priority,
    position: (position as InjectionPosition | undefined) ?? DEFAULT_INJECTION.position,
    budget_tokens: (budget as number | undefined) ?? DEFAULT_INJECTION.budget_tokens,
    ...(gate ? { reveal_gate: (gate as string).trim() } : {}),
  };
}

/**
 * token 估算（确定性、零依赖；T3-12 换真实分词前的粗口径）：
 * CJK 及全角字符 ≈ 1 token/字；其余非空白字符 ≈ 1 token/4 字符（英文单词量级）；空白不计。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x2e80) cjk += 1;
    else if (!/\s/.test(ch)) other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

/** 按 token 预算截断（超限时保头部 + 省略标记；省略标记计入预算，截断后不显著超限） */
export function truncateToTokens(text: string, budget: number): { text: string; truncated: boolean; tokens: number } {
  const total = estimateTokens(text);
  if (total <= budget) return { text, truncated: false, tokens: total };
  const suffix = "……（截断）";
  const contentBudget = Math.max(1, budget - estimateTokens(suffix));
  let cjk = 0;
  let other = 0;
  let built = "";
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    const nextCjk = cjk + (code >= 0x2e80 ? 1 : 0);
    const nextOther = other + (code >= 0x2e80 || /\s/.test(ch) ? 0 : 1);
    if (nextCjk + Math.ceil(nextOther / 4) > contentBudget) break;
    cjk = nextCjk;
    other = nextOther;
    built += ch;
  }
  const clipped = `${built.trimEnd()}${suffix}`;
  return { text: clipped, truncated: true, tokens: estimateTokens(clipped) };
}

/**
 * 注入决策（T3-6 核心）：
 * 对每个条目依 config 与上下文判定「注入 / 排除」，注入项按 budget 截断、
 * 按 position 分组顺序 + priority 降序排序（同组同优先级按 id 升序，保证确定性）。
 */
export function planInjection(items: InjectableItem[], ctx: InjectionContext): InjectionPlan {
  const entries: InjectionPlanEntry[] = [];
  const excluded: InjectionExclusion[] = [];
  const manual = new Set(ctx.manualIds ?? []);

  for (const item of items) {
    const { config } = item;
    // 1) 叙事可见性门控（最先判定：未到揭示章一律不注入）
    if (config.reveal_gate) {
      const gateOrdinal = ctx.ordinalOf ? ctx.ordinalOf(config.reveal_gate) : null;
      if (gateOrdinal === null) {
        excluded.push({
          id: item.id,
          layer: item.layer,
          title: item.title,
          code: "reveal_gate",
          reason: `reveal_gate「${config.reveal_gate}」无法解析（保守不注入，防剧透优先）`,
        });
        continue;
      }
      if (ctx.chapterOrdinal < gateOrdinal) {
        excluded.push({
          id: item.id,
          layer: item.layer,
          title: item.title,
          code: "reveal_gate",
          reason: `叙事可见性门控：早于「${config.reveal_gate}」（第 ${gateOrdinal} 章）不注入（当前第 ${ctx.chapterOrdinal} 章）`,
        });
        continue;
      }
    }
    // 2) 模式判定
    let matchedKeys: string[] = [];
    let reason = "always（常驻）";
    if (config.mode === "manual") {
      if (!manual.has(item.id)) {
        excluded.push({
          id: item.id,
          layer: item.layer,
          title: item.title,
          code: "no_manual",
          reason: "manual 模式：不在手动清单中（需显式指定注入）",
        });
        continue;
      }
      reason = "manual（手动清单指定）";
    } else if (config.mode === "trigger") {
      const keySet = [...new Set(item.keys.map((key) => key.trim()).filter((key) => key !== ""))];
      const hits = trackMentions(ctx.mentionText ?? "", keySet.map((key) => ({ id: key, name: key })));
      matchedKeys = [...new Set(hits.map((hit) => hit.matched))];
      if (matchedKeys.length === 0) {
        excluded.push({
          id: item.id,
          layer: item.layer,
          title: item.title,
          code: "no_trigger",
          reason: `trigger 模式：未命中触发关键词（${keySet.slice(0, 6).join("、") || "无关键词"}）`,
        });
        continue;
      }
      reason = `trigger（命中 ${matchedKeys.join("、")}）`;
    }
    // 3) 预算截断 + 入列
    const clipped = truncateToTokens(item.text, config.budget_tokens);
    entries.push({
      id: item.id,
      layer: item.layer,
      title: item.title,
      position: config.position,
      priority: config.priority,
      mode: config.mode,
      text: clipped.text,
      tokens: clipped.tokens,
      truncated: clipped.truncated,
      matched_keys: matchedKeys,
      reason,
    });
  }

  entries.sort((a, b) => {
    const pos = POSITION_ORDER.indexOf(a.position) - POSITION_ORDER.indexOf(b.position);
    if (pos !== 0) return pos;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id.localeCompare(b.id);
  });
  return {
    entries,
    excluded,
    totalTokens: entries.reduce((sum, entry) => sum + entry.tokens, 0),
  };
}