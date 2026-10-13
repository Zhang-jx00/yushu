import { YushuError } from "@yushu/core";
import { parseDocument } from "yaml";
import { powerLogChapterNo } from "./power-log.js";

/**
 * 爽点与期待感台账（M4 / T4-10 引擎侧，R72）。
 *
 * 真源：`world/satisfaction.yaml`。这一层只做判定不做 IO，同 foreshadow / timeline 的分工。
 *
 * 三条口径先说清楚，否则这块看板会骗人：
 * ① **爽点是曲线上的释放点，期待感是整条曲线**（I03 §1）——所以引擎算的是"隔多久没释放、
 *    压抑连了多少章、承诺欠着没还"这类**间隔与计数**，不预测者"这章读起来爽不爽"。
 * ② **推进率只算作者声明的账**（I04 §3.2）：`advances` 是场景卡上作者自己写的"这场戏推进了谁"，
 *    引擎据此算占比；没有声明就是**不判定**，绝不拿字数反推"这段是不是水"——那是 `@yushu/text`
 *    的字句级 lint（T3-13）与语义判断的活，两套口径不互相冒充。
 * ③ **阈值默认关闭**：I03/I04 给的数字（连续 3 章同类型、5 章无强释放、6 条未决承诺…）是
 *    带"可按基调/派系包覆写"条件的经验值，未经真实语料定标前**不设就不报**，并逐条进 `notEvaluated`
 *    写明缺哪个旋钮——"没判的"要看得见，不能算通过。
 */

export const SATISFACTION_API_VERSION = "yushu.satisfaction/v1";

export type SatisfactionHitType = "face_slap" | "upgrade" | "harvest" | "show" | "reveal" | "sweet";
export type PromiseStatus = "open" | "paying" | "paid" | "deferred" | "dropped";
export type CurvePhase = "suppress" | "build" | "release" | "aftermath";
export type SceneOutcome = "yes" | "no" | "partial";

const HIT_TYPES: readonly SatisfactionHitType[] = ["face_slap", "upgrade", "harvest", "show", "reveal", "sweet"];
const BENEFICIARIES = ["主角", "女主", "配角", "读者情绪"] as const;
const PROMISE_STATUSES: readonly PromiseStatus[] = ["open", "paying", "paid", "deferred", "dropped"];
const CURVE_PHASES: readonly CurvePhase[] = ["suppress", "build", "release", "aftermath"];
const SCENE_OUTCOMES: readonly SceneOutcome[] = ["yes", "no", "partial"];

export interface SatisfactionHit {
  id: string;
  chapter: string;
  type: SatisfactionHitType;
  /** -5~5：负值是"憋"（压抑段里的负面事件），正值才是释放 */
  intensity: number;
  beneficiary: string;
  /** 兑现的是哪条承诺；指向不存在的承诺 ⇒ error（承诺清单与爽点台账必须连得上） */
  promise_id?: string;
}

export interface PromiseEntry {
  id: string;
  promise: string;
  /** 承诺从哪儿来的：简介 / 台词 / 核心梗 / 卷末预告……（I03 §2.2：与伏笔的载体不同） */
  source: string;
  made_ch: string;
  due_ch?: string;
  status: PromiseStatus;
  /** dropped 是合法终态，但必须写理由 */
  drop_reason?: string;
  /** 与伏笔台账的交叉引用：同一件事靠伏笔兑现时在这里挂上，避免两边各写一份 */
  foreshadow_id?: string;
}

export interface CurveSegment {
  phase: CurvePhase;
  from_ch: string;
  to_ch: string;
}

export interface SceneUnit {
  id: string;
  chapter: string;
  /** main / sub-<id> / none；含 none 又含别的 ⇒ 矛盾，引擎不自行取舍 */
  advances: string[];
  outcome: SceneOutcome;
  tension_delta?: number;
}

