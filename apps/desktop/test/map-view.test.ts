/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
  clampPan,
  clampZoom,
  computeViewBox,
  panStep,
  visibleSize,
  zoomAtPoint,
  zoomStep,
  shapePathData,
} from "../renderer/src/components/map-view.js";

/**
 * 地图缩放与平移的**纯函数**判据（R145）。
 *
 * 为什么要单独一个模块：缩放/平移是**视图**状态（"看"的状态，不进 map.yaml），
 * 而它的全部难点都在**边界**上：
 * ① 放大多少算过头（缩得太小看不清、太大只看得见一块）；
 * ② 平移能不能把画面推出作者框定的那一块（推出去了就是在看框外的图 ⇒ 越界）；
 * ③ 放大之后**落点还准不准**（这一条在预演里验：step107 放大+平移之后点一下，
 *    落点仍要落在点击处 —— 靠 SVG 的 `getScreenCTM()` 逆变换，判据在这一侧只管 viewBox）。
 *
 * 这些都是**能算的** ⇒ 提成纯函数单独判，而不是塞进组件里靠人眼看。
 *
 * 口径见 `docs/11` §7.25。
 */

describe("地图缩放与平移（R145）", () => {
  it("缩放有上下限（放大要看清，但不至于只剩一个像素）", () => {
    expect(ZOOM_MIN).toBe(1);
    expect(ZOOM_MAX).toBe(4);
    expect(ZOOM_STEP).toBeGreaterThan(0);
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(1.25)).toBe(1.25);
    expect(clampZoom(9)).toBe(4);
    expect(clampZoom(Number.NaN), "NaN 要落回下限，不许算出 NaN 的 viewBox").toBe(1);
  });

  it("放大/缩小是一步步走的（步进固定，且撞到上限就停住）", () => {
    expect(zoomStep(1, 1)).toBe(1 + ZOOM_STEP);
    expect(zoomStep(1, -1)).toBe(1);
    expect(zoomStep(ZOOM_MAX, 1), "到上限了还往上走").toBe(ZOOM_MAX);
    expect(zoomStep(ZOOM_MIN, -1), "到下限了还往下走").toBe(ZOOM_MIN);
  });

  it("放大几倍 ⇒ 看得见的范围就小几倍（viewBox 的宽高按倍数缩）", () => {
    const size1 = visibleSize(1000, 700, 1);
    expect(size1.w).toBe(1000);
    expect(size1.h).toBe(700);
    const size2 = visibleSize(1000, 700, 2);
    expect(size2.w).toBe(500);
    expect(size2.h).toBe(350);
  });

  it("平移**不能把画面推出作者框定的那一块**（框外是没框过的图）", () => {
    // 没放大时框就是全部 ⇒ 没有可平移的余地
    const at1 = clampPan(300, 200, 1000, 700, 1);
    expect(at1.x).toBe(0);
    expect(at1.y).toBe(0);
    // 放大两倍 ⇒ 可见 500×350 ⇒ 最多能平到 (500, 350)
    const at2 = clampPan(900, 900, 1000, 700, 2);
    expect(at2.x).toBe(500);
    expect(at2.y).toBe(350);
    // 往负的方向也不行
    const neg = clampPan(-100, -50, 1000, 700, 2);
    expect(neg.x).toBe(0);
    expect(neg.y).toBe(0);
  });

  it("方向键一次挪多远：按可见范围的一小步（放得越大看得越窄 ⇒ 步子越小，才好精细挪）", () => {
    const step1 = panStep(1000, 700, 1);
    const step2 = panStep(1000, 700, 2);
    expect(step1).toBeGreaterThan(0);
    expect(step2).toBeGreaterThanOrEqual(1);
    expect(step2, "放大后可见范围更窄 ⇒ 一步挪得更少").toBeLessThanOrEqual(step1);
    expect(panStep(10, 10, 1), "太小也要能挪动一下").toBeGreaterThanOrEqual(1);
  });

  it("viewBox 由「框内尺寸 + 缩放 + 平移」算出（没放大时就是整块框）", () => {
    expect(computeViewBox(1000, 700, 1, 0, 0)).toBe("0 0 1000 700");
    expect(computeViewBox(1000, 700, 2, 100, 50)).toBe("100 50 500 350");
    // 越界的平移会被钳回去（viewBox 里不会出现负数或超出框的范围）
    expect(computeViewBox(1000, 700, 2, 9999, -20)).toBe("500 0 500 350");
  });

  it("viewBox 是**四个数**（x y 宽 高）—— 少一个就画不出来", () => {
    const parts = computeViewBox(1000, 700, 1.5, 10, 20).split(" ");
    expect(parts).toHaveLength(4);
    for (const part of parts) {
      expect(Number.isFinite(Number(part)), `viewBox 里有非数：${part}`).toBe(true);
    }
  });
});

