/* SPDX-License-Identifier: Apache-2.0 */
import { YushuError } from "@yushu/core";
import type { Foreshadow, ForeshadowCarrier, ForeshadowState, ForeshadowVisibility } from "@yushu/core";
import { parseDocument } from "yaml";
import { powerLogChapterNo } from "./power-log.js";

/**
 * 伏笔全生命周期台账（M4 / T4-6 引擎侧，R65）。
 *
 * 真源：`world/foreshadow.yaml`（作者手写、可 diff、可回滚）。这一层**只做判定不做 IO**，
 * 因为"契诃夫之枪有没有兑现"是数据模型的判断，不该跟着进程边界走（桌面端只负责读文件与画表）。
 *
 * 三条口径决定了这份台账值不值得信：
 * ① **合法终态不报缺陷**：红鲱鱼与"主动放弃 + 理由"都是正当写法。把它们报成问题，
 *    作者学会忽略整块看板——那比没有看板更坏。
 * ② **不替作者改状态**：说"已回收"却没有回收章，报的是矛盾，不是把状态悄悄改成未回收。
 *    引擎没有资格判定"作者其实想写什么"。
 * ③ **默认不猜阈值**：多少章没伏笔算"干旱"在流派间差得离谱（凡人流慢热 vs 系统流快节奏），
 *    没有真实语料定标之前该规则**默认关闭**，只有显式传参才报。同一条规矩见 T4-11 的误报阈值。
 */

export const FORESHADOW_API_VERSION = "yushu.foreshadow/v1";

export interface ForeshadowLedger {
  apiVersion: typeof FORESHADOW_API_VERSION;
  entries: Foreshadow[];
}

const CARRIERS: readonly ForeshadowCarrier[] = ["道具", "对白", "意象", "事件", "传闻"];
const VISIBILITIES: readonly ForeshadowVisibility[] = ["显写", "半遮", "藏枪"];
const STATES: readonly ForeshadowState[] = ["planted", "reinforced", "due", "paid", "abandoned"];

/**
 * 本模块可能产出的**全部结论规则 id**（R75 导出）。
 *
 * 伏笔结论要并入全书体检（T4-2 / T4-3），而豁免清单只放行"本次真的参与求值的规则"——
 * 所以这份清单必须与代码同源，漏一条就会出现"结论报得出来、却豁免不掉"。
 * 新增规则没补进来时，`foreshadow.test.ts` 的覆盖锁（扫源码里的 `fs-` 字面量）会红。
 */
export const FORESHADOW_RULE_IDS = [
  "fs-abandon-reason-missing",
  "fs-dangling-chapter",
  "fs-density-drought",
  "fs-density-storm",
  "fs-finale-unpaid",
  "fs-no-chapters",
  "fs-overdue",
  "fs-paid-without-payoff",
  "fs-payoff-before-plant",
  "fs-recheck",
  "fs-red-herring-paid",
] as const;

/** 必填键：缺任何一条都拒绝整份台账，而不是把那条丢掉（半读半丢最坏） */
const REQUIRED_KEYS = [
  "id",
  "name",
  "promise",
  "carrier",
  "visibility",
  "state",
  "plant_chapters",
  "expected_payoff_chapter",
  "payoff_type",
  "is_red_herring",
  "recheck_after",
] as const;

/** 可选键：`payoff_chapters` 是 R65 为「回收标记」补的字段（docs/03 §5.3 原来只有预期回收章） */
const OPTIONAL_KEYS = ["abandon_reason", "payoff_chapters"] as const;

const KNOWN_KEYS = new Set<string>([...REQUIRED_KEYS, ...OPTIONAL_KEYS]);

function fail(message: string): never {
  throw new YushuError("E_FORESHADOW_PARSE", message);
}