export interface SatisfactionThresholds {
  /** 连续多少章同一种爽点类型算同质化（I03 L96） */
  same_type_streak_max?: number;
  /** 连续多少章没有强释放点 ⇒ 期待感断档（G05 release_interval_max） */
  release_interval_max?: number;
  /** intensity 达到多少算"强释放"（配 release_interval_max 用） */
  strong_intensity?: number;
  /** 压抑相位连多少章算"憋屈欠账"（G05 suppress_streak_max） */
  suppress_streak_max?: number;
  /** 未决承诺同时挂着几条算超载（I03 promise_open_max） */
  promise_open_max?: number;
  /** 连续几个场景无推进 ⇒ 该删（I04 pacing-no-advance） */
  no_advance_streak?: number;
}

export const THRESHOLD_KEYS = [
  "same_type_streak_max",
  "release_interval_max",
  "strong_intensity",
  "suppress_streak_max",
  "promise_open_max",
  "no_advance_streak",
] as const;

export interface SatisfactionLedger {
  apiVersion: typeof SATISFACTION_API_VERSION;
  thresholds?: SatisfactionThresholds;
  hits: SatisfactionHit[];
  promises: PromiseEntry[];
  curve: CurveSegment[];
  scenes: SceneUnit[];
}

const ROOT_KEYS = ["apiVersion", "thresholds", "hits", "promises", "curve", "scenes"] as const;
const HIT_KEYS = ["id", "chapter", "type", "intensity", "beneficiary", "promise_id"] as const;
const PROMISE_KEYS = ["id", "promise", "source", "made_ch", "due_ch", "status", "drop_reason", "foreshadow_id"] as const;
const CURVE_KEYS = ["phase", "from_ch", "to_ch"] as const;
const SCENE_KEYS = ["id", "chapter", "advances", "outcome", "tension_delta"] as const;

function fail(message: string): never {
  throw new YushuError("E_SATISFACTION_PARSE", message);
}

function str(value: unknown, label: string, key: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} 的 ${key} 必填且须为非空字符串`);
  return value as string;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string, key: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(`${label} 的 ${key}「${String(value)}」非法值（可选：${allowed.join("/")}）`);
  }
  return value as T;
}

function assertKnownKeys(raw: Record<string, unknown>, allowed: readonly string[], label: string, hint: string): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) fail(`${label} 有未知键「${key}」，不在${hint}字段表里`);
  }
}

function requireKeys(raw: Record<string, unknown>, required: readonly string[], label: string): void {
  for (const key of required) {
    if (raw[key] === undefined || raw[key] === null) fail(`${label} 缺必填字段 ${key}`);
  }
}

function posInt(value: unknown, label: string, key: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    fail(`${label} 的 ${key} 须为正整数（收到「${String(value)}」）`);
  }
  return value as number;
}

function advanceTag(value: unknown, label: string, index: number): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} 的 advances[${index}] 须为非空字符串`);
  const tag = value as string;
  if (tag !== "main" && tag !== "none" && !/^sub-\S+$/.test(tag)) {
    fail(`${label} 的 advances[${index}]「${tag}」非法（只接受 main / sub-<支线id> / none）`);
  }
  return tag;
}

