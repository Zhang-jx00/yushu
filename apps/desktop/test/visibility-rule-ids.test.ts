/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { VISIBILITY_RULE_IDS } from "@yushu/world-engine";
import { describe, expect, it } from "vitest";

/**
 * 可见性规则 id 的三处一致（R103）。
 *
 * 与 `pov-rule-ids.test.ts` 同一条理由：**报得出来的 id 必须豁得掉**，
 * 而豁免清单只认 `consistency-ops.ts` 里那份 `knownRuleIds`。
 * 锁源码而不是 import 数组，是因为 import 只能证明"引擎有这五条"，
 * 证明不了"桌面端把它们交给了豁免清单"。
 */

const OPS = readFileSync(new URL("../src/main/consistency-ops.ts", import.meta.url), "utf8");
const CHECK = readFileSync(
  new URL("../../../packages/@yushu/world-engine/src/visibility-check.ts", import.meta.url),
  "utf8",
);
const DESKTOP = readFileSync(new URL("../src/main/visibility-ops.ts", import.meta.url), "utf8");

describe("可见性规则 id：引擎清单 = 源码里被点名的清单", () => {
  it("引擎五条 + 桌面侧那条坏卡都在 knownRuleIds 里（同源展开，不手抄）", () => {
    expect(VISIBILITY_RULE_IDS).toHaveLength(5);
    expect(OPS).toContain("...VISIBILITY_RULE_IDS");
    expect(OPS).toContain("VIS_UNREADABLE_RULE");
  });

  it("可见性结论确实并进了体检那张表（不是只在自己模块里自说自话）", () => {
    expect(OPS).toContain("visibilityReportFindings");
    expect(OPS).toMatch(/\.\.\.structure\.findings,[\s\S]*?\.\.\.visibilityFindings/);
  });

  it("每条 id 都在源码里真的被产出过（清单不得虚报没实现的规则）", () => {
    const produced = [...CHECK.matchAll(/rule:\s*"([a-z-]+)"/g)].map((match) => match[1]);
    for (const id of VISIBILITY_RULE_IDS) {
      expect(produced, `visibility-check.ts 里没有产出 ${id}`).toContain(id);
    }
    expect(DESKTOP).toMatch(/rule:\s*VIS_UNREADABLE_RULE/);
  });
});
