/* SPDX-License-Identifier: Apache-2.0 */
import type { IndexEntityRow } from "./index-input.js";

/**
 * 世界地图（T5-1 第一段·**引擎侧**，R114）。
 *
 * 口径回源：`docs/research/K-软件工程与产品/K08-时间线与地图UI.md` §3：
 * ⑥ **地图 = 图片底图 + bounds**——虚构地图没有真实地理坐标，主流做法是把一张图片按边界铺在地图上
 *    （Leaflet `L.imageOverlay(url, bounds)` + `L.CRS.Simple`），坐标以**图片像素 / 归一化坐标**记录，
 *    不用真实经纬度；
 * ⑦ **标注即地点卡**：marker 绑定 location 实体；
 * ⑧ **事件锚点**：事件可挂坐标（`place_ref`），编年史选中事件时地图自动定位；
 * ⑨ **分层可控**：底图 / 地名 / 政治 / 事件 / 行程线分层，图层独立显隐（借鉴 Azgaar）。
 *
 * 诊断码回源同上（K08 §3 末尾的诊断码清单）：
 * - `map-bounds-missing`：地图无 `bounds`，或 `bounds` 与底图图片尺寸不匹配 → **error**；
 * - `map-marker-orphan`：marker 的 `entity_ref` 找不到地点实体 → **error**；
 * - `map-marker-overlap`：同层多点重合超阈值 → **info**（建议聚类）。
 * 另加一条 `map-marker-outside`（**本段新增，K08 没有**）：标注落在底图边界之外 → warn。
 *
 * 本段只做**投影与体检**：纯函数、零 fs、不读墙钟、不落盘、不改真源。
 * 地图是实体与坐标的一个**投影**，不长第二套数据结构（照 R69 关系图谱的做法）。
 * UI 渲染（底图铺放、图层开关、点标注开卡）顺延下一段。
 */

/** 地图图层（K08 §3.9 的分层；`other` 兜底认不出的） */
export type MapLayerKind = "base" | "place" | "political" | "event" | "route" | "other";

