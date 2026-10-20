/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { OPENING_RULE_IDS } from "@yushu/world-engine";
import { describe, expect, it } from "vitest";

/**
 * 黄金三章规则 id 的三处一致（R104）。
 *
 * 与 `pov-rule-ids.test.ts` / `visibility-rule-ids.test.ts` 同一条理由：
 * **报得出来的 id 必须豁得掉**，而豁免清单只认 `consistency-ops.ts` 里那份 `knownRuleIds`。
 * 锁源码而不是 import 数组，是因为 import 只能证明"引擎有这四条"，
 * 证明不了"桌面端把它们交给了豁免清单、也没有在清单里虚报没实现的规则"。
 */

const OPS = readFileSync(new URL("../src/main/consistency-ops.ts", import.meta.url), "utf8");
const CHECK = readFileSync(
  new URL("../../../packages/@yushu/world-engine/src/opening-check.ts", import.meta.url),
  "utf8",
);
const DESKTOP = readFileSync(new URL("../src/main/opening-ops.ts", import.meta.url), "utf8");

describe("黄金三章规则 id：引擎清单 = 源码里被点名的清单", () => {
  it("引擎四条 + 桌面侧那条读不动都在 knownRuleIds 里（同源展开，不手抄）", () => {
    expect(OPENING_RULE_IDS).toHaveLength(4);
    expect(OPS).toContain("...OPENING_RULE_IDS");
    expect(OPS).toContain("OPEN_UNREADABLE_RULE");
  });

  it("黄金三章结论确实并进了体检那张表（不是只在自己模块里自说自话）", () => {
    expect(OPS).toContain("openingReportFindings");
    expect(OPS).toMatch(/\.\.\.structure\.findings,[\s\S]*?\.\.\.openingFindings/);
  });

  it("每条 id 都在源码里真的被产出过（清单不得虚报没实现的规则）", () => {
    const produced = [...CHECK.matchAll(/rule:\s*"([a-z-]+)"/g)].map((match) => match[1]);
    for (const id of OPENING_RULE_IDS) {
      expect(produced, `opening-check.ts 里没有产出 ${id}`).toContain(id);
    }
    expect(DESKTOP).toMatch(/rule:\s*OPEN_UNREADABLE_RULE/);
  });

  it("桌面侧只认开局窗口那几章：读正文的循环必须带上窗口上限", () => {
    // 没有上限就是"为一条黄金三章结论把全书正文都读一遍"，成本会随书长线性膨胀
    expect(DESKTOP).toContain("OPENING_WINDOW_CHAPTERS");
    expect(DESKTOP).toMatch(/if\s*\(order > OPENING_WINDOW_CHAPTERS\)/);
  });
});
