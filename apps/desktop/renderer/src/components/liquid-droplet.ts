/* SPDX-License-Identifier: Apache-2.0 */

/**
 * **液态玻璃水滴的纯几何与时序**（R193）。
 *
 * 为什么是纯函数：拉丝颈缩的 path 与各相位进度要在**单测里验红**
 * （预演只能采样到「有水珠/无水珠」，验不了几何正确性）。
 *
 * 形变叙事（对应交互时序）：
 * 点击按钮 ⇒ 按钮鼓包鼓起 ⇒ 按钮与水珠之间生成**连续拉丝颈缩**连接体
 * （两条对称三次贝塞尔，颈宽随进度收细）⇒ 颈宽到阈值 ⇒ **断开**（连接体消失，
 * 返回 null）⇒ 水珠带惯性飞行并缓慢膨胀 ⇒ 落到目标锚点 ⇒ 曲面摊开成面板。
 * 关闭是同一状态机反向回放（融合时颈缩再现一瞬）。
 *
 * 曲线口径：全部只动 `transform` 与 SVG `d`（合成层友好，60fps）；
 * 时长一律由调用方从 `:root` 动效令牌读（`--motion-enter` / `--motion-reveal` /
 * `--motion-exit`），本模块**不持有任何毫秒值**——契约「时长只在 :root 出现」。
 */

/** 一个圆形粒子（按钮鼓包 / 水珠共用同一形状语言） */
export interface LiquidCircle {
  x: number;
  y: number;
  r: number;
}

/**
 * 两圆之间的**拉丝颈缩连接体** path（无闭合圆——圆本体由调用方另画）。
 *
 * @param a 源圆（按钮鼓包）
 * @param b 目标圆（水珠）
 * @param neck 颈宽系数 0..1（1 = 最宽的连接体，0 = 刚断开）
 * @returns SVG path 的 `d` 字符串；**两圆相离过远（已断开）或重叠过深（还在融合）时返回 null**
 *          ——调用方据此决定画不画连接体（null = 跳过，不要画空 path）。
 */
export function metaballBridge(a: LiquidCircle, b: LiquidCircle, neck: number): string | null {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) return null; // 完全重合：没有"之间"，连接体不存在
  const nx = dx / dist;
  const ny = dy / dist;
  // 颈部宽：两圆内侧缘的距离；为负说明圆仍重叠（融合中，不画桥）
  const gap = dist - a.r - b.r;
  if (gap < 0) return null;
  // 断开阈值：间隙超过最大颈长的 1.4 倍 ⇒ 拉断了
  const maxNeck = (a.r + b.r) * 1.1 * neck;
  if (gap > maxNeck * 1.4 || neck <= 0) return null;

  // 切点半径缩进：颈越细，桥在圆上的附着弧越靠"正面"
  const shrink = 0.86 + 0.14 * (1 - Math.min(1, gap / Math.max(maxNeck, 1)));
  const ra = a.r * shrink;
  const rb = b.r * shrink;

  // 桥在两圆上的附着点：沿连线方向再向两侧偏一个随颈宽变化的张角
  const spread = Math.min(1, maxNeck / Math.max(gap, 1)) * (Math.PI / 5.2);
  const attachA = Math.atan2(-ny, -nx); // 从 b 指向 a 的方向角
  const attachB = Math.atan2(ny, nx);
  const a1 = { x: a.x + Math.cos(attachA - spread) * ra, y: a.y + Math.sin(attachA - spread) * ra };
  const a2 = { x: a.x + Math.cos(attachA + spread) * ra, y: a.y + Math.sin(attachA + spread) * ra };
  const b1 = { x: b.x + Math.cos(attachB + spread) * rb, y: b.y + Math.sin(attachB + spread) * rb };
  const b2 = { x: b.x + Math.cos(attachB - spread) * rb, y: b.y + Math.sin(attachB - spread) * rb };

  // 中点收腰：控制点把两条贝塞尔往连线上压，形成颈缩
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const waist = 0.42 + 0.3 * neck;
  const cA1 = { x: a1.x + (mx - a1.x) * waist, y: a1.y + (my - a1.y) * waist };
  const cB1 = { x: b1.x + (mx - b1.x) * waist, y: b1.y + (my - b1.y) * waist };
  const cB2 = { x: b2.x + (mx - b2.x) * waist, y: b2.y + (my - b2.y) * waist };
  const cA2 = { x: a2.x + (mx - a2.x) * waist, y: a2.y + (my - a2.y) * waist };

  const f = (v: { x: number; y: number }): string => `${v.x.toFixed(2)} ${v.y.toFixed(2)}`;
  return (
    `M ${f(a1)} ` +
    `C ${f(cA1)} ${f(cB1)} ${f(b1)} ` +
    `L ${f(b2)} ` +
    `C ${f(cB2)} ${f(cA2)} ${f(a2)} Z`
  );
}

/** 平滑阶梯（smoothstep）：边缘自然，无跳变 */
export function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** 惯性飞行曲线：快出缓收带轻微过冲（水珠脱离按钮后的手感） */
export function flyEase(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  // 先冲过头 4%，再收回来——「带惯性」的观感
  const overshoot = 1 + 0.04 * Math.sin(Math.min(1, x * 1.15) * Math.PI);
  return (1 - Math.pow(1 - x, 2.4)) * overshoot;
}

/** 时序相位（拆成纯函数供单测）：split 全程的各量 */
export interface LiquidPhase {
  /** 颈宽系数 0..1（0 = 已断开 / 尚未长出） */
  neck: number;
  /** 水珠位移进度 0..1（flyEase） */
  travel: number;
  /** 水珠缩放（相对按钮半径；飞行途中缓慢膨胀） */
  scale: number;
  /** 是否已断开（连接体不画） */
  broken: boolean;
}

/** 断裂阈值：进度到达这里颈宽归零 */
export const BREAK_AT = 0.62;

/** 拉丝段的时序分解：t ∈ [0,1] ⇒ 颈宽 / 位移 / 膨胀 / 是否断开 */
export function splitPhase(t: number): LiquidPhase {
  const x = Math.min(1, Math.max(0, t));
  const travelT = smoothstep(Math.min(1, x / BREAK_AT));
  const neck = x < BREAK_AT ? 1 - smoothstep(x / BREAK_AT) : 0;
  // 膨胀：拉丝期先收（从按钮里"挤"出来时比按钮小），断开后进入飞行段再膨胀
  const scale = 0.42 + 0.2 * travelT;
  return { neck, travel: travelT, scale, broken: x >= BREAK_AT };
}

/** 飞行段时序：t ∈ [0,1] ⇒ 位移与继续膨胀（到面板摊开前的大小） */
export function flyPhase(t: number): { travel: number; scale: number } {
  const x = Math.min(1, Math.max(0, t));
  return { travel: flyEase(x), scale: 0.62 + 0.5 * smoothstep(x) };
}