/** 底图边界（图片像素坐标） */
export interface MapBounds {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 地图标注（marker）：绑定一个地点实体 + 底图像素坐标 */
export interface MapMarker {
  id: string;
  layer: MapLayerKind;
  /** 地点实体 id（K08 §3.7：标注即地点卡） */
  entityRef: string;
  /** 底图像素坐标 */
  x: number;
  y: number;
  label?: string;
}

/** 地图定义（作者侧；本段只当输入，不负责解析文件与写盘） */
export interface WorldMapDef {
  id: string;
  /** 底图图片路径（K08 §3.6：作者上传底图并框定 bounds） */
  baseImage?: string;
  /** 坐标系：只有 `simple`（非地理坐标） */
  crs?: "simple";
  /** 底图边界：既接受 {x0,y0,x1,y1}，也接受 K08 里的 [[x0,y0],[x1,y1]] */
  bounds?: MapBounds | [[number, number], [number, number]];
  /** 底图图片尺寸（给了才能核对 bounds 与尺寸是否匹配） */
  baseSize?: { width: number; height: number };
  /** 作者声明的图层（可显隐） */
  layers?: MapLayerKind[];
  markers?: MapMarker[];
}

export interface MapProjectedMarker extends MapMarker {
  /** 画布归一化坐标（0..1）：渲染层直接用，不必自己换算 */
  nx: number;
  ny: number;
  /** 地点实体的名字（标注即地点卡：标上写什么） */
  entityName: string;
}

export type MapFindingCode =
  | "map-bounds-missing"
  | "map-marker-orphan"
  | "map-marker-overlap"
  | "map-marker-outside";

export interface MapFinding {
  code: MapFindingCode;
  severity: "error" | "warn" | "info";
  message: string;
  /** 涉及的 marker id / 图层（逐条点名，不合并成一句） */
  refs: string[];
}

export interface MapLayerSummary {
  kind: MapLayerKind;
  markerCount: number;
}

export interface WorldMapProjection {
  id: string;
  /** 归一化后的边界（无有效边界 = null） */
  bounds: MapBounds | null;
  /** 投影成功的标注（按 id 排序 ⇒ 同输入同输出） */
  markers: MapProjectedMarker[];
  layers: MapLayerSummary[];
  findings: MapFinding[];
  /** 找不到地点实体的 marker id（逐条） */
  orphanMarkers: string[];
  /** 同层重合的点（建议聚类；不自动移动——挪点位是作者的决定） */
  overlapClusters: Array<{ layer: MapLayerKind; members: string[] }>;
  /** 落在底图边界之外的 marker id */
  outOfBoundsMarkers: string[];
}

export interface WorldMapOptions {
  /** 同层两点距离小于该像素值算重合（默认 10px） */
  overlapPx?: number;
  /** 只投影这些图层（K08 §3.9：图层独立显隐）；省略 = 全画 */
  visibleLayers?: MapLayerKind[];
}

const LAYER_ORDER: MapLayerKind[] = ["base", "place", "political", "event", "route", "other"];

function layerRank(kind: MapLayerKind): number {
  const index = LAYER_ORDER.indexOf(kind);
  return index < 0 ? LAYER_ORDER.length : index;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * 归一化边界：接受两种写法（{x0,y0,x1,y1} 与 [[x0,y0],[x1,y1]]），
 * 并**要求宽高为正**——宽高为 0 的 bounds 画不出任何东西，归"无有效边界"。
 */
export function normalizeBounds(
  bounds: WorldMapDef["bounds"],
): { bounds: MapBounds | null; reason: string | null } {
  if (bounds === undefined) return { bounds: null, reason: "地图没有 bounds（图片底图要框定边界）" };
  let raw: MapBounds | null = null;
  if (Array.isArray(bounds)) {
    const [a, b] = bounds;
    if (!Array.isArray(a) || !Array.isArray(b)) return { bounds: null, reason: "bounds 写法认不出" };
    raw = { x0: Number(a[0]), y0: Number(a[1]), x1: Number(b[0]), y1: Number(b[1]) };
  } else {
    raw = { x0: Number(bounds.x0), y0: Number(bounds.y0), x1: Number(bounds.x1), y1: Number(bounds.y1) };
  }
  if (!isFiniteNumber(raw.x0) || !isFiniteNumber(raw.y0) || !isFiniteNumber(raw.x1) || !isFiniteNumber(raw.y1)) {
    return { bounds: null, reason: "bounds 里有非数字" };
  }
  if (raw.x1 <= raw.x0 || raw.y1 <= raw.y0) {
    return { bounds: null, reason: "bounds 的宽或高不为正" };
  }
  return { bounds: raw, reason: null };
}

/**
 * 地图投影：把「标注 + 地点实体」投影成一份可直接渲染的结果，并给出体检结论。
 *
 * 三条不猜：
 * ① 没有有效 bounds ⇒ **不产出坐标**（没有边界就无从归一化），只报 `map-bounds-missing`；
 *    悄悄按 0..1 归一会让"图没画对"看起来像"图画了"；
 * ② marker 指向的地点实体不存在 ⇒ **该标注不画**，但逐条进 `orphanMarkers` 并报
 *    `map-marker-orphan`——悄悄丢标注会让"地图少一个地点"看起来像"没问题"；
 * ③ 同层多点重合 ⇒ 报 `map-marker-overlap`（info，建议聚类）但**不自动挪动**：
 *    挪点位是作者的决定，工具替他挪了，作者就不知道原来那点在哪。
 */
export function projectWorldMap(
  def: WorldMapDef,
  entities: IndexEntityRow[],
  options: WorldMapOptions = {},
): WorldMapProjection {
  const overlapPx = options.overlapPx ?? 10;
  const visible = options.visibleLayers;
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const findings: MapFinding[] = [];

  // ① 边界
  const normalized = normalizeBounds(def.bounds);
  const bounds = normalized.bounds;
  if (bounds === null) {
    findings.push({
      code: "map-bounds-missing",
      severity: "error",
      message: normalized.reason ?? "地图没有有效 bounds",
      refs: [def.id],
    });
  } else if (def.baseSize !== undefined) {
    const width = bounds.x1 - bounds.x0;
    const height = bounds.y1 - bounds.y0;
    if (width !== def.baseSize.width || height !== def.baseSize.height) {
      findings.push({
        code: "map-bounds-missing",
        severity: "error",
        message:
          `bounds 的尺寸 ${String(width)}×${String(height)} 与底图图片 ` +
          `${String(def.baseSize.width)}×${String(def.baseSize.height)} 不匹配`,
        refs: [def.id],
      });
    }
  }

  // ② 标注：先按 id 排序 ⇒ 输出与输入顺序无关（同输入同输出）
  const input = [...(def.markers ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const markers: MapProjectedMarker[] = [];
  const orphanMarkers: string[] = [];
  const outOfBoundsMarkers: string[] = [];
  const perLayer = new Map<MapLayerKind, MapProjectedMarker[]>();

  for (const marker of input) {
    const entity = byId.get(marker.entityRef);
    if (entity === undefined) {
      orphanMarkers.push(marker.id);
      findings.push({
        code: "map-marker-orphan",
        severity: "error",
        message: `标注 ${marker.id} 指向的地点实体 ${marker.entityRef} 不存在`,
        refs: [marker.id, marker.entityRef],
      });
      continue;
    }
    if (visible !== undefined && !visible.includes(marker.layer)) continue;
    if (bounds === null) continue; // 没有边界 ⇒ 不产出坐标
    const nx = (marker.x - bounds.x0) / (bounds.x1 - bounds.x0);
    const ny = (marker.y - bounds.y0) / (bounds.y1 - bounds.y0);
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
      outOfBoundsMarkers.push(marker.id);
      findings.push({
        code: "map-marker-outside",
        severity: "warn",
        message: `标注 ${marker.id} 落在底图边界之外`,
        refs: [marker.id],
      });
    }
    const projected: MapProjectedMarker = { ...marker, nx, ny, entityName: entity.name };
    markers.push(projected);
    const list = perLayer.get(marker.layer) ?? [];
    list.push(projected);
    perLayer.set(marker.layer, list);
  }

  // ③ 同层重合：按距离聚类（贪心：并进第一个够近的簇，否则自成一簇）
  const overlapClusters: Array<{ layer: MapLayerKind; members: string[] }> = [];
  for (const [layer, list] of [...perLayer.entries()].sort((a, b) => layerRank(a[0]) - layerRank(b[0]))) {
    const clusters: string[][] = [];
    for (const marker of list) {
      let target: string[] | null = null;
      for (const cluster of clusters) {
        const anchor = list.find((item) => item.id === cluster[0]);
        if (anchor === undefined) continue;
        const distance = Math.hypot(marker.x - anchor.x, marker.y - anchor.y);
        if (distance < overlapPx) {
          target = cluster;
          break;
        }
      }
      if (target === null) clusters.push([marker.id]);
      else target.push(marker.id);
    }
    for (const members of clusters) {
      if (members.length < 2) continue;
      const sorted = [...members].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      overlapClusters.push({ layer, members: sorted });
      findings.push({
        code: "map-marker-overlap",
        severity: "info",
        message: `图层 ${layer} 上有 ${String(sorted.length)} 个标注重合（建议聚类）`,
        refs: sorted,
      });
    }
  }

  // 图层清单：作者声明的 ∪ 实际出现的，按固定顺序
  const kinds = new Set<MapLayerKind>(def.layers ?? []);
  for (const marker of markers) kinds.add(marker.layer);
  const layers: MapLayerSummary[] = [...kinds]
    .sort((a, b) => layerRank(a) - layerRank(b))
    .map((kind) => ({ kind, markerCount: (perLayer.get(kind) ?? []).length }));

  findings.sort((a, b) => {
    if (a.code !== b.code) return a.code < b.code ? -1 : 1;
    const left = a.refs.join("|");
    const right = b.refs.join("|");
    return left < right ? -1 : left > right ? 1 : 0;
  });

  return {
    id: def.id,
    bounds,
    markers,
    layers,
    findings,
    orphanMarkers,
    overlapClusters,
    outOfBoundsMarkers,
  };
}
