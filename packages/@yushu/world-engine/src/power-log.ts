import { readCardFile } from "./cards.js";

/**
 * 战力台账（M4 / T4-2 第一条语义规则的数据面，R57）。
 *
 * **分工裁决**：战力"崩没崩"的判定只有一套，写在派系包规则件里（`power-no-regress`），
 * 御书不再另写一份等价判定——两套判定各报各的，作者只会学会忽略红色。
 * 这一层因此只做一件事：把作者记在设定卡 `extensions.power_log` 的结构化台账，
 * 拼成规则要的相邻对 `{a, b}`。
 *
 * 拼不出来就**如实报错**：章号认不出、类型不对、同章重复，都返回 error 且不给 entries。
 * 按书写顺序凑一对、或把说不清的那条悄悄丢掉，都会让"没有结论"看起来像"没有问题"。
 */

export interface PowerLogEntry {
  chapter: string;
  chapterNo: number;
  tier: number;
  combatPower: number;
  event?: string;
}

export interface PowerLogParseResult {
  entries: PowerLogEntry[];
  error: string | null;
}

/** 章号来源：中文「第 N 章/节/回/卷」与内部 id「ch-012 / vol-3」两类都认（只认数字，不猜"序章""终章"） */
const CHAPTER_PATTERNS: readonly RegExp[] = [/第\s*(\d+)\s*[章节回卷]/, /^(?:ch|co|vol)-0*(\d+)/i];

/** 章号解析（台账配对与原文定位共用同一套数字规则，两处各写一份早晚漂移） */
export function powerLogChapterNo(raw: string): number | null {
  for (const pattern of CHAPTER_PATTERNS) {
    const hit = pattern.exec(raw);
    if (hit && hit[1] !== undefined) return Number(hit[1]);
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parsePowerLog(cardText: string): PowerLogParseResult {
  let extensions: Record<string, unknown> | undefined;
  try {
    extensions = readCardFile(cardText).card.extensions as Record<string, unknown> | undefined;
  } catch (err) {
    return { entries: [], error: `设定卡 frontmatter 读不了，无法取战力台账：${err instanceof Error ? err.message : String(err)}` };
  }
  const raw = extensions?.["power_log"];
  if (raw === undefined || raw === null) return { entries: [], error: null };
  if (!Array.isArray(raw)) return { entries: [], error: "extensions.power_log 必须是列表" };
  if (raw.length === 0) return { entries: [], error: null };

  const entries: PowerLogEntry[] = [];
  for (const [index, item] of raw.entries()) {
    const label = `第 ${index + 1} 条`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      return { entries: [], error: `power_log ${label} 不是对象：每条要写 chapter / tier / combat_power` };
    }
    const record = item as Record<string, unknown>;
    const chapter = typeof record.chapter === "string" ? record.chapter.trim() : "";
    if (chapter === "") return { entries: [], error: `power_log ${label} 缺 chapter（要写明是第几章的表现）` };
    const chapterNo = powerLogChapterNo(chapter);
    if (chapterNo === null) {
      return { entries: [], error: `power_log ${label}「${chapter}」取不出章号：相邻配对靠章号排序，认不出就不猜顺序` };
    }
    const tier = finiteNumber(record.tier);
    if (tier === null) return { entries: [], error: `power_log ${label}（${chapter}）的 tier 必须是有限数字` };
    const combatPower = finiteNumber(record.combat_power);
    if (combatPower === null) {
      return { entries: [], error: `power_log ${label}（${chapter}）的 combat_power 必须是有限数字（写成文字战力规则没法比）` };
    }
    const event = typeof record.event === "string" ? record.event.trim() : "";
    entries.push({ chapter, chapterNo, tier, combatPower, ...(event === "" ? {} : { event }) });
  }

  entries.sort((a, b) => {
    if (a.chapterNo !== b.chapterNo) return a.chapterNo - b.chapterNo;
    if (a.chapter !== b.chapter) return a.chapter < b.chapter ? -1 : 1;
    return 0;
  });
  for (let index = 1; index < entries.length; index += 1) {
    const prev = entries[index - 1]!;
    const current = entries[index]!;
    if (prev.chapterNo === current.chapterNo) {
      return {
        entries: [],
        error: `power_log 章号重复（都写作第 ${current.chapterNo} 章：「${prev.chapter}」与「${current.chapter}」）：谁在前不可定，本轮不求值`,
      };
    }
  }
  return { entries, error: null };
}

/** 相邻配对：n 条给 n-1 对（不做跨章组合爆炸，那会把同一次波动重复报几十遍） */
export function pairPowerLog(entries: readonly PowerLogEntry[]): Array<{ a: PowerLogEntry; b: PowerLogEntry }> {
  const pairs: Array<{ a: PowerLogEntry; b: PowerLogEntry }> = [];
  for (let index = 1; index < entries.length; index += 1) pairs.push({ a: entries[index - 1]!, b: entries[index]! });
  return pairs;
}

/** 交给派系包规则的求值数据（形状对齐 `power-no-regress` 里 `var: a.* / b.*` 的取数路径） */
export function powerPairData(pair: { a: PowerLogEntry; b: PowerLogEntry }): Record<string, unknown> {
  return {
    a: { chapter: pair.a.chapter, realm: { tier: pair.a.tier }, combat_power: pair.a.combatPower, ...(pair.a.event ? { event: pair.a.event } : {}) },
    b: { chapter: pair.b.chapter, realm: { tier: pair.b.tier }, combat_power: pair.b.combatPower, ...(pair.b.event ? { event: pair.b.event } : {}) },
  };
}
