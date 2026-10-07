import { describe, expect, it } from "vitest";
import {
  MemoryError,
  applyAiSummary,
  applyHumanSummaryEdit,
  buildFactSource,
  canAiWriteSummary,
  lintMemory,
  mentionedEntityIds,
  parseChapterSummary,
  parseFact,
  parseVolumeSummary,
  serializeFact,
  serializeSummary,
  trackMentions,
  verifyFactSource,
  type FactRecord,
  type SummaryRecord,
} from "@yushu/memory";

/**
 * T3-5：五层记忆数据层——摘要/事实记录解析与写入规则（human rev 保护、AI 候选化）、
 * 出处链校验（chapter + 区间 + hash）、提及追踪与跨项目隔离（红线）。
 */

const NOW = "2026-10-07T12:00:00.000Z";

function summary(layer: "volume_summary" | "chapter_summary", rev = 0): SummaryRecord {
  return {
    layer,
    id: layer === "volume_summary" ? "vol-aaaaaa" : "ch-bbbbbb",
    project_id: "world-tianqi-jie",
    ...(layer === "chapter_summary" ? { volume_id: "vol-aaaaaa" } : {}),
    summary_rev: rev,
    updated_at: NOW,
    text: "第一章：少年林渊登场。\n",
  };
}

describe("摘要记录（T3-5）", () => {
  it("卷 / 章摘要序列化-解析往返一致（真源 Markdown + frontmatter）", () => {
    const chapter = summary("chapter_summary");
    const parsed = parseChapterSummary(serializeSummary(chapter));
    expect(parsed).toEqual(chapter);
    const volume = summary("volume_summary");
    expect(parseVolumeSummary(serializeSummary(volume))).toEqual(volume);
  });

  it("格式校验：layer 不符 / rev 非法 / 缺 project_id / 无 frontmatter 均明确报错", () => {
    const text = serializeSummary(summary("chapter_summary"));
    expect(() => parseVolumeSummary(text)).toThrowError(/layer/);
    expect(() => parseChapterSummary(text.replace("summary_rev: 0", "summary_rev: -1"))).toThrowError(
      /summary_rev/,
    );
    expect(() => parseChapterSummary(text.replace(/project_id: .*/, ""))).toThrowError(/project_id/);
    expect(() => parseChapterSummary("没有 frontmatter 的文本")).toThrowError(/frontmatter/);
  });

  it("AI 写入规则：rev = 0 可写；rev > 0 拒绝覆盖（E_MEMORY_REV_PROTECTED，候选化）", () => {
    expect(canAiWriteSummary(null)).toBe(true);
    expect(canAiWriteSummary(summary("chapter_summary", 0))).toBe(true);
    expect(canAiWriteSummary(summary("chapter_summary", 1))).toBe(false);

    const fresh = applyAiSummary("chapter_summary", null, {
      id: "ch-bbbbbb",
      project_id: "world-tianqi-jie",
      volume_id: "vol-aaaaaa",
      text: "AI 摘要",
    }, NOW);
    expect(fresh.summary_rev).toBe(0);
    expect(fresh.text).toBe("AI 摘要\n");

    let error: MemoryError | null = null;
    try {
      applyAiSummary("chapter_summary", summary("chapter_summary", 2), {
        id: "ch-bbbbbb",
        project_id: "world-tianqi-jie",
        text: "试图覆盖",
      }, NOW);
    } catch (err) {
      error = err as MemoryError;
    }
    expect(error?.code).toBe("E_MEMORY_REV_PROTECTED");
    expect(error?.message).toContain("人工修订");
  });

  it("人工编辑：rev 每次 +1（从无到有从 1 起）", () => {
    const first = applyHumanSummaryEdit(null, { id: "ch-bbbbbb", project_id: "p", text: "人工" }, NOW, "chapter_summary");
    expect(first.summary_rev).toBe(1);
    const second = applyHumanSummaryEdit(first, { id: "ch-bbbbbb", project_id: "p", text: "人工二改" }, NOW, "chapter_summary");
    expect(second.summary_rev).toBe(2);
    expect(second.text).toBe("人工二改\n");
  });
});

