/* SPDX-License-Identifier: Apache-2.0 */
import { readFile } from "node:fs/promises";
import {
  MAP_PATH,
  TIMELINE_PATH,
  appendMapAnchor,
  appendMapShape,
  appendMapBase,
  appendMapMarker,
  checkStructureFromSources,
  normalizeBounds,
  parseMapFile,
  parseTimelineFile,
  projectWorldMap,
  setMapAnchorPosition,
  setMapMarkerPosition,
  type WorldMapDef,
} from "@yushu/world-engine";
import type {
  WorldMapBasePayload,
  WorldMapCreateAnchorRequestPayload,
  WorldMapCreateAnchorResult,
  WorldMapCreateShapeRequestPayload,
  WorldMapCreateShapeResult,
  WorldMapCreateMarkerRequestPayload,
  WorldMapCreateMarkerResult,
  WorldMapSetAnchorRequestPayload,
  WorldMapSetAnchorResult,
  WorldMapSetBoundsRequestPayload,
  WorldMapSetBoundsResult,
  WorldMapSetMarkerRequestPayload,
  WorldMapSetMarkerResult,
  WorldMapUploadBaseResult,
  WorldMapViewPayload,
  WorldMapViewRequestPayload,
} from "../shared/ipc.js";
import { gatewayReader } from "./index-ops.js";
import type { ProjectGateway } from "./file-gateway.js";
import type { PickDialog } from "./import-ops.js";

/**
 * 世界地图的桌面接线（M5 / T5-1，R120）：**只读**。
 *
 * 口径回源 `docs/research/K-软件工程与产品/K08-时间线与地图UI.md` §3：
 * ⑥ **地图 = 图片底图 + bounds**（坐标是图片像素 / 归一化坐标，**不用经纬度**——虚构地图没有真实地理坐标）；
 * ⑦ **标注即地点卡**（marker 绑定地点实体，点开能查那张卡）；
 * ⑨ **分层可控**（底图 / 地名 / 政治 / 事件 / 行程线分层，图层独立显隐）。
 *
 * 三条不静默：
 * ① 文件读不了 ⇒ 给 note 且**不出结论**（不退回"空地图"——空地图看起来像"这个项目没有地点"）；
 * ② 文件在但解析不过 ⇒ 同样给 note，**并把解析器的话原样带出来**（作者要知道自己写错了哪一行）；
 * ③ 体检结论（无边界 / 孤儿标注 / 重合 / 越界）**逐条外显**，不静默过滤——
 *    悄悄吞掉一条孤儿标注，"地图少一个地点"就长得像"没问题"。
 *
 * **图层显隐为什么不在这里做**：切层是**纯显示动作**，绕一圈 IPC 会让每次切层都等一次往返，
 * 动效也就没法跟手（R111 的口径：动效必须跟手）。所以这里把**全部标注一次给出去**，
 * 由渲染层按图层过滤——这也是 K08 §3.9「图层独立显隐」的本意：显隐是读者的视角，不是作者的数据。
 *
 * 实体从**真源行表**直算（`checkStructureFromSources`），不碰 SQLite 索引：
 * 删掉 `.yushu/` 之后地图照样画得出来，退化的只有检索（同 R69 图谱的做法）。
 */
