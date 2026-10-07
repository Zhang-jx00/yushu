import { describe, expect, it } from "vitest";
import {
  EXTRACT_SCHEMA_ID,
  buildExtractionCandidates,
  candidateToCardDraft,
  classifyCandidate,
  parseExtractionOutput,
  type ExistingCardRef,
} from "@yushu/world-engine";

/**
 * T3-10 设定抽取：JSON Schema 后校验（含无出处拒绝）、冲突三分类（new / augment / conflict）、
 * 候选组装（candidate_id 序 + status 强制 candidate）与设定卡草案（出处契约）。
 */

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    type: "character",
    name: "林渊",
    aliases: ["小渊"],
    summary: "边城少年，夜探藏经阁。",
    quote: "林渊抬手推开了藏经阁的木门",
    confidence: 0.82,
    ...overrides,
  };
}

const existing: ExistingCardRef[] = [
  { id: "char-abc", type: "character", name: "林渊", aliases: ["小渊"] },
  { id: "law-def", type: "law", name: "灵气法则", aliases: [] },
];

describe("抽取输出 schema 后校验（T3-10）", () => {
  it("合法输出：清洗为候选输入（aliases 缺省补空）", () => {
    const result = parseExtractionOutput({ candidates: [candidate(), candidate({ name: "玄铁令", type: "item", aliases: undefined })] });
    expect(result.issues).toEqual([]);
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates[1]!.aliases).toEqual([]);
    expect(result.candidates[0]!.quote).toContain("藏经阁");
  });

  it("缺失出处 / 未知类型 / 置信度越界 → issues（无出处不得进入候选）", () => {
    const missingQuote = parseExtractionOutput({ candidates: [candidate({ quote: "" })] });
    expect(missingQuote.issues.length).toBeGreaterThan(0);
    expect(missingQuote.candidates).toEqual([]);

    const badType = parseExtractionOutput({ candidates: [candidate({ type: "spaceship" })] });
    expect(badType.issues.length).toBeGreaterThan(0);

    const badConfidence = parseExtractionOutput({ candidates: [candidate({ confidence: 1.4 })] });
    expect(badConfidence.issues.length).toBeGreaterThan(0);

    const notObject = parseExtractionOutput("candidates 不是对象");
    expect(notObject.issues.length).toBeGreaterThan(0);
  });

  it("schema id 与输出 schema 登记（契约可被外部复用）", () => {
    expect(EXTRACT_SCHEMA_ID).toBe("yushu.extract/entity-candidates/v1");
  });
});

describe("候选与既有卡三分类（T3-10）", () => {
  it("new：无名称 / 别名匹配", () => {
    const diff = classifyCandidate(candidate({ name: "玄铁令", type: "item", aliases: [] }), existing);
    expect(diff.kind).toBe("new");
    expect(diff.matched_card_id).toBeUndefined();
  });

  it("augment：同名同类型（名称 / 别名归一：去空白、大小写不敏感）", () => {
    const diff = classifyCandidate(candidate({ name: " 林渊 ", aliases: ["小渊"] }), existing);
    expect(diff.kind).toBe("augment");
    expect(diff.matched_card_id).toBe("char-abc");
    const aliasHit = classifyCandidate(candidate({ name: "渊儿", aliases: ["小渊"], type: "character" }), existing);
    expect(aliasHit.kind).toBe("augment");
    const ascii = classifyCandidate(
      candidate({ name: "LinYuan", aliases: [] }),
      [{ id: "char-xyz", type: "character", name: "linyuan", aliases: [] }],
    );
    expect(ascii.kind).toBe("augment");
  });

  it("conflict：同名异类型（AI 不得覆盖——需人工处置）", () => {
    const diff = classifyCandidate(candidate({ type: "location" }), existing);
    expect(diff.kind).toBe("conflict");
    expect(diff.matched_card_id).toBe("char-abc");
    expect(diff.reason).toContain("类型不同");
  });
});

describe("候选组装与设定卡草案（T3-10）", () => {
  it("candidate_id 按序生成、status 强制 candidate、diff 分类随行", () => {
    const candidates = buildExtractionCandidates(
      [
        candidate(),
        candidate({ name: "玄铁令", type: "item", aliases: [] }),
        candidate({ name: "林渊", type: "location", aliases: [] }),
      ],
      existing,
    );
    expect(candidates.map((item) => item.candidate_id)).toEqual(["cand-0001", "cand-0002", "cand-0003"]);
    expect(candidates.every((item) => item.status === "candidate")).toBe(true);
    expect(candidates.map((item) => item.diff.kind)).toEqual(["augment", "new", "conflict"]);
  });

  it("candidateToCardDraft：层级映射 + source_chapters + extensions.extract（状态 / 出处 / 置信度）+ 正文引文", () => {
    const [first] = buildExtractionCandidates([candidate()], existing);
    const draft = candidateToCardDraft(first!, { chapterId: "ch-012" });
    expect(draft.card.type).toBe("character");
    expect(draft.card.layer).toBe("characters");
    expect(draft.card.sourceChapters).toEqual(["ch-012"]);
    const extract = (draft.card.extensions as { extract: Record<string, unknown> }).extract;
    expect(extract["status"]).toBe("accepted");
    expect(extract["candidate_id"]).toBe("cand-0001");
    expect(extract["chapter_id"]).toBe("ch-012");
    expect(String(extract["quote"])).toContain("藏经阁");
    expect(draft.body).toContain("抽取出处（ch-012）");

    const itemDraft = candidateToCardDraft(
      buildExtractionCandidates([candidate({ name: "玄铁令", type: "item", aliases: [] })], existing)[0]!,
      { chapterId: "ch-012" },
    );
    expect(itemDraft.card.layer).toBe("laws");
  });
});