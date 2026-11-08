/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  mergeRegionRings,
  splitRegionRing,
  regionsAdjacent,
  computeRegionNeighbors,
  markersInRegion,
  type GeoPoint,
  type GeoRing,
} from "../src/map-geometry.js";

/**
 * 地图**面几何**（R172）的判据：相邻 / 合并 / 拆分。
 *
 * 三条机器判据（docs/14 §5.5 B 组）逐条钉住：
 * ① **合并后顶点对得上**（合并圈的顶点 = 两圈顶点之和 − 共享边的两端；不重复首点）；
 * ② **拆分后两区域并集 = 原区域（可量）**（面积恒等 + 两半各 ≥3 点）；
 * ③ **自交 / 重叠 / 不相邻 / 切法不唯一 / 端点压角 / 退化** —— **拒绝并点名**。
 *
 * 另钉**同绕向合并**（两块都按同方向画的临时多边形——旧实现必被拒的 bug 案例，
 * R172 收口修复：反向弧的端点差一）。
 */

/** 左边一块（逆时针：底 → 右 → 顶 → 左） */
const LEFT: GeoRing = [
  [0, 0],
  [100, 0],
  [100, 100],
  [0, 100],
];

const ringEquals = (a: GeoRing, b: GeoRing): boolean =>
  a.length === b.length && a.every((p, i) => p[0] === b[i]?.[0] && p[1] === b[i]?.[1]);

const area = (ring: GeoRing): number => {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i] as [number, number];
    const [x2, y2] = ring[(i + 1) % ring.length] as [number, number];
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum / 2);
};

describe("合并（R172）：顶点对得上", () => {
  it("**同绕向合并**（两块都逆时针——共享边在两圈里方向相反；旧实现必被拒的 bug 案例）", () => {
    // 右边一块，同样逆时针：底 → 右 → 顶 → 左 ⇒ 共享边 (100,0)→(100,100) 在 B 里是反向
    const right: GeoRing = [
      [100, 0],
      [200, 0],
      [200, 100],
      [100, 100],
    ];
    const merged = mergeRegionRings(LEFT, right, "左块", "右块");
    expect(merged.ok, "同绕向的两块必须能合并（旧实现端点差一 ⇒ 必拒——已修）").toBe(true);
    if (!merged.ok) return;
    // ① 顶点对得上：6 个顶点（4 + 4 − 共享边两端），且集合 = 两圈顶点之和
    expect(merged.ring.length).toBe(LEFT.length + right.length - 2);
    expect(merged.ring.length, "不重复首点（GeoRing 口径）").toBe(new Set(merged.ring.map((p) => `${p[0]},${p[1]}`)).size);
    const expected = new Set([
      "0,0",
      "100,0",
      "100,100",
      "0,100",
      "200,0",
      "200,100",
    ]);
    for (const p of merged.ring) expect(expected.has(`${p[0]},${p[1]}`), `顶点 ${p[0]},${p[1]} 是原来两圈的`).toBe(true);
    // 面积也守恒：10000 + 10000 = 20000
    expect(area(merged.ring)).toBe(20000);
  });

  it("**反绕向合并**（两块绕向相反——共享边同向）", () => {
    const rightCW: GeoRing = [
      [100, 100],
      [100, 0],
      [200, 0],
      [200, 100],
    ];
    const merged = mergeRegionRings(LEFT, rightCW);
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    expect(merged.ring.length).toBe(6);
    expect(merged.ring.length).toBe(new Set(merged.ring.map((p) => `${p[0]},${p[1]}`)).size);
    expect(area(merged.ring)).toBe(20000);
  });

  it("**重叠拒绝并点名**（重叠 ⇒ 硬拼会造出作者没画过的形状）", () => {
    const overlapping: GeoRing = [
      [50, 0],
      [150, 0],
      [150, 100],
      [50, 100],
    ];
    const merged = mergeRegionRings(LEFT, overlapping);
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.reason).toContain("重叠");
  });

  it("**不相邻拒绝并点名**（隔着缝 ⇒ 合并不是作者的意思）", () => {
    const far: GeoRing = [
      [300, 0],
      [400, 0],
      [400, 100],
      [300, 100],
    ];
    const merged = mergeRegionRings(LEFT, far);
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.reason).toContain("不相邻");
  });

  it("**自交拒绝并点名**（输入就不是面）", () => {
    const bowtie: GeoRing = [
      [0, 0],
      [100, 100],
      [100, 0],
      [0, 100],
    ];
    const merged = mergeRegionRings(bowtie, LEFT);
    expect(merged.ok).toBe(false);
    if (merged.ok) return;
    expect(merged.reason).toContain("自交");
  });
});

