/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { appendMapMarker, normalizeBounds, parseMapFile, projectWorldMap, setMapMarkerPosition, type WorldMapDef } from "../src/world-map.js";
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

  it("bounds 是底图的**子矩形**（作者框定的那一块）⇒ **不报** map-bounds-missing（框定是正式功能，不是尺寸写错）", () => {
    // 口径回源 K08 §3.6：地图 = 图片底图 + bounds，作者**上传底图并框定 bounds**
    // ⇒ bounds 天然就是底图里的**一块**，不是整张图。
    const def = mapDef({ bounds: { x0: 200, y0: 300, x1: 800, y1: 1100 } });
    const result = projectWorldMap(def, ENTITIES);
    expect(result.findings.find((item) => item.code === "map-bounds-missing")).toBeUndefined();
    // 框里的标注按**新框**归一（坐标空间变了 ⇒ 归一也变）
    const b = result.markers.find((item) => item.id === "m-b");
    expect(b?.nx).toBeCloseTo((300 - 200) / 600, 6);
    expect(b?.ny).toBeCloseTo((400 - 300) / 800, 6);
    // 框**外面**的标注：仍然画（坐标照给），但逐条点名（作者看得见自己框掉了什么）
    const outside = result.findings.filter((item) => item.code === "map-marker-outside");
    expect(outside.map((item) => item.refs[0])).toEqual(["m-a"]);
  });

  it("bounds **超出**底图 ⇒ 仍然是 map-bounds-missing（error），并说清底图多大", () => {
    const def = mapDef({ bounds: { x0: 0, y0: 0, x1: 1200, y1: 1400 } });
    const result = projectWorldMap(def, ENTITIES);
    const finding = result.findings.find((item) => item.code === "map-bounds-missing");
    expect(finding).toBeTruthy();
    expect(finding?.severity).toBe("error");
    expect(finding?.message).toContain("不匹配");
    expect(finding?.message).toContain("1000×1400");
  });

  it("挪标注（R139）⇒ **只改那一行**的 x / y，其余行原样；并把**改之前**那一行给出来（作者要挪回去就贴回去）", () => {
    const text = [
      "# 作者自己写的注释",
      "apiVersion: map-v1",
      "id: map-world",
      "crs: simple",
      "bounds: [[0, 0], [1000, 1400]]",
      "markers:",
      "  - {id: m-a, layer: place, entity_ref: loc-a, x: 100, y: 200}",
      "  - {id: m-b, layer: place, entity_ref: loc-b, x: 300, y: 400}",
      "",
    ].join("\n");
    const result = setMapMarkerPosition(text, "m-b", { x: 321, y: 654 });
    expect(result.reason).toBeNull();
    expect(result.content).not.toBeNull();
    const content = result.content as string;
    expect(content).toContain("x: 321, y: 654");
    // **只有那一行变了**（其余行逐字不动）
    const before = text.split("\n");
    const after = content.split("\n");
    expect(after.length).toBe(before.length);
    const changed = after.filter((line, index) => line !== before[index]);
    expect(changed).toHaveLength(1);
    expect(changed[0]).toContain("m-b");
    expect(changed[0]).not.toContain("m-a");
    // 改之前那一行给作者（回退的路摆在眼前）
    expect(result.previous).toHaveLength(1);
    expect(result.previous[0]).toContain("x: 300, y: 400");
  });

  it("挪标注：文件里没有这个 id ⇒ **如实说找不到**，不半个改", () => {
    const text = ["apiVersion: map-v1", "markers:", "  - {id: m-a, layer: place, entity_ref: loc-a, x: 1, y: 2}", ""].join("\n");
    const result = setMapMarkerPosition(text, "m-zzz", { x: 10, y: 20 });
    expect(result.content).toBeNull();
    expect(result.reason).toContain("m-zzz");
  });

  it("挪标注：那一行认不出 x / y ⇒ **如实说认不出**（不猜、不半改）", () => {
    const text = ["apiVersion: map-v1", "markers:", "  - {id: m-a, layer: place, entity_ref: loc-a}", ""].join("\n");
    const result = setMapMarkerPosition(text, "m-a", { x: 10, y: 20 });
    expect(result.content).toBeNull();
    expect(result.reason).toContain("认不出");
  });

  it("追加标注（R140）⇒ **只加那一行**（放在 markers 段的末尾），其余行原样", () => {
    const text = [
      "# 作者自己写的注释",
      "apiVersion: map-v1",
      "id: map-world",
      "crs: simple",
      "bounds: [[0, 0], [1000, 1400]]",
      "markers:",
      "  - {id: m-a, layer: place, entity_ref: loc-a, x: 100, y: 200}",
      "layers: [place]",
      "",
    ].join("\n");
    const result = appendMapMarker(text, { id: "m-new", layer: "place", entityRef: "loc-b", x: 321, y: 654 });
    expect(result.reason).toBeNull();
    const content = result.content as string;
    // 只多了那一行，且**排在 markers 段的末尾**（作者自己写的标注顺序不变）
    const before = text.split("\n");
    const after = content.split("\n");
    expect(after.length).toBe(before.length + 1);
    // 去掉新增的那一行之后，其余**逐字**一样（插入会让后面的行号整体后移 ⇒ 不能按行号比）
    const added = after.filter((line) => line.includes("id: m-new"));
    expect(added).toHaveLength(1);
    expect(after.filter((line) => !line.includes("id: m-new"))).toEqual(before);
    expect(added[0]).toContain("entity_ref: loc-b");
    expect(added[0]).toContain("x: 321, y: 654");
    // 注释 / bounds / 图层原样
    expect(content).toContain("# 作者自己写的注释");
    expect(content).toContain("bounds: [[0, 0], [1000, 1400]]");
    expect(content).toContain("layers: [place]");
    // 新行在 `layers:` 之前（= markers 段的末尾）
    expect(content.indexOf("id: m-new")).toBeLessThan(content.indexOf("layers:"));
    // **并且排在作者自己那条标注之后**（作者写的顺序不变 ⇒ 钉住"追加"而不是"插到段首"）
    expect(content.indexOf("id: m-a")).toBeLessThan(content.indexOf("id: m-new"));
  });

  it("追加标注：文件里还没有 markers 段 ⇒ 在末尾**新起一段**（不猜作者想放哪）", () => {
    const text = ["apiVersion: map-v1", "id: map-world", "crs: simple", "bounds: [[0, 0], [1000, 1400]]", ""].join("\n");
    const result = appendMapMarker(text, { id: "m-new", layer: "place", entityRef: "loc-b", x: 10, y: 20 });
    const content = result.content as string;
    expect(content).toContain("markers:");
    expect(content).toContain("id: m-new");
    expect(content).toContain("bounds: [[0, 0], [1000, 1400]]");
  });

  it("追加标注之后，文件**仍能严格解析**（生成的那一行是合法 YAML ⇒ 投影得出那个点）", () => {
    const text = ["apiVersion: map-v1", "id: map-world", "crs: simple", "bounds: [[0, 0], [1000, 1400]]", ""].join("\n");
    const result = appendMapMarker(text, { id: "m-new", layer: "place", entityRef: "loc-a", x: 100, y: 200 });
    const def = parseMapFile(result.content as string);
    const markers = def.markers ?? [];
    expect(markers).toHaveLength(1);
    expect(markers[0]?.id).toBe("m-new");
    expect(markers[0]?.x).toBe(100);
    expect(markers[0]?.entityRef).toBe("loc-a");
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

/**
 * 世界地图真源文件的严格解析（R120）。
 *
 * 为什么解析也要严格：**地图错了不会当场显形**——画布照样出得来，只是地点摆错了位置，
 * 作者往往看不出"这张图是歪的"，几天后才在正文里发现对不上。
 * 所以拼错的键、认不出的图层名、非数字的坐标一律拒绝加载并点名，
 * 而不是"忽略这个字段继续画"（那会让作者以为边界设了，其实在画纸上）。
 */
describe("world/map.yaml 的严格解析（R120）", () => {
  const good = [
    "apiVersion: map-v1",
    "id: map-world",
    "crs: simple",
    "bounds: [[0, 0], [1000, 700]]",
    "base_size: {width: 1000, height: 700}",
    "layers: [place, political]",
    "markers:",
    "  - {id: m-1, layer: place, entity_ref: loc-1, x: 120, y: 240}",
    "",
  ].join("\n");

  it("正常文件解析成投影可直接吃的形状（键名 snake_case → 引擎 camelCase）", () => {
    const def = parseMapFile(good);
    expect(def.id).toBe("map-world");
    expect(def.crs).toBe("simple");
    expect(def.bounds).toEqual([[0, 0], [1000, 700]]);
    expect(def.baseSize).toEqual({ width: 1000, height: 700 });
    expect(def.layers).toEqual(["place", "political"]);
    expect(def.markers).toHaveLength(1);
    expect(def.markers?.[0]?.entityRef).toBe("loc-1");
    expect(def.markers?.[0]?.x).toBe(120);
  });

  it("未知键拒绝并点名（拼错的键被静默忽略 ⇒ 作者以为边界设了，其实在画纸上）", () => {
    expect(() => parseMapFile(good + "boudns: [[0,0],[10,10]]\n")).toThrow(/未知键「boudns」/);
  });

  it("apiVersion 不对就拒绝（不拿旧版文件当新版画）", () => {
    expect(() => parseMapFile(good.replace("apiVersion: map-v1", "apiVersion: map-v0"))).toThrow(/apiVersion 须为 map-v1/);
  });

  it("crs 只认 simple（虚构地图没有真实经纬度）", () => {
    expect(() => parseMapFile(good.replace("crs: simple", "crs: EPSG3857"))).toThrow(/crs 只认 simple/);
  });

  it("坐标非数字拒绝（x/y 写错时画出来是歪的，作者却看不出）", () => {
    expect(() => parseMapFile(good.replace("x: 120", "x: 一百二十"))).toThrow(/x 须为有限数字/);
  });

  it("标注 id 重复拒绝（两个标注抢同一个 id ⇒ 点开是哪一个说不清）", () => {
    const dup = good + "  - {id: m-1, layer: place, entity_ref: loc-2, x: 10, y: 10}\n";
    expect(() => parseMapFile(dup)).toThrow(/标注 id 重复：m-1/);
  });

  it("图层名认不出就拒绝并把可选值列出来（不是静默归到 other）", () => {
    expect(() => parseMapFile(good.replace("layers: [place, political]", "layers: [place, terran]"))).toThrow(
      /图层名认不出/,
    );
  });

  it("bounds 形状不对就拒绝（宽高为正与否交给体检，解析不越权）", () => {
    expect(() => parseMapFile(good.replace("bounds: [[0, 0], [1000, 700]]", "bounds: [0, 0, 1000, 700]"))).toThrow(
      /bounds 须写成/,
    );
    // 宽高为 0 不是解析错误——它由 normalizeBounds 归"无有效边界"并报 map-bounds-missing
    const degenerate = parseMapFile(good.replace("[[0, 0], [1000, 700]]", "[[0, 0], [0, 0]]"));
    expect(degenerate.bounds).toEqual([[0, 0], [0, 0]]);
  });
});

/**
 * 事件锚点（R131；口径回源 K08 §3.8「事件挂坐标 ⇒ 时空联动」）。
 *
 * 与标注的差别：标注绑**地点实体**（点开是地点卡），锚点绑**事件**（选事件能定位到地图上）。
 * K08 的样例写作 `xy: [420, 610]`；本项目沿用地图自己的键名口径（`x` / `y` 分开写）⇒
 * 作者只学一套坐标写法 ⇒ 但**照 K08 抄 `xy:` 必须被点名**（静默忽略 ⇒ 作者以为坐标生效了）。
 */
describe("事件锚点（R131）：K08 §3.8 的事件挂坐标", () => {
  const withAnchor = (extra: string): string =>
    [
      "apiVersion: map-v1",
      "id: map-world",
      "crs: simple",
      "bounds: [[0, 0], [1000, 700]]",
      "event_anchors:",
      extra,
    ].join("\n");

  it("解析成 camelCase（event_ref → eventRef），`id` 缺省就用 event_ref", () => {
    const def = parseMapFile(withAnchor("  - {event_ref: ev-war, x: 420, y: 610}"));
    expect(def.eventAnchors).toHaveLength(1);
    expect(def.eventAnchors?.[0]?.eventRef).toBe("ev-war");
    expect(def.eventAnchors?.[0]?.id).toBe("ev-war");
    expect(def.eventAnchors?.[0]?.x).toBe(420);
    expect(def.eventAnchors?.[0]?.y).toBe(610);
  });

  it("照 K08 抄 `xy:` ⇒ 拒绝并点名（静默忽略会让作者以为坐标生效了）", () => {
    expect(() => parseMapFile(withAnchor("  - {event_ref: ev-war, xy: [420, 610]}"))).toThrow(
      /event_anchors\[0\] 有未知键「xy」/,
    );
  });

  it("同一个事件两个锚点 ⇒ 拒绝（选事件定位到哪儿会变得不确定）", () => {
    expect(() =>
      parseMapFile(
        withAnchor("  - {event_ref: ev-war, x: 10, y: 10}\n  - {event_ref: ev-war, x: 20, y: 20}"),
      ),
    ).toThrow(/事件锚点重复：ev-war/);
  });

  it("坐标非数字拒绝（画出来是歪的，作者却看不出）", () => {
    expect(() => parseMapFile(withAnchor("  - {event_ref: ev-war, x: 一百, y: 10}"))).toThrow(/x 须为有限数字/);
  });

  it("投影：锚点按底图像素换算归一化坐标（渲染层直接用）", () => {
    const def = parseMapFile(withAnchor("  - {event_ref: ev-war, x: 250, y: 350}"));
    const projection = projectWorldMap(def, []);
    expect(projection.anchors).toHaveLength(1);
    expect(projection.anchors[0]?.nx).toBeCloseTo(0.25);
    expect(projection.anchors[0]?.ny).toBeCloseTo(0.5);
    expect(projection.outOfBoundsAnchors).toEqual([]);
  });

  it("锚点落在底图边界之外 ⇒ map-anchor-outside（warn），但仍然投影（渲染层可以裁剪）", () => {
    const def = parseMapFile(withAnchor("  - {event_ref: ev-war, x: 2000, y: 10}"));
    const projection = projectWorldMap(def, []);
    expect(projection.outOfBoundsAnchors).toEqual(["ev-war"]);
    expect(projection.findings.some((f) => f.code === "map-anchor-outside" && f.severity === "warn")).toBe(true);
    expect(projection.anchors).toHaveLength(1);
  });

  it("没有有效边界 ⇒ 锚点**不产出坐标**（没有边界就无从归一化）", () => {
    const degenerate = withAnchor("  - {event_ref: ev-war, x: 250, y: 350}").replace(
      "[[0, 0], [1000, 700]]",
      "[[0, 0], [0, 0]]",
    );
    const projection = projectWorldMap(parseMapFile(degenerate), []);
    expect(projection.anchors).toHaveLength(0);
    expect(projection.findings.some((f) => f.code === "map-bounds-missing")).toBe(true);
  });
});
