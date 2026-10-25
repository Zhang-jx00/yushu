/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { batchSetMarkerLayer, worldMapView } from "../src/main/map-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { createSettingCard, parseMapFile, serializeCardFile } from "@yushu/world-engine";

/**
 * 标注的**批量管理**（R171）：筛选 / 批量选中 / 批量改图层。
 *
 * 口径回源 `docs/research/K-软件工程与产品/K08-时间线与地图UI.md` §3：
 * - §3.7 **标注即地点卡**（marker 绑定 location 实体）⇒ 绑一个不存在的地方 = **孤儿标注**；
 * - §3.9 **分层可控**（图层独立显隐）⇒ 图层是作者组织地图的手段 ⇒ 组织手段要能**成批**用。
 *
 * 三条判据（对应所有者给的机器判据）：
 * ① **筛选后的条数与真源逐字一致** ⇒ 载荷里的清单 = 地图文件里的每一条标注（含孤儿），
 *    不多一条、不少一条、孤儿**点着名**（不是悄悄藏起来）；
 * ② **批量改图层只改 map.yaml 里那些行**（其余行**逐字节**原样）；
 * ③ **孤儿标注的处理点名而不是静默** ⇒ 回执点出是哪一条、它指向谁；
 *    而且孤儿标注**不会被悄悄丢掉**（丢了作者还以为那个地方不见了）。
 */

