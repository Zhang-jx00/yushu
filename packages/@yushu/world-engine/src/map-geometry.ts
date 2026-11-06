/* SPDX-License-Identifier: Apache-2.0 */

/**
 * 地图的**面几何**（R172）：相邻判定 / 合并 / 拆分。
 *
 * 口径回源 `docs/research/K-软件工程与产品/K08-时间线与地图UI.md` §5 的图层类型
 * （`type: region`）：K08 给了**图层类型**但没给几何 ⇒ 这一段的几何由本项目定，并写进 docs/11。
 *
 * **为什么单独一个模块**：R151 已经立过一条纪律 ——「**几何规则只有一份**（引擎读盘与主进程写盘共用同一套判定）」。
 * 这一轮把它从"洞的校验"扩到"区域之间的关系"：
 * - **读**的那一侧：地图载荷里的**相邻判定**（哪些区域挨着哪些）；
 * - **写**的那一侧：**合并**（两块地并成一块）与**拆分**（一块地切成两块）。
 * 两侧走的是**同一个模块里的同一批函数** ⇒ 界面上说"这两个区域相邻"、写盘时按"相邻"合并，
 * 说的与做的是同一件事（两处各写一遍 ⇒ 两遍会漂 ⇒ 迟早出现"界面说相邻、合并说不能合"）。
 *
 * 纯函数、零 fs、不读墙钟、不落盘、不改真源。
 */

/** 一个点（底图像素） */
export type GeoPoint = [number, number];

/** 一圈顶点（闭合多边形；不重复首点） */
export type GeoRing = GeoPoint[];

/** 两条线段是否**真正**相交（只碰个端点不算） */
export function segmentsCross(
  a1: GeoPoint,
  a2: GeoPoint,
  b1: GeoPoint,
  b2: GeoPoint,
): boolean {
  const d = (a2[0] - a1[0]) * (b2[1] - b1[1]) - (a2[1] - a1[1]) * (b2[0] - b1[0]);
  if (Math.abs(d) < 1e-9) return false;
  const t = ((b1[0] - a1[0]) * (b2[1] - a1[1]) - (b1[1] - a1[1]) * (b2[0] - a1[0])) / d;
  const u = ((b1[0] - a1[0]) * (a2[1] - a1[1]) - (b1[1] - a1[1]) * (a2[0] - a1[0])) / d;
  return t > 1e-9 && t < 1 - 1e-9 && u > 1e-9 && u < 1 - 1e-9;
}

/** 点是否落在某条边**上**（含端点） */
export function pointOnSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  const cross = (x2 - x1) * (py - y1) - (y2 - y1) * (px - x1);
  if (Math.abs(cross) > 1e-9) return false;
  const minX = Math.min(x1, x2) - 1e-9;
  const maxX = Math.max(x1, x2) + 1e-9;
  const minY = Math.min(y1, y2) - 1e-9;
  const maxY = Math.max(y1, y2) + 1e-9;
  return px >= minX && px <= maxX && py >= minY && py <= maxY;
}

/** 点是否落在这圈顶点的**边界**上 */
export function pointOnRing(point: GeoPoint, ring: GeoRing): boolean {
  const [px, py] = point;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i] as GeoPoint;
    const b = ring[(i + 1) % ring.length] as GeoPoint;
    if (pointOnSegment(px, py, a[0], a[1], b[0], b[1])) return true;
  }
  return false;
}

/**
 * 点是否**严格在**多边形内部（射线法）。
 *
 * 边界上的点算**不在**里面 ⇒ 洞的顶点压在外环边界上会被拒（挖出来的形状不唯一）。
 */
