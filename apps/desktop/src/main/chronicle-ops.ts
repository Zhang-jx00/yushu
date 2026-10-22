/* SPDX-License-Identifier: Apache-2.0 */
import {
  TIMELINE_PATH,
  buildChronicle,
  parseTimelineFile,
  readCardFile,
  type ChronicleResult,
  type TimelineFile,
} from "@yushu/world-engine";
import type { ChronicleBookPayload, SummaryRow } from "../shared/ipc.js";
import type { ProjectGateway } from "./file-gateway.js";

/**
 * 编年史的桌面接线（M4 / T4-8，R71）：**只读，且只读真源**。
 *
 * 两件事在这里做，都不含判定：① 读 `world/timeline.yaml` 交给引擎换算与配段；
 * ② 从 era 设定卡的 `extensions.chronicle` 取时代边界——**引擎不猜年代**，
 * 卡上没写区间的时代直接跳过并计入 `eraSkipped`，而不是"大概从上一段末尾开始"。
 *
 * 通道走 `wrap`：它一行都不写。年份显示走时间线那套历法（`calendar` 参数只是显示口径），
 * 编年史自己不持有刻度——这是 T4-8 的第一条约束（另起一套历法就是第二真源）。
 */

const EMPTY: Omit<ChronicleBookPayload, "path" | "exists" | "note"> = {
  summary: [],
  calendars: [],
  activeCalendar: null,
  entries: [],
  eras: [],
  divergences: [],
  withoutViewpoints: [],
  orphanEvents: [],
  uneraled: [],
  ambiguousEra: false,
  eraSkipped: [],
  stats: { events: 0, entries: 0, cultures: 0 },
};

/** era 卡上的年代区间：`extensions.chronicle: { from, to }`；缺任一侧就不算一个时代 */
async function readEras(gateway: ProjectGateway): Promise<{ eras: { label: string; from: number; to: number }[]; skipped: string[] }> {
  const eras: { label: string; from: number; to: number }[] = [];
  const skipped: string[] = [];
  const files = (await gateway.listTree()).filter(
    (entry) => entry.type === "file" && entry.path.startsWith("world/cards/") && entry.path.endsWith(".md"),
  );
  for (const file of files) {
    const snapshot = await gateway.readDoc(file.path).catch(() => null);
    if (snapshot === null) continue;
    let card;
    try {
      card = readCardFile(snapshot.content).card;
    } catch {
      continue; // 坏卡由档案页与一致性体检负责点名，这里不重复报错
    }
    if (card.layer !== "eras") continue;
    const range = (card.extensions as Record<string, unknown> | undefined)?.["chronicle"];
    if (
      range === null || typeof range !== "object" || Array.isArray(range) ||
      typeof (range as Record<string, unknown>).from !== "number" || typeof (range as Record<string, unknown>).to !== "number"
    ) {
      skipped.push(card.id);
      continue;
    }
    eras.push({
      label: card.name,
      from: (range as { from: number }).from,
      to: (range as { to: number }).to,
    });
  }
  return { eras, skipped };
}

export async function chronicleBook(
  gateway: ProjectGateway,
  request: { calendar?: string } = {},
): Promise<ChronicleBookPayload> {
  const snapshot = await gateway.readDoc(TIMELINE_PATH).catch(() => null);
  if (snapshot === null) {
    return {
      path: TIMELINE_PATH,
      exists: false,
      note: "还没有时间线真源（world/timeline.yaml）：编年史复用同一套刻度，不另建年表",
      ...EMPTY,
    };
  }
  let doc: TimelineFile;
  try {
    doc = parseTimelineFile(snapshot.content);
  } catch (err) {
    return {
      path: TIMELINE_PATH,
      exists: true,
      note: `时间线读不了，编年史不出结论（不静默按空年表显示）：${err instanceof Error ? err.message : String(err)}`,
      ...EMPTY,
    };
  }
  const { eras, skipped } = await readEras(gateway);
  const built: ChronicleResult = buildChronicle(doc, {
    ...(request.calendar === undefined || request.calendar === "" ? {} : { calendar: request.calendar }),
    ...(eras.length > 0 ? { eras } : {}),
  });
  return {
    path: TIMELINE_PATH,
    exists: true,
    note: `${built.stats.events} 个事件 → ${built.stats.entries} 条记载（${built.stats.cultures} 个文化视角）；` +
      (eras.length > 0 ? `${eras.length} 个时代分段` : "无 era 卡区间，按全书一段"),
    // 汇总的**结构化行**（R127）：界面逐行渲染；结构**由后端给**（不切上面那句自由文本）
    summary: [
      { label: "事件", value: `${String(built.stats.events)} 个` },
      { label: "记载", value: `${String(built.stats.entries)} 条` },
      { label: "文化视角", value: `${String(built.stats.cultures)} 个` },
      { label: "时代分段", value: eras.length > 0 ? `${String(eras.length)} 个` : "无 era 卡区间，按全书一段" },
    ],
    calendars: doc.calendars.map((c) => ({ id: c.id, label: c.label, offset: c.offset })),
    activeCalendar: built.entries[0]?.displayYear === null ? null : (request.calendar ?? doc.timelines[0]?.calendar ?? null),
    entries: built.entries,
    eras: built.eras,
    divergences: built.divergences,
    withoutViewpoints: built.withoutViewpoints,
    orphanEvents: built.orphanEvents,
    uneraled: built.uneraled,
    ambiguousEra: built.ambiguousEra,
    eraSkipped: skipped,
    stats: built.stats,
  };
}