export async function worldMapView(
  gateway: ProjectGateway,
  _request: WorldMapViewRequestPayload = {},
): Promise<WorldMapViewPayload> {
  const snapshot = await gateway.readDoc(MAP_PATH).catch(() => null);
  if (snapshot === null) {
    return {
      path: MAP_PATH,
      exists: false,
      note: "项目还没有世界地图：写一份 world/map.yaml（底图 bounds + 标注）才会有地图",
      bounds: null,
      canvas: null,
      baseSize: null,
      markers: [],
      places: [],
      events: [],
      shapes: [],
      anchors: [],
      layers: [],
      findings: [],
      orphanMarkers: [],
      overlapClusters: [],
      outOfBoundsMarkers: [],
      outOfBoundsAnchors: [],
      entityCount: 0,
      summary: { markers: 0, layers: 0, entities: 0, findings: 0, anchors: 0 },
    };
  }
  let def: WorldMapDef;
  try {
    def = parseMapFile(snapshot.content);
  } catch (err) {
    return {
      path: MAP_PATH,
      exists: true,
      note: `地图读不了，本次不出结论（不静默按空地图显示）：${err instanceof Error ? err.message : String(err)}`,
      bounds: null,
      canvas: null,
      baseSize: null,
      markers: [],
      places: [],
      events: [],
      shapes: [],
      anchors: [],
      layers: [],
      findings: [],
      orphanMarkers: [],
      overlapClusters: [],
      outOfBoundsMarkers: [],
      outOfBoundsAnchors: [],
      entityCount: 0,
      summary: { markers: 0, layers: 0, entities: 0, findings: 0, anchors: 0 },
    };
  }

  const structure = await checkStructureFromSources(gatewayReader(gateway));
  const projection = projectWorldMap(def, structure.entities);
  const byId = new Map(structure.entities.map((entity) => [entity.id, entity]));

  const markers = projection.markers.map((marker) => {
    const entity = byId.get(marker.entityRef);
    return {
      id: marker.id,
      layer: marker.layer,
      entityRef: marker.entityRef,
      entityName: marker.entityName,
      nx: marker.nx,
      ny: marker.ny,
      x: marker.x,
      y: marker.y,
      label: marker.label ?? marker.entityName,
      card:
        entity === undefined
          ? null
          : {
              id: entity.id,
              name: entity.name,
              type: entity.type,
              layer: entity.layer,
              aliases: entity.aliases,
              visibility: entity.visibility,
              filePath: entity.filePath,
            },
    };
  });

  const bounds = projection.bounds;
  // 画布 = **bounds 那一块**（作者框定的就是画布；底图按它裁切显示）
  const canvas =
    bounds === null ? null : { width: bounds.x1 - bounds.x0, height: bounds.y1 - bounds.y0 };
  // 底图**声明**的像素尺寸（框定模式下画整张图 ⇒ 拖出来的坐标就是底图像素坐标）
  const baseSize = def.baseSize ?? null;
  // **可放的地点**（R140：放标注时作者要选一个）——只给 location 类的实体，按名字排（同名按 id）
  const places = structure.entities
    .filter((entity) => entity.type === "location")
    .map((entity) => ({ id: entity.id, name: entity.name }))
    .sort((a, b) =>
      a.name === b.name ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.name < b.name ? -1 : 1,
    );
  // **可挂的事件**（R142：放事件锚点时作者要选一个）——来自 world/timeline.yaml（K08 §3.8）
  const timelineSnapshot = await gateway.readDoc(TIMELINE_PATH).catch(() => null);
  let events: { id: string; title: string }[] = [];
  if (timelineSnapshot !== null) {
    try {
      events = parseTimelineFile(timelineSnapshot.content)
        .events.map((event) => ({ id: event.id, title: event.title }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    } catch {
      // 时间线读不了 ⇒ 地图这边就**不列事件**（不放一个假的清单给作者选）
      events = [];
    }
  }

  const note = [
    `${markers.length} 个标注 · ${projection.layers.length} 个图层`,
    projection.anchors.length > 0 ? `${projection.anchors.length} 个事件锚点` : "没有事件锚点",
    `项目里 ${structure.entities.length} 个实体（地图只画标注过的那些）`,
    projection.findings.length > 0 ? `${projection.findings.length} 条体检结论` : "体检无结论",
  ].join("；");

  return {
    path: MAP_PATH,
    exists: true,
    note,
    bounds,
    canvas,
    baseSize,
    markers,
    places,
    events,
    shapes: projection.shapes.map((shape) => ({
      id: shape.id,
      kind: shape.kind,
      layer: shape.layer,
      ...(shape.name === undefined ? {} : { name: shape.name }),
      points: shape.points.map(([nx, ny]) => ({ x: nx, y: ny })),
    })),
    // 事件锚点（K08 §3.8）：事件挂坐标 ⇒ 选事件能定位到地图上
    anchors: projection.anchors.map((anchor) => ({
      id: anchor.id,
      eventRef: anchor.eventRef,
      x: anchor.x,
      y: anchor.y,
      nx: anchor.nx,
      ny: anchor.ny,
      label: anchor.label ?? anchor.eventRef,
    })),
    layers: projection.layers.map((layer) => ({
      kind: layer.kind,
      markerCount: layer.markerCount,
      shapeCount: projection.shapes.filter((shape) => shape.layer === layer.kind).length,
    })),
    findings: projection.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      refs: finding.refs,
    })),
    orphanMarkers: projection.orphanMarkers,
    overlapClusters: projection.overlapClusters,
    outOfBoundsMarkers: projection.outOfBoundsMarkers,
    outOfBoundsAnchors: projection.outOfBoundsAnchors,
    entityCount: structure.entities.length,
    summary: {
      markers: markers.length,
      layers: projection.layers.length,
      entities: structure.entities.length,
      findings: projection.findings.length,
      anchors: projection.anchors.length,
    },
  };
}

/** 底图允许的格式：只认三种位图（SVG 可能带脚本，不进 <image>） */
const BASE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};
/** 底图体积上限：data URL 走 IPC，超过这个尺寸就别搬了（说清楚比搬不动强） */
const BASE_MAX_BYTES = 8 * 1024 * 1024;

/** PNG / JPEG / WEBP 的像素尺寸（从文件头里量，不是作者写的） */
function imageSize(bytes: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === "image/png" && bytes.length >= 24) {
    // PNG 的 IHDR：宽高是大端 uint32，在偏移 16 与 20
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (mime === "image/webp" && bytes.length >= 30) {
    // WEBP 的 VP8X / VP8L / VP8 三种容器，尺寸位置不同（这一段只认 VP8X）
    const tag = bytes.subarray(12, 16).toString("ascii");
    if (tag === "VP8X") {
      // VP8X 的宽高是 24 位小端（各减 1）
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    }
    return null;
  }
  if (mime === "image/jpeg" && bytes.length >= 4) {
    // JPEG：逐段找 SOF0/SOF2 拿高宽
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes.readUInt8(offset) !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = bytes.readUInt8(offset + 1);
      // SOF0..SOF15（跳过 DHT/JPG/DAC 三种不是尺寸的）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
      }
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2) break;
      offset += 2 + length;
    }
  }
  return null;
}

