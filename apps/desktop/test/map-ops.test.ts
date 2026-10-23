/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uploadMapBase, setMapBounds, setMarkerPosition, setAnchorPosition, createMapMarker, createMapAnchor, worldMapView } from "../src/main/map-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { parseMapFile, createSettingCard, serializeCardFile, serializeTimelineFile, TIMELINE_API_VERSION } from "@yushu/world-engine";

/**
 * 底图登记（R135）：**写盘**路径的单测。
 *
 * 这一条链路全是"会改作者项目"的动作 ⇒ 判据盯三件事：
 * ① **只追加那三行**（标注、图层、注释**原样留着** ⇒ 不重写整个文件）；
 * ② **bounds 按量出来的像素尺寸填**（作者手填边界填不对是常态 ⇒ 让工具量）；
 * ③ **已经有底图登记 ⇒ 拒绝**（换底图是作者的决定，工具不替他换，而且要把该改的三行给作者看）。
 */

/** 1×1 的真 PNG（头里有 IHDR ⇒ 能量出尺寸） */
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

let dir: string;
let gateway: ProjectGateway;
let picked: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-mapbase-"));
  gateway = new ProjectGateway(dir);
  picked = join(dir, "picked.png");
  await writeFile(picked, PNG_1x1);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const pick = () => async () => ({ canceled: false, filePaths: [picked] });

describe("底图登记（R135）：挑图 ⇒ 拷进项目 ⇒ 边界按量出来的尺寸自动填", () => {
  it("没有地图文件时：新建一份，三行都写好，bounds = 量出来的尺寸", async () => {
    const result = await uploadMapBase(gateway, pick());
    expect(result.canceled).toBe(false);
    expect(result.path).toBe("world/assets/map/picked.png");
    expect(result.size).toEqual({ width: 1, height: 1 });
    const def = parseMapFile((await gateway.readDoc("world/map.yaml")).content);
    expect(def.baseImage).toBe("world/assets/map/picked.png");
    expect(def.baseSize).toEqual({ width: 1, height: 1 });
    expect(def.bounds).toEqual([[0, 0], [1, 1]]);
    // 图**真的**在项目里（而且是原样的字节）
    const copied = await gateway.readBinary("world/assets/map/picked.png");
    expect(copied.bytes.equals(PNG_1x1)).toBe(true);
  });

  it("已有地图文件（带标注）时：**只追加那三行**，标注与注释原样留着", async () => {
    await gateway.writeDoc(
      "world/map.yaml",
      [
        "apiVersion: map-v1",
        "id: map-world",
        "crs: simple",
        "layers: [place]",
        "markers:",
        "  - {id: m-1, layer: place, entity_ref: loc-a, x: 250, y: 175}",
        "# 作者自己写的注释",
        "",
      ].join("\n"),
    );
    const result = await uploadMapBase(gateway, pick());
    expect(result.canceled).toBe(false);
    const content = (await gateway.readDoc("world/map.yaml")).content;
    expect(content).toContain("# 作者自己写的注释");
    expect(content).toContain("entity_ref: loc-a");
    const def = parseMapFile(content);
    expect(def.markers).toHaveLength(1);
    expect(def.baseImage).toBe("world/assets/map/picked.png");
  });

  it("已经有底图登记 ⇒ **拒绝**并把该改的三行给作者看（map.yaml 一个字节都不动）", async () => {
    const before = [
      "apiVersion: map-v1",
      "id: map-world",
      "crs: simple",
      "base_image: world/assets/map/old.png",
      "base_size: {width: 10, height: 10}",
      "bounds: [[0, 0], [10, 10]]",
      "",
    ].join("\n");
    await gateway.writeDoc("world/map.yaml", before);
    const result = await uploadMapBase(gateway, pick());
    expect(result.canceled).toBe(false);
    expect(result.snippet).toContain("base_image: world/assets/map/picked.png");
    expect(result.snippet).toContain("bounds: [[0, 0], [1, 1]]");
    expect((await gateway.readDoc("world/map.yaml")).content).toBe(before);
  });

  it("作者取消 ⇒ 什么都不做（没有写盘）", async () => {
    const result = await uploadMapBase(gateway, async () => ({ canceled: true, filePaths: [] }));
    expect(result.canceled).toBe(true);
    expect(result.path).toBe(null);
    await expect(gateway.readDoc("world/map.yaml")).rejects.toThrow();
  });

  it("格式不认 ⇒ 不写盘（SVG 之类不进 <image>）", async () => {
    const txt = join(dir, "picked.txt");
    await writeFile(txt, "not an image");
    const result = await uploadMapBase(gateway, async () => ({ canceled: false, filePaths: [txt] }));
    expect(result.path).toBe(null);
    expect(result.note).toContain("格式不认");
    await expect(gateway.readDoc("world/map.yaml")).rejects.toThrow();
  });

  it("同名不覆盖：项目里已经有那张图 ⇒ 换个名字放（旧图还在）", async () => {
    await gateway.writeBinary("world/assets/map/picked.png", PNG_1x1);
    const result = await uploadMapBase(gateway, pick());
    expect(result.path).toBe("world/assets/map/picked-2.png");
    const old = await gateway.readBinary("world/assets/map/picked.png");
    expect(old.bytes.equals(PNG_1x1)).toBe(true);
  });

  it("**换底图**（replace 模式）：替换那三行，标注留着，**换之前的三行给作者看**（换回去贴回去即可）", async () => {
    await gateway.writeBinary("world/assets/map/old.png", PNG_1x1);
    await gateway.writeDoc(
      "world/map.yaml",
      [
        "apiVersion: map-v1",
        "id: map-world",
        "crs: simple",
        "base_image: world/assets/map/old.png",
        "base_size: {width: 1, height: 1}",
        "bounds: [[0, 0], [1, 1]]",
        "markers:",
        "  - {id: m-1, layer: place, entity_ref: loc-a, x: 250, y: 175}",
        "",
      ].join("\n"),
    );
    const result = await uploadMapBase(gateway, pick(), "replace");
    expect(result.canceled).toBe(false);
    expect(result.path).toBe("world/assets/map/picked.png");
    const content = (await gateway.readDoc("world/map.yaml")).content;
    expect(content).toContain("base_image: world/assets/map/picked.png");
    expect(content).not.toContain("base_image: world/assets/map/old.png");
    // 标注**原样留着**（换的是底图，不是整张地图）
    expect(content).toContain("entity_ref: loc-a");
    // 旧图**还在项目里**（换错了可以改回去）
    await expect(gateway.readBinary("world/assets/map/old.png")).resolves.toBeTruthy();
    // 换之前的三行给作者看（他要换回去就贴回去）
    expect(result.previous).toContain("base_image: world/assets/map/old.png");
    expect(result.previous).toHaveLength(3);
  });
});

