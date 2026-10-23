/* SPDX-License-Identifier: Apache-2.0 */

/**
 * 地图缩放与平移的**纯函数**（R145）。
 *
 * 口径（`docs/11` §7.25）：
 * ① **缩放/平移是"看"的状态，不进 map.yaml** —— 作者放大只是为了看清局部，
 *    那不是作品的一部分 ⇒ 不写盘、盘上文件一个字都不许动。
 * ② **看得见的范围永远在作者框定的那一块里**（bounds 之内）⇒ 平移要被钳住，
 *    推出去了就是在看框外的图（那部分作者没框过）。
 * ③ **缩放有上下限**：1 倍 = 整块框（默认），最多 4 倍（再大只见一块像素）。
 * ④ **落点不因缩放而偏**：画面坐标 → 底图像素的换算走 SVG 的 `getScreenCTM()` 逆变换，
 *    缩放只改 viewBox ⇒ 变换矩阵自动跟着变 ⇒ 这一侧不用另写换算。
 *
 * 为什么要单独一个模块：这些**边界**（缩放上限、越界平移、步长）是能算的，
 * 塞在组件里就只能靠人眼看 ⇒ 提成纯函数单独判（`apps/desktop/test/map-view.test.ts`）。
 */

/** 最小缩放：1 倍 = 整块框 */
export const ZOOM_MIN = 1;
/** 最大缩放：再大只看得见一块 */
export const ZOOM_MAX = 4;
/** 一次放大/缩小的步进（1 → 1.25 → 1.5 …） */
export const ZOOM_STEP = 0.25;

/** 把缩放钳在 [1, 4]；算不出来（NaN）就落回下限，不许算出 NaN 的 viewBox */
export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return ZOOM_MIN;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(zoom * 1000) / 1000));
}

/** 放大 / 缩小一步（撞到上下限就停住） */
export function zoomStep(zoom: number, direction: 1 | -1): number {
  return clampZoom(clampZoom(zoom) + direction * ZOOM_STEP);
}

/** 放大几倍 ⇒ 看得见的范围（框内像素） */
export function visibleSize(
  frameW: number,
  frameH: number,
  zoom: number,
): { w: number; h: number } {
  const z = clampZoom(zoom);
  return { w: frameW / z, h: frameH / z };
}

/** 平移钳制：看得见的范围不许越出作者框定的那一块 */
export function clampPan(
  panX: number,
  panY: number,
  frameW: number,
  frameH: number,
  zoom: number,
): { x: number; y: number } {
  const { w, h } = visibleSize(frameW, frameH, zoom);
  const maxX = Math.max(0, frameW - w);
  const maxY = Math.max(0, frameH - h);
  const safeX = Number.isFinite(panX) ? panX : 0;
  const safeY = Number.isFinite(panY) ? panY : 0;
  return {
    x: Math.min(maxX, Math.max(0, safeX)),
    y: Math.min(maxY, Math.max(0, safeY)),
  };
}

/** 方向键一次挪多远：可见范围的一小步（缩得越大步子越大，但至少 1 像素） */
export function panStep(frameW: number, frameH: number, zoom: number): number {
  const { w } = visibleSize(frameW, frameH, zoom);
  return Math.max(1, Math.round(w / 6));
}

/** viewBox（x y 宽 高）：框内坐标 + 缩放 + 平移 */
export function computeViewBox(
  frameW: number,
  frameH: number,
  zoom: number,
  panX: number,
  panY: number,
): string {
  const { w, h } = visibleSize(frameW, frameH, zoom);
  const pan = clampPan(panX, panY, frameW, frameH, zoom);
  return `${String(pan.x)} ${String(pan.y)} ${String(w)} ${String(h)}`;
}
