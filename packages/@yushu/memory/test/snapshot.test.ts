import { describe, expect, it } from "vitest";
import {
  buildContextSnapshot,
  serializeContextSnapshot,
  assembleContext,
  CONTEXT_SNAPSHOT_FORMAT,
  type AssemblyItem,
} from "@yushu/memory";

/**
 * T3-9：上下文快照（预览器可复现载体）——
 * 命中键透传、指纹稳定（除 generated_at）、截断标记正确、序列化可读。
 */

function item(overrides: Partial<AssemblyItem> & { id: string; slot: AssemblyItem["slot"] }): AssemblyItem {
  return { title: overrides.id, text: "默认文本。", ...overrides } as AssemblyItem;
}

function sample() {
  return assembleContext(
    [
      item({ id: "system_prompt", slot: "system_prompt", stable: true, priority: 100, text: "人设与任务约束。" }),
      item({
        id: "fact-1",
        slot: "facts",
        title: "事实：fact-1",
        source: "trigger（命中）：玄铁令",
        matched_keys: ["玄铁令"],
        text: "主角获得玄铁令。",
      }),
      item({ id: "card-1", slot: "world_core", stable: true, text: "设定卡正文。" }),
    ],
    { budget_total: 32000 },
  );
}

describe("上下文快照（T3-9）", () => {
  it("命中键透传：assembled item 保留 matched_keys（未提供时为 []）", () => {
    const result = sample();
    const fact = result.slots.find((slot) => slot.slot === "facts")!.items[0]!;
    const card = result.slots.find((slot) => slot.slot === "world_core")!.items[0]!;
    expect(fact.matched_keys).toEqual(["玄铁令"]);
    expect(card.matched_keys).toEqual([]);
  });

  it("指纹：同输入两次调用一致（generated_at 不参与）；文本变化 → 指纹变化", () => {
    const first = buildContextSnapshot({ chapter: { id: "ch-1", title: "第一章", ordinal: 1, path: "chapters/v/ch-1.md" }, assembly: sample(), generatedAt: "2026-10-07T01:00:00.000Z" });
    const second = buildContextSnapshot({ chapter: { id: "ch-1", title: "第一章", ordinal: 1, path: "chapters/v/ch-1.md" }, assembly: sample(), generatedAt: "2026-10-07T09:59:59.000Z" });
    expect(first.fingerprint).toHaveLength(64);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.generated_at).not.toBe(first.generated_at);

    const changed = buildContextSnapshot({
      chapter: { id: "ch-1", title: "第一章", ordinal: 1, path: "chapters/v/ch-1.md" },
      assembly: assembleContext(
        [
          item({ id: "system_prompt", slot: "system_prompt", stable: true, priority: 100, text: "人设与任务约束（改）。" }),
          item({ id: "fact-1", slot: "facts", matched_keys: ["玄铁令"], text: "主角获得玄铁令。" }),
          item({ id: "card-1", slot: "world_core", stable: true, text: "设定卡正文。" }),
        ],
        { budget_total: 32000 },
      ),
      generatedAt: "2026-10-07T01:00:00.000Z",
    });
    expect(changed.fingerprint).not.toBe(first.fingerprint);
  });

  it("结构化列齐全：槽位 / 来源 / Token / 命中键 / 截断 + 逐出与去重证据 + RAG 回执", () => {
    const snapshot = buildContextSnapshot({
      chapter: { id: "ch-1", title: "第一章", ordinal: 1, path: "chapters/v/ch-1.md" },
      assembly: sample(),
      rag: { status: "ok", query: "林渊", hits: 2, store: "cosine" },
      generatedAt: "2026-10-07T01:00:00.000Z",
    });
    expect(snapshot.format).toBe(CONTEXT_SNAPSHOT_FORMAT);
    expect(snapshot.slots).toHaveLength(8);
    const factRow = snapshot.slots.flatMap((slot) => slot.items).find((entry) => entry.id === "fact-1")!;
    expect(factRow).toMatchObject({ tokens: expect.any(Number), truncated: false, matched_keys: ["玄铁令"] });
    expect(factRow.source).toContain("trigger");
    expect(snapshot.rag).toMatchObject({ status: "ok", hits: 2, store: "cosine" });
    const text = serializeContextSnapshot(snapshot);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).fingerprint).toBe(snapshot.fingerprint);
  });

  it("被截断项标记正确：小预算 → 条目 truncated 标记 + truncatedItems 计数 + dropped 证据", () => {
    const assembly = assembleContext(
      [
        item({
          id: "system_prompt",
          slot: "system_prompt",
          stable: true,
          priority: 100,
          text: "人设与任务约束：你只输出正文，不解释、不评价；保持世界观一致，遵循既定风格与视角，避免剧透。",
        }),
        item({ id: "fact-1", slot: "facts", text: "主角获得玄铁令并离开边城。" }),
      ],
      { budget_total: 40 },
    );
    const snapshot = buildContextSnapshot({
      chapter: { id: "ch-1", title: "第一章", ordinal: 1, path: "chapters/v/ch-1.md" },
      assembly,
      generatedAt: "2026-10-07T01:00:00.000Z",
    });
    expect(snapshot.truncatedItems).toBeGreaterThanOrEqual(1);
    const systemItem = snapshot.slots.find((slot) => slot.slot === "system_prompt")!.items[0]!;
    expect(systemItem.truncated).toBe(true);
    expect(snapshot.dropped.some((entry) => entry.reason === "budget")).toBe(true);
    expect(snapshot.totalTokens).toBeLessThanOrEqual(40);
  });
});