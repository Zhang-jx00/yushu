/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeBounds, projectWorldMap, type WorldMapDef } from "../src/world-map.js";
import type { IndexEntityRow } from "../src/index-input.js";

/**
 * 世界地图（T5-1 第一段·引擎侧，R114）的单测。
 *
 * 口径回源：`docs/research/K-软件工程与产品/K08-时间线与地图UI.md` §3
 * （地图 = 图片底图 + bounds / 标注即地点卡 / 事件锚点 / 分层可控）
 * 与该文的诊断码清单（`map-bounds-missing` / `map-marker-orphan` / `map-marker-overlap`）。
 *
 * 这一层只测**投影与体检**：纯函数、零 fs、不读墙钟、不落盘。
 */

const SOURCE_PATH = join(__dirname, "..", "src", "world-map.ts");

function place(id: string, name: string): IndexEntityRow {
  return {
    id,
    type: "place",
    layer: "geography",
    name,
    aliases: [],
    visibility: "public",
    filePath: `world/cards/location/${id}.md`,
  };
}

const ENTITIES: IndexEntityRow[] = [
  place("loc-a", "青崖城"),
  place("loc-b", "断桥"),
  place("loc-c", "落霞峰"),
];

function mapDef(overrides: Partial<WorldMapDef> = {}): WorldMapDef {
  return {
    id: "map-world",
    crs: "simple",
    bounds: { x0: 0, y0: 0, x1: 1000, y1: 1400 },
    baseSize: { width: 1000, height: 1400 },
    layers: ["base", "place"],
    markers: [
      { id: "m-a", layer: "place", entityRef: "loc-a", x: 100, y: 200 },
      { id: "m-b", layer: "place", entityRef: "loc-b", x: 300, y: 400 },
      { id: "m-c", layer: "place", entityRef: "loc-c", x: 700, y: 900 },
    ],
    ...overrides,
  };
}

