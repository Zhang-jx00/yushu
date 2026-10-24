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

/**
 * **以某个锚点为心的缩放**（R148：滚轮缩放）。
 *
 * 滚轮该有的手感是「**指针下的那一点不动**」：作者指着哪一块，就放大哪一块。
 * 若一律以画布中心缩放，放大时画面会往别处跑 ⇒ 越放大越看不对地方。
 *
 * 做法：记下锚点在**可见范围里的相对位置**（0..1），缩放后按同样的相对位置
 * 反解平移 ⇒ 锚点下的内容坐标保持不变。
 *
 * @param anchorContentX 锚点的**内容坐标**（框内像素，不是屏幕坐标）
 * @param factor 缩放倍数（>1 放大，<1 缩小）
 */
export function zoomAtPoint(
  frameW: number,
  frameH: number,
  zoom: number,
  panX: number,
  panY: number,
  anchorContentX: number,
  anchorContentY: number,
  factor: number,
): { zoom: number; pan: { x: number; y: number } } {
  const nextZoom = clampZoom(zoom * factor);
  if (nextZoom === zoom) return { zoom, pan: { x: panX, y: panY } };
  const before = visibleSize(frameW, frameH, zoom);
  const after = visibleSize(frameW, frameH, nextZoom);
  // 锚点在可见范围里的相对位置（缩放前后要一样）
  const rx = (anchorContentX - panX) / before.w;
  const ry = (anchorContentY - panY) / before.h;
  const pan = clampPan(
    anchorContentX - rx * after.w,
    anchorContentY - ry * after.h,
    frameW,
    frameH,
    nextZoom,
  );
  return { zoom: nextZoom, pan };
}

/**
 * 区域（含洞）⇒ SVG 路径的 `d`（R151）。
 *
 * 为什么用 `path` 而不是 `polygon`：**polygon 只能一个环**。
 * 有洞的区域要画成「外环 + 若干内环」，而且内环要**挖掉**（不是再画一块底色）⇒
 * 靠 `fill-rule="evenodd"`：内环落在偶数层 ⇒ 不填 ⇒ 那块就是空的。
 *
 * 坐标是**画面坐标**（渲染层已经乘过宽高）⇒ 这里只负责把环拼成字符串。
 * 空的外环返回空串（画不出东西就别画一条空路径）。
 */
export function shapePathData(
  outer: { x: number; y: number }[],
  holes: { x: number; y: number }[][] = [],
): string {
  // 没有外环就**什么都没有**（洞是"从外环里挖掉的"，没有外环的洞画不出来 ⇒ 不画）
  if (outer.length === 0) return "";
  const ring = (points: { x: number; y: number }[]): string => {
    if (points.length === 0) return "";
    const head = points[0] as { x: number; y: number };
    const rest = points.slice(1).map((p) => `${String(p.x)},${String(p.y)}`).join(" L ");
    return `M ${String(head.x)},${String(head.y)}${rest === "" ? "" : ` L ${rest}`} Z`;
  };
  return [ring(outer), ...holes.map(ring)].filter((part) => part !== "").join(" ");
}
