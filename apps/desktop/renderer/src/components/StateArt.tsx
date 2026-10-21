/* SPDX-License-Identifier: Apache-2.0 */
import type { ReactNode } from "react";
/**
 * 空状态 / 错误态的**插画**（R113 第四批·第四段）。
 *
 * 为什么要有它：空状态若只有一行灰字，作者看到的是"这儿没东西"，而不是"这儿本来该有东西、
 * 现在还没有"。R115 已经把空状态统一成「图标 + 标题 + 说明」三段式，但那个图标是**图标级**的
 * （Lucide 的 `inbox`，15px 起步）——它负责说"这是哪一类状态"，不负责说"这里将来会有什么"。
 *
 * 插画负责后者，所以它和图标**不是一回事**：
 * - 图标 = 资产，固定画法，有上游（Lucide）或自绘 ⇒ 登记在 `docs/12`；
 * - 插画 = **自绘**，没有上游 ⇒ 也要登记（写明"自绘、没有上游"），但登记的是**画法口径**。
 *
 * 制图口径（与品牌标记同族，见 `docs/12` §1.2）：
 * - **24×24 画布**、**2px 描边**、round join / round cap、**单色 currentColor**；
 * - **不填色**（`fill="none"`）——插画是线稿，填色就变成贴图了；
 * - 放大靠 `size` 缩放，不改 viewBox ⇒ 缩放到任何尺寸，线宽比例都一样。
 *
 * 两个图形是一族（同一张"稿纸"）：empty 是还没写的稿纸，error 是写坏了的稿纸。
 */

export type StateArtKind = "empty" | "error";

const ART: Record<StateArtKind, ReactNode> = {
  // 空：一张还没有字的稿纸（右上折角 + 两条空行）
  empty: (
    <>
      <path d="M5 3h9l5 5v13H5z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 12h7" />
      <path d="M8.5 16h4.5" />
    </>
  ),
  // 错：同一张稿纸，但被一道斜划划掉了（写坏了，不是没写）
  error: (
    <>
      <path d="M5 3h9l5 5v13H5z" />
      <path d="M14 3v5h5" />
      <path d="M8.5 12h7" />
      <path d="M8.5 16h4.5" />
      <path d="M4 20 20 4" />
    </>
  ),
};

/**
 * 空状态 / 错误态插画。
 *
 * `aria-hidden` 是刻意的：插画是**装饰**（旁边的标题与说明才是可访问名），
 * 读屏念"一张纸"对作者没有帮助。
 */
export function StateArt({ kind, size = 40 }: { kind: StateArtKind; size?: number }) {
  return (
    <svg
      className="state-art"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ART[kind]}
    </svg>
  );
}