describe("事实级记忆与出处链（T3-5）", () => {
  const body = "林渊握紧了玄铁令，剑意森然。";

  it("buildFactSource + verify：区间摘录 hash 校验通过", () => {
    const source = buildFactSource("ch-1", body, 6, 10); // 「玄铁令」
    expect(source).toMatchObject({ chapter_id: "ch-1", start: 6, end: 10 });
    expect(verifyFactSource(source, body)).toEqual({ ok: true });
    const fact: FactRecord = {
      layer: "fact",
      id: "fact-1",
      project_id: "world-tianqi-jie",
      keys: ["林渊"],
      text: "林渊持有玄铁令。\n",
      source,
      updated_at: NOW,
    };
    expect(parseFact(serializeFact(fact))).toEqual(fact);
  });

  it("正文改动 / 越界：出处失效给出原因（绝不静默沿用）", () => {
    const source = buildFactSource("ch-1", body, 6, 10);
    const edited = "林渊握紧了乌木令，剑意森然。";
    const check = verifyFactSource(source, edited);
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.reason).toContain("hash 不匹配");
    const short = verifyFactSource({ ...source, start: 0, end: 999 }, body);
    expect(short.ok).toBe(false);
    expect(short.ok === false && short.reason).toContain("超出正文长度");
    expect(() => buildFactSource("ch-1", body, 5, 999)).toThrowError(/超出章节正文长度/);
    expect(() => buildFactSource("ch-1", body, 8, 8)).toThrowError(/非法字符区间/);
  });

  it("事实解析：keys 必填；source 可缺省（lint 给 warn）", () => {
    const noSource: FactRecord = {
      layer: "fact",
      id: "fact-2",
      project_id: "p",
      keys: ["妖丹"],
      text: "妖丹可炼。\n",
      updated_at: NOW,
    };
    expect(parseFact(serializeFact(noSource))).toEqual(noSource);
    const findings = lintMemory([noSource, { ...noSource, id: "fact-3", keys: [] }], "p");
    expect(findings.filter((f) => f.severity === "warn").map((f) => f.code)).toEqual([
      "memory-fact-no-source",
      "memory-fact-no-source",
      "memory-fact-no-keys",
    ]);
    // 非法 source 区间（end <= start）解析即报错
    expect(() =>
      parseFact(serializeFact({ ...noSource, source: { chapter_id: "ch-1", start: 9, end: 3, hash: "h" } })),
    ).toThrowError(/字符区间非法/);
  });
});

describe("跨项目隔离（A5 红线）", () => {
  it("lintMemory：project_id 不匹配 → error（memory-cross-project-leak）", () => {
    const mine = summary("chapter_summary");
    const foreign = { ...summary("chapter_summary"), id: "ch-other", project_id: "world-other" };
    const findings = lintMemory([mine, foreign], "world-tianqi-jie");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ severity: "error", code: "memory-cross-project-leak", record_id: "ch-other" });
    expect(findings[0]?.message).toContain("跨项目泄漏");
  });
});

describe("提及追踪（T3-5 → T3-6 注入触发）", () => {
  const targets = [
    { id: "char-lin", name: "林渊", aliases: ["小渊", "林师兄"] },
    { id: "item-ling", name: "玄铁令" },
  ];

  it("名称与别名均可命中；最长匹配优先、区间不重叠、按位置排序", () => {
    const text = "小渊握着玄铁令，林师兄赶来，林渊之名震慑全场。";
    const hits = trackMentions(text, targets);
    expect(hits.map((hit) => [hit.matched, hit.start])).toEqual([
      ["小渊", 0],
      ["玄铁令", 4],
      ["林师兄", 8],
      ["林渊", 14],
    ]);
    // 长名优先：加入「林渊之」目标后，长名整体命中
    const withLong = trackMentions("林渊之名震四方", [targets[0]!, { id: "extra", name: "林渊之" }]);
    expect(withLong).toHaveLength(1);
    expect(withLong[0]).toMatchObject({ entity_id: "extra", matched: "林渊之", start: 0, end: 3 });
  });

  it("mentionedEntityIds：按首次出现去重（注入触发的键集合）", () => {
    const text = "玄铁令现世；小渊与林师兄同行。";
    expect(mentionedEntityIds(text, targets)).toEqual(["item-ling", "char-lin"]);
    expect(mentionedEntityIds("空", targets)).toEqual([]);
    expect(trackMentions("", targets)).toEqual([]);
  });
});