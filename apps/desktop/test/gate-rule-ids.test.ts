/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { GATE_RULE_IDS } from "@yushu/world-engine";
import { describe, expect, it } from "vitest";

/**
 * 注入门控规则 id 的三处一致（R104）。
 *
 * 与 `pov-rule-ids.test.ts` / `visibility-rule-ids.test.ts` / `opening-rule-ids.test.ts` 同一条理由：
 * **报得出来的 id 必须豁得掉**。这里额外锁一件本族特有的事：
 * 门控分散在两处真源（事实与设定卡），代码里少了任何一处读取，
 * 那一处的悬空就永远不会被报出来——而"零结论"看着像"没问题"，是最难发现的假绿灯。
 */

const OPS = readFileSync(new URL("../src/main/consistency-ops.ts", import.meta.url), "utf8");
const CHECK = readFileSync(
  new URL("../../../packages/@yushu/world-engine/src/gate-check.ts", import.meta.url),
  "utf8",
);
const DESKTOP = readFileSync(new URL("../src/main/gate-ops.ts", import.meta.url), "utf8");

describe("注入门控规则 id：引擎清单 = 源码里被点名的清单", () => {
  it("引擎两条 + 桌面侧那条读不动都在 knownRuleIds 里（同源展开，不手抄）", () => {
    expect(GATE_RULE_IDS).toHaveLength(2);
    expect(OPS).toContain("...GATE_RULE_IDS");
    expect(OPS).toContain("GATE_UNREADABLE_RULE");
  });

  it("门控结论确实并进了体检那张表（不是只在自己模块里自说自话）", () => {
    expect(OPS).toContain("gateReportFindings");
    expect(OPS).toMatch(/\.\.\.structure\.findings,[\s\S]*?\.\.\.gateFindings/);
  });

  it("每条 id 都在源码里真的被产出过（清单不得虚报没实现的规则）", () => {
    const produced = [...CHECK.matchAll(/rule:\s*"([a-z-]+)"/g)].map((match) => match[1]);
    for (const id of GATE_RULE_IDS) {
      expect(produced, `gate-check.ts 里没有产出 ${id}`).toContain(id);
    }
    expect(DESKTOP).toMatch(/rule:\s*GATE_UNREADABLE_RULE/);
  });

  it("两处真源都读了：事实目录与设定卡各一次（漏一处=那一处的悬空永远看不见）", () => {
    expect(DESKTOP).toContain("MEMORY_FACTS_DIR");
    expect(DESKTOP).toContain("readAllCards");
    /** 章序必须走那份单一口径，不许本模块自己再算一遍 */
    expect(DESKTOP).toContain("outlineChapterOrder");
  });
});