/**
 * 框定边界（R138）：**写盘**路径的单测。
 *
 * 口径回源 K08 §3.6「地图 = 图片底图 + bounds → 用户上传底图并**框定 bounds**」：
 * 作者在图上拖一块 ⇒ 那块才是地图。判据盯四件事：
 * ① **只改 `bounds` 那一行**（底图登记、图层、标注、锚点、注释**原样留着**）；
 * ② **框的范围必须落在底图里**（落在外面 ⇒ 画出来是空的）⇒ 拒绝；
 * ③ **盘上没成 ⇒ 一个字节都不动**（拒绝不是"先改了再说说"）；
 * ④ **地图文件读不了 / 没有那一行 ⇒ 拒绝并说清**（工具不替作者猜）。
 */
describe("框定边界（R138）：作者在图上拖一块 ⇒ 只改 map.yaml 的 bounds 那一行", () => {
  const MAP_YAML = [
    "# 作者自己写的注释",
    "apiVersion: map-v1",
    "id: map-world",
    "crs: simple",
    "base_image: world/assets/map/base.png",
    "base_size: {width: 1000, height: 700}",
    "bounds: [[0, 0], [1000, 700]]",
    "layers: [place, event]",
    "markers:",
    "  - {id: m-place, layer: place, entity_ref: loc-a, x: 250, y: 175}",
    "event_anchors:",
    "  - {id: a-ev, event_ref: ev-1, x: 300, y: 200}",
    "",
  ].join("\n");

  it("框在底图内 ⇒ **只改 bounds 那一行**，其余（注释 / 底图登记 / 图层 / 标注 / 锚点）原样留着", async () => {
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const result = await setMapBounds(gateway, { x0: 100, y0: 50, x1: 800, y1: 600 });
    expect(result.ok).toBe(true);
    expect(result.bounds).toEqual({ x0: 100, y0: 50, x1: 800, y1: 600 });
    expect(result.imageSize).toEqual({ width: 1000, height: 700 });
    const content = (await gateway.readDoc("world/map.yaml")).content;
    expect(content).toContain("bounds: [[100, 50], [800, 600]]");
    expect(content).toContain("# 作者自己写的注释");
    expect(content).toContain("base_image: world/assets/map/base.png");
    expect(content).toContain("base_size: {width: 1000, height: 700}");
    expect(content).toContain("- {id: m-place, layer: place, entity_ref: loc-a, x: 250, y: 175}");
    expect(content).toContain("- {id: a-ev, event_ref: ev-1, x: 300, y: 200}");
    // **只改那一行** ⇒ 别的行逐字不动（行数与内容都一样）
    const before = MAP_YAML.split("\n");
    const after = content.split("\n");
    expect(after.length).toBe(before.length);
    const changed = after.filter((line, index) => line !== before[index]);
    expect(changed).toEqual(["bounds: [[100, 50], [800, 600]]"]);
  });

  it("框超出底图 ⇒ 拒绝并说清底图多大，**盘上一个字节都没动**", async () => {
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const before = (await gateway.readDoc("world/map.yaml")).hash;
    const result = await setMapBounds(gateway, { x0: 0, y0: 0, x1: 1200, y1: 700 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("1000×700");
    expect(result.bounds).toBeNull();
    expect((await gateway.readDoc("world/map.yaml")).hash).toBe(before);
  });

  it("框的宽或高不为正 ⇒ 拒绝（画不出任何东西）", async () => {
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const before = (await gateway.readDoc("world/map.yaml")).hash;
    const result = await setMapBounds(gateway, { x0: 300, y0: 200, x1: 300, y1: 500 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("不为正");
    expect((await gateway.readDoc("world/map.yaml")).hash).toBe(before);
  });

  it("地图没有 base_size ⇒ 拒绝（不知道底图多大 ⇒ 框不出范围），不自己猜", async () => {
    await gateway.writeDoc(
      "world/map.yaml",
      ["apiVersion: map-v1", "id: map-world", "crs: simple", "bounds: [[0, 0], [100, 100]]", ""].join("\n"),
    );
    const result = await setMapBounds(gateway, { x0: 0, y0: 0, x1: 50, y1: 50 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("base_size");
    expect(result.imageSize).toBeNull();
  });

  it("地图文件里没有 bounds 那一行 ⇒ 拒绝（工具不替作者加一行）", async () => {
    await gateway.writeDoc(
      "world/map.yaml",
      ["apiVersion: map-v1", "id: map-world", "crs: simple", "base_size: {width: 100, height: 100}", ""].join("\n"),
    );
    const before = (await gateway.readDoc("world/map.yaml")).hash;
    const result = await setMapBounds(gateway, { x0: 0, y0: 0, x1: 50, y1: 50 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("bounds");
    expect((await gateway.readDoc("world/map.yaml")).hash).toBe(before);
  });

  it("项目里根本没有地图文件 ⇒ 拒绝（先登记底图）", async () => {
    const result = await setMapBounds(gateway, { x0: 0, y0: 0, x1: 50, y1: 50 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("先登记底图");
    await expect(gateway.readDoc("world/map.yaml")).rejects.toThrow();
  });

  it("视图的画布 = **框定的那一块**（不是整张底图）⇒ 底图按它裁切显示；且子矩形**不报** map-bounds-missing", async () => {
    await gateway.writeDoc(
      "world/map.yaml",
      [
        "apiVersion: map-v1",
        "id: map-world",
        "crs: simple",
        "base_size: {width: 1000, height: 700}",
        "bounds: [[100, 50], [800, 600]]",
        "layers: [place]",
        "",
      ].join("\n"),
    );
    const view = await worldMapView(gateway, {});
    expect(view.canvas).toEqual({ width: 700, height: 550 });
    expect(view.baseSize).toEqual({ width: 1000, height: 700 });
    expect(view.findings.some((item) => item.code === "map-bounds-missing")).toBe(false);
  });
});

/**
 * 挪标注（R139）：**写盘**路径的单测。
 *
 * 口径回源 K08 §5「地图编辑器：上传底图 → 框定 bounds → **放 marker**、区域、行程线 → 绑定实体」——
 * R135 做了「上传底图」、R138 做了「框定 bounds」，这一轮接上「放 marker」的第一步：**挪**。
 *
 * 判据盯三件事：
 * ① **只改那一个标注的 x / y**（别的标注、底图、bounds、作者的注释**原样留着**）；
 * ② **落在框定的那一块之外 ⇒ 拒绝**（那个点看不见），且**盘上一个字节都没动**；
 * ③ **改之前那一行给作者**（回退的路摆在眼前：把那行贴回去即可）。
 */
describe("挪标注（R139）：作者在图上把标注拖到新位置 ⇒ 只改那一个标注", () => {
  const MAP_YAML = [
    "# 作者自己写的注释",
    "apiVersion: map-v1",
    "id: map-world",
    "crs: simple",
    "base_image: world/assets/map/base.png",
    "base_size: {width: 1000, height: 700}",
    "bounds: [[0, 0], [1000, 700]]",
    "layers: [place]",
    "markers:",
    "  - {id: m-in, layer: place, entity_ref: loc-a, x: 250, y: 175}",
    "  - {id: m-other, layer: place, entity_ref: loc-b, x: 700, y: 500}",
    "",
  ].join("\n");

  it("挪到新位置 ⇒ **只改那一个标注的 x / y**，其余行原样；并把改之前那一行给出来", async () => {
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const result = await setMarkerPosition(gateway, { markerId: "m-in", x: 321, y: 654 });
    expect(result.ok).toBe(true);
    expect(result.position).toEqual({ x: 321, y: 654 });
    const content = (await gateway.readDoc("world/map.yaml")).content;
    expect(content).toContain("- {id: m-in, layer: place, entity_ref: loc-a, x: 321, y: 654}");
    // 别的标注没动
    expect(content).toContain("- {id: m-other, layer: place, entity_ref: loc-b, x: 700, y: 500}");
    // 注释 / 底图 / bounds 都没动
    expect(content).toContain("# 作者自己写的注释");
    expect(content).toContain("base_size: {width: 1000, height: 700}");
    expect(content).toContain("bounds: [[0, 0], [1000, 700]]");
    // **只有那一行变了**
    const before = MAP_YAML.split("\n");
    const after = content.split("\n");
    expect(after.length).toBe(before.length);
    const changed = after.filter((line, index) => line !== before[index]);
    expect(changed).toHaveLength(1);
    // 改之前那一行给作者（挪回去就贴回去）
    expect(result.previous).toHaveLength(1);
    expect(result.previous[0]).toContain("x: 250, y: 175");
  });

  it("落在框定的那一块之外 ⇒ 拒绝并说清范围，**盘上一个字节都没动**", async () => {
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const before = (await gateway.readDoc("world/map.yaml")).hash;
    const result = await setMarkerPosition(gateway, { markerId: "m-in", x: 5000, y: 5000 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("之外");
    expect(result.position).toBeNull();
    expect((await gateway.readDoc("world/map.yaml")).hash).toBe(before);
  });

  it("地图里没有这个标注 ⇒ 拒绝（不猜、不新建）", async () => {
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const before = (await gateway.readDoc("world/map.yaml")).hash;
    const result = await setMarkerPosition(gateway, { markerId: "m-zzz", x: 10, y: 10 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("m-zzz");
    expect((await gateway.readDoc("world/map.yaml")).hash).toBe(before);
  });

  it("项目里根本没有地图文件 ⇒ 拒绝（先登记底图）", async () => {
    const result = await setMarkerPosition(gateway, { markerId: "m-in", x: 10, y: 10 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("先登记底图");
    await expect(gateway.readDoc("world/map.yaml")).rejects.toThrow();
  });
});

/**
 * 放标注（R140）：**写盘**路径的单测。
 *
 * 口径回源 K08 §5「地图编辑器：上传底图 → 框定 bounds → **放 marker**、区域、行程线 → 绑定实体」——
 * R135 做了「上传底图」、R138 做了「框定 bounds」、R139 做了「挪」，这一轮补上「**放**」。
 *
 * 判据盯四件事：
 * ① **只追加那一行**（别的标注、底图、bounds、注释**原样留着**）；
 * ② **必须绑一个真实存在的地点**（否则就是孤儿标注）⇒ 拒绝并点名；
 * ③ **落点必须落在框定的那一块里** ⇒ 拒绝且盘上不动；
 * ④ **标注 id 不撞**（撞了 ⇒ 地图文件被严格解析拒绝 ⇒ 整个地图都读不出来）。
 */
describe("放标注（R140）：选一个地点 ⇒ 在图上点一下 ⇒ 落一个标注", () => {
  const MAP_YAML = [
    "# 作者自己写的注释",
    "apiVersion: map-v1",
    "id: map-world",
    "crs: simple",
    "base_size: {width: 1000, height: 700}",
    "bounds: [[0, 0], [1000, 700]]",
    "layers: [place]",
    "markers:",
    "  - {id: m-1, layer: place, entity_ref: loc-a, x: 250, y: 175}",
    "",
  ].join("\n");

  /** 在项目里放一张真实的地点卡（放标注要绑真地点 ⇒ 判据得先有一个） */
  async function putPlace(id: string, name: string): Promise<void> {
    const card = createSettingCard({ id: id, type: "location", name: name });
    await gateway.writeDoc(`world/cards/location/${id}.md`, serializeCardFile(card, "正文"), undefined);
  }

  /** 在项目里放一张**角色**卡（地图上放的是地点 ⇒ 绑角色要被拒绝） */
  async function putCharacter(id: string, name: string): Promise<void> {
    const card = createSettingCard({ id: id, type: "character", name: name });
    await gateway.writeDoc(`world/cards/character/${id}.md`, serializeCardFile(card, "正文"), undefined);
  }

  it("落一个标注 ⇒ **只追加那一行**，别的行原样；并给出新标注的 id 与位置", async () => {
    await putPlace("loc-b", "断桥");
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const result = await createMapMarker(gateway, { entityRef: "loc-b", x: 400, y: 300 });
    expect(result.ok).toBe(true);
    expect(result.marker).toEqual({ id: "m-2", entityRef: "loc-b", x: 400, y: 300 });
    const content = (await gateway.readDoc("world/map.yaml")).content;
    expect(content).toContain("- {id: m-2, layer: place, entity_ref: loc-b, x: 400, y: 300}");
    // 别的行原样
    expect(content).toContain("# 作者自己写的注释");
    expect(content).toContain("bounds: [[0, 0], [1000, 700]]");
    expect(content).toContain("- {id: m-1, layer: place, entity_ref: loc-a, x: 250, y: 175}");
    // 写完的文件**仍能严格解析**（生成的那一行是合法 YAML）
    expect(parseMapFile(content).markers).toHaveLength(2);
  });

  it("绑一个**不存在的地点** ⇒ 拒绝（否则就是孤儿标注），盘上不动", async () => {
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const before = (await gateway.readDoc("world/map.yaml")).hash;
    const result = await createMapMarker(gateway, { entityRef: "loc-zzz", x: 400, y: 300 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("loc-zzz");
    expect(result.marker).toBeNull();
    expect((await gateway.readDoc("world/map.yaml")).hash).toBe(before);
  });

  it("绑一个**非地点**的实体（角色）⇒ 拒绝（地图上放的是地点，不是角色）", async () => {
    await putCharacter("char-x", "林渊之");
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const before = (await gateway.readDoc("world/map.yaml")).hash;
    const result = await createMapMarker(gateway, { entityRef: "char-x", x: 400, y: 300 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("char-x");
    expect(result.marker).toBeNull();
    expect((await gateway.readDoc("world/map.yaml")).hash).toBe(before);
  });

  it("落点落在框定的那一块之外 ⇒ 拒绝并说清范围，盘上不动", async () => {
    await putPlace("loc-b", "断桥");
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const before = (await gateway.readDoc("world/map.yaml")).hash;
    const result = await createMapMarker(gateway, { entityRef: "loc-b", x: 5000, y: 5000 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("之外");
    expect((await gateway.readDoc("world/map.yaml")).hash).toBe(before);
  });

  it("标注 id **不撞**（已有 m-1 ⇒ 新的是 m-2；撞 id 地图就读不出来了）", async () => {
    await putPlace("loc-b", "断桥");
    await putPlace("loc-c", "落霞峰");
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const first = await createMapMarker(gateway, { entityRef: "loc-b", x: 400, y: 300 });
    expect(first.marker?.id).toBe("m-2");
    const second = await createMapMarker(gateway, { entityRef: "loc-c", x: 500, y: 350 });
    expect(second.marker?.id).toBe("m-3");
    const def = parseMapFile((await gateway.readDoc("world/map.yaml")).content);
    expect((def.markers ?? []).map((marker) => marker.id)).toEqual(["m-1", "m-2", "m-3"]);
  });
});

/**
 * 挪事件锚点（R141）：**写盘**路径的单测。
 *
 * 锚点是「事件挂在地图上的坐标」（K08 §3.8）⇒ 手填的坐标同样常常差一点 ⇒ 让作者在图上**拖**。
 * 判据盯两件事：① **只改那一个锚点的 x / y**（别的锚点、标注、注释原样留着）；
 * ② 落在框定的那一块之外 ⇒ 拒绝且盘上不动。
 */
describe("挪事件锚点（R141）：作者在图上把锚点拖到新位置 ⇒ 只改那一个锚点", () => {
  const MAP_YAML = [
    "# 作者自己写的注释",
    "apiVersion: map-v1",
    "id: map-world",
    "crs: simple",
    "base_size: {width: 1000, height: 700}",
    "bounds: [[0, 0], [1000, 700]]",
    "layers: [place, event]",
    "markers:",
    "  - {id: m-1, layer: place, entity_ref: loc-a, x: 250, y: 175}",
    "event_anchors:",
    "  - {id: a-ev, event_ref: ev-1, x: 300, y: 200}",
    "  - {id: a-ev2, event_ref: ev-2, x: 500, y: 400}",
    "",
  ].join("\n");

  it("挪到新位置 ⇒ **只改那一个锚点的 x / y**，其余行原样", async () => {
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const result = await setAnchorPosition(gateway, { anchorId: "a-ev", x: 321, y: 654 });
    expect(result.ok).toBe(true);
    expect(result.position).toEqual({ x: 321, y: 654 });
    const content = (await gateway.readDoc("world/map.yaml")).content;
    expect(content).toContain("- {id: a-ev, event_ref: ev-1, x: 321, y: 654}");
    // 别的锚点、标注、注释都原样
    expect(content).toContain("- {id: a-ev2, event_ref: ev-2, x: 500, y: 400}");
    expect(content).toContain("- {id: m-1, layer: place, entity_ref: loc-a, x: 250, y: 175}");
    expect(content).toContain("# 作者自己写的注释");
    const before = MAP_YAML.split("\n");
    const after = content.split("\n");
    expect(after.length).toBe(before.length);
    expect(after.filter((line, index) => line !== before[index])).toHaveLength(1);
  });

  it("落在框定的那一块之外 ⇒ 拒绝并说清范围，盘上不动", async () => {
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const before = (await gateway.readDoc("world/map.yaml")).hash;
    const result = await setAnchorPosition(gateway, { anchorId: "a-ev", x: 5000, y: 5000 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("之外");
    expect((await gateway.readDoc("world/map.yaml")).hash).toBe(before);
  });

  it("地图里没有这个锚点 ⇒ 拒绝（不猜、不新建）", async () => {
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const before = (await gateway.readDoc("world/map.yaml")).hash;
    const result = await setAnchorPosition(gateway, { anchorId: "a-zzz", x: 10, y: 10 });
    expect(result.ok).toBe(false);
    // 认**主进程自己那句**（"地图里没有锚点"）——只认 ok=false 太弱：
    // 若主进程放过这个 id、让引擎去报错，回执会变成另一句话 ⇒ 那样也是 bug
    expect(result.note).toContain("地图里没有锚点");
    expect(result.note).toContain("a-zzz");
    expect((await gateway.readDoc("world/map.yaml")).hash).toBe(before);
  });
});

/**
 * 放事件锚点（R142）：**写盘**路径的单测。
 *
 * 口径回源 K08 §3.8：事件可挂坐标 ⇒ 选事件能定位到地图上。
 * 判据盯四件事：① **只追加那一行**（放在 event_anchors 段的末尾 ⇒ 顺序不变）；
 * ② **必须绑一个真实存在的事件**（清单来自 world/timeline.yaml）⇒ 拒绝并点名；
 * ③ 落在框定的那一块之外 ⇒ 拒绝且盘上不动；④ **锚点 id 不撞**。
 */
describe("放事件锚点（R142）：选一个事件 ⇒ 在图上点一下 ⇒ 落一个锚点", () => {
  const MAP_YAML = [
    "# 作者自己写的注释",
    "apiVersion: map-v1",
    "id: map-world",
    "crs: simple",
    "base_size: {width: 1000, height: 700}",
    "bounds: [[0, 0], [1000, 700]]",
    "layers: [place, event]",
    "event_anchors:",
    "  - {id: a-1, event_ref: ev-war, x: 300, y: 200}",
    "",
  ].join("\n");

  /** 项目里放一条时间线（事件的清单来自它） */
  async function putTimeline(): Promise<void> {
    const timeline = serializeTimelineFile({
      apiVersion: TIMELINE_API_VERSION,
      anchor_event: "ev-war",
      calendars: [{ id: "default", label: "元年", offset: 0 }],
      timelines: [{ id: "main", anchor_event: "ev-war", calendar: "default", scale: "numeric", events: ["ev-war"] }],
      events: [
        {
          id: "ev-war",
          title: "玄元立国",
          year: 0,
          timeline: "main",
          participants: [],
          causes: [],
          effects: [],
        },
      ],
    });
    await gateway.writeDoc("world/timeline.yaml", timeline, undefined);
  }

  it("落一个锚点 ⇒ **只追加那一行**（排在已有锚点之后），其余行原样", async () => {
    await putTimeline();
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const result = await createMapAnchor(gateway, { eventRef: "ev-war", x: 450, y: 350 });
    expect(result.ok).toBe(true);
    expect(result.anchor).toEqual({ id: "a-2", eventRef: "ev-war", x: 450, y: 350 });
    const content = (await gateway.readDoc("world/map.yaml")).content;
    expect(content).toContain("- {id: a-2, event_ref: ev-war, x: 450, y: 350}");
    // 别的行原样
    expect(content).toContain("# 作者自己写的注释");
    expect(content).toContain("bounds: [[0, 0], [1000, 700]]");
    expect(content).toContain("- {id: a-1, event_ref: ev-war, x: 300, y: 200}");
    const before = MAP_YAML.split("\n");
    const after = content.split("\n");
    expect(after.length).toBe(before.length + 1);
  });

  it("绑一个**不存在的事件** ⇒ 拒绝（锚点只能挂真实的事件），盘上不动", async () => {
    await putTimeline();
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const before = (await gateway.readDoc("world/map.yaml")).hash;
    const result = await createMapAnchor(gateway, { eventRef: "ev-zzz", x: 450, y: 350 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("ev-zzz");
    expect(result.anchor).toBeNull();
    expect((await gateway.readDoc("world/map.yaml")).hash).toBe(before);
  });

  it("落在框定的那一块之外 ⇒ 拒绝并说清范围，盘上不动", async () => {
    await putTimeline();
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const before = (await gateway.readDoc("world/map.yaml")).hash;
    const result = await createMapAnchor(gateway, { eventRef: "ev-war", x: 5000, y: 5000 });
    expect(result.ok).toBe(false);
    expect(result.note).toContain("之外");
    expect((await gateway.readDoc("world/map.yaml")).hash).toBe(before);
  });

  it("锚点 id **不撞**（已有 a-1 ⇒ 新的是 a-2）", async () => {
    await putTimeline();
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const result = await createMapAnchor(gateway, { eventRef: "ev-war", x: 450, y: 350 });
    expect(result.anchor?.id).toBe("a-2");
  });

  it("地图载荷里带上**事件清单**（作者要选一个事件 ⇒ 清单来自 world/timeline.yaml）", async () => {
    await putTimeline();
    await gateway.writeDoc("world/map.yaml", MAP_YAML);
    const view = await worldMapView(gateway, {});
    expect(view.events).toEqual([{ id: "ev-war", title: "玄元立国" }]);
  });
});
