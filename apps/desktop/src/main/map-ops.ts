/* SPDX-License-Identifier: Apache-2.0 */
import {
  MAP_PATH,
  checkStructureFromSources,
  parseMapFile,
  projectWorldMap,
  type WorldMapDef,
} from "@yushu/world-engine";
import type { WorldMapBasePayload, WorldMapViewPayload, WorldMapViewRequestPayload } from "../shared/ipc.js";
import { gatewayReader } from "./index-ops.js";
import type { ProjectGateway } from "./file-gateway.js";

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
      markers: [],
      layers: [],
      findings: [],
      orphanMarkers: [],
      overlapClusters: [],
      outOfBoundsMarkers: [],
      entityCount: 0,
      summary: { markers: 0, layers: 0, entities: 0, findings: 0 },
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
      markers: [],
      layers: [],
      findings: [],
      orphanMarkers: [],
      overlapClusters: [],
      outOfBoundsMarkers: [],
      entityCount: 0,
      summary: { markers: 0, layers: 0, entities: 0, findings: 0 },
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
  const canvas =
    bounds === null
      ? null
      : {
          width: def.baseSize?.width ?? bounds.x1 - bounds.x0,
          height: def.baseSize?.height ?? bounds.y1 - bounds.y0,
        };

  const note = [
    `${markers.length} 个标注 · ${projection.layers.length} 个图层`,
    `项目里 ${structure.entities.length} 个实体（地图只画标注过的那些）`,
    projection.findings.length > 0 ? `${projection.findings.length} 条体检结论` : "体检无结论",
  ].join("；");

  return {
    path: MAP_PATH,
    exists: true,
    note,
    bounds,
    canvas,
    markers,
    layers: projection.layers.map((layer) => ({ kind: layer.kind, markerCount: layer.markerCount })),
    findings: projection.findings.map((finding) => ({
      code: finding.code,
      severity: finding.severity,
      message: finding.message,
      refs: finding.refs,
    })),
    orphanMarkers: projection.orphanMarkers,
    overlapClusters: projection.overlapClusters,
    outOfBoundsMarkers: projection.outOfBoundsMarkers,
    entityCount: structure.entities.length,
    summary: {
      markers: markers.length,
      layers: projection.layers.length,
      entities: structure.entities.length,
      findings: projection.findings.length,
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
