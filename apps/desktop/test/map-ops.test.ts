/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { uploadMapBase } from "../src/main/map-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { parseMapFile } from "@yushu/world-engine";

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
