/* SPDX-License-Identifier: Apache-2.0 */
import { LAYER_KEYS, type LayerKey } from "@yushu/core";
import { GENESIS_STEPS } from "../renderer/src/genesis-steps.js";
import { LAYER_ORDER, LAYER_TITLES, layerTitle } from "../src/shared/layer-titles.js";
import { describe, expect, it } from "vitest";

/**
 * 层级显示名的漂移锁（R98）。
 *
 * 起因是设定集导出：产物要写中文层名，而写文件的是主进程；可应用里已有的层级名
 * 是从「起源工作台步骤」派生的（`renderer/src/genesis-steps.ts`），主进程拿不到。
 * 两份显示名并存是现实，**不许并存的是"各改各的"**——所以这里逐层比对两边，
 * 步骤标题改了而这边没改（或反过来）就红，并点名是哪一层。
 */

describe("层级显示名（T5-5 设定集与起源工作台共用）", () => {
  it("十一层每层都有中文标题，且不重复", () => {
    const titles = LAYER_KEYS.map((layer) => LAYER_TITLES[layer]);
    expect(titles.every((title) => title !== "")).toBe(true);
    expect(new Set(titles).size).toBe(LAYER_KEYS.length);
  });

  it("LAYER_ORDER 就是 LAYER_KEYS：目录编排与层级 chips 共用同一个顺序", () => {
    expect([...LAYER_ORDER]).toEqual([...LAYER_KEYS]);
  });

  it("起源工作台覆盖到的层，两边的标题逐字一致（改了那边忘了这边就红）", () => {
    const drift = GENESIS_STEPS.filter(
      (step) => LAYER_TITLES[step.layer as LayerKey] !== step.title,
    ).map((step) => `${step.layer}：步骤「${step.title}」vs 层级名「${LAYER_TITLES[step.layer as LayerKey]}」`);
    expect(drift, `层级显示名漂移：\n${drift.join("\n")}`).toEqual([]);
    // 步骤只覆盖 9 层，剩下两层（events / chapters）也得有名，否则产物里会掉出英文键
    expect(LAYER_TITLES.events).not.toBeUndefined();
    expect(LAYER_TITLES.chapters).not.toBeUndefined();
  });

  it("未知层键原样回退：不替派系包的自定义层猜一个中文名", () => {
    expect(layerTitle("feelings")).toBe("feelings");
    expect(layerTitle("characters")).toBe("人物");
  });
});
