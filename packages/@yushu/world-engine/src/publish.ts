/* SPDX-License-Identifier: Apache-2.0 */
import { parse, stringify as stringifyYaml } from "yaml";

/**
 * 发布状态机 + 定时发布（本地提醒队列）+ 章节字数闸（R105 / M5 T5-6，引擎侧）。
 *
 * 判据回源（不是这里发明的）：
 * - **docs/03 §5.3**：`Chapter.status: 'draft' | 'revised' | 'published'`——架构文档与已实现的
 *   `chapterSchema` 枚举逐字一致，本模块**只认这三个**，不另立一套；
 * - **I01 §5 更新状态机**：`draft → stock → scheduled → published → revised`，
 *   「均可回退，回退记录留痕」。存稿（stock）与定时（scheduled）是"还没发出去"的两副面孔，
 *   投影到三态就是 `draft`；`revised` 只在 `published` 之后成立（从没发过的章不存在"修订"），
 *   所以 `draft → revised` 是**非法迁移**；
 * - **I01 §3.7 / §5**：定时发布是**本地提醒队列**，应用离线时启动后补发提示，**不代替平台发布**；
 * - **I01 §5 校验规则** `chapter-word-floor`：单章字数低于平台下限 ⇒ warn，
 *   **参数来自平台规则包**（I07 §3.1：平台规则外置，每条带 source_url / effective_date / version，
 *   应用只读不硬编码）⇒ **包里没声明就不判**（宁缺毋造，不拿别的平台的数字来凑）；
 * - **番茄官方口径**（I08 §3.2/§3.3）：「章节结构优先，字数并不在优先考虑的范围」
 *   ⇒ 番茄**不设单章下限**；它的字数门槛是**当日**全勤档（普通 4,000 / 进阶 6,000）。
 *
 * **两条不做**：① 不查平台、不代替作者发布——`status` 记的是作者自己登记的本地状态；
 * ② 不算平台"有效字数"——番茄的口径是"后台打卡口径（自然月内每日有效过审字数）"，
 * 本地算不了就把口径名带出来，**不拿本地字数冒充有效字数**。
 *
 * **不读墙钟**：时刻一律由调用方给（同输入必得同输出，与导出装配同一条口径）。
 */

/** 三态与 docs/03 §5.3、chapterSchema 枚举逐字一致 */
export const PUBLISH_STATUSES = ["draft", "revised", "published"] as const;
export type PublishStatus = (typeof PUBLISH_STATUSES)[number];

/** 结论出处（豁免清单与体检表要能点名"这是哪条规则判的"） */
export const PUBLISH_ORIGIN = "御书发布状态机（docs/03 §5.3 · I01 §5 更新状态机）";
export const PUBLISH_REMINDER_ORIGIN = "御书定时发布提醒（I01 §3.7：本地提醒队列，不代替平台发布）";
export const PUBLISH_WORD_ORIGIN = "御书章节字数闸（I01 §5 chapter-word-floor · I07 平台规则包）";

/**
 * 合法迁移表（I01 §5 状态机投影到三态）。
 *
 * - `draft → published`：发布；
 * - `published → revised`：已发布章节在改（I01 §2.6：改已发布章节要处理"已订阅读者"的兼容问题）；
 * - `revised → published`：修订完成重新发布；
 * - `published / revised → draft`：**回退**（I01「均可回退」），回退要留痕。
 *
 * **没有 `draft → revised`**：没发出去的章不存在"修订中"这个状态。
 */
const TRANSITIONS: Record<PublishStatus, readonly PublishStatus[]> = {
  draft: ["published"],
  published: ["revised", "draft"],
  revised: ["published", "draft"],
};

export function isPublishStatus(value: unknown): value is PublishStatus {
  return typeof value === "string" && (PUBLISH_STATUSES as readonly string[]).includes(value);
}