/**
 * 读世界地图的**底图**（R123）：**只读**。
 *
 * 底图是**作者自己放进项目**的一张图（真源 `world/map.yaml` 的 `base_image` 记相对路径）
 * ——地图登记不设表单（与其它真源 YAML 同一处置），所以这一条只负责**读**：
 * 路径防护走 gateway（K12 防路径穿越），只认 PNG / JPEG / WEBP 三种位图。
 *
 * 三条不静默：没有登记底图 ⇒ 说清楚；文件读不到 ⇒ 点名路径；超出体积上限 ⇒ 说清楚多大。
 */
export async function worldMapBase(
  gateway: ProjectGateway,
  _request: WorldMapBasePayload extends never ? never : Record<string, never> = {},
): Promise<WorldMapBasePayload> {
  const snapshot = await gateway.readDoc(MAP_PATH).catch(() => null);
  if (snapshot === null) {
    return { path: null, exists: false, note: "项目还没有世界地图", dataUrl: null, size: null };
  }
  let def: WorldMapDef;
  try {
    def = parseMapFile(snapshot.content);
  } catch (err) {
    return {
      path: null,
      exists: false,
      note: `地图读不了，取不到底图：${err instanceof Error ? err.message : String(err)}`,
      dataUrl: null,
      size: null,
    };
  }
  if (def.baseImage === undefined) {
    return { path: null, exists: false, note: "这张地图没有登记底图（world/map.yaml 的 base_image）", dataUrl: null, size: null };
  }
  const ext = def.baseImage.split(".").pop()?.toLowerCase() ?? "";
  const mime = BASE_MIME[ext];
  if (mime === undefined) {
    return {
      path: def.baseImage,
      exists: false,
      note: `底图格式不认：${def.baseImage}（只认 png / jpg / jpeg / webp）`,
      dataUrl: null,
      size: null,
    };
  }
  let bytes: Buffer;
  try {
    bytes = (await gateway.readBinary(def.baseImage)).bytes;
  } catch (err) {
    return {
      path: def.baseImage,
      exists: false,
      note: `底图读不到：${def.baseImage}（${err instanceof Error ? err.message : String(err)}）`,
      dataUrl: null,
      size: null,
    };
  }
  if (bytes.length > BASE_MAX_BYTES) {
    return {
      path: def.baseImage,
      exists: true,
      note: `底图太大（${String(bytes.length)} 字节 > ${String(BASE_MAX_BYTES)}），这一段不搬它`,
      dataUrl: null,
      size: imageSize(bytes, mime),
    };
  }
  return {
    path: def.baseImage,
    exists: true,
    note: `底图 ${def.baseImage}（${mime}，${String(bytes.length)} 字节）`,
    dataUrl: `data:${mime};base64,${bytes.toString("base64")}`,
    size: imageSize(bytes, mime),
  };
}

/** 底图在项目里放的目录（作者的项目内容都在真源下 ⇒ 底图也是） */
const BASE_DIR = "world/assets/map";

function baseName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] ?? "base.png";
}

/** 同名不覆盖：换个名字（覆盖 = 悄悄换掉作者的那张图） */
async function uniqueAssetPath(gateway: ProjectGateway, rel: string): Promise<string> {
  const exists = async (candidate: string): Promise<boolean> =>
    gateway.readBinary(candidate).then(
      () => true,
      () => false,
    );
  let candidate = rel;
  let n = 2;
  while (await exists(candidate)) {
    const dot = rel.lastIndexOf(".");
    candidate = dot > 0 ? `${rel.slice(0, dot)}-${String(n)}${rel.slice(dot)}` : `${rel}-${String(n)}`;
    n += 1;
  }
  return candidate;
}

/**
 * **底图登记**（R135）：**写盘**——作者挑一张图，工具把它拷进项目、并把
 * `base_image` / `base_size` / `bounds` 三行写进 `world/map.yaml`。
 *
 * 口径回源 K08 §5「地图编辑器：**上传底图 → 框定 bounds** → 放 marker/区域/行程线 → 绑定实体」——
 * 这一轮做**第一步**（上传 + 边界），且**边界按量出来的像素尺寸自动填**：
 * 作者手填 bounds 填不对是常态（`map-bounds-missing` 那条诊断码就是这么来的）⇒
 * 让工具量 ⇒ 作者填不错。
 *
 * 三条不静默 / 不越权：
 * ① **路径不出主进程**：渲染层只拿到项目内的相对路径与尺寸（原生对话框在主进程开）；
 * ② **只追加那三行**：标注、图层、事件锚点**原样留着**（不重写整个文件 ⇒ 不抹作者的注释与排版）；
 * ③ **已经有底图登记 ⇒ 拒绝并把该改的三行给作者看**：换底图是作者的决定，工具不替他换。
 *
 * 写盘带 baseHash ⇒ 作者在别处改过 map.yaml 时**报冲突**，不覆盖。
 */
