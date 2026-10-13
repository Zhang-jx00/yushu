import { YushuError } from "@yushu/core";
import type { Event as WorldEvent, Timeline } from "@yushu/core";
import { parseDocument } from "yaml";

/**
 * 时间线：统一数字刻度 + 锚定归零 + 多历法渲染映射 + 冲突校验（M4 / T4-7 引擎侧，R67）。
 *
 * 真源 `world/timeline.yaml`。**刻度只有一套**：`year` 是内部数字年，锚定事件 = Year 0；
 * 历法（帝国纪年 / 通纪 …）只是显示层的 `offset` 换算，**绝不回写真源**——两套刻度同时落盘
 * 就是长出第二真源（红线 1）。所以 `formatCalendarYear` 是纯显示函数，序列化里没有它的位置。
 *
 * 三条"不猜"：
 * ① 事件没写 `kind` ⇒ 不参与需要 kind 的判定，但逐条进 `notEvaluated` 点名（同 T4-2 的未参与规则口径）；
 * ② 因果先后**按 year 比**，不按数组顺序（作者把 effects 写在前面不代表时间倒流）；
 * ③ 历法 id 认不出 ⇒ 显示年 `null`，不退回"就当 offset 0"——那会把"我不知道"显示成"我确定"。
 */

export const TIMELINE_API_VERSION = "yushu.timeline/v1";

/** 事件在时间轴上扮演的角色；**缺省即不参与需要角色的判定**（不猜） */
export const EVENT_KINDS = ["founding", "destruction", "birth", "death", "battle", "treaty", "other"] as const;
export type TimelineEventKind = (typeof EVENT_KINDS)[number];

export interface TimelineEvent extends WorldEvent {
  kind?: TimelineEventKind;
}

export interface Calendar {
  id: string;
  label: string;
  /** 显示年 = 内部年 + offset（负数=锚定前的纪年起点） */
  offset: number;
}

export interface TimelineFile {
  apiVersion: typeof TIMELINE_API_VERSION;
  /** 锚定事件 id：内部刻度的 Year 0 */
  anchor_event: string;
  calendars: Calendar[];
  timelines: Timeline[];
  events: TimelineEvent[];
}

export interface TimelineFinding {
  /** 相关事件 id；文档级判定用 "-" */
  id: string;
  severity: "error" | "warn" | "info";
  rule: string;
  message: string;
}

export interface TimelineSkipped {
  rule: string;
  reason: string;
  ids: string[];
}

export interface TimelineViewRow {
  id: string;
  title: string;
  year: number;
  timeline: string;
  calendar: string;
  /** 认不出历法时为 null（不退回 offset 0） */
  displayYear: string | null;
  kind: TimelineEventKind | null;
  location: string | null;
}

function fail(message: string): never {
  throw new YushuError("E_TIMELINE_PARSE", message);
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} 必须是映射`);
  return value as Record<string, unknown>;
}

function asString(value: unknown, label: string, key: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} 的 ${key} 必填且须为非空字符串`);
  return value;
}

