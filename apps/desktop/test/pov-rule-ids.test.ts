/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { POV_RULE_IDS } from "@yushu/world-engine";
import { describe, expect, it } from "vitest";

/**
 * 视角规则 id 的三处一致（R102）。
 *
 * 这条锁的形状照 `power-gate.test.ts` 那条（R97）：**报得出来的 id 必须豁免得掉**。
 * 视角结论会并进「全书体检」那张表，而豁免清单（config/consistency.yaml）只认
 * `consistency-ops.ts` 里那份 `knownRuleIds`——漏一条的后果不是报错，是作者面对一条
 * 既消不掉、又删不掉的结论，最后学会的是忽略整块红色。
 *
 * 为什么锁源码而不是 import 那个数组：`knownRuleIds` 是 `consistency-ops.ts` 里的局部常量，
 * import 进来只能证明"引擎有这五条"，证明不了"桌面端把它们交给了豁免清单"。
 */

const OPS = readFileSync(new URL("../src/main/consistency-ops.ts", import.meta.url), "utf8");

describe("视角规则 id：引擎清单 = 源码里被点名的清单", () => {
  it("引擎五条都在 consistency-ops 的 knownRuleIds 里（同源展开，不手抄）", () => {
    expect(POV_RULE_IDS).toHaveLength(5);
    expect(OPS).toContain("...POV_RULE_IDS");
    // 桌面侧那条「策略读不了」也要进名单（fs-ledger-unreadable 同一条路子）：
    // 报了名却豁不掉的结论，最后教会作者的是忽略红色
    expect(OPS).toContain("POV_UNREADABLE_RULE");
  });

  it("POV 结论确实并进了体检那张表（不是只在看板里自说自话）", () => {
    expect(OPS).toContain("povReportFindings");
    expect(OPS).toMatch(/\.\.\.structure\.findings,[\s\S]*?\.\.\.povFindings/);
  });

  it("每条 id 都在源码里真的被产出过（清单不得虚报没实现的规则）", () => {
    const CHECK = readFileSync(
      new URL("../../../packages/@yushu/world-engine/src/pov-check.ts", import.meta.url),
      "utf8",
    );
    const produced = [...CHECK.matchAll(/rule:\s*"([a-z-]+)"/g)].map((match) => match[1]);
    for (const id of POV_RULE_IDS) {
      expect(produced, `pov-check.ts 里没有产出 ${id}`).toContain(id);
    }
    // 桌面侧那条也得同样能证伪：只声明 id 却永不产出，就是虚报一条规则
    const OPS_SOURCE = readFileSync(new URL("../src/main/pov-ops.ts", import.meta.url), "utf8");
    expect(OPS_SOURCE).toMatch(/rule:\s*POV_UNREADABLE_RULE/);
  });
});