export async function uploadMapBase(
  gateway: ProjectGateway,
  pick: PickDialog,
  mode: "register" | "replace" = "register",
): Promise<WorldMapUploadBaseResult> {
  const picked = await pick();
  const source = picked.canceled ? undefined : picked.filePaths[0];
  if (source === undefined) {
    return {
      canceled: true,
      path: null,
      size: null,
      note: "没有挑文件（已取消）",
      snippet: null,
      previous: [],
      mapPath: MAP_PATH,
    };
  }
  const ext = source.split(".").pop()?.toLowerCase() ?? "";
  const mime = BASE_MIME[ext];
  if (mime === undefined) {
    return {
      canceled: false,
      path: null,
      size: null,
      note: `底图格式不认：${baseName(source)}（只认 png / jpg / jpeg / webp）`,
      snippet: null,
      previous: [],
      mapPath: MAP_PATH,
    };
  }
  const bytes = await readFile(source);
  if (bytes.length > BASE_MAX_BYTES) {
    return {
      canceled: false,
      path: null,
      size: null,
      note: `底图太大（${String(bytes.length)} 字节 > ${String(BASE_MAX_BYTES)}），这一段不搬它`,
      snippet: null,
      previous: [],
      mapPath: MAP_PATH,
    };
  }
  const size = imageSize(bytes, mime);
  if (size === null) {
    return {
      canceled: false,
      path: null,
      size: null,
      note: "量不出这张图的像素尺寸（文件头不认）",
      snippet: null,
      previous: [],
      mapPath: MAP_PATH,
    };
  }
  // 拷进项目（同名不覆盖）
  const rel = await uniqueAssetPath(gateway, `${BASE_DIR}/${baseName(source)}`);
  await gateway.writeBinary(rel, bytes);
  const snippet = [
    `base_image: ${rel}`,
    `base_size: {width: ${size.width}, height: ${size.height}}`,
    `bounds: [[0, 0], [${size.width}, ${size.height}]]`,
  ].join("\n");
  const snapshot = await gateway.readDoc(MAP_PATH).catch(() => null);
  const current =
    snapshot === null
      ? ["apiVersion: map-v1", "id: map-world", "crs: simple", ""].join("\n")
      : snapshot.content;
  const merged = appendMapBase(current, { baseImage: rel, width: size.width, height: size.height }, mode);
  if (merged.content === null) {
    return {
      canceled: false,
      path: rel,
      size,
      note: `底图已拷进项目，但${merged.reason ?? "地图文件里已有底图登记"} ⇒ 没有替你改`,
      snippet,
      previous: merged.previous,
      mapPath: MAP_PATH,
    };
  }
  await gateway.writeDoc(MAP_PATH, merged.content, snapshot?.hash);
  return {
    canceled: false,
    path: rel,
    size,
    note:
      mode === "replace"
        ? `底图已换成：${rel}（${String(size.width)}×${String(size.height)}，bounds 按量出来的尺寸填好了；旧图还留在项目里）`
        : `底图已登记：${rel}（${String(size.width)}×${String(size.height)}，bounds 按量出来的尺寸填好了）`,
    snippet: null,
    previous: merged.previous,
    mapPath: MAP_PATH,
  };
}

/**
 * **框定边界**（R138）：**写盘**——作者在底图上**拖出一块** ⇒ 写进 `world/map.yaml` 的 `bounds`。
 *
 * 口径回源 K08 §5「地图编辑器：上传底图 → **框定 bounds** → 放 marker/区域/行程线 → 绑定实体」：
 * R135 做了"上传底图"（bounds 按量出来的尺寸自动填 = 整张图），
 * 这一轮把**框定**这一步给作者：**在图上拖一块** ⇒ 那块才是地图（K08 §3.6「用户上传底图并框定 bounds」）。
 *
 * 三条不静默 / 不越权（与 R135/R136 的写盘纪律同一条）：
 * ① **只改 `bounds` 那一行**：底图登记、图层、标注、事件锚点**原样留着**
 *    （不重写整个文件 ⇒ 不抹作者的注释与排版；行尾也照原样）；
 * ② **框的范围必须落在底图里**（落在外面 ⇒ 画出来是空的）⇒ 拒绝并说清楚；
 * ③ 写盘带 baseHash ⇒ 作者在别处改过 map.yaml 时**报冲突**、不覆盖。
 */
