/* SPDX-License-Identifier: Apache-2.0 */
import { readCardFile } from "./cards.js";

/**
 * 战力台账（M4 / T4-2 第一条语义规则的数据面，R57）。
 *
 * **分工裁决**：战力"崩没崩"的判定只有一套，写在派系包规则件里（`power-no-regress`），
 * 御书不再另写一份等价判定——两套判定各报各的，作者只会学会忽略红色。
 * 这一层因此只做一件事：把作者记在设定卡 `extensions.power_log` 的结构化台账，
 * 拼成规则要的相邻对 `{a, b}`。R97 起这条台账还能带 `kind / expiry / gain` 三个可选字段，
 * 供 `power-gate.ts` 核对 D03 的 R3（升级三件套）与 R5（临时增益要回落）——**不写就不参与判定**，
 * 老项目的解析结果逐字不变。
 *
 * 拼不出来就**如实报错**：章号认不出、类型不对、同章重复，都返回 error 且不给 entries。
 * 按书写顺序凑一对、或把说不清的那条悄悄丢掉，都会让"没有结论"看起来像"没有问题"。
 */

/** D03 §5 里 `events.types` 那六种（写了 kind 就必须落在这张表里，不同义词、不猜） */
export const POWER_EVENT_KINDS = ["breakthrough", "skill_gain", "item_equip", "injury", "buff", "debuff"] as const;

export type PowerEventKind = (typeof POWER_EVENT_KINDS)[number];

/** D03 R3「新能力三件套」：证据 / 代价 / 复用记录 */
export interface PowerGain {
  evidenceRef: string;
  cost: string;
  reuseRecord: string;
}

/** gain 块里允许的键（未知键一律拒：多一个代码不认识的东西会安静地被忽略） */
export const POWER_GAIN_KEYS = ["evidence_ref", "cost", "reuse_record"] as const;

export interface PowerLogEntry {
  chapter: string;
  chapterNo: number;
  tier: number;
  combatPower: number;
  event?: string;
  /** 这次变更的类型（D03 的六种之一）；不写就不参与 buff 判定 */
  kind?: PowerEventKind;
  /** 临时增益的失效章（kind=buff 却没写它 ⇒ `buff-ttl` 点名） */
  expiry?: string;
  /** 升级三件套；**只要写了这个块就进入逐条核对**（一件都没写时只有一条 info 总述） */
  gain?: Partial<PowerGain>;
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
    let kind: PowerEventKind | undefined;
    if (record.kind !== undefined && record.kind !== null) {
      const rawKind = String(record.kind).trim();
      if (!(POWER_EVENT_KINDS as readonly string[]).includes(rawKind)) {
        return {
          entries: [],
          error:
            `power_log ${label}（${chapter}）的 kind「${rawKind}」不在 D03 的六种事件类型里：` +
            `只能写 ${POWER_EVENT_KINDS.join(" / ")}（不猜同义词，写错就报，别让它安静地不生效）`,
        };
      }
      kind = rawKind as PowerEventKind;
    }
    const expiry = typeof record.expiry === "string" && record.expiry.trim() !== "" ? record.expiry.trim() : undefined;
    let gain: Partial<PowerGain> | undefined;
    if (record.gain !== undefined && record.gain !== null) {
      if (typeof record.gain !== "object" || Array.isArray(record.gain)) {
        return { entries: [], error: `power_log ${label}（${chapter}）的 gain 必须是对象（三件套：${POWER_GAIN_KEYS.join(" / ")}）` };
      }
      const block = record.gain as Record<string, unknown>;
      const unknown = Object.keys(block).filter((key) => !(POWER_GAIN_KEYS as readonly string[]).includes(key));
      if (unknown.length > 0) {
        return {
          entries: [],
          error: `power_log ${label}（${chapter}）的 gain 里有代码不认识的键：${unknown.sort().join("、")}` +
            `（只认 ${POWER_GAIN_KEYS.join(" / ")}；未知键一律拒，静默忽略等于让作者以为记过了）`,
        };
      }
      const read = (key: string): string => (typeof block[key] === "string" ? (block[key] as string).trim() : "");
      const evidenceRef = read("evidence_ref");
      const cost = read("cost");
      const reuseRecord = read("reuse_record");
      gain = {
        ...(evidenceRef === "" ? {} : { evidenceRef }),
        ...(cost === "" ? {} : { cost }),
        ...(reuseRecord === "" ? {} : { reuseRecord }),
      };
    }
    entries.push({
      chapter,
      chapterNo,
      tier,
      combatPower,
      ...(event === "" ? {} : { event }),
      ...(kind === undefined ? {} : { kind }),
      ...(expiry === undefined ? {} : { expiry }),
      ...(gain === undefined ? {} : { gain }),
    });
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