let dir: string;
let gateway: ProjectGateway;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-mapbatch-"));
  gateway = new ProjectGateway(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * 四条标注：m-1 / m-2 / m-4 绑真实地点，m-3 绑**不存在的实体**（⇒ 孤儿标注）。
 * 文件里还有作者自己的注释、一个区域、一段 bounds —— 批量改图层不该动它们。
 */
const MAP_YAML = [
  "# 作者自己写的注释",
  "apiVersion: map-v1",
  "id: map-world",
  "crs: simple",
  "base_size: {width: 1000, height: 700}",
  "bounds: [[0, 0], [1000, 700]]",
  "layers: [place, political]",
  "markers:",
  "  - {id: m-1, layer: place, entity_ref: loc-a, x: 250, y: 175}",
  "  - {id: m-2, layer: place, entity_ref: loc-b, x: 300, y: 200}",
  "  - {id: m-3, layer: political, entity_ref: loc-gone, x: 400, y: 300}",
  "  - {id: m-4, layer: place, entity_ref: loc-a, x: 500, y: 400}",
  "regions:",
  '  - {id: r-1, layer: political, name: "北境", points: [[100, 100], [500, 100], [500, 500], [100, 500]]}',
  "",
].join("\n");

/** 在项目里放一张真实的地点卡（标注要绑真地点 ⇒ 判据得先有） */
async function putPlace(id: string, name: string): Promise<void> {
  const card = createSettingCard({ id: id, type: "location", name: name });
  await gateway.writeDoc(`world/cards/location/${id}.md`, serializeCardFile(card, "正文"), undefined);
}

async function seed(): Promise<void> {
  await putPlace("loc-a", "玄天城");
  await putPlace("loc-b", "断桥");
  await gateway.writeDoc("world/map.yaml", MAP_YAML);
}

describe("标注清单（R171）：文件里的每一条标注（含孤儿）都在清单里", () => {
  it("清单条数与真源逐字一致：四条标注一条不多一条不少，孤儿**点着名**", async () => {
    await seed();
    const view = await worldMapView(gateway);
    expect(view.exists).toBe(true);
    // 文件里写了四条标注 ⇒ 清单里就有四条（**含孤儿**）
    expect(parseMapFile(MAP_YAML).markers).toHaveLength(4);
    expect(view.markerRows).toHaveLength(4);
    expect(view.markerRows.map((row) => row.id)).toEqual(["m-1", "m-2", "m-3", "m-4"]);
    // 孤儿标注：指向的实体不存在 ⇒ 点名（orphan=true、没有名字），不是悄悄藏起来
    const orphan = view.markerRows.find((row) => row.id === "m-3");
    expect(orphan?.orphan).toBe(true);
    expect(orphan?.entityName).toBeNull();
    expect(orphan?.entityRef).toBe("loc-gone");
    // 有实体的标注：名字从真源直算
    const alive = view.markerRows.find((row) => row.id === "m-1");
    expect(alive?.orphan).toBe(false);
    expect(alive?.entityName).toBe("玄天城");
    // 图上画出来的那些仍然只有三条（孤儿画不出来 ⇒ K08 的 map-marker-orphan 是 error）
    expect(view.markers).toHaveLength(3);
    expect(view.orphanMarkers).toEqual(["m-3"]);
  });

  it("清单按 id 排序（同输入同输出 ⇒ 界面不会因为文件里的顺序抖动）", async () => {
    await seed();
    const view = await worldMapView(gateway);
    const ids = view.markerRows.map((row) => row.id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("批量改图层（R171）：只改被点名的那几行", () => {
  it("改两条 ⇒ **那两行**变了，其余行**逐字节**原样（注释 / 区域 / bounds / 别的标注都不动）", async () => {
    await seed();
    const before = (await gateway.readDoc("world/map.yaml")).content.split("\n");
    const result = await batchSetMarkerLayer(gateway, { markerIds: ["m-1", "m-4"], layer: "political" });
    expect(result.ok).toBe(true);
    expect(result.changed).toEqual(["m-1", "m-4"]);
    const after = (await gateway.readDoc("world/map.yaml")).content.split("\n");
    // 行数不变（改图层不是加行也不是删行）
    expect(after).toHaveLength(before.length);
    const changedLines = new Set(["m-1", "m-4"]);
    for (let index = 0; index < before.length; index += 1) {
      const line = before[index] as string;
      const isTarget = [...changedLines].some((id) => line.includes(`id: ${id},`));
      if (isTarget) {
        // 目标行：**只**换了 layer 那一处（其余字段逐字不变）
        expect(after[index]).toBe(line.replace(/layer: place/, "layer: political"));
      } else {
        // 其余每一行**逐字节**原样
        expect(after[index]).toBe(line);
      }
    }
    // 改完仍能严格解析，且图层确实换了
    const def = parseMapFile(after.join("\n"));
    expect(def.markers?.find((marker) => marker.id === "m-1")?.layer).toBe("political");
    expect(def.markers?.find((marker) => marker.id === "m-4")?.layer).toBe("political");
    expect(def.markers?.find((marker) => marker.id === "m-2")?.layer).toBe("place");
  });

  it("孤儿标注**点名而不是静默**：回执点出是哪一条、它指向谁；而且它**没有被悄悄丢掉**", async () => {
    await seed();
    const result = await batchSetMarkerLayer(gateway, { markerIds: ["m-3"], layer: "place" });
    expect(result.ok).toBe(true);
    expect(result.orphanChanged).toEqual(["m-3"]);
    // 回执里点了名：是哪一条 + 它指向的那个不存在的实体
    expect(result.note).toContain("m-3");
    expect(result.note).toContain("孤儿标注");
    expect(result.note).toContain("loc-gone");
    // 孤儿标注**仍在盘上**（改了图层 ≠ 被丢掉）
    const content = (await gateway.readDoc("world/map.yaml")).content;
    expect(content).toContain("id: m-3");
    expect(parseMapFile(content).markers).toHaveLength(4);
    // 清单里它仍然是孤儿（点名这件事不会被改图层顺手抹掉）
    const view = await worldMapView(gateway);
    expect(view.markerRows.find((row) => row.id === "m-3")?.orphan).toBe(true);
  });

  it("地图里没有这些标注 ⇒ 整批拒绝并点名，**盘上一个字节都没动**", async () => {
    await seed();
    const before = await gateway.readDoc("world/map.yaml");
    const result = await batchSetMarkerLayer(gateway, { markerIds: ["m-1", "m-zzz"], layer: "political" });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("m-zzz");
    expect(result.changed).toEqual([]);
    const after = await gateway.readDoc("world/map.yaml");
    expect(after.content).toBe(before.content);
    expect(after.hash).toBe(before.hash);
  });

  it("图层名拼错 ⇒ 拒绝（拼错的图层名会让地图文件下一次**读不出来**），盘上不动", async () => {
    await seed();
    const before = await gateway.readDoc("world/map.yaml");
    const result = await batchSetMarkerLayer(gateway, { markerIds: ["m-1"], layer: "politcal" });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("认不出");
    const after = await gateway.readDoc("world/map.yaml");
    expect(after.content).toBe(before.content);
  });

  it("没选中任何标注 ⇒ 拒绝（不猜作者要改哪些）", async () => {
    await seed();
    const before = await gateway.readDoc("world/map.yaml");
    const result = await batchSetMarkerLayer(gateway, { markerIds: [], layer: "political" });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("没有选中");
    expect((await gateway.readDoc("world/map.yaml")).content).toBe(before.content);
  });
});