describe("世界地图投影（R114 引擎侧）", () => {
  it("缺 bounds ⇒ 报 map-bounds-missing（error）且**不产出坐标**（没有边界就无从归一化）", () => {
    const def = mapDef({ bounds: undefined, baseSize: undefined });
    const result = projectWorldMap(def, ENTITIES);
    const finding = result.findings.find((item) => item.code === "map-bounds-missing");
    expect(finding).toBeTruthy();
    expect(finding?.severity).toBe("error");
    expect(result.bounds).toBeNull();
    expect(result.markers).toEqual([]);
  });

  it("bounds 与底图图片尺寸不匹配 ⇒ 同样是 map-bounds-missing（error）", () => {
    const def = mapDef({ baseSize: { width: 800, height: 1400 } });
    const result = projectWorldMap(def, ENTITIES);
    const finding = result.findings.find((item) => item.code === "map-bounds-missing");
    expect(finding).toBeTruthy();
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("不匹配");
  });

  it("两种 bounds 写法等价（{x0,y0,x1,y1} 与 K08 里的 [[x0,y0],[x1,y1]]）", () => {
    const a = normalizeBounds({ x0: 0, y0: 0, x1: 1000, y1: 1400 });
    const b = normalizeBounds([
      [0, 0],
      [1000, 1400],
    ]);
    expect(a.bounds).toEqual(b.bounds);
    expect(a.bounds).not.toBeNull();
  });

  it("宽或高不为正的 bounds 归「无有效边界」（画不出任何东西）", () => {
    expect(normalizeBounds({ x0: 0, y0: 0, x1: 0, y1: 1400 }).bounds).toBeNull();
    expect(normalizeBounds({ x0: 10, y0: 0, x1: 0, y1: 1400 }).bounds).toBeNull();
  });

  it("标注指向不存在的地点实体 ⇒ map-marker-orphan（error），该标注**不画**但逐条点名", () => {
    const def = mapDef({
      markers: [
        { id: "m-a", layer: "place", entityRef: "loc-a", x: 100, y: 200 },
        { id: "m-x", layer: "place", entityRef: "loc-missing", x: 500, y: 500 },
      ],
    });
    const result = projectWorldMap(def, ENTITIES);
    const finding = result.findings.find((item) => item.code === "map-marker-orphan");
    expect(finding).toBeTruthy();
    expect(finding?.severity).toBe("error");
    expect(result.orphanMarkers).toEqual(["m-x"]);
    expect(result.markers.map((m) => m.id)).toEqual(["m-a"]);
  });

  it("同层多点重合 ⇒ map-marker-overlap（info，建议聚类），且**不自动挪动**点位", () => {
    const def = mapDef({
      markers: [
        { id: "m-1", layer: "place", entityRef: "loc-a", x: 100, y: 200 },
        { id: "m-2", layer: "place", entityRef: "loc-b", x: 103, y: 202 },
        { id: "m-3", layer: "place", entityRef: "loc-c", x: 700, y: 900 },
      ],
    });
    const result = projectWorldMap(def, ENTITIES, { overlapPx: 10 });
    const finding = result.findings.find((item) => item.code === "map-marker-overlap");
    expect(finding).toBeTruthy();
    expect(finding?.severity).toBe("info");
    expect(result.overlapClusters).toEqual([{ layer: "place", members: ["m-1", "m-2"] }]);
    // 点位一个都没被挪动：挪点位是作者的决定
    expect(result.markers.map((m) => [m.id, m.x, m.y])).toEqual([
      ["m-1", 100, 200],
      ["m-2", 103, 202],
      ["m-3", 700, 900],
    ]);
  });

  it("归一化坐标按底图像素换算（渲染层直接用，不必自己算）", () => {
    const result = projectWorldMap(mapDef(), ENTITIES);
    const a = result.markers.find((m) => m.id === "m-a");
    expect(a?.nx).toBeCloseTo(0.1, 6);
    expect(a?.ny).toBeCloseTo(200 / 1400, 6);
    expect(a?.entityName).toBe("青崖城");
  });

  it("落在底图边界之外的标注 ⇒ map-marker-outside（warn），但仍然投影（渲染层可以裁剪）", () => {
    const def = mapDef({
      markers: [{ id: "m-out", layer: "place", entityRef: "loc-a", x: 1200, y: 200 }],
    });
    const result = projectWorldMap(def, ENTITIES);
    const finding = result.findings.find((item) => item.code === "map-marker-outside");
    expect(finding).toBeTruthy();
    expect(finding?.severity).toBe("warn");
    expect(result.outOfBoundsMarkers).toEqual(["m-out"]);
    expect(result.markers.map((m) => m.id)).toEqual(["m-out"]);
  });

  it("图层可独立显隐（K08 §3.9），被隐藏的图层不投影但仍体检", () => {
    const def = mapDef({
      layers: ["base", "place", "political"],
      markers: [
        { id: "m-a", layer: "place", entityRef: "loc-a", x: 100, y: 200 },
        { id: "m-p", layer: "political", entityRef: "loc-b", x: 300, y: 400 },
        { id: "m-x", layer: "political", entityRef: "loc-missing", x: 300, y: 400 },
      ],
    });
    const result = projectWorldMap(def, ENTITIES, { visibleLayers: ["place"] });
    expect(result.markers.map((m) => m.id)).toEqual(["m-a"]);
    // 隐藏的图层里的孤儿标注照样点名：数据问题与显隐无关
    expect(result.orphanMarkers).toEqual(["m-x"]);
    expect(result.layers.map((l) => l.kind)).toEqual(["base", "place", "political"]);
  });

  it("同输入两次 ⇒ 输出逐字相同（纯函数、确定）", () => {
    const def = mapDef();
    const first = JSON.stringify(projectWorldMap(def, ENTITIES));
    const second = JSON.stringify(projectWorldMap(def, ENTITIES));
    expect(second).toBe(first);
    // 输入顺序变了也一样（按 id 排序）
    const shuffled = mapDef({ markers: [...(def.markers ?? [])].reverse() });
    expect(JSON.stringify(projectWorldMap(shuffled, ENTITIES))).toBe(first);
  });

  it("引擎侧是纯函数：不碰 fs、不读墙钟、不用随机数", () => {
    const source = readFileSync(SOURCE_PATH, "utf8");
    expect(source).not.toMatch(/from "node:fs"/);
    expect(source).not.toMatch(/Date\.now|new Date\(/);
    expect(source).not.toMatch(/Math\.random/);
  });
});
