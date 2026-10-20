/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { BRIEF_KEYS, OPENING_BRIEF_LABELS } from "@yushu/world-engine";
import { describe, expect, it } from "vitest";

/**
 * 章纲七要素显示名的漂移锁（R104）。
 *
 * 起因是黄金三章那条 `open-brief-incomplete`：引擎要在结论里说"缺的是**阻碍、钩子**"，
 * 而这套中文词本来只存在于渲染层 `OutlineView.tsx` 的 `BRIEF_FIELDS`（引擎进不了渲染层，
 * 渲染层又不该为了一个词去 import 整个 world-engine——那是把包体撑大）。
 * 两份表并存是分层的现实，**不许并存的是"各改各的"**：
 * 界面把"在哪"改成"地点"而结论还写"在哪"，作者就不知道结论指的是哪个输入框。
 * 与 `layer-titles.test.ts` 同一条路子。
 */

const VIEW = readFileSync(
  new URL("../renderer/src/views/OutlineView.tsx", import.meta.url),
  "utf8",
);

/** 从渲染层那张表里抠出 key → label（认字段形状，不认整行文案） */
function viewLabels(): Record<string, string> {
  const pairs = [...VIEW.matchAll(/\{\s*key:\s*"([a-z]+)",\s*label:\s*"([^"]+)"/g)];
  return Object.fromEntries(pairs.map((match) => [match[1] ?? "", match[2] ?? ""]));
}

describe("章纲七要素的中文显示名（引擎结论与大纲页共用）", () => {
  it("渲染层那张表抠得出来，且正好覆盖七要素", () => {
    const labels = viewLabels();
    expect(Object.keys(labels).length).toBe(BRIEF_KEYS.length);
    for (const key of BRIEF_KEYS) {
      expect(labels[key], `OutlineView 的 BRIEF_FIELDS 里没有 ${key}`).toBeTruthy();
    }
  });

  it("两边逐字一致：改了界面忘了结论（或反过来）就红", () => {
    const drift = BRIEF_KEYS.filter((key) => OPENING_BRIEF_LABELS[key] !== viewLabels()[key]).map(
      (key) => `${key}：结论用「${OPENING_BRIEF_LABELS[key]}」vs 界面用「${String(viewLabels()[key])}」`,
    );
    expect(drift, `七要素显示名漂移：\n${drift.join("\n")}`).toEqual([]);
  });

  it("顺序也是同一张表：结论里列出缺项的顺序 = 界面上输入框的顺序", () => {
    expect(Object.keys(viewLabels())).toEqual([...BRIEF_KEYS]);
  });
});