function str(value: unknown, label: string, key: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} 的 ${key} 必填且须为非空字符串`);
  return value as string;
}

function strList(value: unknown, label: string, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${label} 的 ${key} 必须是列表`);
  const out: string[] = [];
  for (const [i, item] of (value as unknown[]).entries()) {
    if (typeof item !== "string" || item.trim() === "") fail(`${label} 的 ${key}[${i}] 须为非空字符串（章 id）`);
    out.push(item as string);
  }
  return out;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string, key: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${label} 的 ${key}「${String(value)}」非法值（可选：${allowed.join("/")}）`);
  }
  return value as T;
}

/** 严格解析：未知键、非法枚举、重复 id、缺必填一律拒绝并点名到条目 */
export function parseForeshadowLedger(text: string): ForeshadowLedger {
  let doc: unknown;
  try {
    doc = parseDocument(text, { uniqueKeys: true }).toJS();
  } catch (err) {
    return fail(`台账 YAML 读不了：${err instanceof Error ? err.message : String(err)}`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) fail("台账根必须是映射（apiVersion + entries）");
  const root = doc as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (key !== "apiVersion" && key !== "entries") fail(`根级未知键「${key}」（只认 apiVersion / entries）`);
  }
  if (root.apiVersion !== FORESHADOW_API_VERSION) {
    fail(`apiVersion 须为 ${FORESHADOW_API_VERSION}（收到「${String(root.apiVersion)}」）`);
  }
  if (root.entries !== undefined && root.entries !== null && !Array.isArray(root.entries)) fail("entries 必须是列表");

  const entries: Foreshadow[] = [];
  const seen = new Set<string>();
  for (const [index, item] of ((root.entries ?? []) as unknown[]).entries()) {
    const label = `entries[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) fail(`${label} 不是对象`);
    const raw = item as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!KNOWN_KEYS.has(key)) fail(`${label}（${String(raw.id ?? "?")}）有未知键「${key}」，不在伏笔字段表里`);
    }
    for (const key of REQUIRED_KEYS) {
      if (raw[key] === undefined || raw[key] === null) fail(`${label} 缺必填字段 ${key}`);
    }
    const id = str(raw.id, label, "id");
    if (seen.has(id)) fail(`id 重复：${id}（台账按 id 定位，撞号等于两条并成一条）`);
    seen.add(id);
    if (typeof raw.is_red_herring !== "boolean") fail(`${label}（${id}）的 is_red_herring 必须是 true/false`);
    const recheck = typeof raw.recheck_after === "number" && Number.isInteger(raw.recheck_after) && raw.recheck_after > 0
      ? raw.recheck_after
      : null;
    if (recheck === null) fail(`${label}（${id}）的 recheck_after 须为正整数（每隔多少章复查一次）`);
    const entry: Foreshadow = {
      id,
      name: str(raw.name, label, "name"),
      promise: str(raw.promise, label, "promise"),
      plant_chapters: strList(raw.plant_chapters, label, "plant_chapters"),
      carrier: oneOf(raw.carrier, CARRIERS, label, "carrier"),
      visibility: oneOf(raw.visibility, VISIBILITIES, label, "visibility"),
      expected_payoff_chapter: str(raw.expected_payoff_chapter, label, "expected_payoff_chapter"),
      payoff_type: str(raw.payoff_type, label, "payoff_type"),
      is_red_herring: raw.is_red_herring as boolean,
      state: oneOf(raw.state, STATES, label, "state"),
      recheck_after: recheck,
    };
    if (raw.payoff_chapters !== undefined && raw.payoff_chapters !== null) {
      entry.payoff_chapters = strList(raw.payoff_chapters, label, "payoff_chapters");
    }
    if (raw.abandon_reason !== undefined && raw.abandon_reason !== null) {
      entry.abandon_reason = str(raw.abandon_reason, label, "abandon_reason");
    }
    entries.push(entry);
  }
  return { apiVersion: FORESHADOW_API_VERSION, entries };
}

