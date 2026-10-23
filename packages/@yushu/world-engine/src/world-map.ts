/* SPDX-License-Identifier: Apache-2.0 */
import { YushuError } from "@yushu/core";
import { parseDocument } from "yaml";
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

/**
 * 地图上的**面 / 线**（R143）：区域（多边形）与行程线（折线）。
 *
 * 口径回源 K08 §5 的图层类型（`type: region` / `type: polyline`）——
 * K08 给了**图层类型**但没给几何 ⇒ 这一段的几何由本项目定，并写进 docs/11：
 * **点用底图像素**（与标注/锚点同一套坐标空间），一行一个形状：
 * `regions: [{id, layer, name?, points: [[x,y], …]}]` / `routes: [{id, layer, name?, points: [[x,y], …]}]`。
 *
 * 为什么不用经纬度：K08 §3.6 明写「坐标以图片像素 / 归一化坐标记录（不用真实经纬度）」。
 */
export type MapShapeKind = "region" | "route";

/** 地图上的一个面 / 线 */
export interface MapShape {
  id: string;
  kind: MapShapeKind;
  layer: MapLayerKind;
  /** 作者给的名字（可省 ⇒ 界面上显示 id） */
  name?: string;
  /** 顶点（底图像素；区域是闭合多边形，行程线是折线） */
  points: [number, number][];
}

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

/**
 * 事件锚点（K08 §3.8：**事件挂坐标** ⇒ 时空联动）。
 *
 * 与标注的差别：标注绑**地点实体**（点开是地点卡），锚点绑**事件**（选事件能定位到地图上）。
 * K08 §3.6 的样例写作 `{event_ref: evt-0007, xy: [420, 610]}`；本项目沿用地图自己的键名口径
 * （`x` / `y` 分开写，与 `markers` 一致）⇒ 作者只学一套坐标写法。
 */
export interface MapEventAnchor {
  id: string;
  /** 事件 id（对应 `world/timeline.yaml` 里的事件） */
  eventRef: string;
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
  /** 区域与行程线（R143；K08 §5 的后两样） */
  shapes?: MapShape[];
  /** 作者声明的图层（可显隐） */
  layers?: MapLayerKind[];
  markers?: MapMarker[];
  /** 事件锚点（K08 §3.8：事件挂坐标 ⇒ 时空联动） */
  eventAnchors?: MapEventAnchor[];
}

export interface MapProjectedMarker extends MapMarker {
  /** 画布归一化坐标（0..1）：渲染层直接用，不必自己换算 */
  nx: number;
  ny: number;
  /** 地点实体的名字（标注即地点卡：标上写什么） */
  entityName: string;
}

/** 事件锚点的投影结果（归一化坐标） */
export interface MapProjectedAnchor extends MapEventAnchor {
  nx: number;
  ny: number;
}

/** 面 / 线的投影结果（顶点已归一化） */
export interface MapProjectedShape extends MapShape {
  /** 归一化后的顶点（0..1） */
  points: [number, number][];
}

