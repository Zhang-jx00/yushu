/* SPDX-License-Identifier: Apache-2.0 */
import { formatCalendarYear, type Calendar, type TimelineEvent, type TimelineFile } from "./timeline.js";

/**
 * 编年史（M4 / T4-8 引擎侧，R70）：大事年表 + 同一事件的多文化"伪史书"。
 *
 * **刻度只复用不重造**：本模块吃 T4-7 的 `TimelineFile`，年份一律走 `formatCalendarYear`，
 * 自己**没有年表结构、也没有第二套历法**——另起一套就是长出第二真源（红线 1）。
 *
 * 三条不猜：
 * ① 事件没有 `pov_viewpoints` ⇒ 给一条 `culture: null` 的中性记载，**不替作者编一个视角**；
 * ② 时代边界由调用方给（来自 era 设定卡），引擎**不猜年代**；落不进任何时代的事件进 `uneraled` 点名，
 *    不悄悄塞进最后一段；
 * ③ 多文化记载**完全相同**时 `differing: false` 并写明"一致"——"几个文化说法一样"与
 *    "只有一个说法"是两回事，前者是有价值的证据，后者是没数据。
 */

export interface ChronicleEntry {
  eventId: string;
  title: string;
  year: number;
  displayYear: string | null;
  culture: string | null;
  account: string | null;
  source: string | null;
}

export interface ChronicleEra {
  label: string;
  from: number;
  to: number;
  entries: number;
}

export interface ChronicleDivergence {
  eventId: string;
  title: string;
  cultures: string[];
  differing: boolean;
  note: string;
}

export interface ChronicleOptions {
  /** 显示用历法（省略 = 用事件所属时间线自己的历法） */
  calendar?: string;
  /** 时代分段（由 era 设定卡给出；省略 = 单段「全书」，不假装分过段） */
  eras?: { label: string; from: number; to: number }[];
}

export interface ChronicleResult {
  entries: ChronicleEntry[];
  eras: ChronicleEra[];
  divergences: ChronicleDivergence[];
  withoutViewpoints: string[];
  orphanEvents: string[];
  uneraled: string[];
  ambiguousEra: boolean;
  stats: { events: number; entries: number; cultures: number };
}

function byCodePoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function calendarFor(doc: TimelineFile, options: ChronicleOptions, event: TimelineEvent): Calendar | null {
  const id = options.calendar ?? doc.timelines.find((t) => t.id === event.timeline)?.calendar ?? "";
  return doc.calendars.find((c) => c.id === id) ?? null;
}

export function buildChronicle(doc: TimelineFile, options: ChronicleOptions = {}): ChronicleResult {
  // 解析层已经拒绝「事件引用不存在的 timeline」，这里能查的归属问题是：
  // 事件写了合法 timeline，却没有任何时间线把它列进 events[]（写了年表却没进年表）
  const listedEvents = new Set(doc.timelines.flatMap((t) => t.events));
  const events = [...doc.events].sort((a, b) => a.year - b.year || byCodePoint(a.id, b.id));

  const entries: ChronicleEntry[] = [];
  const withoutViewpoints: string[] = [];
  const divergences: ChronicleDivergence[] = [];
  const orphanEvents: string[] = [];
  const cultures = new Set<string>();

  for (const event of events) {
    if (!listedEvents.has(event.id)) orphanEvents.push(event.id);
    const calendar = calendarFor(doc, options, event);
    const displayYear = calendar === null ? null : formatCalendarYear(event.year, calendar);
    const viewpoints = event.pov_viewpoints ?? [];
    if (viewpoints.length === 0) {
      withoutViewpoints.push(event.id);
      entries.push({ eventId: event.id, title: event.title, year: event.year, displayYear, culture: null, account: null, source: null });
      continue;
    }
    const sorted = [...viewpoints].sort((a, b) => byCodePoint(a.culture, b.culture));
    for (const view of sorted) {
      cultures.add(view.culture);
      entries.push({
        eventId: event.id,
        title: event.title,
        year: event.year,
        displayYear,
        culture: view.culture,
        account: view.account,
        source: view.source ?? null,
      });
    }
    if (sorted.length >= 2) {
      const accounts = new Set(sorted.map((view) => view.account));
      divergences.push({
        eventId: event.id,
        title: event.title,
        cultures: sorted.map((view) => view.culture),
        differing: accounts.size > 1,
        note: accounts.size > 1
          ? `${sorted.length} 个文化的记载不同（${[...accounts].sort(byCodePoint).join(" / ")}）`
          : `${sorted.length} 个文化的记载完全一致——这本身是证据，不是"没有分歧"`,
      });
    }
  }

  const eraSpecs = options.eras;
  let eras: ChronicleEra[] = [];
  const uneraled: string[] = [];
  let ambiguousEra = false;

  if (eraSpecs !== undefined && eraSpecs.length > 0) {
    eraSpecs.forEach((left, index) => {
      for (const right of eraSpecs.slice(index + 1)) {
        if (left.from < right.to && right.from < left.to) ambiguousEra = true;
      }
    });
    const counts = eraSpecs.map((era) => ({ label: era.label, from: era.from, to: era.to, entries: 0 }));
    for (const entry of entries) {
      const hit = counts.find((era) => entry.year >= era.from && entry.year < era.to);
      if (hit) hit.entries += 1;
      else uneraled.push(entry.eventId);
    }
    eras = counts;
    uneraled.sort(byCodePoint);
    // 同一事件的多个文化记载会重复出现在 uneraled 里，去重后才是"哪些事件没归属"
    return finish({ eras, uneraled: [...new Set(uneraled)].sort(byCodePoint), ambiguousEra });
  }

  const firstEvent = events[0];
  const lastEvent = events[events.length - 1];
  if (firstEvent !== undefined && lastEvent !== undefined) {
    eras = [{ label: "全书", from: firstEvent.year, to: lastEvent.year, entries: entries.length }];
  }
  return finish({ eras, uneraled, ambiguousEra });

  function finish(extra: { eras: ChronicleEra[]; uneraled: string[]; ambiguousEra: boolean }) {
    return {
      entries,
      eras: extra.eras,
      divergences,
      withoutViewpoints: withoutViewpoints.sort(byCodePoint),
      orphanEvents: orphanEvents.sort(byCodePoint),
      uneraled: extra.uneraled,
      ambiguousEra: extra.ambiguousEra,
      stats: { events: events.length, entries: entries.length, cultures: cultures.size },
    };
  }
}
