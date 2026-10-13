import {
  TIMELINE_PATH,
  buildTimelineView,
  checkTimelineConflicts,
  parseTimelineFile,
  type TimelineFile,
} from "@yushu/world-engine";
import type { TimelineViewPayload, TimelineViewRequestPayload } from "../shared/ipc.js";
import type { ProjectGateway } from "./file-gateway.js";

/**
 * 时间线视图的桌面接线（M4 / T4-7，R68）：**只读**。
 *
 * 判定与换算都在引擎（`world-engine/timeline.ts`），这里只做"读真源 → 投影成载荷"。
 * 历法切换是**纯显示参数**：它只进 `buildTimelineView` 的入参，不产生任何写操作，
 * 所以通道走 `wrap` 而不是 `wrapWrite`（R59 那道写通道锁与 R66 的四处对账锁都盯着这类判断）。
 *
 * 两条不静默：文件读不了 ⇒ 给 note 且**不出结论**（不退回空时间线）；
 * 缺 `kind` / 缺生死标记 ⇒ 引擎的 `notEvaluated` 原样带到界面，让"没判的"看得见。
 */

const EMPTY: Omit<TimelineViewPayload, "path" | "exists" | "note"> = {
  calendars: [],
  activeCalendar: null,
  rows: [],
  findings: [],
  notEvaluated: [],
};

export async function timelineView(
  gateway: ProjectGateway,
  request: TimelineViewRequestPayload = {},
): Promise<TimelineViewPayload> {
  const snapshot = await gateway.readDoc(TIMELINE_PATH).catch(() => null);
  if (snapshot === null) {
    return {
      path: TIMELINE_PATH,
      exists: false,
      note: "项目还没有时间线：写几条事件（含 year 与锚定事件）才能定标与校验",
      ...EMPTY,
    };
  }
  let parsed: TimelineFile;
  try {
    parsed = parseTimelineFile(snapshot.content);
  } catch (err) {
    return {
      path: TIMELINE_PATH,
      exists: true,
      note: `时间线读不了，本次不出结论（不静默按空时间线显示）：${err instanceof Error ? err.message : String(err)}`,
      ...EMPTY,
    };
  }
  const calendar = request.calendar;
  const view = buildTimelineView(parsed, calendar === undefined || calendar === "" ? {} : { calendar });
  const conflicts = checkTimelineConflicts(parsed);
  return {
    path: TIMELINE_PATH,
    exists: true,
    note: `${parsed.events.length} 条事件 · 锚定「${parsed.anchor_event}」= Year 0 · 历法 ${parsed.calendars.length} 套`,
    calendars: parsed.calendars.map((c) => ({ id: c.id, label: c.label, offset: c.offset })),
    activeCalendar: view.rows[0]?.calendar ?? null,
    rows: view.rows,
    findings: [...view.findings, ...conflicts.findings],
    notEvaluated: conflicts.notEvaluated,
  };
}