function asIdList(value: unknown, label: string, key: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${label} 的 ${key} 必须是列表`);
  return (value as unknown[]).map((item, i) => {
    if (typeof item !== "string" || item.trim() === "") fail(`${label} 的 ${key}[${i}] 须为非空字符串`);
    return item;
  });
}

function checkKeys(raw: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const known = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) fail(`${label} 有未知键「${key}」（可选：${allowed.join(" / ")}）`);
  }
}

/** 严格解析：未知键 / 非法枚举 / 重复 id / 悬空 timeline 引用一律拒绝并点名 */
export function parseTimelineFile(text: string): TimelineFile {
  let rootRaw: unknown;
  try {
    rootRaw = parseDocument(text, { uniqueKeys: true }).toJS();
  } catch (err) {
    return fail(`YAML 读不了：${err instanceof Error ? err.message : String(err)}`);
  }
  const root = asObject(rootRaw, "时间线根");
  checkKeys(root, ["apiVersion", "anchor_event", "calendars", "timelines", "events"], "时间线根");
  if (root.apiVersion !== TIMELINE_API_VERSION) fail(`apiVersion 须为 ${TIMELINE_API_VERSION}（收到「${String(root.apiVersion)}」）`);
  const anchorEvent = asString(root.anchor_event, "时间线根", "anchor_event");

  const calendars: Calendar[] = [];
  const calendarIds = new Set<string>();
  for (const [index, item] of ((root.calendars ?? []) as unknown[]).entries()) {
    const label = `calendars[${index}]`;
    const raw = asObject(item, label);
    checkKeys(raw, ["id", "label", "offset"], label);
    const id = asString(raw.id, label, "id");
    if (calendarIds.has(id)) fail(`历法 id 重复：${id}`);
    calendarIds.add(id);
    if (typeof raw.offset !== "number" || !Number.isFinite(raw.offset)) fail(`${label} 的 offset 须为有限数字`);
    calendars.push({ id, label: asString(raw.label, label, "label"), offset: raw.offset });
  }

  const timelines: Timeline[] = [];
  const timelineIds = new Set<string>();
  for (const [index, item] of ((root.timelines ?? []) as unknown[]).entries()) {
    const label = `timelines[${index}]`;
    const raw = asObject(item, label);
    checkKeys(raw, ["id", "anchor_event", "calendar", "scale", "events"], label);
    const id = asString(raw.id, label, "id");
    if (timelineIds.has(id)) fail(`时间线 id 重复：${id}`);
    timelineIds.add(id);
    if (raw.scale !== "numeric") fail(`${label} 的 scale 只支持 "numeric"（内部统一数字刻度，收到「${String(raw.scale)}」）`);
    timelines.push({
      id,
      anchor_event: asString(raw.anchor_event, label, "anchor_event"),
      calendar: asString(raw.calendar, label, "calendar"),
      scale: "numeric",
      events: asIdList(raw.events, label, "events"),
    });
  }

  const events: TimelineEvent[] = [];
  const eventIds = new Set<string>();
  for (const [index, item] of ((root.events ?? []) as unknown[]).entries()) {
    const label = `events[${index}]`;
    const raw = asObject(item, label);
    checkKeys(raw, ["id", "title", "year", "timeline", "participants", "location", "causes", "effects", "pov_viewpoints", "kind"], label);
    const id = asString(raw.id, label, "id");
    if (eventIds.has(id)) fail(`事件 id 重复：${id}（时间线按 id 定位，撞号等于两条并成一条）`);
    eventIds.add(id);
    if (typeof raw.year !== "number" || !Number.isFinite(raw.year)) fail(`${label}（${id}）的 year 须为有限数字（内部刻度不接受"大约十二"这类估算）`);
    const timeline = asString(raw.timeline, label, "timeline");
    if (!timelineIds.has(timeline)) fail(`${label}（${id}）的 timeline「${timeline}」不存在（先建时间线，或改引用）`);
    const event: TimelineEvent = {
      id,
      title: asString(raw.title, label, "title"),
      year: raw.year,
      timeline,
      participants: asIdList(raw.participants, label, "participants"),
      causes: asIdList(raw.causes, label, "causes"),
      effects: asIdList(raw.effects, label, "effects"),
    };
    if (raw.location !== undefined && raw.location !== null) event.location = asString(raw.location, label, "location");
    if (raw.kind !== undefined && raw.kind !== null) {
      if (!(EVENT_KINDS as readonly string[]).includes(raw.kind as string)) {
        fail(`${label}（${id}）的 kind「${String(raw.kind)}」非法值（可选：${EVENT_KINDS.join("/")}）`);
      }
      event.kind = raw.kind as TimelineEventKind;
    }
    if (raw.pov_viewpoints !== undefined && raw.pov_viewpoints !== null) {
      event.pov_viewpoints = raw.pov_viewpoints as WorldEvent["pov_viewpoints"];
    }
    events.push(event);
  }

  return { apiVersion: TIMELINE_API_VERSION, anchor_event: anchorEvent, calendars, timelines, events };
}

function quote(value: string): string {
  return JSON.stringify(value);
}

/** 手写序列化：键序固定 ⇒ 同内容同字节（真源是给人看 diff 的） */
export function serializeTimelineFile(doc: TimelineFile): string {
  const lines: string[] = [`apiVersion: ${doc.apiVersion}`, `anchor_event: ${doc.anchor_event}`];
  lines.push("calendars:");
  for (const calendar of doc.calendars) {
    lines.push(`  - id: ${calendar.id}`, `    label: ${quote(calendar.label)}`, `    offset: ${String(calendar.offset)}`);
  }
  lines.push("timelines:");
  for (const timeline of doc.timelines) {
    lines.push(
      `  - id: ${timeline.id}`,
      `    anchor_event: ${timeline.anchor_event}`,
      `    calendar: ${timeline.calendar}`,
      `    scale: ${timeline.scale}`,
      `    events: ${JSON.stringify(timeline.events)}`,
    );
  }
  lines.push("events:");
  for (const event of doc.events) {
    lines.push(
      `  - id: ${event.id}`,
      `    title: ${quote(event.title)}`,
      `    year: ${String(event.year)}`,
      `    timeline: ${event.timeline}`,
      `    participants: ${JSON.stringify(event.participants)}`,
    );
    if (event.location !== undefined) lines.push(`    location: ${event.location}`);
    if (event.kind !== undefined) lines.push(`    kind: ${event.kind}`);
    lines.push(`    causes: ${JSON.stringify(event.causes)}`, `    effects: ${JSON.stringify(event.effects)}`);
    if (event.pov_viewpoints !== undefined) lines.push(`    pov_viewpoints: ${JSON.stringify(event.pov_viewpoints)}`);
  }
  return `${lines.join("\n")}\n`;
}

/** 显示年换算（纯渲染层函数）：0 年读作「元年」，负数读作「前 N 年」 */
export function formatCalendarYear(year: number, calendar: Pick<Calendar, "label" | "offset">): string {
  const display = year + calendar.offset;
  if (display > 0) return `${calendar.label} ${display} 年`;
  if (display === 0) return `${calendar.label} 元年`;
  return `${calendar.label} 前 ${Math.abs(display)} 年`;
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function eventOrder(a: TimelineEvent, b: TimelineEvent): number {
  return a.year - b.year || byCodePoint(a.id, b.id);
}

function calendarOf(doc: TimelineFile, id: string): Calendar | null {
  return doc.calendars.find((c) => c.id === id) ?? null;
}

/** 时间线视图：按 (year, id) 排序 + 历法映射。认不出历法时 displayYear 为 null */
export function buildTimelineView(
  doc: TimelineFile,
  options: { calendar?: string } = {},
): { rows: TimelineViewRow[]; findings: TimelineFinding[] } {
  const findings: TimelineFinding[] = [];
  const timelineCalendar = new Map(doc.timelines.map((t) => [t.id, t.calendar]));
  const useCalendar = options.calendar;
  if (useCalendar !== undefined && calendarOf(doc, useCalendar) === null) {
    findings.push({
      id: "-",
      severity: "error",
      rule: "tl-calendar-unknown",
      message: `历法「${useCalendar}」不存在（可选：${doc.calendars.map((c) => c.id).join("/") || "尚未定义历法"}）：显示年留空，不按 offset 0 猜`,
    });
  }
  const rows = [...doc.events].sort(eventOrder).map((event) => {
    const calendarId = useCalendar ?? timelineCalendar.get(event.timeline) ?? "";
    const calendar = calendarOf(doc, calendarId);
    return {
      id: event.id,
      title: event.title,
      year: event.year,
      timeline: event.timeline,
      calendar: calendarId,
      displayYear: calendar === null ? null : formatCalendarYear(event.year, calendar),
      kind: event.kind ?? null,
      location: event.location ?? null,
    };
  });
  return { rows, findings };
}

/** 冲突校验：锚定、因果先后、生死在场、遗址出生。缺数据的判定逐条进 notEvaluated */
export function checkTimelineConflicts(doc: TimelineFile): { findings: TimelineFinding[]; notEvaluated: TimelineSkipped[] } {
  const byId = new Map(doc.events.map((event) => [event.id, event]));
  const findings: TimelineFinding[] = [];
  const notEvaluated: TimelineSkipped[] = [];
  const push = (id: string, severity: TimelineFinding["severity"], rule: string, message: string): void => {
    findings.push({ id, severity, rule, message });
  };

  const anchor = byId.get(doc.anchor_event);
  if (!anchor) {
    push("-", "error", "tl-anchor-missing", `锚定事件「${doc.anchor_event}」不在事件表里：Year 0 无处可定，时间线不能定标`);
  } else if (anchor.year !== 0) {
    push("-", "warn", "tl-anchor-not-zero", `锚定事件 ${anchor.id} 的 year 是 ${String(anchor.year)} 而非 0：内部刻度没按锚点归零（本层不擅自平移，避免把作者的纪年起点改掉）`);
  }

  for (const event of doc.events) {
    for (const causeId of event.causes) {
      const cause = byId.get(causeId);
      if (!cause) {
        push(event.id, "error", "tl-cause-dangling", `${event.id} 的 causes 引用「${causeId}」不存在`);
        continue;
      }
      if (event.year < cause.year) {
        push(event.id, "error", "tl-cause-after-effect", `${event.id}（${event.year}）早于它的原因 ${causeId}（${cause.year}）：因果倒置`);
      }
    }
    for (const effectId of event.effects) {
      if (!byId.has(effectId)) push(event.id, "error", "tl-effect-dangling", `${event.id} 的 effects 引用「${effectId}」不存在`);
    }
  }

  const kindOf = (kind: TimelineEventKind): TimelineEvent[] => doc.events.filter((event) => event.kind === kind);
  const noKind = doc.events.filter((event) => event.kind === undefined);
  if (noKind.length > 0) {
    notEvaluated.push({
      rule: "tl-kind-required",
      reason: "这些事件没写 kind，涉及角色的判定整条跳过（不算通过，也不算失败）",
      ids: noKind.map((event) => event.id).sort(byCodePoint),
    });
  }

  const destructions = kindOf("destruction").filter((event) => event.location !== undefined);
  const births = kindOf("birth").filter((event) => event.location !== undefined);
  if (births.length > 0) {
    if (destructions.length === 0) {
      notEvaluated.push({ rule: "tl-born-after-destruction", reason: "没有任何带 location 的 destruction 事件，无从比较", ids: [] });
    } else {
      for (const birth of births) {
        for (const ruin of destructions) {
          if (ruin.location === birth.location && ruin.year <= birth.year) {
            push(
              birth.id,
              "error",
              "tl-born-after-destruction",
              `${birth.id}（${birth.title}）出生在 ${String(birth.year)}，而 ${birth.location} 已在 ${String(ruin.year)} 被 ${ruin.id}（${ruin.title}）灭亡：角色出身于已不存在的国度`,
            );
          }
        }
      }
    }
  }

  const deaths = kindOf("death");
  if (deaths.length === 0) {
    notEvaluated.push({ rule: "tl-participant-after-death", reason: "没有任何 kind=death 事件，无法判定生死区间", ids: [] });
  } else {
    for (const death of deaths) {
      for (const participant of death.participants) {
        for (const later of doc.events) {
          if (later.year <= death.year || later.id === death.id) continue;
          if (!later.participants.includes(participant)) continue;
          push(
            later.id,
            "error",
            "tl-participant-after-death",
            `${participant} 死于 ${death.id}（${String(death.year)}），却出现在 ${later.id}（${String(later.year)}）`,
          );
        }
      }
    }
  }

  findings.sort((a, b) => byCodePoint(`${a.rule}\u0000${a.id}`, `${b.rule}\u0000${b.id}`));
  notEvaluated.sort((a, b) => byCodePoint(a.rule, b.rule));
  return { findings, notEvaluated };
}