export async function setMapBounds(
  gateway: ProjectGateway,
  request: WorldMapSetBoundsRequestPayload,
): Promise<WorldMapSetBoundsResult> {
  const snapshot = await gateway.readDoc(MAP_PATH).catch(() => null);
  if (snapshot === null) {
    return { ok: false, note: "项目还没有世界地图（先登记底图）", bounds: null, imageSize: null };
  }
  let def: WorldMapDef;
  try {
    def = parseMapFile(snapshot.content);
  } catch (err) {
    return {
      ok: false,
      note: `地图文件现在读不了：${err instanceof Error ? err.message : String(err)}`,
      bounds: null,
      imageSize: null,
    };
  }
  const imageSize = def.baseSize ?? null;
  if (imageSize === null) {
    return {
      ok: false,
      note: "这张地图没有 base_size（不知道底图多大 ⇒ 框不出范围）",
      bounds: null,
      imageSize: null,
    };
  }
  // 拖出来的坐标是**底图像素** ⇒ 取整（像素没有小数）
  const x0 = Math.round(request.x0);
  const y0 = Math.round(request.y0);
  const x1 = Math.round(request.x1);
  const y1 = Math.round(request.y1);
  if (![x0, y0, x1, y1].every((n) => Number.isFinite(n))) {
    return { ok: false, note: "框的坐标里有非数字", bounds: null, imageSize };
  }
  if (x1 <= x0 || y1 <= y0) {
    return { ok: false, note: "框的宽或高不为正", bounds: null, imageSize };
  }
  if (x0 < 0 || y0 < 0 || x1 > imageSize.width || y1 > imageSize.height) {
    return {
      ok: false,
      note: `框的范围超出了底图（底图 ${String(imageSize.width)}×${String(imageSize.height)}）`,
      bounds: null,
      imageSize,
    };
  }
  // 只改 bounds 那一行（`[^\r\n]*` ⇒ 行尾照原样，不把 CRLF 改成 LF）
  if (!/^bounds[^\r\n]*/m.test(snapshot.content)) {
    return {
      ok: false,
      note: "地图文件里没有 bounds 那一行（先登记底图）",
      bounds: null,
      imageSize,
    };
  }
  const content = snapshot.content.replace(
    /^bounds[^\r\n]*/m,
    `bounds: [[${String(x0)}, ${String(y0)}], [${String(x1)}, ${String(y1)}]]`,
  );
  await gateway.writeDoc(MAP_PATH, content, snapshot.hash);
  return {
    ok: true,
    note: `边界已定：${String(x0)},${String(y0)} → ${String(x1)},${String(y1)}`,
    bounds: { x0, y0, x1, y1 },
    imageSize,
  };
}

/**
 * **挪标注**（R139）：**写盘**——作者在图上把标注拖到新位置 ⇒ 改 `world/map.yaml` 里
 * **那一个标注**的 `x` / `y`。
 *
 * 口径回源 K08 §5「地图编辑器：上传底图 → 框定 bounds → **放 marker**、区域、行程线 → 绑定实体」：
 * R135 做了「上传底图」、R138 做了「框定 bounds」，这一轮接上「放 marker」的第一步——
 * 作者手填的坐标常常差一点（差几十像素，地图上就偏了一截）⇒ 让他在图上**拖**。
 *
 * 三条不静默 / 不越权（与 R135/R136/R138 的写盘纪律同一条）：
 * ① **只改那一个标注的 x / y**（底图登记、bounds、图层、别的标注、锚点、作者自己的注释**原样留着**）；
 * ② **坐标必须落在框定的那一块里**（落在外面 ⇒ 那个点看不见）⇒ 拒绝并说清范围；
 * ③ 写盘带 baseHash ⇒ 作者在别处改过 map.yaml 时**报冲突**、不覆盖。
 */
export async function setMarkerPosition(
  gateway: ProjectGateway,
  request: WorldMapSetMarkerRequestPayload,
): Promise<WorldMapSetMarkerResult> {
  const snapshot = await gateway.readDoc(MAP_PATH).catch(() => null);
  if (snapshot === null) {
    return { ok: false, note: "项目还没有世界地图（先登记底图）", position: null, previous: [] };
  }
  let def: WorldMapDef;
  try {
    def = parseMapFile(snapshot.content);
  } catch (err) {
    return {
      ok: false,
      note: `地图文件现在读不了：${err instanceof Error ? err.message : String(err)}`,
      position: null,
      previous: [],
    };
  }
  const bounds = normalizeBounds(def.bounds).bounds;
  if (bounds === null) {
    return { ok: false, note: "地图没有有效边界（框不出范围）", position: null, previous: [] };
  }
  const x = Math.round(request.x);
  const y = Math.round(request.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, note: "坐标里有非数字", position: null, previous: [] };
  }
  if (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1) {
    return {
      ok: false,
      note:
        `这个点落在框定的那一块之外（${String(bounds.x0)},${String(bounds.y0)} → ` +
        `${String(bounds.x1)},${String(bounds.y1)}）`,
      position: null,
      previous: [],
    };
  }
  const marker = (def.markers ?? []).find((item) => item.id === request.markerId);
  if (marker === undefined) {
    return {
      ok: false,
      note: `地图里没有标注 ${request.markerId}`,
      position: null,
      previous: [],
    };
  }
  const moved = setMapMarkerPosition(snapshot.content, request.markerId, { x, y });
  if (moved.content === null) {
    return {
      ok: false,
      note: moved.reason ?? "没挪成",
      position: null,
      previous: moved.previous,
    };
  }
  await gateway.writeDoc(MAP_PATH, moved.content, snapshot.hash);
  return {
    ok: true,
    note: `标注 ${request.markerId} 挪到 ${String(x)},${String(y)}`,
    position: { x, y },
    previous: moved.previous,
  };
}

