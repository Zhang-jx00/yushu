/* SPDX-License-Identifier: Apache-2.0 */
/**
 * 标签页图标：Lucide（**ISC**）v1.55.0 的 11 个图标。
 *
 * path 数据**逐字复制**自 https://unpkg.com/lucide-static@1.55.0/icons/<name>.svg，
 * 不做二次创作——改 path 就等于换图标，那时候应该换的是"选哪个图标"这个决定，而不是偷偷改坐标。
 * 之所以复制而不是装包：本项目刚剪掉 5 条没用到的依赖声明，为一个 16px 的描边图标引一个运行时依赖
 * 属于反向操作；复制的代价是上游更新不会自动跟进，收益是零依赖、零网络、离线可用。
 * 许可合规：ISC 要求保留版权与许可声明（下面那份），`NOTICE` 里也登记了来源。
 *
 * ─── Lucide 原件许可（ISC）原文 ───
 * ISC License
 * Copyright (c) 2026 Lucide Icons and Contributors
 * Permission to use, copy, modify, and/or distribute this software for any
 * purpose with or without fee is hereby granted, provided that the above
 * copyright notice and this permission notice appear in all copies.
 * THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
 * REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
 * AND FITNESS...（完整条款见 lucide-static@1.55.0/LICENSE）
 * ─────────────────────────────
 */

import type { ReactNode } from "react";

/** 图标名 = Lucide 的文件名（去掉 .svg），这样将来对得上上游仓库，不另起一套命名 */
export type YushuIconName =
  | "layers"
  | "list-ordered"
  | "pen-line"
  | "library"
  | "sparkles"
  | "brain"
  | "scale"
  | "download"
  | "book-open"
  | "chart-column"
  | "folder-tree";

const ICONS: Record<YushuIconName, ReactNode> = {
  // 起源工作台：世界是分层建起来的（创世起源→法则→地理→生态→历史→文明→社会现状）
  layers: (
    <>
      <path d="M12.83 2.18a2 2 0 0 0-1.66 0L2.6 6.08a1 1 0 0 0 0 1.83l8.58 3.91a2 2 0 0 0 1.66 0l8.58-3.9a1 1 0 0 0 0-1.83z" />
      <path d="M2 12a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 12" />
      <path d="M2 17a1 1 0 0 0 .58.91l8.6 3.91a2 2 0 0 0 1.65 0l8.58-3.9A1 1 0 0 0 22 17" />
    </>
  ),
  // 三级大纲：卷→章→节的有序列表
  "list-ordered": (
    <>
      <path d="M11 5h10" />
      <path d="M11 12h10" />
      <path d="M11 19h10" />
      <path d="M4 4h1v5" />
      <path d="M4 9h2" />
      <path d="M6.5 20H3.4c0-1 2.6-1.925 2.6-3.5a1.5 1.5 0 0 0-2.6-1.02" />
    </>
  ),
  // 编辑器：一支笔 + 一条基线
  "pen-line": (
    <>
      <path d="M13 21h8" />
      <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
    </>
  ),
  // 稿件总览：一排书脊
  library: (
    <>
      <path d="m16 6 4 14" />
      <path d="M12 6v14" />
      <path d="M8 8v12" />
      <path d="M4 4v16" />
    </>
  ),
  // AI 副驾：星芒（候选、灵感，不是"魔法解决一切"）
  sparkles: (
    <>
      <path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594z" />
      <path d="M20 2v4" />
      <path d="M22 4h-4" />
      <circle cx="4" cy="20" r="2" />
    </>
  ),
  // 记忆：五层记忆与事实台账
  brain: (
    <>
      <path d="M12 18V5" />
      <path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4" />
      <path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5" />
      <path d="M17.997 5.125a4 4 0 0 1 2.526 5.77" />
      <path d="M18 18a4 4 0 0 0 2-7.464" />
      <path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517" />
      <path d="M6 18a4 4 0 0 1-2-7.464" />
      <path d="M6.003 5.125a4 4 0 0 0-2.526 5.77" />
    </>
  ),
  // 规则：天平（校验与裁量，不是"惩罚"）
  scale: (
    <>
      <path d="M12 3v18" />
      <path d="m19 8 3 8a5 5 0 0 1-6 0zV7" />
      <path d="M3 7h1a17 17 0 0 0 8-2 17 17 0 0 0 8 2h1" />
      <path d="m5 8 3 8a5 5 0 0 1-6 0zV7" />
      <path d="M7 21h10" />
    </>
  ),
  // 导出与自查：向下箭头进托盘
  download: (
    <>
      <path d="M12 15V3" />
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="m7 10 5 5 5-5" />
    </>
  ),
  // 世界观档案：摊开的设定卡
  "book-open": (
    <>
      <path d="M12 5v16" />
      <path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z" />
    </>
  ),
  // 码字统计：柱状（净增 / 有效字数 / 节奏）
  "chart-column": (
    <>
      <path d="M3 3v16a2 2 0 0 0 2 2h16" />
      <path d="M18 17V9" />
      <path d="M13 17V5" />
      <path d="M8 17v-3" />
    </>
  ),
  // 项目文件：目录树（真源在磁盘上，这一页就是给人看的）
  "folder-tree": (
    <>
      <path d="M20 10a1 1 0 0 0 1-1V6a1 1 0 0 0-1-1h-2.5a1 1 0 0 1-.8-.4l-.9-1.2A1 1 0 0 0 15 3h-2a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z" />
      <path d="M20 21a1 1 0 0 0 1-1v-3a1 1 0 0 0-1-1h-2.9a1 1 0 0 1-.88-.55l-.42-.85a1 1 0 0 0-.92-.6H13a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1Z" />
      <path d="M3 5a2 2 0 0 0 2 2h3" />
      <path d="M3 3v13a2 2 0 0 0 2 2h3" />
    </>
  ),
};

/**
 * 描边图标统一走 `currentColor`：颜色由所在控件的文字色决定（未选中标签 `--muted`、
 * 选中 `--accent`），这样主题/高对比调整不用改图标本身。
 * `aria-hidden` 是刻意的——图标旁边的文字才是可访问名，读屏不该念"图标 天平"。
 */
export function YushuIcon({ name, size = 15 }: { name: YushuIconName; size?: number }): ReactNode {
  return (
    <svg
      className="yushu-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {ICONS[name]}
    </svg>
  );
}
