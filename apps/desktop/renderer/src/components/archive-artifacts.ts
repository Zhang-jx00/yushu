/* SPDX-License-Identifier: Apache-2.0 */
import type {
  ChronicleBookPayload,
  ForeshadowBoardPayload,
  SatisfactionBoardPayload,
  SummaryRow,
} from "../../../src/shared/ipc.js";

/**
 * 世界观档案页右栏的「产物」摘要（R162）：伏笔 / 爽点 / 编年史三块。
 *
 * 为什么单独抽一个**纯函数**模块：右栏的每一个数都必须与中栏那张表**逐字对得上**
 * （§7.34 的「同一份真源的两个读法」⇒ 预演可以对账）。
 * 只要右栏自己再算一遍，就会有两个数可能对不上 ⇒ 这一层必须是**同一份载荷 + 同一套算法**，
 * 放在一起才看得见"是不是同一个数"。
 *
 * 三条口径：
 * ① **一个数一个出处**：这里的数全部来自载荷（`stats` / `rows` / `promises` / `entries`），
 *    界面不自己算、不写死字面量（换一份载荷，右栏整套数跟着换）；
 * ② **名单与中栏的表一一对应**：`listed` = 中栏那张表的 tbody 行数；
 *    `marked` = 那张表里**带标记**的行数（伏笔 = 未回收 / 爽点 = 还没兑现 / 编年史 = 有分歧）；
 *    名单项的 `name` / `state` 与中栏那一列的**字面**一致 ⇒ 预演能逐项对账；
 * ③ **没取到就说没取到**（不许装成有）：载荷没到就写"还没取到"，载荷到了但没有内容就摆它自己的 `note`。
 *
 * 纯函数：只读载荷，不碰 fs、不碰 React、不读墙钟 ⇒ 可单测。
 */

export type ArchiveArtifactKey = "foreshadow" | "satisfaction" | "chronicle";

/** 名单里的一项（与中栏那张表的一行一一对应） */
export interface ArchiveArtifactItem {
  /** 这一项的稳定标识（伏笔 id / 承诺 id / 事件 id + 文化） */
  id: string;
  /** 名单上摆的名字（与中栏那一列的字面一致） */
  name: string;
  /** 这一项的状态（与中栏那一列的字面一致） */
  state: string;
}

/** 对账用的数：每一个都能在中栏那张表里数出来 */
export interface ArchiveArtifactCounts {
  /** 名单条数 == 中栏那张表的 tbody 行数 */
  listed: number;
  /** 名单条数在界面上叫什么 */
  listedLabel: string;
  /** 名单里"带标记"的条数 == 中栏那张表里带标记的行数 */
  marked: number;
  /** 带标记的条数在界面上叫什么 */
  markedLabel: string;
  /** 这一块特有的另一个数（没有就 null） */
  extra: { label: string; value: number } | null;
}

/** 右栏的一块产物 */
export interface ArchiveArtifactBlock {
  key: ArchiveArtifactKey;
  title: string;
  /** 结论摘要（结构化行，来自载荷；界面逐行渲染，不切字符串） */
  summary: SummaryRow[];
  /** 名单 */
  items: ArchiveArtifactItem[];
  counts: ArchiveArtifactCounts;
  /** 没取到 / 没有内容时的如实说明（空串 = 有内容） */
  note: string;
}

export interface ArchiveArtifactInput {
  foreshadow: ForeshadowBoardPayload | null;
  satisfaction: SatisfactionBoardPayload | null;
  chronicle: ChronicleBookPayload | null;
}

/** 名单最多列这么多条（多的说清还有几条）——窄栏里别把作者埋了 */
export const ARCHIVE_ARTIFACT_MAX_ITEMS = 20;

/**
 * 还没兑现的承诺状态（引擎 `world-engine/satisfaction.ts` 的 `OPEN_STATUSES`）。
 *
 * 这里照抄一份是**有意的**：界面上要把"还没兑现"这件事说给作者听，
 * 而判定仍在引擎（引擎那边给的 `stats.openPromises` 与这份口径必须一致 ⇒ 单测对着核）。
 */
export const OPEN_PROMISE_STATUSES: readonly string[] = ["open", "paying", "deferred"];

