/* SPDX-License-Identifier: Apache-2.0 */
/**
 * 品牌标记「御书」（R109 UI 重构第一轮）。
 *
 * **为什么自己画而不是抄图标库**：11 个标签页图标用 Lucide 原件（ISC，见 `icons.tsx`），
 * 但**品牌标记不是通用图标**——它没有上游，抄一份别人的 logo 当自己的品牌是署名事故。
 * 所以这一枚是**本项目自绘**的，按 Lucide 的同一套制图约定画（24×24 画布、2px 描边、
 * round join / round cap、居中留白），这样它和界面里的其他图标是**一套**，不是"外来的"。
 *
 * 形状的来历：**一卷书 + 右下角一枚朱色落款印**。
 * 「御」这个字自带官印的意象，写作工具最贴切的身份物就是"作者的落款"——
 * 一份写好的稿子，末尾盖一枚印。纸墨色系里补一枚朱，正好是印章的颜色，不是外来配色。
 *
 * **不许随手改 path**：改了就换了设计决定（该走"重新评审标记"那条路，而不是偷偷挪坐标）。
 *
 * 三条制图口径：
 * ① 24×24 画布、**2px 描边**、圆角连接与圆头端点——与界面图标同一套，看过去是一家人；
 * ② **小尺寸优先**：16px 下仍要认得出是"一页稿子 + 一枚印"（朱印是实心块，不是一个小圆点
 *    ——16px 的圆点会消失，块不会）；
 * ③ **单色**（`currentColor`）：不自带颜色 ⇒ 放在纸底上是赭色、放在墨底上是纸色，跟着语境走。
 */

import type { ReactNode } from "react";

/** 品牌标记的 path（唯一来源；组件里不许再内联一份） */
export const BRAND_MARK_PATHS: readonly string[] = [
  // 稿纸：带一个极小的圆角，像一张纸的边
  "M6 4h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z",
  // 两行字：上面一行长、下面一行短（右上角留给印）
  "M8 8h7M8 11.2h4.6",
];

/** 落款印：实心方块（朱色由 currentColor 决定，不另设颜色） */
export const BRAND_MARK_SEAL = { x: 14.4, y: 13.4, size: 4.4, radius: 0.7 };

/** 品牌标记（单色，跟随 currentColor） */
export function BrandMark({ size = 24, className }: { size?: number; className?: string }): ReactNode {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="御书"
    >
      {BRAND_MARK_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
      <rect
        x={BRAND_MARK_SEAL.x}
        y={BRAND_MARK_SEAL.y}
        width={BRAND_MARK_SEAL.size}
        height={BRAND_MARK_SEAL.size}
        rx={BRAND_MARK_SEAL.radius}
        fill="currentColor"
        stroke="none"
      />
    </svg>
  );
}

/** 品牌字标（标记 + 两个字）——顶栏与欢迎屏共用同一处来源 */
export function BrandWordmark({ size = 18, className }: { size?: number; className?: string }): ReactNode {
  return (
    <span className={`brand-lockup ${className ?? ""}`.trim()}>
      <BrandMark size={size} className="brand-mark" />
      <strong className="brand">御书</strong>
    </span>
  );
}
