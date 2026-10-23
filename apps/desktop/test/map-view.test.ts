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
  zoomStep,
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