/**
 * R148：**滚轮缩放以指针为锚点** —— 滚轮该"指针下的那一点不动"。
 *
 * 为什么这是判据而不是感觉：滚轮放大若一律以**画布中心**缩放，作者想看的是
 * 指针指着的那一块 ⇒ 手感是"越放大越跑偏"。⇒ 判据量的是**锚点的相对位置**
 * （锚点内容坐标在可见范围里的位置）在缩放前后**不变**。
 *
 * **边界优先**：锚点贴在可见范围边缘、或缩到 1 倍（可见范围 = 整块 ⇒ 没有平移余地）时，
 * "锚点不动"与"不许出框"**不能同时满足** ⇒ 以边界优先，锚点允许移动。
 */
describe("滚轮缩放以指针为锚点（R148）", () => {
  const FRAME_W = 1000;
  const FRAME_H = 700;

  /** 锚点在可见范围里的相对位置（0..1） */
  const relative = (
    anchorX: number,
    anchorY: number,
    panX: number,
    panY: number,
    zoom: number,
  ): { rx: number; ry: number } => {
    const { w, h } = visibleSize(FRAME_W, FRAME_H, zoom);
    return { rx: (anchorX - panX) / w, ry: (anchorY - panY) / h };
  };

  it("放大时，**指针下的那一点不动**（锚点的相对位置不变）", () => {
    const anchor = { x: 300, y: 200 };
    const before = { zoom: 1, pan: { x: 0, y: 0 } };
    const after = zoomAtPoint(
      FRAME_W,
      FRAME_H,
      before.zoom,
      before.pan.x,
      before.pan.y,
      anchor.x,
      anchor.y,
      1.5,
    );
    expect(after.zoom).toBeGreaterThan(before.zoom);
    const r0 = relative(anchor.x, anchor.y, before.pan.x, before.pan.y, before.zoom);
    const r1 = relative(anchor.x, anchor.y, after.pan.x, after.pan.y, after.zoom);
    expect(r1.rx).toBeCloseTo(r0.rx, 6);
    expect(r1.ry).toBeCloseTo(r0.ry, 6);
  });

  it("缩小时同样以指针为锚点（锚点放在**可见范围内部**）", () => {
    // 锚点放在可见范围内部：贴边时会与"不许出框"打架（见下一条），缩到 1 倍时也一样
    // （可见范围 = 整块 ⇒ 没有平移余地 ⇒ 锚点必然移动）⇒ 这里缩到 1.6 倍。
    const anchor = { x: 400, y: 300 };
    const before = { zoom: 2, pan: { x: 250, y: 175 } };
    const after = zoomAtPoint(
      FRAME_W,
      FRAME_H,
      before.zoom,
      before.pan.x,
      before.pan.y,
      anchor.x,
      anchor.y,
      0.8,
    );
    expect(after.zoom).toBeLessThan(before.zoom);
    const r0 = relative(anchor.x, anchor.y, before.pan.x, before.pan.y, before.zoom);
    const r1 = relative(anchor.x, anchor.y, after.pan.x, after.pan.y, after.zoom);
    expect(r1.rx).toBeCloseTo(r0.rx, 6);
    expect(r1.ry).toBeCloseTo(r0.ry, 6);
  });

  it("锚点贴在可见范围边缘时，**边界优先**（不许为了锚点不动而把画面推出框外）", () => {
    const anchor = { x: 700, y: 500 };
    const before = { zoom: 2, pan: { x: 200, y: 100 } };
    const after = zoomAtPoint(
      FRAME_W,
      FRAME_H,
      before.zoom,
      before.pan.x,
      before.pan.y,
      anchor.x,
      anchor.y,
      0.5,
    );
    const { w, h } = visibleSize(FRAME_W, FRAME_H, after.zoom);
    expect(after.pan.x).toBeGreaterThanOrEqual(0);
    expect(after.pan.y).toBeGreaterThanOrEqual(0);
    expect(after.pan.x + w).toBeLessThanOrEqual(FRAME_W + 0.001);
    expect(after.pan.y + h).toBeLessThanOrEqual(FRAME_H + 0.001);
  });

  it("到上限就停住（不会越界放大）", () => {
    const atMax = zoomAtPoint(FRAME_W, FRAME_H, ZOOM_MAX, 0, 0, 500, 350, 1.5);
    expect(atMax.zoom).toBe(ZOOM_MAX);
    const atMin = zoomAtPoint(FRAME_W, FRAME_H, 1, 0, 0, 500, 350, 0.5);
    expect(atMin.zoom).toBe(1);
  });

  it("滚完之后**看得见的范围仍然在框内**（平移要重新钳一遍）", () => {
    const after = zoomAtPoint(FRAME_W, FRAME_H, 1, 0, 0, 990, 690, 1.5);
    const { w, h } = visibleSize(FRAME_W, FRAME_H, after.zoom);
    expect(after.pan.x).toBeGreaterThanOrEqual(0);
    expect(after.pan.y).toBeGreaterThanOrEqual(0);
    expect(after.pan.x + w).toBeLessThanOrEqual(FRAME_W + 0.001);
    expect(after.pan.y + h).toBeLessThanOrEqual(FRAME_H + 0.001);
  });
});