/**
 * **放标注**（R140）：**写盘**——作者选一个地点实体 ⇒ 在图上点一下 ⇒ 落一个标注。
 *
 * 口径回源 K08 §5「地图编辑器：上传底图 → 框定 bounds → **放 marker**、区域、行程线 → 绑定实体」：
 * R135 做了「上传底图」、R138 做了「框定 bounds」、R139 做了「挪」，这一轮补上「**放**」。
 *
 * 四条不静默 / 不越权（与前几轮同一条纪律）：
 * ① **只追加那一行**（别的标注、底图、bounds、图层、锚点、作者自己的注释**原样留着**）；
 * ② **必须绑一个真实存在的地点**（K08 §3.7：标注即地点卡 ⇒ 绑一个不存在的地方 = 孤儿标注）⇒ 拒绝并点名；
 * ③ **落点必须落在框定的那一块里**（落在外面 ⇒ 那个点看不见）⇒ 拒绝并说清范围；
 * ④ 写盘带 baseHash ⇒ 作者在别处改过 map.yaml 时**报冲突**、不覆盖。
 *
 * 标注 id 由**主进程**生成（`m-<n>`，跳过已占用的）⇒ 两个标注不会撞 id
 * （撞 id 的话地图文件会被严格解析拒绝 ⇒ 整个地图都读不出来）。
 */
export async function createMapMarker(
  gateway: ProjectGateway,
  request: WorldMapCreateMarkerRequestPayload,
): Promise<WorldMapCreateMarkerResult> {
  const snapshot = await gateway.readDoc(MAP_PATH).catch(() => null);
  if (snapshot === null) {
    return { ok: false, note: "项目还没有世界地图（先登记底图）", marker: null };
  }
  let def: WorldMapDef;
  try {
    def = parseMapFile(snapshot.content);
  } catch (err) {
    return {
      ok: false,
      note: `地图文件现在读不了：${err instanceof Error ? err.message : String(err)}`,
      marker: null,
    };
  }
  const bounds = normalizeBounds(def.bounds).bounds;
  if (bounds === null) {
    return { ok: false, note: "地图没有有效边界（框不出范围）", marker: null };
  }
  const x = Math.round(request.x);
  const y = Math.round(request.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, note: "坐标里有非数字", marker: null };
  }
  if (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1) {
    return {
      ok: false,
      note:
        `这个点落在框定的那一块之外（${String(bounds.x0)},${String(bounds.y0)} → ` +
        `${String(bounds.x1)},${String(bounds.y1)}）`,
      marker: null,
    };
  }
  // ② 地点必须真实存在（从**真源**直算，不碰 SQLite 索引）
  const structure = await checkStructureFromSources(gatewayReader(gateway));
  const place = structure.entities.find(
    (entity) => entity.id === request.entityRef && entity.type === "location",
  );
  if (place === undefined) {
    return {
      ok: false,
      note: `项目里没有这个地点：${request.entityRef}（标注只能绑真实的地点）`,
      marker: null,
    };
  }
  // id 不能撞（撞了 ⇒ 地图文件被严格解析拒绝 ⇒ 整个地图读不出来）
  const used = new Set((def.markers ?? []).map((marker) => marker.id));
  let index = 1;
  while (used.has(`m-${String(index)}`)) index += 1;
  const id = `m-${String(index)}`;
  const appended = appendMapMarker(snapshot.content, {
    id,
    layer: "place",
    entityRef: request.entityRef,
    x,
    y,
  });
  if (appended.content === null) {
    return { ok: false, note: appended.reason ?? "没放成", marker: null };
  }
  await gateway.writeDoc(MAP_PATH, appended.content, snapshot.hash);
  return {
    ok: true,
    note: `已放标注 ${id}：${place.name}（${String(x)},${String(y)}）`,
    marker: { id, entityRef: request.entityRef, x, y },
  };
}