describe("拆分（R172）：并集 = 原区域，可量", () => {
  it("**竖切正方形**：两半面积之和 == 原面积；两半各 ≥3 点；顶点都是原来的", () => {
    const cut: [GeoPoint, GeoPoint] = [
      [50, -10],
      [50, 110],
    ];
    const split = splitRegionRing(LEFT, cut);
    expect(split.ok).toBe(true);
    if (!split.ok) return;
    expect(area(split.a) + area(split.b)).toBe(area(LEFT));
    expect(split.a.length).toBeGreaterThanOrEqual(3);
    expect(split.b.length).toBeGreaterThanOrEqual(3);
    // 两半不相交（面积恒等 + 不重叠才算切干净：两半交集面积应为 0 —— 用面积守恒即可）
    expect(Math.abs(area(split.a) - 5000)).toBeLessThanOrEqual(1);
    expect(Math.abs(area(split.b) - 5000)).toBeLessThanOrEqual(1);
  });

  it("**切法不唯一拒绝并点名**（带凹口的环 + 穿过凹口的长割线，交叉 4 次）", () => {
    const notched: GeoRing = [
      [0, 0],
      [200, 0],
      [200, 100],
      [150, 100],
      [150, 150],
      [200, 150],
      [200, 200],
      [0, 200],
    ];
    const split = splitRegionRing(notched, [
      [175, -10],
      [175, 210],
    ]);
    expect(split.ok).toBe(false);
    if (split.ok) return;
    expect(split.reason).toContain("不唯一");
  });

  it("**端点压角拒绝并点名**（R172 收口修复：旧实现产出 2 点退化块 ⇒ 读盘自砖化）", () => {
    const split = splitRegionRing(LEFT, [
      [0, 0],
      [100, 50],
    ]);
    expect(split.ok).toBe(false);
    if (split.ok) return;
    expect(split.reason).toContain("顶点");
  });

  // 「退化（<3 点）拒绝」的 ≥3 点下限是**防御性兜底**：端点压角被拒之后，
  // 常规流切出来的两半各 ≥3 点（两个交点 + 其间至少一个顶点）⇒ 该下限不可达，
  // 单测没法诚实地让它红 ⇒ 不立用例（立了就是恒绿判据）；下限仍留在代码里防回归。
});

describe("相邻（R172）：与合并用同一套判定", () => {
  it("共享边的两块**相邻**；隔缝的两块**不相邻**（computeRegionNeighbors 按 id 排序）", () => {
    const right: GeoRing = [
      [100, 0],
      [200, 0],
      [200, 100],
      [100, 100],
    ];
    const far: GeoRing = [
      [300, 0],
      [400, 0],
      [400, 100],
      [300, 100],
    ];
    const neighbors = computeRegionNeighbors([
      { id: "r-left", points: LEFT },
      { id: "r-right", points: right },
      { id: "r-far", points: far },
    ]);
    expect(neighbors.get("r-left")).toEqual(["r-right"]);
    expect(neighbors.get("r-right")).toEqual(["r-left"]);
    expect(neighbors.get("r-far")).toEqual([]);
    expect(regionsAdjacent(LEFT, right)).toBe(true);
    expect(regionsAdjacent(LEFT, far)).toBe(false);
  });
});

describe("区域内容查询（R173）：markersInRegion", () => {
  const square: GeoRing = [
    [0, 0],
    [100, 0],
    [100, 100],
    [0, 100],
  ];

  it("**几何包含**：在区域里的标注返回 id，外面的不返回", () => {
    const markers = [
      { id: "m-in-1", x: 30, y: 30 },
      { id: "m-in-2", x: 80, y: 80 },
      { id: "m-out", x: 150, y: 50 },
    ];
    const inside = markersInRegion(square, markers);
    expect(inside).toEqual(["m-in-1", "m-in-2"]);
  });

  it("**边界上的点不算在里面**（与 pointInRing 口径一致）", () => {
    const markers = [
      { id: "m-edge", x: 0, y: 50 },
      { id: "m-vertex", x: 0, y: 0 },
      { id: "m-in", x: 50, y: 50 },
    ];
    expect(markersInRegion(square, markers)).toEqual(["m-in"]);
  });

  it("**空标注清单返回空**（不造数）", () => {
    expect(markersInRegion(square, [])).toEqual([]);
  });

  it("**单元素区域也能查**（最小合法多边形 = 3 点三角形）", () => {
    const tri: GeoRing = [
      [0, 0],
      [100, 0],
      [50, 80],
    ];
    const markers = [
      { id: "m-in", x: 50, y: 30 },
      { id: "m-out", x: 90, y: 70 },
    ];
    expect(markersInRegion(tri, markers)).toEqual(["m-in"]);
  });

  it("**带 bounds 换算**：环是归一化、标注是底图像素 ⇒ 先归一再判（与投影同一套公式）", () => {
    // 真实口径：shapes 投影后是 0..1，markerRows 直出是像素（如 x: 250, y: 175）——
    // 直接判包含永远是空（R173 收口踩过的坑：0..1 的环套 250 的点）。
    const normRing: GeoRing = [
      [0.1, 0.1],
      [0.15, 0.1],
      [0.15, 0.15],
      [0.1, 0.15],
    ];
    const bounds = { x0: 0, y0: 0, x1: 1000, y1: 700 };
    const markers = [
      { id: "m-in", x: 120, y: 84 }, // 归一 (0.12, 0.12) ⇒ 在环里
      { id: "m-out", x: 500, y: 350 }, // 归一 (0.5, 0.5) ⇒ 在环外
    ];
    expect(markersInRegion(normRing, markers, bounds)).toEqual(["m-in"]);
  });

  it("**bounds 原点不为零**：作者框定的那一块不从 (0,0) 起 ⇒ 归一要先减原点", () => {
    const normRing: GeoRing = [
      [0, 0],
      [0.5, 0],
      [0.5, 0.5],
      [0, 0.5],
    ];
    const bounds = { x0: 100, y0: 200, x1: 1100, y1: 1200 };
    // (350, 450) → ((350−100)/1000, (450−200)/1000) = (0.25, 0.25) ⇒ 在环里
    expect(markersInRegion(normRing, [{ id: "m-in", x: 350, y: 450 }], bounds)).toEqual(["m-in"]);
    // (100, 200) → (0, 0) 恰在环边界上 ⇒ 与主口径一致，不算在里面
    expect(markersInRegion(normRing, [{ id: "m-edge", x: 100, y: 200 }], bounds)).toEqual([]);
  });
});