/** 手写序列化：键序固定 ⇒ 同内容同字节（交给 YAML 库 dump 会随版本改键序，diff 会淹死作者） */
export function serializeForeshadowLedger(ledger: ForeshadowLedger): string {
  const lines: string[] = [`apiVersion: ${FORESHADOW_API_VERSION}`, "entries:"];
  if (ledger.entries.length === 0) return `${lines.join("\n")}\n`;
  for (const entry of ledger.entries) {
    lines.push(`  - id: ${entry.id}`);
    lines.push(`    name: ${JSON.stringify(entry.name)}`);
    lines.push(`    promise: ${JSON.stringify(entry.promise)}`);
    lines.push(`    carrier: ${entry.carrier}`);
    lines.push(`    visibility: ${entry.visibility}`);
    lines.push(`    state: ${entry.state}`);
    lines.push(`    plant_chapters: ${JSON.stringify(entry.plant_chapters)}`);
    lines.push(`    expected_payoff_chapter: ${entry.expected_payoff_chapter}`);
    lines.push(`    payoff_chapters: ${JSON.stringify(entry.payoff_chapters ?? [])}`);
    lines.push(`    payoff_type: ${JSON.stringify(entry.payoff_type)}`);
    lines.push(`    is_red_herring: ${String(entry.is_red_herring)}`);
    lines.push(`    recheck_after: ${String(entry.recheck_after)}`);
    if (entry.abandon_reason !== undefined) lines.push(`    abandon_reason: ${JSON.stringify(entry.abandon_reason)}`);
  }
  return `${lines.join("\n")}\n`;
}

export type ForeshadowSeverity = "error" | "warn" | "info";

export interface ForeshadowFinding {
  id: string;
  severity: ForeshadowSeverity;
  rule: string;
  message: string;
}

export interface ForeshadowRow {
  id: string;
  name: string;
  state: ForeshadowState;
  /** open = 还欠读者一个兑现；closed = 已回收或已带理由放弃 */
  board: "open" | "closed";
  isRedHerring: boolean;
  /** 距预期回收已过去几章（负数=还没到；无法定位时 null，不编 0） */
  overdueBy: number | null;
  /** 距最近一次伏笔动作（埋设或回收）几章 */
  sinceAction: number | null;
}

export interface ForeshadowBoardOptions {
  /** 全书章节 id 的**顺序清单**（来自三级大纲或磁盘章序）；空清单时不编造进度 */
  chapters: string[];
  /** 写到哪一章；缺省取清单最后一章 */
  currentChapter?: string;
  /** 终局窗口：最后 N 章内仍未回收 ⇒ error */
  finaleWindow?: number;
  /** 单章埋设数超过它 ⇒ 密度提示 */
  maxPlantsPerChapter?: number;
  /** 连续 N 章无任何伏笔动作 ⇒ 干旱提示；**0 或缺省=关闭**（阈值未经真实语料定标） */
  droughtChapters?: number;
}

const OPEN_STATES: readonly ForeshadowState[] = ["planted", "reinforced", "due"];

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * 章序号：先按 id 精确匹配，再退到"第 N 章 / ch-012"这类数字口径；都认不出返回 null。
 *
 * 数字口径有**两种**，顺序不能反：先认"id 里带这个数"（老项目把章编进 id，如 `ch-012`），
 * 再认"有序清单里的第 N 章"（作者的自然写法——大纲生成的 id 是随机后缀 `ch-q5wbog`，
 * 只按 id 比数字的话「第 1 章」永远定位不到，会被误报成悬空。R75 并入体检时被测试当场抓到）。
 * 超出清单长度仍返回 null：不夹到最后一章，"没这一章"和"我数错了"是两回事。
 */
function chapterIndex(chapters: string[], indexById: Map<string, number>, ref: string): number | null {
  const exact = indexById.get(ref);
  if (exact !== undefined) return exact;
  const num = powerLogChapterNo(ref);
  if (num === null) return null;
  for (const [index, id] of chapters.entries()) {
    if (powerLogChapterNo(id) === num) return index;
  }
  return num >= 1 && num <= chapters.length ? num - 1 : null;
}

