import { describe, expect, it } from "vitest";
import {
  DEFAULT_INJECTION,
  estimateTokens,
  parseFact,
  parseInjectionConfig,
  planInjection,
  serializeFact,
  truncateToTokens,
  type FactRecord,
  type InjectableItem,
} from "@yushu/memory";

/**
 * T3-6：注入控制——配置校验（mode / priority / position / budget_tokens / reveal_gate）、
 * 决策与解释（always / trigger 命中 / manual 清单 / 门控排除）、预算截断与排序确定性。
 */

const NOW = "2026-10-07T12:00:00.000Z";

function item(id: string, overrides: Partial<InjectableItem> = {}): InjectableItem {
  return {
    id,
    layer: "fact",
    title: id,
    text: "林渊在第一章末获得玄铁令。",
    keys: ["林渊"],
    config: { ...DEFAULT_INJECTION },
    ...overrides,
  };
}

describe("注入配置（T3-6）", () => {
  it("缺省回退默认（trigger / 50 / near_end / 400）；显式字段覆盖", () => {
    expect(parseInjectionConfig(undefined, "f")).toEqual(DEFAULT_INJECTION);
    expect(
      parseInjectionConfig(
        { mode: "always", priority: 80, position: "after_system", budget_tokens: 800, reveal_gate: "ch-030" },
        "f",
      ),
    ).toEqual({ mode: "always", priority: 80, position: "after_system", budget_tokens: 800, reveal_gate: "ch-030" });
  });

  it("非法字段明确报错（mode / priority / position / budget / reveal_gate）", () => {
    expect(() => parseInjectionConfig({ mode: "sometimes" }, "f")).toThrowError(/mode/);
    expect(() => parseInjectionConfig({ priority: 101 }, "f")).toThrowError(/priority/);
    expect(() => parseInjectionConfig({ priority: 1.5 }, "f")).toThrowError(/priority/);
    expect(() => parseInjectionConfig({ position: "middle" }, "f")).toThrowError(/position/);
    expect(() => parseInjectionConfig({ budget_tokens: 0 }, "f")).toThrowError(/budget_tokens/);
    expect(() => parseInjectionConfig({ reveal_gate: "  " }, "f")).toThrowError(/reveal_gate/);
  });

  it("token 估算：CJK ≈ 1/字、ASCII ≈ 1/4 字符、空白不计", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("夜色")).toBe(2);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("a b c d")).toBe(1);
    expect(estimateTokens("林渊 abc")).toBe(3);
  });

  it("预算截断：超限保头部并加省略标记；未超限原样返回", () => {
    const short = truncateToTokens("夜色", 10);
    expect(short.truncated).toBe(false);
    const long = truncateToTokens("一二三四五六七八九十", 8);
    expect(long.truncated).toBe(true);
    expect(long.text.startsWith("一二三")).toBe(true);
    expect(long.text).toContain("（截断）");
    expect(long.tokens).toBeLessThanOrEqual(8);
  });
});

describe("注入决策 planInjection（T3-6）", () => {
  it("always 常驻；trigger 命中（含 matched_keys）；未命中 → no_trigger 排除", () => {
    const plan = planInjection(
      [
        item("fact-always", { config: { ...DEFAULT_INJECTION, mode: "always" } }),
        item("fact-hit", { keys: ["玄铁令"] }),
        item("fact-miss", { keys: ["不存在的词"] }),
      ],
      { chapterOrdinal: 1, mentionText: "尾声：玄铁令现世。" },
    );
    expect(plan.entries.map((entry) => entry.id)).toEqual(["fact-always", "fact-hit"]);
    expect(plan.entries[1]?.matched_keys).toEqual(["玄铁令"]);
    expect(plan.excluded).toEqual([
      expect.objectContaining({ id: "fact-miss", code: "no_trigger" }),
    ]);
  });

  it("manual：不在清单 → no_manual；在清单 → 注入（reason 标明手动）", () => {
    const target = item("fact-manual", { config: { ...DEFAULT_INJECTION, mode: "manual" } });
    const without = planInjection([target], { chapterOrdinal: 1 });
    expect(without.entries).toHaveLength(0);
    expect(without.excluded[0]?.code).toBe("no_manual");
    const withList = planInjection([target], { chapterOrdinal: 1, manualIds: ["fact-manual"] });
    expect(withList.entries[0]?.reason).toContain("manual");
  });

  it("reveal_gate：早于门控章不注入；到章后注入；门控无法解析保守不注入（防剧透优先）", () => {
    const ordinalOf = (id: string) => (id === "ch-030" ? 30 : null);
    const gated = item("fact-gated", { config: { ...DEFAULT_INJECTION, mode: "always", reveal_gate: "ch-030" } });
    const early = planInjection([gated], { chapterOrdinal: 29, ordinalOf });
    expect(early.entries).toHaveLength(0);
    expect(early.excluded[0]).toMatchObject({ code: "reveal_gate" });
    const at = planInjection([gated], { chapterOrdinal: 30, ordinalOf });
    expect(at.entries).toHaveLength(1);
    const broken = item("fact-broken-gate", {
      config: { ...DEFAULT_INJECTION, mode: "always", reveal_gate: "ch-999" },
    });
    const unresolvable = planInjection([broken], { chapterOrdinal: 99, ordinalOf });
    expect(unresolvable.excluded[0]).toMatchObject({ code: "reveal_gate" });
  });

  it("排序：position 分组顺序（after_system → near_start → near_end）+ 同组 priority 降序 + id 兜底", () => {
    const plan = planInjection(
      [
        item("fact-b", { config: { ...DEFAULT_INJECTION, mode: "always", position: "near_end", priority: 10 } }),
        item("fact-a", { config: { ...DEFAULT_INJECTION, mode: "always", position: "after_system", priority: 10 } }),
        item("fact-c", { config: { ...DEFAULT_INJECTION, mode: "always", position: "near_end", priority: 90 } }),
        item("fact-d", { config: { ...DEFAULT_INJECTION, mode: "always", position: "near_end", priority: 90 } }),
      ],
      { chapterOrdinal: 1 },
    );
    expect(plan.entries.map((entry) => entry.id)).toEqual(["fact-a", "fact-c", "fact-d", "fact-b"]);
    expect(plan.totalTokens).toBeGreaterThan(0);
  });

  it("预算截断进入计划（truncated 标记 + tokens 不超单项预算）", () => {
    const long = item("fact-long", {
      text: "一".repeat(200),
      config: { ...DEFAULT_INJECTION, mode: "always", budget_tokens: 20 },
    });
    const plan = planInjection([long], { chapterOrdinal: 1 });
    expect(plan.entries[0]?.truncated).toBe(true);
    expect(plan.entries[0]?.tokens).toBeLessThanOrEqual(25);
  });
});

describe("事实记录的注入配置（T3-6 持久化）", () => {
  it("serializeFact / parseFact 往返保留 injection；缺省时不写字段", () => {
    const base: FactRecord = {
      layer: "fact",
      id: "fact-abcd1234",
      project_id: "world-tianqi-jie",
      keys: ["林渊"],
      text: "林渊获得玄铁令。\n",
      updated_at: NOW,
    };
    expect(parseFact(serializeFact(base)).injection).toBeUndefined();
    const withInjection: FactRecord = {
      ...base,
      injection: { mode: "manual", priority: 90, position: "after_system", budget_tokens: 200, reveal_gate: "ch-030" },
    };
    expect(parseFact(serializeFact(withInjection))).toEqual(withInjection);
  });
});