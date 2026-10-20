/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  GATE_CHECK_ORIGIN,
  GATE_LEDGER_SUBJECT,
  GATE_RULE_IDS,
  checkInjectionGates,
  type GateItemRow,
} from "../src/gate-check";

/**
 * 注入门控 `reveal_gate` 的悬空核对（R104 / M4 T4-2 第五批第二段）。
 *
 * 判据回源：
 * - **docs/03 §10.1**：`reveal_gate: ch-030 # 早于该章不注入（叙事可见性，J05/A08）`；
 * - **`@yushu/memory/injection.ts:202-213` 的实际行为**：门控解析不到 ⇒ 直接进排除清单，
 *   理由写着「无法解析（保守不注入，防剧透优先）」——**保守是对的方向，但代价是静默**：
 *   这条事实 / 卡从此在**任何一章**都不进上下文，而记忆页上还显示"门控 ch-xxx"，看着像已经配好了。
 *   本模块不改那个保守默认，只把"它其实永远不会生效"这件事搬到体检表上。
 * - **J03:99** 那条 `memory-spoiler-leak`（门控未到却被注入）由 `planInjection` 自己拦，不在这里重复。
 *
 * **口径与 R103 一致**：一条门控都没登记 ⇒ 零结论（没配置不发 info 进表，R102 裁决）；
 * 但**有门控而章序取不到**时不许逐条喊悬空——那会把"章纲还没回填 chapter_id"冤枉成"门控全坏了"，
 * 只给一条总述。
 */

const ORDER = ["ch-001", "ch-002", "ch-003"];

function item(overrides: Partial<GateItemRow> = {}): GateItemRow {
  return { id: "fact-iron", kind: "fact", label: "玄铁令的来历", gate: "ch-003", ...overrides };
}

describe("checkInjectionGates — 门控指向不存在的章", () => {
  it("门控 id 不在章序里 ⇒ 一条 warn，说清「它其实永远不注入」这件事", () => {
    const rows = checkInjectionGates({ items: [item({ gate: "ch-999" })], chapterOrder: ORDER });
    expect(rows.map((row) => row.rule)).toEqual(["gate-chapter-unknown"]);
    expect(rows[0]).toMatchObject({ severity: "warn", subject: "fact-iron", related: "ch-999" });
    expect(rows[0]?.message).toContain("ch-999");
    expect(rows[0]?.message).toContain("玄铁令的来历");
    expect(rows[0]?.evidence).toContain("不注入");
    expect(rows[0]?.origin).toBe(GATE_CHECK_ORIGIN);
  });

  it("门控指向存在的章 ⇒ 零结论（门控未到是设计，不是缺陷）", () => {
    expect(checkInjectionGates({ items: [item({ gate: "ch-003" })], chapterOrder: ORDER })).toEqual([]);
  });

  it("没登记门控的条目直接跳过：省略 = 无门控 = 常驻，不该被报", () => {
    const rows = checkInjectionGates({
      items: [item({ gate: "" }), item({ id: "fact-b", gate: "   " })],
      chapterOrder: ORDER,
    });
    expect(rows).toEqual([]);
  });

  it("卡和事实混在一起也逐条点名，且顺序与输入无关（红线 5：码点序）", () => {
    const items: GateItemRow[] = [
      item({ id: "char-linyuan", kind: "card", label: "林渊", gate: "ch-zzz" }),
      item({ id: "fact-a", kind: "fact", label: "第一条事实", gate: "ch-nope" }),
      item({ id: "fact-g", kind: "fact", label: "第三条事实", gate: "ch-002" }),
    ];
    const forward = checkInjectionGates({ items, chapterOrder: ORDER });
    expect(forward.map((row) => row.subject)).toEqual(["char-linyuan", "fact-a"]);
    expect(forward.map((row) => row.severity)).toEqual(["warn", "warn"]);
    const reversed = checkInjectionGates({ items: [...items].reverse(), chapterOrder: ORDER });
    expect(reversed).toEqual(forward);
  });

  it("条目为空 ⇒ 零结论（没配门控这件事不该占一行）", () => {
    expect(checkInjectionGates({ items: [], chapterOrder: ORDER })).toEqual([]);
  });
});

describe("checkInjectionGates — 章序取不到时不冤枉逐条", () => {
  it("有门控但章序为空 ⇒ 只给一条 info 总述，并写明「没核对过」不等于「门控没问题」", () => {
    const rows = checkInjectionGates({
      items: [item({ gate: "ch-999" }), item({ id: "fact-b", label: "第二条", gate: "ch-007" })],
      chapterOrder: [],
    });
    expect(rows.map((row) => row.rule)).toEqual(["gate-no-chapter-order"]);
    expect(rows[0]).toMatchObject({ severity: "info", subject: GATE_LEDGER_SUBJECT });
    expect(rows[0]?.message).toContain("2");
    expect(rows[0]?.evidence).toContain("不等于");
    /** 关键防误报：章序缺失时不许把每一条都判成悬空 */
    expect(rows.some((row) => row.rule === "gate-chapter-unknown")).toBe(false);
  });

  it("一条门控都没登记时，章序为空也不发总述（没配置不该打扰作者）", () => {
    expect(checkInjectionGates({ items: [item({ gate: "" })], chapterOrder: [] })).toEqual([]);
  });

  it("章序里重复的 id 只认第一次出现，不影响判定", () => {
    expect(checkInjectionGates({ items: [item({ gate: "ch-002" })], chapterOrder: ["ch-002", "ch-002"] })).toEqual([]);
  });
});

describe("checkInjectionGates — 清单与产出一致", () => {
  it("两条 id 都在清单里，且每条都有结论真的发过", () => {
    expect([...GATE_RULE_IDS].sort()).toEqual(["gate-chapter-unknown", "gate-no-chapter-order"]);
    const fired = new Set([
      ...checkInjectionGates({ items: [item({ gate: "ch-999" })], chapterOrder: ORDER }).map((row) => row.rule),
      ...checkInjectionGates({ items: [item({ gate: "ch-999" })], chapterOrder: [] }).map((row) => row.rule),
    ]);
    for (const id of GATE_RULE_IDS) {
      expect(fired.has(id), `${String(id)} 从没被任何结论发过`).toBe(true);
    }
  });
});