/**
 * **区域路径**（R151）：外环 + 洞 ⇒ 一条路径。
 *
 * 为什么要有这个函数：区域从一个环变成"外环 + 若干洞"⇒ `<polygon>` 画不了（它只能一个环）
 * ⇒ 改用 `<path>` + `fill-rule="evenodd"`（洞落在偶数层 ⇒ 不填 ⇒ 那块是空的）。
 *
 * 判据盯两件事：① 洞**必须真的多出一段**（少一段 ⇒ 洞没画出来，看起来还是一整块地）；
 * ② 空的外环**不许**画出一条空路径（浏览器会警告，作者还看见一条莫名其妙的线）。
 */
describe("区域路径（R151）：外环 + 洞", () => {
  it("没有洞 ⇒ 只有一段 M…Z", () => {
    const d = shapePathData([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ]);
    expect(d).toBe("M 0,0 L 10,0 L 10,10 Z");
  });

  it("有一个洞 ⇒ **两段**（洞靠 evenodd 挖掉；少一段就等于没挖）", () => {
    const d = shapePathData(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      [
        [
          { x: 2, y: 2 },
          { x: 4, y: 2 },
          { x: 3, y: 4 },
        ],
      ],
    );
    expect(d).toBe("M 0,0 L 10,0 L 10,10 L 0,10 Z M 2,2 L 4,2 L 3,4 Z");
    // 两段 ⇒ 两个闭合
    expect(d.split("Z").length - 1).toBe(2);
  });

  it("两个洞 ⇒ 三段", () => {
    const d = shapePathData(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      [
        [
          { x: 1, y: 1 },
          { x: 2, y: 1 },
          { x: 1, y: 2 },
        ],
        [
          { x: 5, y: 5 },
          { x: 6, y: 5 },
          { x: 5, y: 6 },
        ],
      ],
    );
    expect(d.split("Z").length - 1).toBe(3);
  });

  it("空的外环 ⇒ 空串（不画空路径）", () => {
    expect(shapePathData([])).toBe("");
    expect(shapePathData([], [[{ x: 1, y: 1 }]])).toBe("");
  });
});
