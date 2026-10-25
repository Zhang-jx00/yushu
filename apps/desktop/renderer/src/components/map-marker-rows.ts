/* SPDX-License-Identifier: Apache-2.0 */
import type { WorldMapMarkerRow } from "../../../src/shared/ipc";

/**
 * 标注清单的**筛选**（R171）。
 *
 * 口径回源 `docs/research/K-软件工程与产品/K08-时间线与地图UI.md` §3：
 * - §3.7 **标注即地点卡**（marker 绑定 location 实体）⇒ 一个标注的身份是「它绑的是谁」；
 * - §3.9 **分层可控**（底图 / 地名 / 政治 / 事件 / 行程线分层，图层独立显隐）⇒ 另一个身份是「它在哪一层」。
 *
 * 所以筛选只有三个维度：**按实体 / 按图层 / 是不是孤儿**（K08 的 `map-marker-orphan`：
 * 标注指向的地点实体不存在 ⇒ 那条标注画不出来，但它**仍在作者的文件里**）。
 *
 * **为什么筛选放在渲染层**：图层显隐本来就是"读者的视角，不是作者的数据"（R145 的口径）
 * ⇒ 筛选同属"看"的动作，不进真源；而**清单本身**（每一条标注、包括孤儿）由主进程从
 * 真源直算好送过来（`WorldMapViewPayload.markerRows`）⇒ 界面**不自己造数**。
 *
 * **为什么这三个维度可以叠**：它们问的是三件不同的事（谁 / 哪层 / 有没有实体）⇒ 叠加就是"同时满足"。
 */

/** 筛选条件：三个维度都是"空 = 不筛"（`orphanOnly` 默认 false） */
export interface MapMarkerFilter {
  /** 按实体筛（空 = 不按实体筛） */
  entityRef: string | null;
  /** 按图层筛（空 = 不按图层筛） */
  layer: string | null;
  /** 只看孤儿标注（指向的实体不存在） */
  orphanOnly: boolean;
}

/** 空筛选（三个维度都不筛） */
export const EMPTY_MARKER_FILTER: MapMarkerFilter = {
  entityRef: null,
  layer: null,
  orphanOnly: false,
};

/** 这个筛选有没有在筛（界面上据此决定要不要显示「清空筛选」） */
export function markerFilterActive(filter: MapMarkerFilter): boolean {
  return filter.entityRef !== null || filter.layer !== null || filter.orphanOnly;
}

/**
 * 筛出符合条件的标注（顺序照原清单 ⇒ 同输入同输出）。
 *
 * 三个维度是**与**的关系：按图层 + 只看孤儿 ⇒ 只要"既在这一层、又是孤儿"的那几条。
 */
export function filterMapMarkerRows(
  rows: WorldMapMarkerRow[],
  filter: MapMarkerFilter,
): WorldMapMarkerRow[] {
  return rows.filter((row) => {
    if (filter.entityRef !== null && row.entityRef !== filter.entityRef) return false;
    if (filter.layer !== null && row.layer !== filter.layer) return false;
    if (filter.orphanOnly && !row.orphan) return false;
    return true;
  });
}

/** 清单里出现过的图层（按清单里第一次出现的顺序 ⇒ 不另排一套序） */
export function markerRowLayers(rows: WorldMapMarkerRow[]): string[] {
  const out: string[] = [];
  for (const row of rows) {
    if (!out.includes(row.layer)) out.push(row.layer);
  }
  return out;
}

/**
 * 清单里出现过的实体（`entityRef` + 名字；孤儿标注**没有名字**，只留 id）。
 *
 * 名字取自清单本身（主进程从真源行表直算）⇒ 界面不自己查实体。
 */
export function markerRowEntities(
  rows: WorldMapMarkerRow[],
): { id: string; name: string | null; orphan: boolean }[] {
  const out: { id: string; name: string | null; orphan: boolean }[] = [];
  for (const row of rows) {
    if (out.some((item) => item.id === row.entityRef)) continue;
    out.push({ id: row.entityRef, name: row.entityName, orphan: row.orphan });
  }
  return out;
}