/** 严格解析：未知键、非法枚举、重复 id、越界数字一律拒绝并点名到条目 */
export function parseSatisfactionFile(text: string): SatisfactionLedger {
  let doc: unknown;
  try {
    doc = parseDocument(text, { uniqueKeys: true }).toJS();
  } catch (err) {
    return fail(`台账 YAML 读不了：${err instanceof Error ? err.message : String(err)}`);
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    fail("台账根必须是映射（apiVersion + hits / promises / curve / scenes）");
  }
  const root = doc as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!ROOT_KEYS.includes(key as (typeof ROOT_KEYS)[number])) {
      fail(`根级未知键「${key}」（只认 ${ROOT_KEYS.join(" / ")}）`);
    }
  }
  if (root.apiVersion !== SATISFACTION_API_VERSION) {
    fail(`apiVersion 须为 ${SATISFACTION_API_VERSION}（收到「${String(root.apiVersion)}」）`);
  }
  const list = (value: unknown, key: string): unknown[] => {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) fail(`${key} 必须是列表`);
    return value as unknown[];
  };

  const ledger: SatisfactionLedger = {
    apiVersion: SATISFACTION_API_VERSION,
    hits: [],
    promises: [],
    curve: [],
    scenes: [],
  };

  if (root.thresholds !== undefined && root.thresholds !== null) {
    if (typeof root.thresholds !== "object" || Array.isArray(root.thresholds)) fail("thresholds 必须是映射");
    const raw = root.thresholds as Record<string, unknown>;
    assertKnownKeys(raw, THRESHOLD_KEYS, "thresholds", "阈值");
    const thresholds: SatisfactionThresholds = {};
    for (const key of THRESHOLD_KEYS) {
      const value = raw[key];
      if (value === undefined || value === null) continue;
      if (key === "strong_intensity") {
        if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 5) {
          fail("thresholds 的 strong_intensity 须为 1~5 的整数（它是 intensity 的量纲）");
        }
        thresholds.strong_intensity = value;
      } else {
        (thresholds as unknown as Record<string, number>)[key] = posInt(value, "thresholds", key);
      }
    }
    if (Object.keys(thresholds).length > 0) ledger.thresholds = thresholds;
  }

  const seen = new Set<string>();
  const uniqueId = (id: string, label: string): string => {
    if (seen.has(id)) fail(`id 重复：${id}（${label} 撞号等于两条并成一条）`);
    seen.add(id);
    return id;
  };

  for (const [index, item] of list(root.hits, "hits").entries()) {
    const label = `hits[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) fail(`${label} 不是对象`);
    const raw = item as Record<string, unknown>;
    assertKnownKeys(raw, HIT_KEYS, label, "爽点");
    requireKeys(raw, ["id", "chapter", "type", "intensity", "beneficiary"], label);
    const id = uniqueId(str(raw.id, label, "id"), "爽点");
    if (typeof raw.intensity !== "number" || !Number.isInteger(raw.intensity) || raw.intensity < -5 || raw.intensity > 5) {
      fail(`${label}（${id}）的 intensity 须为 -5~5 的整数（收到「${String(raw.intensity)}」）`);
    }
    const hit: SatisfactionHit = {
      id,
      chapter: str(raw.chapter, label, "chapter"),
      type: oneOf(raw.type, HIT_TYPES, label, "type"),
      intensity: raw.intensity as number,
      beneficiary: oneOf(raw.beneficiary, BENEFICIARIES, label, "beneficiary"),
    };
    if (raw.promise_id !== undefined && raw.promise_id !== null) {
      hit.promise_id = str(raw.promise_id, label, "promise_id");
    }
    ledger.hits.push(hit);
  }

  for (const [index, item] of list(root.promises, "promises").entries()) {
    const label = `promises[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) fail(`${label} 不是对象`);
    const raw = item as Record<string, unknown>;
    assertKnownKeys(raw, PROMISE_KEYS, label, "承诺");
    requireKeys(raw, ["id", "promise", "source", "made_ch", "status"], label);
    const entry: PromiseEntry = {
      id: uniqueId(str(raw.id, label, "id"), "承诺"),
      promise: str(raw.promise, label, "promise"),
      source: str(raw.source, label, "source"),
      made_ch: str(raw.made_ch, label, "made_ch"),
      status: oneOf(raw.status, PROMISE_STATUSES, label, "status"),
    };
    for (const key of ["due_ch", "drop_reason", "foreshadow_id"] as const) {
      const value = raw[key];
      if (value !== undefined && value !== null) {
        (entry as unknown as Record<string, string>)[key] = str(value, label, key);
      }
    }
    ledger.promises.push(entry);
  }

  for (const [index, item] of list(root.curve, "curve").entries()) {
    const label = `curve[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) fail(`${label} 不是对象`);
    const raw = item as Record<string, unknown>;
    assertKnownKeys(raw, CURVE_KEYS, label, "曲线相位");
    requireKeys(raw, ["phase", "from_ch", "to_ch"], label);
    ledger.curve.push({
      phase: oneOf(raw.phase, CURVE_PHASES, label, "phase"),
      from_ch: str(raw.from_ch, label, "from_ch"),
      to_ch: str(raw.to_ch, label, "to_ch"),
    });
  }

  for (const [index, item] of list(root.scenes, "scenes").entries()) {
    const label = `scenes[${index}]`;
    if (item === null || typeof item !== "object" || Array.isArray(item)) fail(`${label} 不是对象`);
    const raw = item as Record<string, unknown>;
    assertKnownKeys(raw, SCENE_KEYS, label, "场景");
    requireKeys(raw, ["id", "chapter", "advances", "outcome"], label);
    if (!Array.isArray(raw.advances) || (raw.advances as unknown[]).length === 0) {
      fail(`${label} 的 advances 必须是非空列表（写了场景就得说它推进了谁）`);
    }
    const advances = (raw.advances as unknown[]).map((tag, i) => advanceTag(tag, label, i));
    const scene: SceneUnit = {
      id: uniqueId(str(raw.id, label, "id"), "场景"),
      chapter: str(raw.chapter, label, "chapter"),
      advances,
      outcome: oneOf(raw.outcome, SCENE_OUTCOMES, label, "outcome"),
    };
    if (raw.tension_delta !== undefined && raw.tension_delta !== null) {
      const delta = raw.tension_delta;
      if (typeof delta !== "number" || !Number.isFinite(delta)) fail(`${label} 的 tension_delta 须为有限数字`);
      scene.tension_delta = delta as number;
    }
    ledger.scenes.push(scene);
  }

  return ledger;
}

/** 手写序列化：键序固定 ⇒ 同内容同字节（库 dump 会随版本漂键序，diff 会淹死作者） */
export function serializeSatisfactionFile(ledger: SatisfactionLedger): string {
  const lines: string[] = [`apiVersion: ${SATISFACTION_API_VERSION}`];
  if (ledger.thresholds) {
    lines.push("thresholds:");
    for (const key of THRESHOLD_KEYS) {
      const value = (ledger.thresholds as unknown as Record<string, number | undefined>)[key];
      if (value !== undefined) lines.push(`  ${key}: ${String(value)}`);
    }
  }
  if (ledger.hits.length === 0) lines.push("hits: []");
  else {
    lines.push("hits:");
    for (const hit of ledger.hits) {
      lines.push(`  - id: ${hit.id}`);
      lines.push(`    chapter: ${hit.chapter}`);
      lines.push(`    type: ${hit.type}`);
      lines.push(`    intensity: ${String(hit.intensity)}`);
      lines.push(`    beneficiary: ${hit.beneficiary}`);
      if (hit.promise_id !== undefined) lines.push(`    promise_id: ${hit.promise_id}`);
    }
  }
  if (ledger.promises.length === 0) lines.push("promises: []");
  else {
    lines.push("promises:");
    for (const p of ledger.promises) {
      lines.push(`  - id: ${p.id}`);
      lines.push(`    promise: ${JSON.stringify(p.promise)}`);
      lines.push(`    source: ${p.source}`);
      lines.push(`    made_ch: ${p.made_ch}`);
      if (p.due_ch !== undefined) lines.push(`    due_ch: ${p.due_ch}`);
      lines.push(`    status: ${p.status}`);
      if (p.drop_reason !== undefined) lines.push(`    drop_reason: ${JSON.stringify(p.drop_reason)}`);
      if (p.foreshadow_id !== undefined) lines.push(`    foreshadow_id: ${p.foreshadow_id}`);
    }
  }
  if (ledger.curve.length === 0) lines.push("curve: []");
  else {
    lines.push("curve:");
    for (const seg of ledger.curve) {
      lines.push(`  - phase: ${seg.phase}`);
      lines.push(`    from_ch: ${seg.from_ch}`);
      lines.push(`    to_ch: ${seg.to_ch}`);
    }
  }
  if (ledger.scenes.length === 0) lines.push("scenes: []");
  else {
    lines.push("scenes:");
    for (const scene of ledger.scenes) {
      lines.push(`  - id: ${scene.id}`);
      lines.push(`    chapter: ${scene.chapter}`);
      lines.push("    advances:");
      for (const tag of scene.advances) lines.push(`      - ${tag}`);
      lines.push(`    outcome: ${scene.outcome}`);
      if (scene.tension_delta !== undefined) lines.push(`    tension_delta: ${String(scene.tension_delta)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export type SatisfactionSeverity = "error" | "warn" | "info";

export interface SatisfactionFinding {
  id: string;
  severity: SatisfactionSeverity;
  rule: string;
  message: string;
}

export interface SatisfactionNotEvaluated {
  rule: string;
  reason: string;
}

export interface SatisfactionRowHit {
  id: string;
  type: SatisfactionHitType;
  intensity: number;
  beneficiary: string;
}

export interface SatisfactionRow {
  chapter: string;
  /** 卷内序号（1 起）；章清单里的位置，不是猜的章号 */
  ordinal: number;
  hits: SatisfactionRowHit[];
  promisesOpened: string[];
  phase: CurvePhase | null;
  scenes: { total: number; advancing: number };
  advanceRate: number | null;
}

export interface SatisfactionPromiseView {
  id: string;
  promise: string;
  status: PromiseStatus;
  /** 距到期已过去几章（负数=还没到；章号认不出给 null，不编 0） */
  overdueBy: number | null;
  evidence: "hit" | "foreshadow" | "none";
}

export interface SatisfactionBoardOptions {
  /** 全书章节 id 的**顺序清单**（来自三级大纲或磁盘章序）；空清单时不编造进度 */
  chapters: string[];
  /** 写到哪一章；缺省取清单最后一章 */
  currentChapter?: string;
  /** 覆盖真源里的阈值（缺省用文件里的；两边都没给 ⇒ 该规则不判定） */
  thresholds?: SatisfactionThresholds;
}

export interface SatisfactionBoard {
  rows: SatisfactionRow[];
  promises: SatisfactionPromiseView[];
  findings: SatisfactionFinding[];
  notEvaluated: SatisfactionNotEvaluated[];
  current: string | null;
  stats: {
    hits: number;
    scenes: number;
    /** 无场景声明 ⇒ null（"没数据"不等于"推进率 0"） */
    advanceRate: number | null;
    openPromises: number;
    strongestStreak: number;
  };
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 章序号：先按 id 精确匹配，再退到"第 N 章 / ch-012"这类数字口径；都认不出返回 null */
function chapterIndex(chapters: string[], indexById: Map<string, number>, ref: string): number | null {
  const exact = indexById.get(ref);
  if (exact !== undefined) return exact;
  const num = powerLogChapterNo(ref);
  if (num === null) return null;
  return num >= 1 && num <= chapters.length ? num - 1 : null;
}

const OPEN_STATUSES: readonly PromiseStatus[] = ["open", "paying", "deferred"];

export function buildSatisfactionBoard(
  ledger: SatisfactionLedger,
  options: SatisfactionBoardOptions,
): SatisfactionBoard {
  const chapters = options.chapters;
  const indexById = new Map<string, number>();
  for (const [index, id] of chapters.entries()) indexById.set(id, index);
  const currentRef = options.currentChapter ?? chapters[chapters.length - 1] ?? null;
  const currentIdx = currentRef === null ? null : chapterIndex(chapters, indexById, currentRef);
  const thresholds: SatisfactionThresholds = { ...ledger.thresholds, ...options.thresholds };

  const findings: SatisfactionFinding[] = [];
  const notEvaluated: SatisfactionNotEvaluated[] = [];
  let findingSeq = 0;
  const push = (severity: SatisfactionSeverity, rule: string, message: string): void => {
    findingSeq += 1;
    findings.push({ id: `sf-${String(findingSeq).padStart(2, "0")}`, severity, rule, message });
  };

  const promiseIds = new Set(ledger.promises.map((p) => p.id));
  const unknownChapters = new Set<string>();
  const refIdx = (ref: string): number | null => {
    const idx = chapterIndex(chapters, indexById, ref);
    if (idx === null && chapters.length > 0) unknownChapters.add(ref);
    return idx;
  };

  // ── 行表：按章归位（章序即清单序，不猜） ─────────────────────────────
  const hitsByChapter = new Map<number, SatisfactionHit[]>();
  for (const hit of [...ledger.hits].sort((a, b) => byCodePoint(a.id, b.id))) {
    const idx = refIdx(hit.chapter);
    if (idx === null) continue;
    const bucket = hitsByChapter.get(idx);
    if (bucket) bucket.push(hit);
    else hitsByChapter.set(idx, [hit]);
  }
  const scenesByChapter = new Map<number, SceneUnit[]>();
  for (const scene of ledger.scenes) {
    const idx = refIdx(scene.chapter);
    if (idx === null) continue;
    const bucket = scenesByChapter.get(idx);
    if (bucket) bucket.push(scene);
    else scenesByChapter.set(idx, [scene]);
  }
  const openedByChapter = new Map<number, string[]>();
  for (const p of [...ledger.promises].sort((a, b) => byCodePoint(a.id, b.id))) {
    const idx = refIdx(p.made_ch);
    if (idx === null) continue;
    const bucket = openedByChapter.get(idx);
    if (bucket) bucket.push(p.id);
    else openedByChapter.set(idx, [p.id]);
  }
  /** 每章落在哪个相位里；重叠时取第一条（并在结论里点名重叠，不静默二选一） */
  const phaseByChapter = new Map<number, CurvePhase>();
  for (const seg of ledger.curve) {
    const from = refIdx(seg.from_ch);
    const to = refIdx(seg.to_ch);
    if (from === null || to === null) continue;
    for (let i = Math.min(from, to); i <= Math.max(from, to); i += 1) {
      if (!phaseByChapter.has(i)) phaseByChapter.set(i, seg.phase);
    }
  }

  const rows: SatisfactionRow[] = chapters.map((chapter, i) => {
    const hits = (hitsByChapter.get(i) ?? []).map((h) => ({
      id: h.id,
      type: h.type,
      intensity: h.intensity,
      beneficiary: h.beneficiary,
    }));
    const scenes = scenesByChapter.get(i) ?? [];
    const advancing = scenes.filter((s) => !s.advances.includes("none")).length;
    return {
      chapter,
      ordinal: i + 1,
      hits,
      promisesOpened: openedByChapter.get(i) ?? [],
      phase: phaseByChapter.get(i) ?? null,
      scenes: { total: scenes.length, advancing },
      advanceRate: scenes.length === 0 ? null : advancing / scenes.length,
    };
  });

  // ── 承诺清单：状态与证据要自洽 ───────────────────────────────────────
  const hitPromiseIds = new Set(ledger.hits.map((h) => h.promise_id).filter((v): v is string => v !== undefined));
  const promiseViews: SatisfactionPromiseView[] = [];
  for (const p of [...ledger.promises].sort((a, b) => byCodePoint(a.id, b.id))) {
    const dueIdx = p.due_ch === undefined ? null : refIdx(p.due_ch);
    const overdueBy = p.due_ch !== undefined && dueIdx !== null && currentIdx !== null ? currentIdx - dueIdx : null;
    const evidence: SatisfactionPromiseView["evidence"] = hitPromiseIds.has(p.id)
      ? "hit"
      : p.foreshadow_id !== undefined
        ? "foreshadow"
        : "none";
    promiseViews.push({ id: p.id, promise: p.promise, status: p.status, overdueBy, evidence });

    if (p.status === "dropped" && (p.drop_reason === undefined || p.drop_reason.trim() === "")) {
      push("error", "sf-dropped-without-reason", `承诺「${p.id}」标为 dropped 却没写 drop_reason：放弃要留痕，否则与漏写无法区分`);
    }
    if (p.status === "paid" && evidence === "none") {
      push("warn", "sf-paid-without-evidence", `承诺「${p.id}」说已兑现，但既没有引用它的爽点记录、也没挂伏笔交叉引用：兑现得留下证据`);
    }
    if ((p.status === "open" || p.status === "paying") && overdueBy !== null && overdueBy > 0) {
      push("warn", "sf-promise-overdue", `承诺「${p.id}」到期章后已过去 ${String(overdueBy)} 章仍未兑现（状态 ${p.status}）`);
    }
    if (p.status === "deferred" && (dueIdx === null || currentIdx === null || overdueBy === null || overdueBy >= 0)) {
      push("warn", "sf-deferred-without-new-due", `承诺「${p.id}」标了 deferred 却没写新的到期章：延后不是搁置，读者等的是一个日期`);
    }
  }
  for (const hit of [...ledger.hits].sort((a, b) => byCodePoint(a.id, b.id))) {
    if (hit.promise_id !== undefined && !promiseIds.has(hit.promise_id)) {
      push("error", "sf-promise-dangling", `爽点「${hit.id}」的 promise_id「${hit.promise_id}」不在承诺清单里`);
    }
  }

  // ── 曲线：相位区间不重叠、不断档 ─────────────────────────────────────
  const segments = ledger.curve
    .map((seg) => ({ seg, from: refIdx(seg.from_ch), to: refIdx(seg.to_ch) }))
    .filter((s): s is { seg: CurveSegment; from: number; to: number } => s.from !== null && s.to !== null)
    .map((s) => ({ ...s, lo: Math.min(s.from, s.to), hi: Math.max(s.from, s.to) }))
    .sort((a, b) => a.lo - b.lo || byCodePoint(a.seg.from_ch, b.seg.from_ch));
  for (const [i, a] of segments.entries()) {
    for (const b of segments.slice(i + 1)) {
      if (a.lo <= b.hi && b.lo <= a.hi) {
        push("warn", "sf-curve-overlap", `相位区间重叠：${a.seg.phase}（${a.seg.from_ch}~${a.seg.to_ch}）与 ${b.seg.phase}（${b.seg.from_ch}~${b.seg.to_ch}）——同几章有两种解释，归段按给出顺序取前者`);
      }
    }
  }
  let prev: (typeof segments)[number] | null = null;
  for (const cur of segments) {
    if (prev !== null) {
      const gapStart = prev.hi + 1;
      const gapEnd = cur.lo - 1;
      if (gapEnd >= gapStart) {
        const missing = chapters.slice(gapStart, gapEnd + 1).join("、");
        push("warn", "sf-curve-gap", `相位在 ${cur.seg.from_ch} 之前断了：${missing} 不属于任何阶段（曲线断档处读者最容易弃书）`);
      }
    }
    prev = cur;
  }

  // ── 推进率：只算作者声明的场景账 ─────────────────────────────────────
  const totalScenes = ledger.scenes.length;
  const advancingScenes = ledger.scenes.filter((s) => !s.advances.includes("none")).length;
  const advanceRate = totalScenes === 0 ? null : advancingScenes / totalScenes;
  for (const scene of [...ledger.scenes].sort((a, b) => byCodePoint(a.id, b.id))) {
    if (scene.advances.includes("none") && scene.advances.length > 1) {
      push("warn", "sf-scene-contradiction", `场景「${scene.id}」的 advances 同时写了 none 和别的值：推进与不推进不能并存，引擎不替你选一个`);
    }
    if (scene.outcome === "no" && scene.advances.length === 1 && scene.advances[0] === "none") {
      push("info", "sf-scene-deletable", `场景「${scene.id}」（${scene.chapter}）既无推进又无结果：I04 的判据是"删掉它读者不错过任何内容"，可删`);
    }
  }
  if (totalScenes === 0 || thresholds.no_advance_streak === undefined) {
    notEvaluated.push({
      rule: "sf-scene-no-advance",
      reason: totalScenes === 0
        ? "没有任何场景声明（scenes 为空）：推进率没有数据源，不算通过"
        : "未设 thresholds.no_advance_streak：连续几个场景无推进才算注水未经定标，不默认生效",
    });
  } else {
    const limit = thresholds.no_advance_streak;
    let streak = 0;
    let worst = 0;
    for (const scene of ledger.scenes) {
      streak = scene.advances.includes("none") ? streak + 1 : 0;
      worst = Math.max(worst, streak);
    }
    if (worst >= limit) {
      push("warn", "sf-scene-no-advance", `连续 ${String(worst)} 个场景 advances 全为 none（阈值 ${String(limit)}）：这一段没推进任何线，是注水的高发形态`);
    }
  }

  // ── 阈值类判定：没设旋钮就不报，也不假装通过 ──────────────────────────
  const hitSequence = rows
    .map((row, index) => ({ index, row }))
    .filter((x) => x.row.hits.length > 0);

  if (thresholds.same_type_streak_max === undefined) {
    notEvaluated.push({ rule: "sf-same-type-streak", reason: "未设 thresholds.same_type_streak_max：连续几章同一种爽点算同质化未经定标，不默认生效" });
  } else {
    const limit = thresholds.same_type_streak_max;
    let streak = 0;
    let worst = 0;
    let lastType: string | null = null;
    for (const entry of hitSequence) {
      const type = entry.row.hits[0]?.type ?? null;
      if (type === null) continue;
      streak = type === lastType ? streak + 1 : 1;
      lastType = type;
      worst = Math.max(worst, streak);
    }
    if (worst >= limit) {
      push("warn", "sf-same-type-streak", `连续 ${String(worst)} 章都是同一种爽点（阈值 ${String(limit)}）：同质化的爽点不再产生释放，只是重复`);
    }
  }

  if (thresholds.release_interval_max === undefined || thresholds.strong_intensity === undefined) {
    const missing = [
      thresholds.release_interval_max === undefined ? "release_interval_max" : null,
      thresholds.strong_intensity === undefined ? "strong_intensity" : null,
    ].filter((v): v is string => v !== null);
    notEvaluated.push({
      rule: "sf-release-gap",
      reason: `未设 thresholds.${missing.join(" / ")}：隔多少章必须有一次强释放与"多强算强"都未经定标，不默认生效`,
    });
  } else {
    const limit = thresholds.release_interval_max;
    const strong = thresholds.strong_intensity;
    let gap = 0;
    let worst = 0;
    for (const row of rows) {
      const hasStrong = row.hits.some((h) => h.intensity >= strong);
      gap = hasStrong ? 0 : gap + 1;
      worst = Math.max(worst, gap);
    }
    if (worst > limit) {
      push("warn", "sf-release-gap", `连续 ${String(worst)} 章没有 intensity ≥ ${String(strong)} 的释放点（阈值 ${String(limit)}）：期待感只欠不还会转成弃书`);
    }
  }

  if (thresholds.suppress_streak_max === undefined) {
    notEvaluated.push({ rule: "sf-suppress-streak", reason: "未设 thresholds.suppress_streak_max：压抑连几章算「憋屈欠账」在流派间差得离谱，不默认生效" });
  } else {
    const limit = thresholds.suppress_streak_max;
    let streak = 0;
    let worst = 0;
    for (const row of rows) {
      streak = row.phase === "suppress" ? streak + 1 : 0;
      worst = Math.max(worst, streak);
    }
    if (worst >= limit) {
      push("warn", "sf-suppress-streak", `压抑相位连续 ${String(worst)} 章（阈值 ${String(limit)}）：G05 的口径是"受委屈不能憋过这个数"`);
    }
  }

  if (thresholds.promise_open_max === undefined) {
    notEvaluated.push({ rule: "sf-promise-overload", reason: "未设 thresholds.promise_open_max：同时挂着几条未决承诺算超载未经定标，不默认生效" });
  } else {
    const open = ledger.promises.filter((p) => OPEN_STATUSES.includes(p.status)).length;
    if (open > thresholds.promise_open_max) {
      push("warn", "sf-promise-overload", `未决承诺 ${String(open)} 条，超过上限 ${String(thresholds.promise_open_max)}：账越摊越大，读者记不住，作者也容易漏还`);
    }
  }

  // 章号认不出：统一点名一次（不猜位置，也不静默跳过）
  for (const ref of [...unknownChapters].sort(byCodePoint)) {
    push("warn", "sf-chapter-unknown", `章号「${ref}」在章清单里认不出：相关判定按"无法判断"处理，不当成没写`);
  }

  const strongestStreak = hitSequence.reduce((acc, entry) => {
    const top = entry.row.hits.reduce((m, h) => Math.max(m, h.intensity), -5);
    return Math.max(acc, top);
  }, 0);

  const order: Record<SatisfactionSeverity, number> = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || byCodePoint(a.rule, b.rule) || byCodePoint(a.message, b.message));

  return {
    rows,
    promises: promiseViews,
    findings,
    notEvaluated,
    current: currentRef,
    stats: {
      hits: ledger.hits.length,
      scenes: totalScenes,
      advanceRate,
      openPromises: ledger.promises.filter((p) => OPEN_STATUSES.includes(p.status)).length,
      strongestStreak,
    },
  };
}
