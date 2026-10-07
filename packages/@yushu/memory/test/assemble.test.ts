import { describe, expect, it } from "vitest";
import {
  DEFAULT_SLOT_CONFIG,
  SLOT_ORDER,
  assembleContext,
  textSimilarity,
  type AssemblyItem,
} from "@yushu/memory";

/**
 * T3-7：上下文组装——固定槽位顺序、priority_then_recent 排序、recent_n 窗口、
 * 去重（by_id / by_similarity）、槽位 cap 截断、全局预算逐出顺序与确定性。
 */

function item(overrides: Partial<AssemblyItem> & { id: string; slot: AssemblyItem["slot"] }): AssemblyItem {
  return {
    title: overrides.id,
    text: "默认文本。",
    ...overrides,
  } as AssemblyItem;
}

const BIG_BUDGET = { budget_total: 32000 };

describe("上下文组装 assembleContext（T3-7）", () => {
  it("固定槽位顺序输出（含空槽；缺省 caps 与 docs/03 §10.2 一致）", () => {
    const result = assembleContext([item({ id: "f1", slot: "facts" })], BIG_BUDGET);
    expect(result.slots.map((slot) => slot.slot)).toEqual([...SLOT_ORDER]);
    expect(result.slots.find((slot) => slot.slot === "facts")?.cap_tokens).toBe(2000);
    expect(DEFAULT_SLOT_CONFIG).toHaveLength(8);
  });

  it("槽内排序：priority 降序 → recency 降序 → id 升序（priority_then_recent）", () => {
    const result = assembleContext(
      [
        item({ id: "f-low", slot: "facts", priority: 10, recency: 9, text: "低优先事实。" }),
        item({ id: "f-high-old", slot: "facts", priority: 90, recency: 1, text: "高优先旧事实。" }),
        item({ id: "f-high-new", slot: "facts", priority: 90, recency: 5, text: "高优先新事实。" }),
      ],
      BIG_BUDGET,
    );
    const ids = result.slots.find((slot) => slot.slot === "facts")!.items.map((entry) => entry.id);
    expect(ids).toEqual(["f-high-new", "f-high-old", "f-low"]);
  });

  it("recent_n 窗口：超出按新近度丢弃（reason=recent_n）", () => {
    const result = assembleContext(
      [
        item({ id: "f-old", slot: "facts", recency: 1 }),
        item({ id: "f-new", slot: "facts", recency: 9 }),
      ],
      { budget_total: 32000, slots: { facts: { recent_n: 1 } } },
    );
    expect(result.slots.find((slot) => slot.slot === "facts")!.items.map((entry) => entry.id)).toEqual(["f-new"]);
    expect(result.dropped[0]).toMatchObject({ id: "f-old", reason: "recent_n" });
  });

  it("by_id 去重：同 id 保留先出现槽位（world_core 先于 facts）", () => {
    const result = assembleContext(
      [
        item({ id: "char-1", slot: "facts", text: "事实版本。" }),
        item({ id: "char-1", slot: "world_core", text: "卡片版本。" }),
      ],
      BIG_BUDGET,
    );
    expect(result.dedup.by_id).toBe(1);
    expect(result.slots.find((slot) => slot.slot === "world_core")!.items).toHaveLength(1);
    expect(result.slots.find((slot) => slot.slot === "facts")!.items).toHaveLength(0);
    expect(result.dropped[0]).toMatchObject({ id: "char-1", reason: "by_id" });
  });

  it("by_similarity 去重：文本一致（不同 id）→ 后者丢弃；相似度函数阈值 0.95", () => {
    expect(textSimilarity("林渊获得玄铁令。", "林渊获得玄铁令。")).toBe(1);
    expect(textSimilarity("林渊获得玄铁令。", "张三离开了边城，一路向北。")).toBeLessThan(0.5);
    const result = assembleContext(
      [
        item({ id: "f-a", slot: "facts", text: "林渊获得玄铁令并离开了边城。" }),
        item({ id: "f-b", slot: "facts", text: "林渊获得玄铁令并离开了边城。" }),
      ],
      BIG_BUDGET,
    );
    expect(result.dedup.by_similarity).toBe(1);
    expect(result.slots.find((slot) => slot.slot === "facts")!.items.map((entry) => entry.id)).toEqual(["f-a"]);
  });

  it("槽位 cap：超限先截断一条（truncated），其后逐条丢弃（reason=cap）", () => {
    const long = "一".repeat(200);
    const result = assembleContext(
      [item({ id: "f-1", slot: "facts", text: long }), item({ id: "f-2", slot: "facts", text: long })],
      { budget_total: 32000, slots: { facts: { cap_tokens: 60 } } },
    );
    const facts = result.slots.find((slot) => slot.slot === "facts")!;
    expect(facts.items).toHaveLength(1);
    expect(facts.items[0]?.truncated).toBe(true);
    expect(facts.truncated).toBe(true);
    expect(result.dropped.some((entry) => entry.reason === "cap")).toBe(true);
  });

  it("全局预算：按逐出顺序整条逐出（facts 先于 recent_prose；system_prompt 只截断不丢）", () => {
    const result = assembleContext(
      [
        item({ id: "s-1", slot: "system_prompt", text: "系统提示。", stable: true }),
        item({ id: "f-1", slot: "facts", text: "事实一。" }),
        item({ id: "c-1", slot: "triggered_cards", text: "卡片一。" }),
        item({ id: "p-1", slot: "recent_prose", text: "最近正文。" }),
      ],
      { budget_total: 12 },
    );
    const keptIds = result.slots.flatMap((slot) => slot.items.map((entry) => entry.id));
    expect(keptIds).not.toContain("f-1"); // 逐出序第一：facts
    expect(result.dropped.find((entry) => entry.id === "f-1")?.reason).toBe("budget");
    expect(result.totalTokens).toBeLessThanOrEqual(12);
    expect(keptIds).toContain("s-1");
  });

  it("预算极端小：稳定前缀最终被截断（不整条丢弃），合计不超预算", () => {
    const result = assembleContext(
      [item({ id: "s-1", slot: "system_prompt", text: "一".repeat(100), stable: true })],
      { budget_total: 30 },
    );
    const prompt = result.slots.find((slot) => slot.slot === "system_prompt")!;
    expect(prompt.items).toHaveLength(1);
    expect(prompt.items[0]?.truncated).toBe(true);
    expect(result.totalTokens).toBeLessThanOrEqual(30);
  });

  it("稳定前缀与可复现：stableTokens 统计；同输入两次结果一致（快照复现前提）", () => {
    const items = [
      item({ id: "s-1", slot: "system_prompt", text: "系统提示。", stable: true }),
      item({ id: "w-1", slot: "world_core", text: "世界核心。", stable: true }),
      item({ id: "p-1", slot: "recent_prose", text: "最近正文。" }),
    ];
    const first = assembleContext(items, BIG_BUDGET);
    const second = assembleContext(items, BIG_BUDGET);
    expect(first).toEqual(second);
    expect(first.stableTokens).toBeGreaterThan(0);
    expect(first.stableTokens).toBeLessThan(first.totalTokens);
    expect(first.truncatedItems).toBe(0);
  });
});