/** 码点序比较（红线 5：不用 localeCompare，同输入必得同输出） */
function byCodePoint(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

export interface PublishTransitionResult {
  ok: boolean;
  code: "" | "E_PUBLISH_TRANSITION_INVALID" | "E_PUBLISH_STATUS_UNKNOWN";
  reason: string;
  from: string;
  to: string;
  /** 回退（published / revised → draft）：回退要留痕，调用方据此决定要不要写台账 */
  rollback: boolean;
}

/**
 * 问一次"这一步迁移合不合法"。
 *
 * **非法迁移给理由而不是默默放行**：作者在界面上点了"标记为已发布"，而这一步其实不成立时，
 * 静默改状态等于替他做了决定。
 */
export function canTransition(from: string, to: string): PublishTransitionResult {
  if (!isPublishStatus(from) || !isPublishStatus(to)) {
    return {
      ok: false,
      code: "E_PUBLISH_STATUS_UNKNOWN",
      reason: `发布状态未知：from="${from}" / to="${to}"（合法值：${PUBLISH_STATUSES.join(" / ")}）`,
      from,
      to,
      rollback: false,
    };
  }
  if (from === to) {
    return { ok: true, code: "", reason: "同状态，不重复记账", from, to, rollback: false };
  }
  if (TRANSITIONS[from].includes(to)) {
    return {
      ok: true,
      code: "",
      reason: to === "draft" ? "回退：把这一章退回草稿（要留痕）" : `合法的状态迁移：${from} → ${to}`,
      from,
      to,
      rollback: to === "draft",
    };
  }
  return {
    ok: false,
    code: "E_PUBLISH_TRANSITION_INVALID",
    reason:
      from === "draft" && to === "revised"
        ? "「修订」只对已发布过的章成立：没发出去的章没有「修订中」这个状态（I01 §5 状态机 published → revised）"
        : `不允许的迁移：${from} → ${to}（合法：${TRANSITIONS[from].join(" / ")}）`,
    from,
    to,
    rollback: false,
  };
}

/**
 * 迁移指引矩阵：3×3 全给，**含非法迁移的理由**。
 *
 * 界面按这张表渲染按钮（合法的可点、非法的禁用并把理由挂在 title 上）——
 * 渲染层**不自己抄一份迁移表**：抄一份就会漂移，而漂移出来的按钮点下去只会被引擎拒，
 * 作者看到的却是"按钮能点但没用"。
 */
export interface PublishTransitionGuide {
  from: PublishStatus;
  to: PublishStatus;
  ok: boolean;
  reason: string;
  rollback: boolean;
}

export function publishTransitionGuide(): PublishTransitionGuide[] {
  const guide: PublishTransitionGuide[] = [];
  for (const from of PUBLISH_STATUSES) {
    for (const to of PUBLISH_STATUSES) {
      const check = canTransition(from, to);
      guide.push({ from, to, ok: check.ok, reason: check.reason, rollback: check.rollback });
    }
  }
  return guide;
}

/** 一次迁移的留痕（I01「回退记录留痕」） */
export interface PublishEvent {
  chapterId: string;
  from: PublishStatus;
  to: PublishStatus;
  /** 时刻由调用方给（ISO 串） */
  at: string;
  /** 留痕当时的字数（事后改稿不改变"发出去那版有多少字"） */
  wordCount: number;
  note?: string;
  rollback: boolean;
}

export function buildPublishEvent(input: {
  chapterId: string;
  from: PublishStatus;
  to: PublishStatus;
  at: string;
  wordCount: number;
  note?: string;
}): PublishEvent {
  const check = canTransition(input.from, input.to);
  if (!check.ok) {
    throw new PublishRulesError(check.reason);
  }
  return {
    chapterId: input.chapterId,
    from: input.from,
    to: input.to,
    at: input.at,
    wordCount: input.wordCount,
    ...(input.note === undefined || input.note.trim() === "" ? {} : { note: input.note.trim() }),
    rollback: check.rollback,
  };
}

/** 一章在发布流里的样子（桌面侧从真源拼好再给引擎判） */
export interface PublishScheduleRow {
  id: string;
  title: string;
  status: PublishStatus;
  wordCount: number;
  /** 计划发布时刻（ISO 串）；没设 = 不参与定时 */
  publishAt?: string;
}

export interface PublishReminder {
  id: string;
  title: string;
  publishAt: string;
  wordCount: number;
  /** 到期时长（毫秒）：正值 = 已经过点还没处理 */
  dueMs: number;
}

/**
 * 定时发布：**本地提醒队列**（I01 §3.7）。
 *
 * 三条口径：
 * ① **只是提醒，不代替平台发布**——御书不连平台，也不替作者"发"；
 * ② **已发布的章不进队列**（发过了就没有待办）；
 * ③ **离线补发**：过点很久的也要列出来（作者关机时错过的提醒，开机后仍要看得见），
 *    所以判据是"到点且还没处理"，不是"刚好在那一秒"。
 */
export function planPublishReminders(
  rows: readonly PublishScheduleRow[],
  now: string,
): PublishReminder[] {
  const nowMs = Date.parse(now);
  const reminders: PublishReminder[] = [];
  for (const row of rows) {
    if (row.publishAt === undefined || row.publishAt.trim() === "") continue;
    if (row.status === "published") continue;
    const atMs = Date.parse(row.publishAt);
    if (Number.isNaN(atMs) || Number.isNaN(nowMs)) continue;
    if (atMs > nowMs) continue;
    reminders.push({
      id: row.id,
      title: row.title,
      publishAt: row.publishAt,
      wordCount: row.wordCount,
      dueMs: nowMs - atMs,
    });
  }
  return reminders.sort((a, b) => {
    const delta = Date.parse(a.publishAt) - Date.parse(b.publishAt);
    if (delta !== 0) return delta;
    return byCodePoint(a.id, b.id);
  });
}

/* ---------------- 发布台账（回退留痕的真源） ---------------- */

/** 台账格式版本：改结构就改版本号，旧文件按"读不了"处理，不静默按旧结构读 */
export const PUBLISH_LEDGER_API_VERSION = "yushu.publish/v1";

export interface PublishLedger {
  apiVersion: string;
  events: PublishEvent[];
}

const LEDGER_KEYS = ["apiVersion", "events"] as const;
const LEDGER_EVENT_KEYS = ["chapter_id", "from", "to", "at", "word_count", "rollback", "note"] as const;

/**
 * 解析 `config/publish.yaml`（发布台账）。
 *
 * **为什么台账是真源而不是派生物**：它是"这一章什么时候从什么状态到了什么状态"的**作者动作留痕**
 * （I01 §5「回退记录留痕」）——没有它，"发了又撤回"和"从没发过"在盘上长得一模一样，
 * 当日字数口径（番茄全勤）也就算不出来。派生区放不了这个：删掉 `.yushu/` 就没有了。
 *
 * 与豁免清单、阈值表同一套严格约定：apiVersion 必填、未知键直接拒、状态必须是三个合法值之一。
 */
export function parsePublishLedger(text: string): PublishLedger {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    throw new PublishRulesError(`发布台账 YAML 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (raw === null || raw === undefined) {
    throw new PublishRulesError("发布台账为空");
  }
  const record = asRecord(raw, "发布台账");
  for (const key of Object.keys(record)) {
    if (!(LEDGER_KEYS as readonly string[]).includes(key)) {
      throw new PublishRulesError(`发布台账含未知键「${key}」（允许：${LEDGER_KEYS.join(" / ")}）`);
    }
  }
  if (record["apiVersion"] !== PUBLISH_LEDGER_API_VERSION) {
    throw new PublishRulesError(
      `发布台账的 apiVersion 应为 ${PUBLISH_LEDGER_API_VERSION}，实际 ${String(record["apiVersion"])}`,
    );
  }
  const list = record["events"];
  if (!Array.isArray(list)) {
    throw new PublishRulesError("发布台账缺少 events（没有留痕就写空数组）");
  }
  const events: PublishEvent[] = list.map((item, index) => parseLedgerEvent(item, index));
  return { apiVersion: PUBLISH_LEDGER_API_VERSION, events };
}

function parseLedgerEvent(value: unknown, index: number): PublishEvent {
  const where = `发布台账 events[${String(index)}]`;
  const record = asRecord(value, where);
  for (const key of Object.keys(record)) {
    if (!(LEDGER_EVENT_KEYS as readonly string[]).includes(key)) {
      throw new PublishRulesError(`${where} 含未知键「${key}」（拒绝静默忽略）`);
    }
  }
  const chapterId = requiredString(record, "chapter_id", where);
  const from = record["from"];
  const to = record["to"];
  if (!isPublishStatus(from) || !isPublishStatus(to)) {
    throw new PublishRulesError(
      `${where} 的 from / to 必须是 ${PUBLISH_STATUSES.join(" / ")} 之一（实际 ${String(from)} → ${String(to)}）`,
    );
  }
  const at = requiredString(record, "at", where);
  if (Number.isNaN(Date.parse(at))) {
    throw new PublishRulesError(`${where} 的 at 不是可解析的时刻：${at}`);
  }
  const wordCount = record["word_count"];
  if (typeof wordCount !== "number" || !Number.isInteger(wordCount) || wordCount < 0) {
    throw new PublishRulesError(`${where} 的 word_count 必须是非负整数`);
  }
  const rollback = record["rollback"];
  if (typeof rollback !== "boolean") {
    throw new PublishRulesError(`${where} 的 rollback 必须是布尔值`);
  }
  const noteRaw = record["note"];
  if (noteRaw !== undefined && noteRaw !== null && typeof noteRaw !== "string") {
    throw new PublishRulesError(`${where} 的 note 必须是字符串`);
  }
  return {
    chapterId,
    from,
    to,
    at,
    wordCount,
    rollback,
    ...(noteRaw === undefined || noteRaw === null || String(noteRaw).trim() === ""
      ? {}
      : { note: String(noteRaw).trim() }),
  };
}

/** 确定性序列化（键顺序固定，同输入同字节，可 diff 可进快照） */
export function serializePublishLedger(ledger: PublishLedger): string {
  const body = {
    apiVersion: ledger.apiVersion,
    events: ledger.events.map((event) => ({
      chapter_id: event.chapterId,
      from: event.from,
      to: event.to,
      at: event.at,
      word_count: event.wordCount,
      rollback: event.rollback,
      ...(event.note === undefined || event.note.trim() === "" ? {} : { note: event.note.trim() }),
    })),
  };
  return stringifyYaml(body, { lineWidth: 0 });
}

/* ---------------- 平台规则包（I07 §3.1：外置、带来源与生效日期、应用只读不硬编码） ---------------- */

/** 读不下来的规则包：调用方把它当"本轮没判"处理，不许降级成"没问题" */
export class PublishRulesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublishRulesError";
  }
}

export interface PublishRules {
  platform: string;
  version: string;
  effectiveDate: string;
  checkedAt?: string;
  sourceUrls: string[];
  /** 平台"有效字数"的口径名（本地算不了后台口径时如实报出口径） */
  validWordRule: string;
  /** 单章下限 / 上限：包里没声明 = 该平台不按单章字数判（宁缺毋造） */
  perChapter?: { min?: number; max?: number };
  /** 当日口径（全勤档之类）：包里没声明 = 不给当日结论 */
  daily?: { standard?: number; advanced?: number };
}

const RULE_TOP_KEYS = [
  "platform",
  "version",
  "effective_date",
  "checked_at",
  "source_urls",
  "valid_word_rule",
  "per_chapter",
  "daily",
];
const PER_CHAPTER_KEYS = ["min", "max"];
const DAILY_KEYS = ["standard", "advanced"];

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PublishRulesError(`${label} 必须是键值映射`);
  }
  return value as Record<string, unknown>;
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new PublishRulesError(`${label} 缺少 ${key}（或不是非空字符串）`);
  }
  return value.trim();
}

function optionalPositiveInt(
  record: Record<string, unknown>,
  key: string,
  label: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new PublishRulesError(`${label}.${key} 必须是正整数`);
  }
  return value;
}

/**
 * 解析平台规则包。
 *
 * **三条硬规矩**（与豁免清单、阈值表、平台导出包同一条路子）：
 * ① **来源与生效日期缺一不可**——没有出处的数字不许进包（I07 pr-rule-source-missing 是 error 级）；
 * ② **未知键直接拒**——一个代码不认识却被悄悄忽略的字段，比报错危险得多（作者会以为它生效了）；
 * ③ **没声明 = 不判**，不是"按默认判"。
 */
export function parsePublishRules(raw: string): PublishRules {
  let data: unknown;
  try {
    data = parse(raw);
  } catch (err) {
    throw new PublishRulesError(`平台规则包 YAML 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (data === null || data === undefined) {
    throw new PublishRulesError("平台规则包为空");
  }
  const record = asRecord(data, "平台规则包");
  for (const key of Object.keys(record)) {
    if (!RULE_TOP_KEYS.includes(key)) {
      throw new PublishRulesError(`平台规则包出现未知键 ${key}（允许：${RULE_TOP_KEYS.join(" / ")}）`);
    }
  }
  const platform = requiredString(record, "platform", "平台规则包");
  const version = requiredString(record, "version", "平台规则包");
  const effectiveDate = requiredString(record, "effective_date", "平台规则包");
  const validWordRule = requiredString(record, "valid_word_rule", "平台规则包");
  const rawUrls = record["source_urls"];
  if (!Array.isArray(rawUrls) || rawUrls.length === 0) {
    throw new PublishRulesError("平台规则包缺少 source_urls（没有出处的数字不许进包）");
  }
  const sourceUrls: string[] = [];
  for (const item of rawUrls) {
    if (typeof item !== "string" || item.trim() === "") {
      throw new PublishRulesError("平台规则包 source_urls 里必须都是非空字符串");
    }
    sourceUrls.push(item.trim());
  }
  const checkedAtRaw = record["checked_at"];
  if (checkedAtRaw !== undefined && checkedAtRaw !== null && typeof checkedAtRaw !== "string") {
    throw new PublishRulesError("平台规则包 checked_at 必须是字符串");
  }
  const perChapterRaw = record["per_chapter"];
  let perChapter: PublishRules["perChapter"];
  if (perChapterRaw !== undefined && perChapterRaw !== null) {
    const sub = asRecord(perChapterRaw, "平台规则包 per_chapter");
    for (const key of Object.keys(sub)) {
      if (!PER_CHAPTER_KEYS.includes(key)) {
        throw new PublishRulesError(`per_chapter 出现未知键 ${key}（允许：${PER_CHAPTER_KEYS.join(" / ")}）`);
      }
    }
    const min = optionalPositiveInt(sub, "min", "per_chapter");
    const max = optionalPositiveInt(sub, "max", "per_chapter");
    if (min !== undefined && max !== undefined && min > max) {
      throw new PublishRulesError(`per_chapter 的 min（${min}）大于 max（${max}）`);
    }
    perChapter = { ...(min === undefined ? {} : { min }), ...(max === undefined ? {} : { max }) };
  }
  const dailyRaw = record["daily"];
  let daily: PublishRules["daily"];
  if (dailyRaw !== undefined && dailyRaw !== null) {
    const sub = asRecord(dailyRaw, "平台规则包 daily");
    for (const key of Object.keys(sub)) {
      if (!DAILY_KEYS.includes(key)) {
        throw new PublishRulesError(`daily 出现未知键 ${key}（允许：${DAILY_KEYS.join(" / ")}）`);
      }
    }
    const standard = optionalPositiveInt(sub, "standard", "daily");
    const advanced = optionalPositiveInt(sub, "advanced", "daily");
    if (standard !== undefined && advanced !== undefined && standard > advanced) {
      throw new PublishRulesError(`daily 的 standard（${standard}）大于 advanced（${advanced}）`);
    }
    daily = { ...(standard === undefined ? {} : { standard }), ...(advanced === undefined ? {} : { advanced }) };
  }
  return {
    platform,
    version,
    effectiveDate,
    ...(checkedAtRaw === undefined || checkedAtRaw === null ? {} : { checkedAt: String(checkedAtRaw) }),
    sourceUrls,
    validWordRule,
    ...(perChapter === undefined ? {} : { perChapter }),
    ...(daily === undefined ? {} : { daily }),
  };
}

/* ---------------- 章节字数闸 ---------------- */

export interface PublishWordRow {
  id: string;
  title: string;
  wordCount: number;
}

export interface WordGateResult {
  count: number;
  total: number;
  min: number;
  max: number;
  median: number;
  /** 平台"有效字数"口径名：本地算不了后台口径，如实报出口径而不是拿本地字数冒充 */
  validWordRule: string;
  /** 平台有没有声明单章下限（没声明 = 不判，不静默） */
  perChapterFloorDeclared: boolean;
  /** 低于平台单章下限的章，逐条点名 */
  belowFloor: { id: string; title: string; wordCount: number }[];
  /** 当日口径：包里没声明当日档位 = 不给当日结论 */
  daily?: {
    date: string;
    publishedChars: number;
    standard?: number;
    advanced?: number;
    reached: string[];
  };
}

/**
 * 章节字数统计与字数闸（I01 §5）。
 *
 * **当日口径怎么算**：台账里每章的**最后一次**事件决定它现在算不算"今天发的"——
 * 发了又回退的章不算数（回退要留痕，留痕就是为了这个能算清）。
 * 日期按调用方给的 ISO 串前 10 位比较（同基准，不做时区换算）。
 */
export function checkWordGate(
  rows: readonly PublishWordRow[],
  rules: PublishRules,
  events: readonly PublishEvent[],
  now: string,
): WordGateResult {
  const counts = rows.map((row) => row.wordCount).sort((a, b) => a - b);
  const total = counts.reduce((sum, value) => sum + value, 0);
  const median =
    counts.length === 0
      ? 0
      : counts.length % 2 === 1
        ? (counts[(counts.length - 1) / 2] ?? 0)
        : ((counts[counts.length / 2 - 1] ?? 0) + (counts[counts.length / 2] ?? 0)) / 2;

  const floor = rules.perChapter?.min;
  const belowFloor =
    floor === undefined
      ? []
      : rows
          .filter((row) => row.wordCount < floor)
          .map((row) => ({ id: row.id, title: row.title, wordCount: row.wordCount }))
          .sort((a, b) => byCodePoint(a.id, b.id));

  const result: WordGateResult = {
    count: rows.length,
    total,
    min: counts.length === 0 ? 0 : (counts[0] ?? 0),
    max: counts.length === 0 ? 0 : (counts[counts.length - 1] ?? 0),
    median,
    validWordRule: rules.validWordRule,
    perChapterFloorDeclared: floor !== undefined,
    belowFloor,
  };

  if (rules.daily === undefined) return result;
  const date = now.slice(0, 10);
  const latestByChapter = new Map<string, PublishEvent>();
  for (const event of events) {
    const previous = latestByChapter.get(event.chapterId);
    if (previous === undefined || event.at >= previous.at) {
      latestByChapter.set(event.chapterId, event);
    }
  }
  let publishedChars = 0;
  for (const event of latestByChapter.values()) {
    if (event.to !== "published") continue;
    if (event.at.slice(0, 10) !== date) continue;
    publishedChars += event.wordCount;
  }
  const standard = rules.daily.standard;
  const advanced = rules.daily.advanced;
  const reached: string[] = [];
  if (standard !== undefined && publishedChars >= standard) reached.push("standard");
  if (advanced !== undefined && publishedChars >= advanced) reached.push("advanced");
  result.daily = {
    date,
    publishedChars,
    ...(standard === undefined ? {} : { standard }),
    ...(advanced === undefined ? {} : { advanced }),
    reached,
  };
  return result;
}