export type MapFindingCode =
  | "map-bounds-missing"
  | "map-marker-orphan"
  | "map-marker-overlap"
  | "map-marker-outside"
  | "map-anchor-outside"
  | "map-shape-outside";

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
  /** 投影成功的事件锚点（按 id 排序 ⇒ 同输入同输出） */
  anchors: MapProjectedAnchor[];
  /** 投影成功的区域与行程线（按 id 排序） */
  shapes: MapProjectedShape[];
  layers: MapLayerSummary[];
  findings: MapFinding[];
  /** 找不到地点实体的 marker id（逐条） */
  orphanMarkers: string[];
  /** 同层重合的点（建议聚类；不自动移动——挪点位是作者的决定） */
  overlapClusters: Array<{ layer: MapLayerKind; members: string[] }>;
  /** 落在底图边界之外的 marker id */
  outOfBoundsMarkers: string[];
  /** 落在底图边界之外的事件锚点 id */
  outOfBoundsAnchors: string[];
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
    // R138：**bounds 是作者框定的那一块**（口径回源 K08 §3.6「用户上传底图并**框定 bounds**」）
    // ⇒ 判据从「尺寸必须等于底图」改成「**范围必须落在底图里**」。
    // 以前那条判等是"作者只能整张图当地图"时代留下的：那时没有框定，只能拿手填的尺寸去对。
    // 现在作者框一块是**正式功能** ⇒ 只有"框到图外"才是写错（画出来是空的）。
    const outside =
      bounds.x0 < 0 ||
      bounds.y0 < 0 ||
      bounds.x1 > def.baseSize.width ||
      bounds.y1 > def.baseSize.height;
    if (outside) {
      findings.push({
        code: "map-bounds-missing",
        severity: "error",
        message:
          `bounds 的范围 ${String(bounds.x0)},${String(bounds.y0)} → ` +
          `${String(bounds.x1)},${String(bounds.y1)} 与底图图片 ` +
          `${String(def.baseSize.width)}×${String(def.baseSize.height)} 不匹配（框定的范围超出了底图）`,
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

  // ④ 事件锚点（K08 §3.8：事件挂坐标 ⇒ 选事件能定位到地图上）
  //    与标注同一套"不猜"：没有有效边界 ⇒ 不产出坐标（悄悄按 0..1 归一会让"图没画对"像"图画了"）。
  const anchorInput = [...(def.eventAnchors ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // 面 / 线（R143）：顶点按边界归一（与标注同一套坐标空间）
  // 没有有效边界 ⇒ **不产出形状**（没有边界就无从归一，与标注、锚点同一条纪律）
  const shapes: MapProjectedShape[] = [];
  if (bounds !== null) {
  for (const shape of [...(def.shapes ?? [])].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const points: [number, number][] = [];
    let outside = false;
    for (const [px, py] of shape.points) {
      const nx = (px - bounds.x0) / (bounds.x1 - bounds.x0);
      const ny = (py - bounds.y0) / (bounds.y1 - bounds.y0);
      if (nx < 0 || nx > 1 || ny < 0 || ny > 1) outside = true;
      points.push([nx, ny]);
    }
    if (outside) {
      findings.push({
        code: "map-shape-outside",
        severity: "warn",
        message: `${shape.kind === "region" ? "区域" : "行程线"} ${shape.id} 有顶点落在底图边界之外`,
        refs: [shape.id],
      });
    }
    shapes.push({ ...shape, points });
  }
  }

  const anchors: MapProjectedAnchor[] = [];
  const outOfBoundsAnchors: string[] = [];
  for (const anchor of anchorInput) {
    if (bounds === null) continue; // 没有边界 ⇒ 不产出坐标
    const nx = (anchor.x - bounds.x0) / (bounds.x1 - bounds.x0);
    const ny = (anchor.y - bounds.y0) / (bounds.y1 - bounds.y0);
    if (nx < 0 || nx > 1 || ny < 0 || ny > 1) {
      outOfBoundsAnchors.push(anchor.id);
      findings.push({
        code: "map-anchor-outside",
        severity: "warn",
        message: `事件锚点 ${anchor.id}（${anchor.eventRef}）落在底图边界之外`,
        refs: [anchor.id, anchor.eventRef],
      });
    }
    anchors.push({ ...anchor, nx, ny });
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
    anchors,
    shapes,
    layers,
    findings,
    orphanMarkers,
    overlapClusters,
    outOfBoundsMarkers,
    outOfBoundsAnchors,
  };
}

/* ---------------------------------------------------------------------------
 * 真源文件的严格解析（R120）
 *
 * 口径回源 K08 §3.6 的 yaml 样例（`map: {id, base_image, crs, bounds, layers, markers}`）
 * 与 §2.9「分层可控」。**为什么解析要严格**：地图错了不会立刻显形——画布照样出得来，
 * 只是地点摆错了位置；作者往往看不出"这张图是歪的"，几天后才在正文里发现对不上。
 * 所以拼错的键、认不出的图层名、非数字的坐标一律**拒绝加载并点名**，
 * 而不是"忽略这个字段继续画"（那会让作者以为坐标生效了）。
 *
 * 与投影的分工：**解析管形状**（键名/类型/枚举/重复 id），
 * **投影管体检**（bounds 是否有效、标注是否孤儿、是否重合、是否越界）——
 * 边界宽高为正与否不在这里判：那是 `normalizeBounds` 的活，判了它就会把
 * "无有效边界"这件事从体检结论里抹掉。
 * ------------------------------------------------------------------------ */

export const MAP_API_VERSION = "map-v1";

/**
 * 把底图登记**并进**地图文件（R135）：只加 `base_image` / `base_size` / `bounds` 三行，
 * 标注、图层、事件锚点**原样留着**。
 *
 * 为什么不是"重写整个文件"：那要一个序列化器（会把作者写的注释与排版抹掉），
 * 而作者在意的恰恰是那些标注与顺序 ⇒ 只**追加**三行。
 *
 * 已经登记过底图 ⇒ **拒绝**（不覆盖）：换底图是作者的决定，旧的那张也还在项目里。
 *
 * `bounds` 用**量出来的像素尺寸**填（不是作者手填）⇒ 作者再也填不对边界。
 */
export function appendMapBase(
  text: string,
  base: { baseImage: string; width: number; height: number },
  mode: "register" | "replace" = "register",
): { content: string | null; reason: string | null; previous: string[] } {
  const lines = text.split("\n");
  const hasKey = (key: string): boolean => lines.some((line) => new RegExp(`^${key}:`).test(line));
  const existing = ["base_image", "base_size", "bounds"].filter(hasKey);
  const previous = lines.filter((line) => /^(base_image|base_size|bounds):/.test(line));
  if (existing.length > 0 && mode !== "replace") {
    return {
      content: null,
      reason: `地图文件里已经有 ${existing.join(" / ")} ⇒ 不替你改（换底图是作者的决定）`,
      previous,
    };
  }
  // 「换」模式：把**旧的那几行**去掉再写新的（作者的标注、图层、注释**原样留着**）
  const kept = mode === "replace" ? lines.filter((line) => !/^(base_image|base_size|bounds):/.test(line)) : lines;
  const head = kept.join("\n").replace(/\n*$/, "");
  const added = [
    `base_image: ${base.baseImage}`,
    `base_size: {width: ${base.width}, height: ${base.height}}`,
    `bounds: [[0, 0], [${base.width}, ${base.height}]]`,
  ];
  return { content: `${head}\n${added.join("\n")}\n`, reason: null, previous };
}

function failMap(message: string): never {
  throw new YushuError("E_MAP_PARSE", message);
}

/** 正则里要转义的字符（id 是作者起的名字，可能带 . - _） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 找到**那一个标注**在文件里的行号（R139：挪标注）。
 *
 * 只认**单行的流式映射**（`- {id: …, x: …, y: …}`）——那正是作者手写与工具写出来的形状。
 * 认不出就**如实说认不出**（让作者自己改那一行），不猜、不重排整个文件。
 */
function markerLineIndex(lines: string[], markerId: string): number {
  const idPattern = new RegExp(`(?:^|[\\s{,])id\\s*:\\s*${escapeRegExp(markerId)}\\s*(?:,|\\})`);
  return lines.findIndex((line) => /^\s*-\s*\{/.test(line) && idPattern.test(line));
}

/**
 * 找到**那一个事件锚点**在文件里的行号（R141：挪锚点）。
 *
 * 锚点的 `id` **可以省**（默认用 `event_ref`）⇒ 认 `id:` 也认 `event_ref:`。
 * 还要**在 `event_anchors:` 段里**找（别把同名的一行标注当成锚点）。
 */
function anchorLineIndex(lines: string[], anchorId: string): number {
  const escaped = escapeRegExp(anchorId);
  const idPattern = new RegExp(`(?:^|[\\s{,])id\\s*:\\s*${escaped}\\s*(?:,|\\})`);
  const refPattern = new RegExp(`(?:^|[\\s{,])event_ref\\s*:\\s*${escaped}\\s*(?:,|\\})`);
  let inSection = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as string;
    if (/^event_anchors\s*:/.test(line)) {
      inSection = true;
      continue;
    }
    if (inSection && /^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(line)) inSection = false;
    if (!inSection) continue;
    if (/^\s*-\s*\{/.test(line) && (idPattern.test(line) || refPattern.test(line))) return index;
  }
  return -1;
}

/** 把一行里的 `x` / `y` 改成新值（其余部分原样保留） */
function rewritePositionInLine(line: string, position: { x: number; y: number }): string {
  return line
    .replace(/\bx\s*:\s*-?\d+(?:\.\d+)?/, `x: ${String(position.x)}`)
    .replace(/\by\s*:\s*-?\d+(?:\.\d+)?/, `y: ${String(position.y)}`);
}

/**
 * 把**一个新标注**追加进地图文件（R140）：只动 `markers:` 那一段，别的行**原样留着**。
 *
 * 为什么不是"解析 → 改对象 → 重新序列化"：那要一个序列化器（会把作者写的注释与排版抹掉），
 * 而作者在意的恰恰是那些标注与顺序 ⇒ 只**追加那一行**（与 `appendMapBase` 同一个道理）。
 *
 * 追加的位置：`markers:` 段的**末尾**（下一个顶层键之前）——放最后 ⇒ 作者自己写的标注顺序不变。
 * 文件里还没有 `markers:` 段 ⇒ 在末尾**新起一段**（不猜作者原本想放哪 ⇒ 追加是最保守的）。
 */
export function appendMapMarker(
  text: string,
  marker: { id: string; layer: MapLayerKind; entityRef: string; x: number; y: number },
): { content: string | null; reason: string | null; previous: string[] } {
  const lines = text.split("\n");
  const entry =
    `  - {id: ${marker.id}, layer: ${marker.layer}, entity_ref: ${marker.entityRef}, ` +
    `x: ${String(marker.x)}, y: ${String(marker.y)}}`;
  const markersIndex = lines.findIndex((line) => /^markers\s*:/.test(line));
  if (markersIndex < 0) {
    const head = text.replace(/\n*$/, "");
    return { content: `${head}\nmarkers:\n${entry}\n`, reason: null, previous: [] };
  }
  // `markers:` 段的末尾 = 下一个**顶层键**（列 0 的 `key:`）或文件末尾
  let end = markersIndex + 1;
  while (end < lines.length && !/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(lines[end] as string)) end += 1;
  const inserted = [...lines.slice(0, end), entry, ...lines.slice(end)];
  return { content: inserted.join("\n"), reason: null, previous: [] };
}

/**
 * 把**一个区域 / 行程线**追加进地图文件（R143）：只动 `regions:` / `routes:` 那一段。
 *
 * 与 `appendMapMarker` / `appendMapAnchor` 同一条纪律：**只追加那一行**，
 * 排在那一段的**末尾** ⇒ 作者自己写的顺序不变；没有那一段就在末尾**新起一段**。
 */
export function appendMapShape(
  text: string,
  shape: { id: string; kind: MapShapeKind; layer: MapLayerKind; name?: string; points: [number, number][] },
): { content: string | null; reason: string | null; previous: string[] } {
  const key = shape.kind === "region" ? "regions" : "routes";
  const points = shape.points.map(([x, y]) => `[${String(x)}, ${String(y)}]`).join(", ");
  const namePart = shape.name === undefined ? "" : `, name: "${shape.name.replace(/["\\]/g, "\\$&")}"`;
  const entry = `  - {id: ${shape.id}, layer: ${shape.layer}${namePart}, points: [${points}]}`;
  const lines = text.split("\n");
  const sectionIndex = lines.findIndex((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (sectionIndex < 0) {
    const head = text.replace(/\n*$/, "");
    return { content: `${head}\n${key}:\n${entry}\n`, reason: null, previous: [] };
  }
  let end = sectionIndex + 1;
  while (end < lines.length && !/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(lines[end] as string)) end += 1;
  const inserted = [...lines.slice(0, end), entry, ...lines.slice(end)];
  return { content: inserted.join("\n"), reason: null, previous: [] };
}

/**
 * 把**一个新事件锚点**追加进地图文件（R142）：只动 `event_anchors:` 那一段，别的行**原样留着**。
 *
 * 与 `appendMapMarker` 同理：不重新序列化整个文件（那会抹掉作者写的注释与排版），
 * 只**追加那一行**，且排在 `event_anchors:` 段的**末尾**（作者自己写的锚点顺序不变）。
 */
export function appendMapAnchor(
  text: string,
  anchor: { id: string; eventRef: string; x: number; y: number },
): { content: string | null; reason: string | null; previous: string[] } {
  const lines = text.split("\n");
  const entry =
    `  - {id: ${anchor.id}, event_ref: ${anchor.eventRef}, ` +
    `x: ${String(anchor.x)}, y: ${String(anchor.y)}}`;
  const sectionIndex = lines.findIndex((line) => /^event_anchors\s*:/.test(line));
  if (sectionIndex < 0) {
    const head = text.replace(/\n*$/, "");
    return { content: `${head}\nevent_anchors:\n${entry}\n`, reason: null, previous: [] };
  }
  let end = sectionIndex + 1;
  while (end < lines.length && !/^[A-Za-z_][A-Za-z0-9_]*\s*:/.test(lines[end] as string)) end += 1;
  const inserted = [...lines.slice(0, end), entry, ...lines.slice(end)];
  return { content: inserted.join("\n"), reason: null, previous: [] };
}

/**
 * 把**一个标注**挪到新位置（R139）：只改那一行的 `x` / `y`，别的**一个字都不动**。
 *
 * 为什么不做"解析 → 改对象 → 重新序列化"：那要一个序列化器（会把作者写的注释与排版抹掉），
 * 而作者在意的恰恰是那些标注与顺序 ⇒ 只**改那一行**（与 `appendMapBase` 同一个道理）。
 *
 * 挪不动的三种情况都**如实说**（不猜、不半个改）：
 * ① 文件里没有这个标注；② 它不是单行写法；③ 那一行里认不出 `x` / `y`。
 */
export function setMapMarkerPosition(
  text: string,
  markerId: string,
  position: { x: number; y: number },
): { content: string | null; reason: string | null; previous: string[] } {
  const lines = text.split("\n");
  const index = markerLineIndex(lines, markerId);
  if (index < 0) {
    return {
      content: null,
      reason: `地图文件里找不到标注 ${markerId}（它也许是多行写法 ⇒ 请手动改那一行）`,
      previous: [],
    };
  }
  const line = lines[index] as string;
  const next = rewritePositionInLine(line, position);
  if (next === line) {
    return {
      content: null,
      reason: `标注 ${markerId} 那一行里认不出 x / y（请手动改那一行）`,
      previous: [line],
    };
  }
  lines[index] = next;
  return { content: lines.join("\n"), reason: null, previous: [line] };
}

/**
 * 把**一个事件锚点**挪到新位置（R141）：同样只改那一行的 `x` / `y`。
 *
 * 与标注的差别：锚点的 `id` **可以省**（默认用 `event_ref`）⇒ 找那一行时
 * **认 `id:` 也认 `event_ref:`**（两种写法都算这个锚点）。
 */
export function setMapAnchorPosition(
  text: string,
  anchorId: string,
  position: { x: number; y: number },
): { content: string | null; reason: string | null; previous: string[] } {
  const lines = text.split("\n");
  const index = anchorLineIndex(lines, anchorId);
  if (index < 0) {
    return {
      content: null,
      reason: `地图文件里找不到锚点 ${anchorId}（它也许是多行写法 ⇒ 请手动改那一行）`,
      previous: [],
    };
  }
  const line = lines[index] as string;
  const next = rewritePositionInLine(line, position);
  if (next === line) {
    return {
      content: null,
      reason: `锚点 ${anchorId} 那一行里认不出 x / y（请手动改那一行）`,
      previous: [line],
    };
  }
  lines[index] = next;
  return { content: lines.join("\n"), reason: null, previous: [line] };
}

function asMapObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) failMap(`${label} 必须是映射`);
  return value as Record<string, unknown>;
}

function asMapString(value: unknown, label: string, key: string): string {
  if (typeof value !== "string" || value.trim() === "") failMap(`${label} 的 ${key} 必填且须为非空字符串`);
  return value;
}

function asMapNumber(value: unknown, label: string, key: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) failMap(`${label} 的 ${key} 须为有限数字`);
  return value;
}

function checkMapKeys(raw: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const known = new Set(allowed);
  for (const key of Object.keys(raw)) {
    if (!known.has(key)) failMap(`${label} 有未知键「${key}」（可选：${allowed.join(" / ")}）`);
  }
}

/** bounds：[[x0, y0], [x1, y1]]（K08 §3.6 的像素边界） */
function parseMapBounds(value: unknown): [[number, number], [number, number]] {
  if (!Array.isArray(value) || value.length !== 2) failMap("bounds 须写成 [[x0, y0], [x1, y1]] 两对数字");
  const pair = (item: unknown, label: string): [number, number] => {
    if (!Array.isArray(item) || item.length !== 2) failMap(`${label} 须是一对数字`);
    return [asMapNumber(item[0], label, "x"), asMapNumber(item[1], label, "y")];
  };
  const a = pair(value[0], "bounds[0]");
  const b = pair(value[1], "bounds[1]");
  return [a, b];
}

/**
 * 严格解析 `world/map.yaml` → 投影可直接吃的 `WorldMapDef`。
 *
 * 已知键：apiVersion / id / base_image / crs / bounds / base_size / layers / markers。
 * 未知键一律拒绝并点名（拼错的键被静默忽略 ⇒ 作者以为边界设了，其实在画纸上）。
 */
export function parseMapFile(text: string): WorldMapDef {
  let rootRaw: unknown;
  try {
    rootRaw = parseDocument(text, { uniqueKeys: true }).toJS();
  } catch (err) {
    return failMap(`YAML 读不了：${err instanceof Error ? err.message : String(err)}`);
  }
  const root = asMapObject(rootRaw, "地图根");
  checkMapKeys(
    root,
    [
      "apiVersion",
      "id",
      "base_image",
      "crs",
      "bounds",
      "base_size",
      "layers",
      "markers",
      "event_anchors",
      "regions",
      "routes",
    ],
    "地图根",
  );
  if (root.apiVersion !== MAP_API_VERSION) {
    failMap(`apiVersion 须为 ${MAP_API_VERSION}（收到「${String(root.apiVersion)}」）`);
  }
  const id = asMapString(root.id, "地图根", "id");
  // crs：虚构地图没有真实经纬度 ⇒ 只认 simple（K08 §2.5 / §3.6）
  if (root.crs !== undefined && root.crs !== null && root.crs !== "simple") {
    failMap(`crs 只认 simple（虚构地图没有真实经纬度，收到「${String(root.crs)}」）`);
  }
  const bounds = parseMapBounds(root.bounds);
  const def: WorldMapDef = { id, crs: "simple", bounds, markers: [] };

  if (root.base_image !== undefined && root.base_image !== null) {
    def.baseImage = asMapString(root.base_image, "地图根", "base_image");
  }
  if (root.base_size !== undefined && root.base_size !== null) {
    const raw = asMapObject(root.base_size, "地图根.base_size");
    checkMapKeys(raw, ["width", "height"], "地图根.base_size");
    def.baseSize = {
      width: asMapNumber(raw.width, "base_size", "width"),
      height: asMapNumber(raw.height, "base_size", "height"),
    };
  }
  const layers: MapLayerKind[] = [];
  const layerSeen = new Set<string>();
  for (const [index, item] of ((root.layers ?? []) as unknown[]).entries()) {
    const label = `layers[${index}]`;
    if (typeof item !== "string" || !LAYER_ORDER.includes(item as MapLayerKind)) {
      failMap(`${label} 的图层名认不出（可选：${LAYER_ORDER.join(" / ")}）`);
    }
    const kind = item as MapLayerKind;
    if (layerSeen.has(kind)) failMap(`图层重复：${kind}`);
    layerSeen.add(kind);
    layers.push(kind);
  }
  if (layers.length > 0) def.layers = layers;

  const markers: MapMarker[] = [];
  const markerIds = new Set<string>();
  for (const [index, item] of ((root.markers ?? []) as unknown[]).entries()) {
    const label = `markers[${index}]`;
    const raw = asMapObject(item, label);
    checkMapKeys(raw, ["id", "layer", "entity_ref", "x", "y", "label"], label);
    const markerId = asMapString(raw.id, label, "id");
    if (markerIds.has(markerId)) failMap(`标注 id 重复：${markerId}`);
    markerIds.add(markerId);
    if (typeof raw.layer !== "string" || !LAYER_ORDER.includes(raw.layer as MapLayerKind)) {
      failMap(`${label} 的 layer 认不出（可选：${LAYER_ORDER.join(" / ")}）`);
    }
    const marker: MapMarker = {
      id: markerId,
      layer: raw.layer as MapLayerKind,
      entityRef: asMapString(raw.entity_ref, label, "entity_ref"),
      x: asMapNumber(raw.x, label, "x"),
      y: asMapNumber(raw.y, label, "y"),
    };
    if (raw.label !== undefined && raw.label !== null) marker.label = asMapString(raw.label, label, "label");
    markers.push(marker);
  }
  def.markers = markers;

  // 区域与行程线（R143；K08 §5 的后两样）：`regions` 是多边形、`routes` 是折线，
  // 顶点用**底图像素**（与标注/锚点同一套坐标空间）。
  // 顶点数下限：区域至少 3 个点（否则画不出面），行程线至少 2 个点。
  const shapes: MapShape[] = [];
  const shapeIds = new Set<string>();
  for (const [kind, key] of [
    ["region", "regions"],
    ["route", "routes"],
  ] as const) {
    for (const [index, item] of ((root[key] ?? []) as unknown[]).entries()) {
      const label = `${key}[${index}]`;
      const raw = asMapObject(item, label);
      checkMapKeys(raw, ["id", "layer", "name", "points"], label);
      const shapeId = asMapString(raw.id, label, "id");
      if (shapeIds.has(shapeId)) failMap(`形状 id 重复：${shapeId}`);
      shapeIds.add(shapeId);
      if (typeof raw.layer !== "string" || !LAYER_ORDER.includes(raw.layer as MapLayerKind)) {
        failMap(`${label} 的 layer 认不出（可选：${LAYER_ORDER.join(" / ")}）`);
      }
      const rawPoints = raw.points;
      const minPoints = kind === "region" ? 3 : 2;
      if (!Array.isArray(rawPoints) || rawPoints.length < minPoints) {
        failMap(`${label} 的 points 至少要 ${String(minPoints)} 个点`);
      }
      const points: [number, number][] = [];
      for (const [pointIndex, pair] of (rawPoints as unknown[]).entries()) {
        if (!Array.isArray(pair) || pair.length !== 2) {
          failMap(`${label}.points[${String(pointIndex)}] 须是 [x, y]`);
        }
        const px = asMapNumber((pair as unknown[])[0], `${label}.points[${String(pointIndex)}]`, "x");
        const py = asMapNumber((pair as unknown[])[1], `${label}.points[${String(pointIndex)}]`, "y");
        points.push([px, py]);
      }
      const shape: MapShape = {
        id: shapeId,
        kind,
        layer: raw.layer as MapLayerKind,
        points,
      };
      if (raw.name !== undefined && raw.name !== null) {
        shape.name = asMapString(raw.name, label, "name");
      }
      shapes.push(shape);
    }
  }
  if (shapes.length > 0) def.shapes = shapes;

  // 事件锚点（K08 §3.8）：`id` 可省（默认用 event_ref），但**一个事件只能有一个锚点**——
  // 两个锚点会让"选事件定位到地图上"指向哪儿变得不确定 ⇒ 宁可拒绝加载并点名。
  const anchors: MapEventAnchor[] = [];
  const anchorIds = new Set<string>();
  const anchorEvents = new Set<string>();
  for (const [index, item] of ((root.event_anchors ?? []) as unknown[]).entries()) {
    const label = `event_anchors[${index}]`;
    const raw = asMapObject(item, label);
    checkMapKeys(raw, ["id", "event_ref", "x", "y", "label"], label);
    const eventRef = asMapString(raw.event_ref, label, "event_ref");
    if (anchorEvents.has(eventRef)) {
      failMap(`事件锚点重复：${eventRef}（一个事件只能有一个锚点）`);
    }
    anchorEvents.add(eventRef);
    const anchorId =
      raw.id === undefined || raw.id === null ? eventRef : asMapString(raw.id, label, "id");
    if (anchorIds.has(anchorId)) failMap(`事件锚点 id 重复：${anchorId}`);
    anchorIds.add(anchorId);
    const anchor: MapEventAnchor = {
      id: anchorId,
      eventRef,
      x: asMapNumber(raw.x, label, "x"),
      y: asMapNumber(raw.y, label, "y"),
    };
    if (raw.label !== undefined && raw.label !== null) anchor.label = asMapString(raw.label, label, "label");
    anchors.push(anchor);
  }
  if (anchors.length > 0) def.eventAnchors = anchors;
  return def;
}
