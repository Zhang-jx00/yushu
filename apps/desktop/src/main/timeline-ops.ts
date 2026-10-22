/* SPDX-License-Identifier: Apache-2.0 */
import {
  TIMELINE_PATH,
  buildTimelineView,
  checkStructureFromSources,
  checkTimelineConflicts,
  parseTimelineFile,
  type TimelineFile,
} from "@yushu/world-engine";
import type { TimelineFindingPayload, TimelineViewPayload, TimelineViewRequestPayload } from "../shared/ipc.js";
import { gatewayReader } from "./index-ops.js";
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
 *
 * **R134 加一条跨文件的体检**：`place_ref` 指向的**实体存在吗**？
 * 引擎不认地点实体（它只管时间）⇒ 这条判定只能在**桌面接线**这一层做
 * （这里能读项目的实体表）⇒ 写错 id 的地方**当场被点名**，而不是"地图上没这个地点"让人自己猜。
 * 口径与地图那边一致（`map-marker-orphan`）：**按 id 存在与否**判，不猜卡片的 type 名。
 */

const EMPTY: Omit<TimelineViewPayload, "path" | "exists" | "note"> = {
  summary: [],
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
  // R134：`place_ref` 指向的实体**存在吗**（引擎不认地点实体 ⇒ 这条判定在桌面接线这一层做）
  // 口径与地图那边一致（`map-marker-orphan`）：**按 id 存在与否**判，不猜卡片的 type 名
  // （地点卡的 type 叫 `location`、layer 叫 `geography`；把类型名写死在这儿，换个写法就误报）
  const structure = await checkStructureFromSources(gatewayReader(gateway));
  const entityIds = new Set(structure.entities.map((entity) => entity.id));
  const placeOrphans: TimelineFindingPayload[] = parsed.events
    .filter((event) => event.placeRef !== undefined && !entityIds.has(event.placeRef))
    .map((event) => ({
      id: event.id,
      severity: "error" as const,
      rule: "tl-place-orphan",
      message: `事件 ${event.id} 的 place_ref「${event.placeRef}」指向的地点实体不存在（项目里没有这个 id）`,
    }));
  return {
    path: TIMELINE_PATH,
    exists: true,
    note: `${parsed.events.length} 条事件 · 锚定「${parsed.anchor_event}」= Year 0 · 历法 ${parsed.calendars.length} 套`,
    // 汇总的**结构化行**（R128）：界面逐行渲染；结构**由后端给**（不切上面那句自由文本）
    summary: [
      { label: "事件", value: `${String(parsed.events.length)} 条` },
      { label: "锚定", value: `「${parsed.anchor_event}」= Year 0` },
      { label: "历法", value: `${String(parsed.calendars.length)} 套` },
      ...(view.rows[0]?.calendar === undefined
        ? []
        : [{ label: "当前显示", value: `按「${view.rows[0]?.calendar}」` }]),
    ],
    calendars: parsed.calendars.map((c) => ({ id: c.id, label: c.label, offset: c.offset })),
    activeCalendar: view.rows[0]?.calendar ?? null,
    rows: view.rows,
    findings: [...view.findings, ...conflicts.findings, ...placeOrphans],
    notEvaluated: conflicts.notEvaluated,
  };
}
