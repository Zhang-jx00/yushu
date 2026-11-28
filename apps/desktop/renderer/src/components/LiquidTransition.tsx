/* SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useRef } from "react";
import {
  BREAK_AT,
  flyPhase,
  metaballBridge,
  splitPhase,
  type LiquidCircle,
} from "./liquid-droplet.js";

/**
 * **液态玻璃水滴过渡层**（R193）：按钮与面板之间的「拉丝颈缩 → 啵断 → 惯性飞行 →
 * 摊开」以及关闭反向的「收缩汇聚 → 飞回融合」。独立 fixed overlay，只动
 * `transform` 与 SVG `d`（合成层友好）。
 *
 * 契约合口径（docs/10 §5 的 R193 修订）：
 * - **不新增 @keyframes**（全表锁 1）——动画由 rAF 状态机驱动，时长从
 *   `:root` 动效令牌**读取**（`--motion-reveal` / `--motion-exit`），本组件不写死毫秒；
 * - **prefers-reduced-motion** ⇒ 整层跳过（直接回调完成，面板无动画出现）；
 * - 玻璃质感（blur / 菲涅尔高光）是 CSS 令牌（`:root` 的 `--glass-*`），不是这张 SVG。
 */
export function LiquidTransition({
  direction,
  sourceRect,
  targetRect,
  onDone,
}: {
  /** split = 开（按钮 → 面板锚点）；merge = 关（面板锚点 → 飞回按钮融合） */
  direction: "split" | "merge";
  sourceRect: { x: number; y: number; r: number };
  targetRect: { x: number; y: number; r: number };
  onDone: () => void;
}) {
  const bridgeRef = useRef<SVGPathElement | null>(null);
  const dropletRef = useRef<HTMLDivElement | null>(null);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      doneRef.current();
      return;
    }
    const style = getComputedStyle(document.documentElement);
    const readMs = (name: string): number => {
      const raw = style.getPropertyValue(name).trim();
      const n = Number(raw.endsWith("ms") ? raw.slice(0, -2) : raw);
      return Number.isFinite(n) && n > 0 ? n : 380;
    };
    const duration = readMs(direction === "split" ? "--motion-reveal" : "--motion-exit");

    const source: LiquidCircle = { x: sourceRect.x, y: sourceRect.y, r: sourceRect.r };
    const target: LiquidCircle = { x: targetRect.x, y: targetRect.y, r: targetRect.r };
    let raf = 0;
    const t0 = performance.now();
    const frame = (now: number): void => {
      const t = Math.min(1, (now - t0) / duration);
      const isSplit = direction === "split";
      // 位移：split 用「拉丝段 + 飞行段」两段拼接；merge 直接用飞行曲线反向
      const split = splitPhase(t);
      const flyNow = flyPhase(t);
      const travel = isSplit
        ? (t < BREAK_AT ? split.travel * 0.45 : 0.45 + flyPhase(t - BREAK_AT).travel * 0.55)
        : flyNow.travel;
      const scale = isSplit
        ? (t < BREAK_AT ? split.scale : flyPhase(t - BREAK_AT).scale * 0.62 + 0.38)
        : flyNow.scale;
      const cx = source.x + (target.x - source.x) * travel;
      const cy = source.y + (target.y - source.y) * travel;
      const r = (isSplit ? source.r : target.r) * scale;

      // 颈缩连接体：split 在断裂前画；merge 在落地融合段画（反向叙事）
      const neck = isSplit ? split.neck : Math.max(0, (t - 0.72) / 0.28);
      const bridge = neck > 0 ? metaballBridge(source, { x: cx, y: cy, r }, neck) : null;
      if (bridgeRef.current !== null) {
        bridgeRef.current.setAttribute("d", bridge ?? "");
        bridgeRef.current.style.opacity = bridge === null ? "0" : "1";
      }
      if (dropletRef.current !== null) {
        dropletRef.current.style.transform = `translate(${String(cx - r)}px, ${String(cy - r)}px)`;
        dropletRef.current.style.width = `${String(r * 2)}px`;
        dropletRef.current.style.height = `${String(r * 2)}px`;
        dropletRef.current.style.opacity = "1";
      }
      if (t < 1) {
        raf = requestAnimationFrame(frame);
      } else {
        doneRef.current();
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
    };
  }, [direction, sourceRect.x, sourceRect.y, sourceRect.r, targetRect.x, targetRect.y, targetRect.r]);

  // 覆盖全窗口的绘制层：桥是一整片玻璃色 path，水珠是独立的玻璃圆
  return (
    <div className="liquid-layer" aria-hidden="true">
      <svg className="liquid-svg" width={window.innerWidth} height={window.innerHeight}>
        <path ref={bridgeRef} className="liquid-bridge" d="" />
      </svg>
      <div ref={dropletRef} className="liquid-droplet" data-liquid-droplet={direction} />
    </div>
  );
}