/** 台账看板：逐条状态 + 逾期/复查/密度/终局判定。纯函数，同输入同输出 */
export function buildForeshadowBoard(
  ledger: ForeshadowLedger,
  options: ForeshadowBoardOptions,
): { rows: ForeshadowRow[]; findings: ForeshadowFinding[]; stats: Record<string, number> } {
  const chapters = options.chapters;
  const indexById = new Map(chapters.map((id, index) => [id, index]));
  const finaleWindow = options.finaleWindow ?? 5;
  const maxPlants = options.maxPlantsPerChapter ?? 3;
  const drought = options.droughtChapters ?? 0;
  const currentRef = options.currentChapter ?? chapters[chapters.length - 1];
  const current = currentRef === undefined ? null : chapterIndex(chapters, indexById, currentRef);

  const findings: ForeshadowFinding[] = [];
  const push = (id: string, severity: ForeshadowSeverity, rule: string, message: string): void => {
    findings.push({ id, severity, rule, message });
  };

  if (chapters.length === 0) {
    push("-", "error", "fs-no-chapters", "章清单为空：无法定位埋设/回收章，也不编造进度（先看三级大纲有没有建）");
  }

  const rows: ForeshadowRow[] = [];
  const plantsByChapter = new Map<string, string[]>();

  for (const entry of ledger.entries) {
    const label = `${entry.id}（${entry.name}）`;
    const isOpen = OPEN_STATES.includes(entry.state);
    const refs: { key: string; value: string }[] = [
      ...entry.plant_chapters.map((value) => ({ key: "plant_chapters", value })),
      { key: "expected_payoff_chapter", value: entry.expected_payoff_chapter },
      ...(entry.payoff_chapters ?? []).map((value) => ({ key: "payoff_chapters", value })),
    ];
    const indexByRef = new Map<string, number>();
    for (const ref of refs) {
      const at = chapterIndex(chapters, indexById, ref.value);
      if (at === null) {
        push(entry.id, "error", "fs-dangling-chapter", `${label} 的 ${ref.key}「${ref.value}」不在章清单里（章号写错或章还没建）`);
      } else {
        indexByRef.set(ref.value, at);
      }
    }
    for (const chapter of entry.plant_chapters) {
      const bucket = plantsByChapter.get(chapter) ?? [];
      bucket.push(entry.id);
      plantsByChapter.set(chapter, bucket);
    }

    const plantIndexes = entry.plant_chapters.map((value) => indexByRef.get(value)).filter((v): v is number => v !== undefined);
    const payoffIndexes = (entry.payoff_chapters ?? []).map((value) => indexByRef.get(value)).filter((v): v is number => v !== undefined);
    const expectedIndex = indexByRef.get(entry.expected_payoff_chapter) ?? null;

    if (plantIndexes.length > 0 && expectedIndex !== null) {
      const earliestPlant = Math.min(...plantIndexes);
      if (expectedIndex < earliestPlant) {
        push(entry.id, "warn", "fs-payoff-before-plant", `${label} 的预期回收章早于最早埋设章（第 ${earliestPlant + 1} 章埋、第 ${expectedIndex + 1} 章收）`);
      }
    }

    let overdueBy: number | null = null;
    if (isOpen && current !== null && expectedIndex !== null) {
      overdueBy = current - expectedIndex;
      if (overdueBy > 0) {
        const nearEnd = chapters.length > 0 && current >= chapters.length - finaleWindow;
        if (nearEnd) {
          push(entry.id, "error", "fs-finale-unpaid", `${label} 已逾期 ${overdueBy} 章且已进入终局窗口（最后 ${finaleWindow} 章）：结局承诺清算前必须回收或写明放弃理由`);
        } else {
          push(entry.id, "warn", "fs-overdue", `${label} 逾期 ${overdueBy} 章未回收（预期第 ${expectedIndex + 1} 章）`);
        }
      }
    }

    if (entry.state === "paid" && (entry.payoff_chapters ?? []).length === 0) {
      push(entry.id, "warn", "fs-paid-without-payoff", `${label} 状态是 paid 却没有回收章：报矛盾，不替作者改状态`);
    }
    if (entry.state === "paid" && entry.is_red_herring) {
      push(entry.id, "warn", "fs-red-herring-paid", `${label} 标了红鲱鱼却又"回收"：红鲱鱼应当被点破（abandoned + 理由），不该兑现`);
    }
    if (entry.state === "abandoned" && (entry.abandon_reason ?? "").trim() === "") {
      push(entry.id, "error", "fs-abandon-reason-missing", `${label} 放弃了却没写 abandon_reason（与一致性豁免同一条规矩：不记理由不算豁免）`);
    }

    const actionIndexes = [...plantIndexes, ...payoffIndexes];
    const sinceAction = isOpen && current !== null && actionIndexes.length > 0 ? current - Math.max(...actionIndexes) : null;
    if (isOpen && sinceAction !== null && sinceAction >= entry.recheck_after) {
      push(entry.id, "info", "fs-recheck", `${label} 距上次伏笔动作已 ${sinceAction} 章（复查间隔 ${entry.recheck_after}）：该强化、该回收还是该放弃，现在定比结尾补写便宜`);
    }

    rows.push({
      id: entry.id,
      name: entry.name,
      state: entry.state,
      board: isOpen ? "open" : "closed",
      isRedHerring: entry.is_red_herring,
      overdueBy: overdueBy !== null && overdueBy > 0 ? overdueBy : null,
      sinceAction,
    });
  }

  for (const [chapter, ids] of [...plantsByChapter.entries()].sort((a, b) => byCodePoint(a[0], b[0]))) {
    if (ids.length > maxPlants) {
      push("-", "warn", "fs-density-storm", `${chapter} 一章埋了 ${ids.length} 条伏笔（阈值 ${maxPlants}）：${ids.sort(byCodePoint).join("、")}——读者记不住，后面只能靠旁白提醒`);
    }
  }

  if (drought > 0 && current !== null) {
    let lastAction = -1;
    for (const entry of ledger.entries) {
      for (const chapter of [...entry.plant_chapters, ...(entry.payoff_chapters ?? [])]) {
        const at = chapterIndex(chapters, indexById, chapter);
        if (at !== null && at > lastAction) lastAction = at;
      }
    }
    const gap = lastAction < 0 ? current + 1 : current - lastAction;
    if (gap >= drought) {
      push("-", "info", "fs-density-drought", `已连续 ${gap} 章没有任何伏笔动作（阈值 ${drought}）：这条阈值未经真实语料定标，只在显式开启时提示`);
    }
  }

  rows.sort((a, b) => byCodePoint(a.id, b.id));
  findings.sort((a, b) => byCodePoint(`${a.id}\u0000${a.rule}`, `${b.id}\u0000${b.rule}`));

  const count = (predicate: (entry: Foreshadow) => boolean): number => ledger.entries.filter(predicate).length;
  const stats: Record<string, number> = {
    total: ledger.entries.length,
    open: count((entry) => OPEN_STATES.includes(entry.state)),
    closed: count((entry) => !OPEN_STATES.includes(entry.state)),
    planted: count((entry) => entry.state === "planted"),
    reinforced: count((entry) => entry.state === "reinforced"),
    due: count((entry) => entry.state === "due"),
    paid: count((entry) => entry.state === "paid"),
    abandoned: count((entry) => entry.state === "abandoned"),
    redHerring: count((entry) => entry.is_red_herring),
    overdue: rows.filter((row) => row.overdueBy !== null && row.overdueBy > 0).length,
  };
  return { rows, findings, stats };
}