/**
 * **放事件锚点**（R142）：**写盘**——作者选一个事件 ⇒ 在图上点一下 ⇒ 落一个锚点。
 *
 * 口径回源 K08 §3.8「事件可挂坐标 ⇒ 选事件能定位到地图上」：
 * R131 之后锚点只能**手写**在 map.yaml 里 ⇒ 这一轮把它交给作者动手。
 *
 * 四条不静默 / 不越权（与放标注、挪标注同一条纪律）：
 * ① **只追加那一行**（放在 `event_anchors:` 段的末尾 ⇒ 作者自己写的锚点顺序不变）；
 * ② **必须绑一个真实存在的事件**（事件清单来自 `world/timeline.yaml`）⇒ 拒绝并点名；
 * ③ **落点必须落在框定的那一块里** ⇒ 拒绝并说清范围；
 * ④ 写盘带 baseHash ⇒ 作者在别处改过 map.yaml 时**报冲突**、不覆盖。
 *
 * 锚点 id 由**主进程**生成（`a-<n>`，跳过已占用的）⇒ 两个锚点不会撞 id
 * （撞 id 的话地图文件会被严格解析拒绝 ⇒ 整个地图都读不出来）。
 */
export async function createMapAnchor(
  gateway: ProjectGateway,
  request: WorldMapCreateAnchorRequestPayload,
): Promise<WorldMapCreateAnchorResult> {
  const snapshot = await gateway.readDoc(MAP_PATH).catch(() => null);
  if (snapshot === null) {
    return { ok: false, note: "项目还没有世界地图（先登记底图）", anchor: null };
  }
  let def: WorldMapDef;
  try {
    def = parseMapFile(snapshot.content);
  } catch (err) {
    return {
      ok: false,
      note: `地图文件现在读不了：${err instanceof Error ? err.message : String(err)}`,
      anchor: null,
    };
  }
  const bounds = normalizeBounds(def.bounds).bounds;
  if (bounds === null) {
    return { ok: false, note: "地图没有有效边界（框不出范围）", anchor: null };
  }
  const x = Math.round(request.x);
  const y = Math.round(request.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, note: "坐标里有非数字", anchor: null };
  }
  if (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1) {
    return {
      ok: false,
      note:
        `这个点落在框定的那一块之外（${String(bounds.x0)},${String(bounds.y0)} → ` +
        `${String(bounds.x1)},${String(bounds.y1)}）`,
      anchor: null,
    };
  }
  // ② 事件必须真实存在（清单来自 world/timeline.yaml）
  const timelineSnapshot = await gateway.readDoc(TIMELINE_PATH).catch(() => null);
  if (timelineSnapshot === null) {
    return { ok: false, note: "项目还没有世界时间线（world/timeline.yaml）⇒ 无从挂事件", anchor: null };
  }
  let eventTitle: string | null = null;
  try {
    const event = parseTimelineFile(timelineSnapshot.content).events.find(
      (item) => item.id === request.eventRef,
    );
    eventTitle = event?.title ?? null;
  } catch (err) {
    return {
      ok: false,
      note: `时间线读不了：${err instanceof Error ? err.message : String(err)}`,
      anchor: null,
    };
  }
  if (eventTitle === null) {
    return {
      ok: false,
      note: `时间线里没有这个事件：${request.eventRef}（锚点只能挂真实的事件）`,
      anchor: null,
    };
  }
  // id 不能撞（撞了 ⇒ 地图文件被严格解析拒绝 ⇒ 整个地图读不出来）
  const used = new Set((def.eventAnchors ?? []).map((anchorItem) => anchorItem.id));
  let index = 1;
  while (used.has(`a-${String(index)}`)) index += 1;
  const id = `a-${String(index)}`;
  const appended = appendMapAnchor(snapshot.content, { id, eventRef: request.eventRef, x, y });
  if (appended.content === null) {
    return { ok: false, note: appended.reason ?? "没放成", anchor: null };
  }
  await gateway.writeDoc(MAP_PATH, appended.content, snapshot.hash);
  return {
    ok: true,
    note: `已放锚点 ${id}：${eventTitle}（${String(x)},${String(y)}）`,
    anchor: { id, eventRef: request.eventRef, x, y },
  };
}

/**
 * **放区域 / 行程线**（R143）：**写盘**——作者在图上点出一串点 ⇒ 落一个面 / 一条线。
 *
 * 口径回源 K08 §5「地图编辑器：上传底图 → 框定 bounds → 放 marker、**区域、行程线** → 绑定实体」。
 *
 * 三条不静默 / 不越权（与前几轮同一条纪律）：
 * ① **只追加那一行**（放在 `regions:` / `routes:` 段的末尾 ⇒ 作者自己写的顺序不变）；
 * ② **顶点必须落在框定的那一块里**（落在外面 ⇒ 那个形状看不见）⇒ 拒绝并说清范围；
 * ③ 顶点数下限：区域至少 3 个（画不出面）、行程线至少 2 个。
 *
 * 形状 id 由**主进程**生成（`r-<n>` / `rt-<n>`，跳过已占用的）⇒ 两个形状不会撞 id。
 */
