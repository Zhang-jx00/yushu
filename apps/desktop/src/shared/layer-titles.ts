/* SPDX-License-Identifier: Apache-2.0 */
import { LAYER_KEYS, type LayerKey } from "@yushu/core";

/**
 * 世界构建层级的中文显示名（M5 / T5-5，R98）。
 *
 * 为什么主进程也要一份显示名：**设定集是落盘的产物**，标题得由写文件的一方决定；
 * 渲染层那份 `card-labels.ts` 的层级名是从「起源工作台步骤」派生的（步骤标题≠层级名，
 * 且步骤只覆盖 9 层，events / chapters 没有步骤）。两份并存是事实，
 * 但漂移不许是事实——`test/layer-titles.test.ts` 逐层比对自己与步骤标题，改了那边忘了这边就红。
 */
export const LAYER_TITLES: Record<LayerKey, string> = {
  genesis: "起源",
  laws: "法则",
  geography: "地理",
  ecology: "生态",
  eras: "历史",
  civilizations: "文明",
  factions: "社会",
  characters: "人物",
  events: "事件",
  storylines: "故事",
  chapters: "章节",
};

/** 层级显示名（未知键原样回退：派系包扩展层不该被这里猜一个名字） */
export function layerTitle(layer: string): string {
  const hit = LAYER_TITLES[layer as LayerKey];
  return hit ?? layer;
}

/** 十一层的固定顺序（目录编排与 chips 都用它，别在两个地方各写一遍） */
export const LAYER_ORDER: readonly string[] = LAYER_KEYS;