/** 三块产物（左到右的固定次序） */
export function summarizeArchiveArtifacts(input: ArchiveArtifactInput): ArchiveArtifactBlock[] {
  return [
    summarizeForeshadow(input.foreshadow),
    summarizeSatisfaction(input.satisfaction),
    summarizeChronicle(input.chronicle),
  ];
}

/** 伏笔：中栏那张表是「伏笔台账」 ⇒ 名单 = 台账的行，带标记 = 看板为未回收 */
function summarizeForeshadow(board: ForeshadowBoardPayload | null): ArchiveArtifactBlock {
  if (board === null) {
    return {
      key: "foreshadow",
      title: "伏笔产物",
      summary: [],
      items: [],
      counts: { listed: 0, listedLabel: "伏笔", marked: 0, markedLabel: "未回收", extra: null },
      note: "这一块还没取到（等伏笔台账读回来）",
    };
  }
  const items: ArchiveArtifactItem[] = board.rows.map((row) => ({
    id: row.id,
    name: row.name,
    // 看板的中文说法与中栏那一列**逐字一致**（"open" ⇒ 未回收，"closed" ⇒ 已闭环）
    state: row.board === "open" ? "未回收" : "已闭环",
  }));
  return {
    key: "foreshadow",
    title: "伏笔产物",
    summary: board.summary,
    items,
    counts: {
      listed: items.length,
      listedLabel: "伏笔",
      marked: items.filter((item) => item.state === "未回收").length,
      markedLabel: "未回收",
      extra: { label: "已闭环", value: board.stats.closed ?? 0 },
    },
    note: items.length === 0 ? board.note : "",
  };
}

/** 爽点：中栏那张表是「爽点与期待感」 ⇒ 名单 = 承诺，带标记 = 还没兑现 */
function summarizeSatisfaction(board: SatisfactionBoardPayload | null): ArchiveArtifactBlock {
  if (board === null) {
    return {
      key: "satisfaction",
      title: "爽点产物",
      summary: [],
      items: [],
      counts: { listed: 0, listedLabel: "承诺", marked: 0, markedLabel: "还没兑现", extra: null },
      note: "这一块还没取到（等爽点台账读回来）",
    };
  }
  const items: ArchiveArtifactItem[] = board.promises.map((promise) => ({
    id: promise.id,
    name: promise.promise,
    // 状态用载荷里的**原值**（与中栏那一列逐字一致）
    state: promise.status,
  }));
  return {
    key: "satisfaction",
    title: "爽点产物",
    summary: board.summary,
    items,
    counts: {
      listed: items.length,
      listedLabel: "承诺",
      marked: items.filter((item) => OPEN_PROMISE_STATUSES.includes(item.state)).length,
      markedLabel: "还没兑现",
      extra: { label: "章", value: board.rows.length },
    },
    note: items.length === 0 ? board.note : "",
  };
}

/** 编年史：中栏那张表是「编年史」 ⇒ 名单 = 记载，带标记 = 这一事件有分歧 */
function summarizeChronicle(book: ChronicleBookPayload | null): ArchiveArtifactBlock {
  if (book === null) {
    return {
      key: "chronicle",
      title: "编年史产物",
      summary: [],
      items: [],
      counts: { listed: 0, listedLabel: "记载", marked: 0, markedLabel: "有分歧", extra: null },
      note: "这一块还没取到（等编年史读回来）",
    };
  }
  const differing = new Set(
    book.divergences.filter((item) => item.differing).map((item) => item.eventId),
  );
  const items: ArchiveArtifactItem[] = book.entries.map((entry) => ({
    id: entry.eventId + "|" + (entry.culture ?? "中性记载"),
    name: entry.title,
    // 视角的说法与中栏那一列**逐字一致**（没有多文化版本 ⇒ 中性记载）
    state: entry.culture ?? "中性记载",
  }));
  // 「有分歧」按**记载行**数（与中栏那张表的行一一对应）——
  // 同一事件有两个文化记载时，那两行都带分歧徽标（中栏就是这么渲染的）。
  const marked = book.entries.filter((entry) => differing.has(entry.eventId)).length;
  return {
    key: "chronicle",
    title: "编年史产物",
    summary: book.summary,
    items,
    counts: {
      listed: items.length,
      listedLabel: "记载",
      marked,
      markedLabel: "有分歧",
      extra: { label: "事件", value: book.stats.events },
    },
    note: items.length === 0 ? book.note : "",
  };
}