export async function createMapShape(
  gateway: ProjectGateway,
  request: WorldMapCreateShapeRequestPayload,
): Promise<WorldMapCreateShapeResult> {
  const snapshot = await gateway.readDoc(MAP_PATH).catch(() => null);
  if (snapshot === null) {
    return { ok: false, note: "项目还没有世界地图（先登记底图）", shape: null };
  }
  let def: WorldMapDef;
  try {
    def = parseMapFile(snapshot.content);
  } catch (err) {
    return {
      ok: false,
      note: `地图文件现在读不了：${err instanceof Error ? err.message : String(err)}`,
      shape: null,
    };
  }
  const bounds = normalizeBounds(def.bounds).bounds;
  if (bounds === null) {
    return { ok: false, note: "地图没有有效边界（框不出范围）", shape: null };
  }
  const minPoints = request.kind === "region" ? 3 : 2;
  if (request.points.length < minPoints) {
    return {
      ok: false,
      note: `${request.kind === "region" ? "区域" : "行程线"}至少要 ${String(minPoints)} 个点（现在 ${String(request.points.length)} 个）`,
      shape: null,
    };
  }
  const points = request.points.map((point) => ({
    x: Math.round(point.x),
    y: Math.round(point.y),
  }));
  for (const point of points) {
    if (point.x < bounds.x0 || point.x > bounds.x1 || point.y < bounds.y0 || point.y > bounds.y1) {
      return {
        ok: false,
        note:
          `有个顶点落在框定的那一块之外（${String(bounds.x0)},${String(bounds.y0)} → ` +
          `${String(bounds.x1)},${String(bounds.y1)}）`,
        shape: null,
      };
    }
  }
  // id 不能撞
  const used = new Set((def.shapes ?? []).map((shape) => shape.id));
  const prefix = request.kind === "region" ? "r" : "rt";
  let index = 1;
  while (used.has(`${prefix}-${String(index)}`)) index += 1;
  const id = `${prefix}-${String(index)}`;
  const appended = appendMapShape(snapshot.content, {
    id,
    kind: request.kind,
    layer: request.kind === "region" ? "political" : "route",
    ...(request.name === undefined || request.name === "" ? {} : { name: request.name }),
    points: points.map((point) => [point.x, point.y] as [number, number]),
  });
  if (appended.content === null) {
    return { ok: false, note: appended.reason ?? "没放成", shape: null };
  }
  await gateway.writeDoc(MAP_PATH, appended.content, snapshot.hash);
  return {
    ok: true,
    note: `已放${request.kind === "region" ? "区域" : "行程线"} ${id}（${String(points.length)} 个点）`,
    shape: { id, kind: request.kind, points },
  };
}

/**
 * **挪事件锚点**（R141）：**写盘**——作者在图上把锚点拖到新位置 ⇒ 改 `world/map.yaml` 里
 * **那一个锚点**的 `x` / `y`。
 *
 * 锚点是「事件挂在地图上的坐标」（K08 §3.8：选事件能定位到地图上）⇒ 手填的坐标同样常常差一点
 * ⇒ 让他在图上**拖**（与挪标注同一条纪律：只改那一行、范围要落在框内、写盘带 baseHash）。
 */
export async function setAnchorPosition(
  gateway: ProjectGateway,
  request: WorldMapSetAnchorRequestPayload,
): Promise<WorldMapSetAnchorResult> {
  const snapshot = await gateway.readDoc(MAP_PATH).catch(() => null);
  if (snapshot === null) {
    return { ok: false, note: "项目还没有世界地图（先登记底图）", position: null, previous: [] };
  }
  let def: WorldMapDef;
  try {
    def = parseMapFile(snapshot.content);
  } catch (err) {
    return {
      ok: false,
      note: `地图文件现在读不了：${err instanceof Error ? err.message : String(err)}`,
      position: null,
      previous: [],
    };
  }
  const bounds = normalizeBounds(def.bounds).bounds;
  if (bounds === null) {
    return { ok: false, note: "地图没有有效边界（框不出范围）", position: null, previous: [] };
  }
  const x = Math.round(request.x);
  const y = Math.round(request.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return { ok: false, note: "坐标里有非数字", position: null, previous: [] };
  }
  if (x < bounds.x0 || x > bounds.x1 || y < bounds.y0 || y > bounds.y1) {
    return {
      ok: false,
      note:
        `这个点落在框定的那一块之外（${String(bounds.x0)},${String(bounds.y0)} → ` +
        `${String(bounds.x1)},${String(bounds.y1)}）`,
      position: null,
      previous: [],
    };
  }
  const anchor = (def.eventAnchors ?? []).find((item) => item.id === request.anchorId);
  if (anchor === undefined) {
    return {
      ok: false,
      note: `地图里没有锚点 ${request.anchorId}`,
      position: null,
      previous: [],
    };
  }
  const moved = setMapAnchorPosition(snapshot.content, request.anchorId, { x, y });
  if (moved.content === null) {
    return {
      ok: false,
      note: moved.reason ?? "没挪成",
      position: null,
      previous: moved.previous,
    };
  }
  await gateway.writeDoc(MAP_PATH, moved.content, snapshot.hash);
  return {
    ok: true,
    note: `锚点 ${request.anchorId} 挪到 ${String(x)},${String(y)}`,
    position: { x, y },
    previous: moved.previous,
  };
}