export function pointInRing(point: GeoPoint, ring: GeoRing): boolean {
  const [px, py] = point;
  if (pointOnRing(point, ring)) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = (ring[i] as GeoPoint)[0];
    const yi = (ring[i] as GeoPoint)[1];
    const xj = (ring[j] as GeoPoint)[0];
    const yj = (ring[j] as GeoPoint)[1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 两圈顶点的边是否相交 */
export function ringsCross(a: GeoRing, b: GeoRing): boolean {
  for (let i = 0; i < a.length; i += 1) {
    const a1 = a[i] as GeoPoint;
    const a2 = a[(i + 1) % a.length] as GeoPoint;
    for (let j = 0; j < b.length; j += 1) {
      const b1 = b[j] as GeoPoint;
      const b2 = b[(j + 1) % b.length] as GeoPoint;
      if (segmentsCross(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/**
 * **有向面积**（鞋带公式）：正负表示绕向，绝对值是面积。
 *
 * 为什么要有它：合并与拆分的结果**必须可量** —— 合并后面积应当等于原来两块之和，
 * 拆分后两块面积之和应当等于原来那块 ⇒ 这是**几何对不对**的机器判据，
 * 不是"看起来接上了"（顶点接上了但面积不对 = 里面被多算/少算了一块）。
 */
export function ringArea(ring: GeoRing): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i] as GeoPoint;
    const b = ring[(i + 1) % ring.length] as GeoPoint;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum / 2;
}

/** 环是否**自交**（自己的两条边真相交 ⇒ 画出来是个结，不是面） */
export function ringSelfIntersects(ring: GeoRing): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    const a1 = ring[i] as GeoPoint;
    const a2 = ring[(i + 1) % n] as GeoPoint;
    for (let j = i + 1; j < n; j += 1) {
      // 相邻的两条边共享一个端点 ⇒ 不算自交
      if (j === i + 1) continue;
      if (i === 0 && j === n - 1) continue;
      const b1 = ring[j] as GeoPoint;
      const b2 = ring[(j + 1) % n] as GeoPoint;
      if (segmentsCross(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/** 两个环是否**重叠**（边真相交，或一个把另一个包住，或 T 字路口式的部分重叠） */
export function ringsOverlap(a: GeoRing, b: GeoRing): boolean {
  if (ringsCross(a, b)) return true;
  for (const vertex of a) {
    if (pointInRing(vertex, b)) return true;
  }
  for (const vertex of b) {
    if (pointInRing(vertex, a)) return true;
  }
  // **T 字路口式的部分重叠**：两圈的所有顶点都压在对方**边界**上（没有一个严格在内部），
  // 边与边也只有端点相碰 ⇒ 顶点法与严格交叉法都检不出，但两块确实叠着
  // （实例：错位一半的两个正方形）⇒ 用**边中点**抽样：中点严格落进对方内部就是叠着
  // （R172 收口修复——旧实现检不出，只会报"不相邻"；fail-safe 但口径错了）。
  // 共享边的两块不受影响：共享边的边中点压在对方边界上，pointInRing（严格内部）= false。
  const midpoints = (ring: GeoRing): GeoPoint[] =>
    ring.map((p, i) => {
      const q = ring[(i + 1) % ring.length] as GeoPoint;
      return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as GeoPoint;
    });
  for (const m of midpoints(a)) {
    if (pointInRing(m, b)) return true;
  }
  for (const m of midpoints(b)) {
    if (pointInRing(m, a)) return true;
  }
  return false;
}

/** 两个环共享的那条边（在两个环里的下标） */
export interface SharedEdge {
  /** 在第一个环里的边下标（a[i] → a[i+1]） */
  aIndex: number;
  /** 在第二个环里的边下标（b[j] → b[j+1]） */
  bIndex: number;
}

function samePoint(a: GeoPoint, b: GeoPoint): boolean {
  return Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
}

/**
 * 两个环是否**共享一条边**（端点相同、方向可反）。
 *
 * 共享边是"两块地挨在一起"的几何事实 ⇒ 合并就是沿它把两圈拼成一圈。
 */
export function findSharedEdge(a: GeoRing, b: GeoRing): SharedEdge | null {
  for (let i = 0; i < a.length; i += 1) {
    const a1 = a[i] as GeoPoint;
    const a2 = a[(i + 1) % a.length] as GeoPoint;
    for (let j = 0; j < b.length; j += 1) {
      const b1 = b[j] as GeoPoint;
      const b2 = b[(j + 1) % b.length] as GeoPoint;
      if ((samePoint(a1, b1) && samePoint(a2, b2)) || (samePoint(a1, b2) && samePoint(a2, b1))) {
        return { aIndex: i, bIndex: j };
      }
    }
  }
  return null;
}

/**
 * 两个区域是否**相邻**（共享一条边，或互相重叠）。
 *
 * 口径：相邻 = "两块地挨着" ⇒ 能合并（重叠的不能合并，见 `mergeRegionRings`）。
 */
export function regionsAdjacent(a: GeoRing, b: GeoRing): boolean {
  if (findSharedEdge(a, b) !== null) return true;
  return ringsOverlap(a, b);
}

/** 合并的结果：成功给那一圈，失败给**点名**的理由 */
export type MergeResult = { ok: true; ring: GeoRing } | { ok: false; reason: string };

/**
 * **合并两个区域**：沿它们共享的那条边，把两圈拼成一圈。
 *
 * 三条规矩：
 * ① **只认共享边**（不认"离得近"）⇒ 合并出来的圈**顶点全是原来两圈的顶点**
 *    ⇒ 机器判据「合并后区域的顶点对得上」是可量的（集合相等，不是"看起来接上了"）；
 * ② **重叠的一律拒绝**（重叠 ⇒ 并集不是一条简单的圈 ⇒ 硬拼会造出一个作者没画过的形状）⇒ **点名**；
 * ③ **不相邻的拒绝**（两块地中间隔着一条缝 ⇒ 合并不是作者的意思）⇒ **点名**。
 */
export function mergeRegionRings(a: GeoRing, b: GeoRing, labelA = "第一个区域", labelB = "第二个区域"): MergeResult {
  if (a.length < 3 || b.length < 3) {
    return { ok: false, reason: `${labelA} 与 ${labelB} 至少要各有 3 个点` };
  }
  if (ringSelfIntersects(a)) {
    return { ok: false, reason: `${labelA} 自己的边交叉了（自交 ⇒ 不是一个面，合并不了）` };
  }
  if (ringSelfIntersects(b)) {
    return { ok: false, reason: `${labelB} 自己的边交叉了（自交 ⇒ 不是一个面，合并不了）` };
  }
  if (ringsOverlap(a, b)) {
    return { ok: false, reason: `${labelA} 与 ${labelB} 重叠（重叠的两块地并不成一个简单的圈 ⇒ 请先改边界）` };
  }
  const shared = findSharedEdge(a, b);
  if (shared === null) {
    return { ok: false, reason: `${labelA} 与 ${labelB} 不相邻（没有共享的边 ⇒ 合并不是作者的意思）` };
  }
  const { aIndex, bIndex } = shared;
  // A：从共享边的**终点**绕一圈回到**起点**（这一圈不含共享边）
  const pathA: GeoRing = [];
  for (let k = 0; k < a.length; k += 1) {
    pathA.push(a[(aIndex + 1 + k) % a.length] as GeoPoint);
  }
  // B：从共享边的一端绕到另一端，**跳过共享边的两个端点**——它们已在 A 的弧里
  //    （重复就是 GeoRing 口径 violation：首尾同点 / 重复顶点）。两种绕向各走各的弧：
  //    · B 的边与 A 同向（b[bIndex] == a[aIndex]）：B 沿反方向走；
  //    · B 的边与 A 反向（b[bIndex] == a[aIndex+1]，即两块**同绕向**——手工按同方向画的
  //      多边形的最常见情形）：B 沿正方向走。
  //    R172 收口修复：旧实现两种弧的端点都差一——同向多收了 pathA 的首点（ring 首尾同点，
  //    违反 GeoRing 口径），反向的首尾都对不上（检查必然失败 ⇒ 同绕向合并必被拒）。
  const bStart = b[bIndex] as GeoPoint;
  const pathB: GeoRing = [];
  if (samePoint(bStart, a[aIndex] as GeoPoint)) {
    for (let k = b.length - 1; k >= 2; k -= 1) {
      pathB.push(b[(bIndex + k) % b.length] as GeoPoint);
    }
  } else {
    for (let k = 2; k <= b.length - 1; k += 1) {
      pathB.push(b[(bIndex + k) % b.length] as GeoPoint);
    }
  }
  const ring = [...pathA, ...pathB];
  // 拼出来的圈必须还是一圈：顶点数 = 两圈顶点数之和 − 共享边的两个端点；且不自交
  if (ring.length !== a.length + b.length - 2) {
    return { ok: false, reason: `${labelA} 与 ${labelB} 的共享边对不上（拼不成一圈）` };
  }
  if (ringSelfIntersects(ring)) {
    return { ok: false, reason: `${labelA} 与 ${labelB} 拼出来的圈自交（合并不是作者的意思）` };
  }
  return { ok: true, ring };
}

/** 拆分的结果：成功给两半，失败给**点名**的理由 */
export type SplitResult = { ok: true; a: GeoRing; b: GeoRing } | { ok: false; reason: string };

/**
 * **沿一条割线把一个区域切成两半**。
 *
 * 判据（都可量）：
 * ① 割线与边界**恰好交叉两次**（进一次、出一次）⇒ 切法唯一；
 *    交叉多于两次（非凸区域 + 一条长割线）⇒ **拒绝并点名**（切法不唯一）；
 * ② 割线**不许穿过区域的角**（穿过角 ⇒ 分成哪几块不唯一）⇒ **拒绝并点名**；
 * ③ 两半的**面积之和 == 原来那块的面积**（可量）⇒ 切出来的两块真的是原来那块分的。
 */
export function splitRegionRing(ring: GeoRing, cut: [GeoPoint, GeoPoint], label = "区域"): SplitResult {
  if (ring.length < 3) return { ok: false, reason: `${label} 至少要 3 个点` };
  if (ringSelfIntersects(ring)) {
    return { ok: false, reason: `${label} 自己的边交叉了（自交 ⇒ 不是一个面，切不了）` };
  }
  const [p, q] = cut;
  if (samePoint(p, q)) return { ok: false, reason: "割线是空的（两个点一样）" };
  // 割线**端点落在顶点上** ⇒ 那个角被相邻两条边各记一次交点，切分不唯一。
  // R172 收口修复：旧实现会漏过这个口子并产出 2 点的退化块 ⇒ 下次读盘地图文件直接解析失败
  //（自我砖化）⇒ 点名拒绝。
  for (const vertex of ring) {
    if (samePoint(p, vertex) || samePoint(q, vertex)) {
      return { ok: false, reason: `${label} 的割线端点落在顶点上（分成哪几块不唯一 ⇒ 请挪动割线端点）` };
    }
  }
  // 割线与边界的交叉点（只认**边的内部**交叉；穿过角 ⇒ 不唯一 ⇒ 拒绝）
  const hits: { index: number; point: GeoPoint }[] = [];
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i] as GeoPoint;
    const b = ring[(i + 1) % ring.length] as GeoPoint;
    if (segmentsCross(p, q, a, b)) {
      const hit = segmentIntersection(p, q, a, b);
      if (hit === null) continue;
      hits.push({ index: i, point: hit });
      continue;
    }
    // 割线的端点正好落在边上 ⇒ 那也是一个交点
    if (pointOnSegment(p[0], p[1], a[0], a[1], b[0], b[1])) hits.push({ index: i, point: p });
    else if (pointOnSegment(q[0], q[1], a[0], a[1], b[0], b[1])) hits.push({ index: i, point: q });
  }
  if (hits.length < 2) {
    return { ok: false, reason: `割线没有把 ${label} 切开（要与边界交叉两次：进一次、出一次）` };
  }
  if (hits.length > 2) {
    return { ok: false, reason: `割线与 ${label} 的边界交叉了 ${String(hits.length)} 次（多于两次 ⇒ 切法不唯一）` };
  }
  const first = hits[0] as { index: number; point: GeoPoint };
  const second = hits[1] as { index: number; point: GeoPoint };
  const n = ring.length;
  // 两段边界弧：从第一个交点顺着边界走到第二个，再从第二个走回第一个
  const arcA: GeoRing = [first.point];
  for (let k = 1; k <= n; k += 1) {
    const vertex = ring[(first.index + k) % n] as GeoPoint;
    arcA.push(vertex);
    if (k === ((second.index - first.index + n) % n)) break;
  }
  arcA.push(second.point);
  const arcB: GeoRing = [second.point];
  for (let k = 1; k <= n; k += 1) {
    const vertex = ring[(second.index + k) % n] as GeoPoint;
    arcB.push(vertex);
    if (k === ((first.index - second.index + n) % n)) break;
  }
  arcB.push(first.point);
  // 两半（各自的闭合边是那条割线 ⇒ 不重复首点）
  const partA = arcA;
  const partB = arcB;
  // **退化下限**：切出来的一块不足 3 个点 ⇒ 不是一个面（map.yaml 读盘要求区域 ≥3 点，
  //    写一块退化的下去 = 下次读盘直接解析失败——自我砖化）⇒ 点名拒绝。
  if (partA.length < 3 || partB.length < 3) {
    return { ok: false, reason: `${label} 切出来有一块不足 3 个点（退化 ⇒ 已拒绝）` };
  }
  const areaOriginal = Math.abs(ringArea(ring));
  const areaParts = Math.abs(ringArea(partA)) + Math.abs(ringArea(partB));
  if (Math.abs(areaParts - areaOriginal) > 1e-6) {
    return {
      ok: false,
      reason: `割线切出来的两块面积之和不等于 ${label} 的面积（切法不对 ⇒ 已拒绝）`,
    };
  }
  if (ringSelfIntersects(partA) || ringSelfIntersects(partB)) {
    return { ok: false, reason: `割线切出来的块自交（切法不对 ⇒ 已拒绝）` };
  }
  return { ok: true, a: partA, b: partB };
}

/** 两条线段的交点（已知它们真相交） */
function segmentIntersection(a1: GeoPoint, a2: GeoPoint, b1: GeoPoint, b2: GeoPoint): GeoPoint | null {
  const d = (a2[0] - a1[0]) * (b2[1] - b1[1]) - (a2[1] - a1[1]) * (b2[0] - b1[0]);
  if (Math.abs(d) < 1e-9) return null;
  const t = ((b1[0] - a1[0]) * (b2[1] - b1[1]) - (b1[1] - a1[1]) * (b2[0] - b1[0])) / d;
  return [a1[0] + t * (a2[0] - a1[0]), a1[1] + t * (a2[1] - a1[1])];
}

/**
 * **相邻判定**（R172）：哪些区域挨着哪些。
 *
 * 口径：**相邻 = 共享一条边，或互相重叠**（regionsAdjacent）
 * ⇒ 与写盘时"能不能合并"用的是**同一套判定**（同一个函数）
 * ⇒ 界面上说"这两个相邻"、点合并时若被拒，作者看到的与工具做的是同一件事。
 *
 * 纯函数：给一组区域（id + 外环），给出 id → 相邻 id 清单（**按 id 排序** ⇒ 同输入同输出）。
 */
export function computeRegionNeighbors(
  regions: { id: string; points: GeoPoint[] }[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const region of regions) out.set(region.id, []);
  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      const a = regions[i] as { id: string; points: GeoPoint[] };
      const b = regions[j] as { id: string; points: GeoPoint[] };
      if (!regionsAdjacent(a.points, b.points)) continue;
      (out.get(a.id) as string[]).push(b.id);
      (out.get(b.id) as string[]).push(a.id);
    }
  }
  for (const [id, list] of out) {
    out.set(id, [...list].sort());
  }
  return out;
}
