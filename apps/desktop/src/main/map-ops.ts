/* SPDX-License-Identifier: Apache-2.0 */
import {
  MAP_PATH,
  checkStructureFromSources,
  parseMapFile,
  projectWorldMap,
  type WorldMapDef,
} from "@yushu/world-engine";
import type { WorldMapViewPayload, WorldMapViewRequestPayload } from "../shared/ipc.js";
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
  };
}
