import { describe, expect, it } from "vitest";
import {
  buildConsistencyReport,
  locateCardRefSpans,
  locatePowerLogSpans,
  parseConsistencyAllowList,
  serializeConsistencyAllowList,
  type ConsistencyAllowList,
} from "../src/consistency-report.js";
import { checkStructure, type IndexEntityRow } from "@yushu/world-engine";

/**
 * 一致性豁免清单（M4 / T4-3，docs/03 §11.2 与 docs/04 §7.5 A6）。
 *
 * A6 的原文是「误报白名单必须记录理由，且有审计入口」——所以这份清单的关键不是能不能豁免，
 * 而是**没有理由就不许豁免**。空 reason、缺 subject 的"整条规则一刀切"都要被拒。
 */

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as { code?: string }).code ?? "(无 code)";
  }
  return "(未抛错)";
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  return "(未抛错)";
}

const GOOD = [
  "apiVersion: yushu.consistency-allow/v1",
  "entries:",
  "  - rule: ref-dangling",
  "    subject: char-linyuan",
  "    related: fac-ghost",
  "    reason: 该门派在第二部才登场，此处是有意留白",
  "    decided_at: 2026-10-09T10:00:00.000Z",
].join("\n");

describe("豁免清单解析", () => {
  it("正常清单可解析并保留审计字段", () => {
    const allow = parseConsistencyAllowList(GOOD);
    expect(allow.entries).toHaveLength(1);
    expect(allow.entries[0]).toMatchObject({
      rule: "ref-dangling",
      subject: "char-linyuan",
      related: "fac-ghost",
    });
    expect(allow.entries[0]!.reason).toContain("有意留白");
    expect(allow.entries[0]!.decidedAt).toBe("2026-10-09T10:00:00.000Z");
  });

  it("不该放过：reason 缺失或只有空白字符 → 拒绝加载（A6 的硬要求）", () => {
    const noReason = ["apiVersion: yushu.consistency-allow/v1", "entries:", "  - rule: ref-dangling", "    subject: char-a"].join("\n");
    expect(codeOf(() => parseConsistencyAllowList(noReason))).toBe("E_CONSISTENCY_ALLOW");
    expect(messageOf(() => parseConsistencyAllowList(noReason))).toContain("reason");

    const blank = ["apiVersion: yushu.consistency-allow/v1", "entries:", "  - rule: ref-dangling", "    subject: char-a", '    reason: "   "', "    decided_at: 2026-10-09T10:00:00.000Z"].join("\n");
    expect(codeOf(() => parseConsistencyAllowList(blank))).toBe("E_CONSISTENCY_ALLOW");
  });

  it("apiVersion 必填且必须是本版本；未知键一律拒绝", () => {
    expect(codeOf(() => parseConsistencyAllowList("entries: []"))).toBe("E_CONSISTENCY_ALLOW");
    expect(messageOf(() => parseConsistencyAllowList("entries: []"))).toContain("apiVersion");
    expect(codeOf(() => parseConsistencyAllowList("apiVersion: yushu.consistency-allow/v2\nentries: []"))).toBe("E_CONSISTENCY_ALLOW");
    expect(messageOf(() => parseConsistencyAllowList("apiVersion: yushu.consistency-allow/v1\nentriess: []"))).toContain("未知键");
    expect(
      messageOf(() =>
        parseConsistencyAllowList(["apiVersion: yushu.consistency-allow/v1", "entries:", "  - rule: ref-dangling", "    subject: char-a", "    reason: r", "    until: never"].join("\n")),
      ),
    ).toContain("until");
  });

  it("rule 必须是已知规则 id，subject 不得为空（防止整条规则一刀切）", () => {
    expect(
      messageOf(() =>
        parseConsistencyAllowList(["apiVersion: yushu.consistency-allow/v1", "entries:", "  - rule: whatever", "    subject: char-a", "    reason: r"].join("\n")),
      ),
    ).toContain("whatever");
    expect(
      messageOf(() =>
        parseConsistencyAllowList(["apiVersion: yushu.consistency-allow/v1", "entries:", "  - rule: ref-dangling", '    subject: ""', "    reason: r"].join("\n")),
      ),
    ).toContain("subject");
  });

  it("空清单合法（就是没豁免）；related 与 decided_at 可缺省", () => {
    const allow = parseConsistencyAllowList("apiVersion: yushu.consistency-allow/v1\nentries: []");
    expect(allow.entries).toEqual([]);
    const minimal = parseConsistencyAllowList(
      ["apiVersion: yushu.consistency-allow/v1", "entries:", "  - rule: ref-cycle", "    subject: char-a", "    reason: 有意的双线叙事"].join("\n"),
    );
    expect(minimal.entries[0]!.related).toBeUndefined();
    expect(minimal.entries[0]!.decidedAt).toBeUndefined();
  });
});

describe("豁免清单序列化", () => {
  it("往返一致：解析 → 序列化 → 再解析，内容不变", () => {
    const allow = parseConsistencyAllowList(GOOD);
    expect(parseConsistencyAllowList(serializeConsistencyAllowList(allow))).toEqual(allow);
  });

  it("同输入同字节（可 diff、可进快照），且键顺序固定", () => {
    const allow: ConsistencyAllowList = parseConsistencyAllowList(GOOD);
    const first = serializeConsistencyAllowList(allow);
    const second = serializeConsistencyAllowList({ apiVersion: allow.apiVersion, entries: [...allow.entries] });
    expect(second).toBe(first);
    expect(first.indexOf("rule:")).toBeLessThan(first.indexOf("subject:"));
    expect(first.indexOf("reason:")).toBeLessThan(first.indexOf("decided_at:"));
  });
});

/* ---------------- 原文区间与报告结构（A4：每条发现可跳到原文并显示出处） ---------------- */

const CARD_TEXT = [
  "---",
  "id: char-linyuan",
  "type: character",
  "name: 林渊",
  "layer: characters",
  "refs:",
  "  - relation: 师从",
  "    target: fac-ghost",
  "  - relation: 宿敌",
  "    target: char-haize",
  "---",
  "",
  "边城少年，剑道天赋被夺。",
].join("\n");

const entity = (over: Partial<IndexEntityRow> = {}): IndexEntityRow => ({
  id: "char-linyuan",
  type: "character",
  layer: "characters",
  name: "林渊",
  aliases: [],
  visibility: "revealed",
  filePath: "world/cards/character/char-linyuan.md",
  ...over,
});

describe("locateCardRefSpans：引用条目的原文区间", () => {
  it("每个 ref 条目给出可用的 UTF-16 区间，切片正好是那段 YAML", () => {
    const spans = locateCardRefSpans(CARD_TEXT);
    expect(spans.map((span) => span.target)).toEqual(["fac-ghost", "char-haize"]);
    const first = spans[0]!;
    const slice = CARD_TEXT.slice(first.start, first.end);
    expect(slice).toContain("relation: 师从");
    expect(slice).toContain("target: fac-ghost");
  });

  it("含中文与全角标点的正文里偏移也不错位（切片必须精确）", () => {
    const spans = locateCardRefSpans(CARD_TEXT);
    for (const span of spans) {
      expect(CARD_TEXT.slice(span.start, span.end)).toContain(span.target);
    }
  });

  it("不该抛错：没有 refs、非法 YAML、frontmatter 缺失都返回空数组", () => {
    expect(locateCardRefSpans("---\nid: x\n---\n正文\n")).toEqual([]);
    expect(locateCardRefSpans("不是合法 frontmatter")).toEqual([]);
    expect(locateCardRefSpans("")).toEqual([]);
  });
});

describe("buildConsistencyReport：span + evidence + fix 三件套", () => {
  const danglingFindings = () =>
    checkStructure({
      entities: [entity(), entity({ id: "char-haize", name: "海泽" })],
      refs: [
        { referrer: "char-linyuan", relation: "师从", target: "fac-ghost" },
        { referrer: "char-linyuan", relation: "宿敌", target: "char-haize" },
      ],
    }).findings;

  it("悬空引用挂上文件与精确区间，fix 给出可执行方向（含豁免出口）", () => {
    const report = buildConsistencyReport({
      findings: danglingFindings(),
      entities: [entity(), entity({ id: "char-haize", name: "海泽" })],
      cardTexts: { "world/cards/character/char-linyuan.md": CARD_TEXT },
    });
    expect(report.entries).toHaveLength(1);
    const entry = report.entries[0]!;
    expect(entry.span).not.toBeNull();
    expect(entry.span!.file).toBe("world/cards/character/char-linyuan.md");
    expect(CARD_TEXT.slice(entry.span!.start, entry.span!.end)).toContain("fac-ghost");
    expect(entry.span!.text).toBe(CARD_TEXT.slice(entry.span!.start, entry.span!.end).trimEnd());
    expect(entry.evidence).toContain("师从");
    expect(entry.fix).toContain("config/consistency.yaml");
    expect(report.counted).toEqual({ findings: 1, entries: 1, suppressed: 0 });
  });

  it("不该造假：找不到原文时 span 为 null，而不是给一个 0-0 的假区间", () => {
    const report = buildConsistencyReport({ findings: danglingFindings(), entities: [entity()], cardTexts: {} });
    expect(report.entries[0]!.span).toBeNull();
  });

  it("环结论的区间落在环上那条边，并保留完整路径", () => {
    const aText = ["---", "id: char-a", "refs:", "  - relation: ally_of", "    target: char-b", "---", "", "正文"].join("\n");
    const bText = ["---", "id: char-b", "refs:", "  - relation: rival_of", "    target: char-a", "---", "", "正文"].join("\n");
    const entities = [entity({ id: "char-a", name: "A", filePath: "world/cards/character/char-a.md" }), entity({ id: "char-b", name: "B", filePath: "world/cards/character/char-b.md" })];
    const findings = checkStructure({
      entities,
      refs: [
        { referrer: "char-a", relation: "ally_of", target: "char-b" },
        { referrer: "char-b", relation: "rival_of", target: "char-a" },
      ],
    }).findings.filter((f) => f.rule === "ref-cycle");
    const report = buildConsistencyReport({
      findings,
      entities,
      cardTexts: { "world/cards/character/char-a.md": aText, "world/cards/character/char-b.md": bText },
    });
    expect(report.entries[0]!.path).toEqual(["char-a", "char-b", "char-a"]);
    const span = report.entries[0]!.span;
    expect(span).not.toBeNull();
    expect(span!.file).toBe("world/cards/character/char-a.md");
    expect(aText.slice(span!.start, span!.end)).toContain("char-b");
  });

  it("倒置引用的 fix 点名两个层级，不只给一句结论", () => {
    const findings = checkStructure({
      entities: [entity({ id: "geo-a", layer: "geography", name: "青云山" }), entity({ id: "char-a", layer: "characters", name: "林渊" })],
      refs: [{ referrer: "geo-a", relation: "born_story", target: "char-a" }],
    }).findings.filter((f) => f.rule === "layer-order-violation");
    const report = buildConsistencyReport({ findings, entities: [], cardTexts: {} });
    expect(report.entries[0]!.fix).toContain("geography");
    expect(report.entries[0]!.fix).toContain("characters");
  });
});

/* ---------------- 豁免（A6：必须记理由，且要看得见） ---------------- */

describe("豁免应用", () => {
  const findings = checkStructure({
    entities: [entity()],
    refs: [{ referrer: "char-linyuan", relation: "师从", target: "fac-ghost" }],
  }).findings;
  const base = { findings, entities: [entity()], cardTexts: { "world/cards/character/char-linyuan.md": CARD_TEXT } };

  it("匹配条目不进结论、进 suppressed，并带着理由与决策时间交给审计", () => {
    const allow = parseConsistencyAllowList(GOOD);
    const report = buildConsistencyReport({ ...base, allow });
    expect(report.entries).toEqual([]);
    expect(report.suppressed).toHaveLength(1);
    expect(report.suppressed[0]!.reason).toContain("有意留白");
    expect(report.suppressed[0]!.decidedAt).toBe("2026-10-09T10:00:00.000Z");
    expect(report.counted).toEqual({ findings: 1, entries: 0, suppressed: 1 });
  });

  it("不该豁免：related 不同就一条也不该被吞掉", () => {
    const allow = parseConsistencyAllowList(GOOD.replace("fac-ghost", "fac-other"));
    const report = buildConsistencyReport({ ...base, allow });
    expect(report.entries).toHaveLength(1);
    expect(report.suppressed).toEqual([]);
    expect(report.unusedAllow).toHaveLength(1);
  });

  it("不写 related 的豁免按「规则 + 主体」匹配（同一条引用的多处发现一并豁免）", () => {
    const allow = parseConsistencyAllowList(
      ["apiVersion: yushu.consistency-allow/v1", "entries:", "  - rule: ref-dangling", "    subject: char-linyuan", "    reason: 第二部再补"].join("\n"),
    );
    const report = buildConsistencyReport({ ...base, allow });
    expect(report.entries).toEqual([]);
    expect(report.suppressed).toHaveLength(1);
  });

  it("用不上的豁免要报出来——否则清单会越来越长而没人知道哪条已失效", () => {
    const allow = parseConsistencyAllowList(GOOD.replace("ref-dangling", "ref-cycle"));
    const report = buildConsistencyReport({ ...base, allow });
    expect(report.entries).toHaveLength(1);
    expect(report.unusedAllow).toEqual(["ref-cycle|char-linyuan|fac-ghost"]);
  });
});

/**
 * 派系包规则接入后的两处契约（R57）。
 *
 * 战力类结论来自包内 DSL 规则（id 形如 `power-no-regress`），不是内置那三条。
 * 两处必须同时放开，否则会出现"结论报得出来、豁免却写不进去"的半截状态：
 * ① 豁免清单的"rule 必须是已实现 id"要认得**本次参与求值的那些 id**（仍然不许豁免一条不存在的规则）；
 * ② 台账里的每一条要能定位回原文，作者才知道结论是从哪一行来的。
 */
const LF = String.fromCharCode(10);

describe("派系包规则的豁免与出处（R57）", () => {
  const allowText = (rule) =>
    ["apiVersion: yushu.consistency-allow/v1", "entries:", "  - rule: " + rule, "    subject: char-linyuan", "    reason: 作者确认这段是刻意反转", ""].join(LF);

  it("默认只认内置三条：包规则 id 不在已知集合里仍然拒载", () => {
    expect(() => parseConsistencyAllowList(allowText("power-no-regress"))).toThrowError(/已实现的规则 id/);
  });

  it("把参与求值的包规则 id 传进去就认（A6 仍要求写理由）", () => {
    const parsed = parseConsistencyAllowList(allowText("power-no-regress"), ["ref-dangling", "power-no-regress"]);
    expect(parsed.entries[0]!.rule).toBe("power-no-regress");
    expect(() => parseConsistencyAllowList(allowText("power-no-regress"), ["ref-dangling"])).toThrowError(/已实现的规则 id/);
  });

  it("power_log 各条能定位原文区间（供结论一键跳过去）", () => {
    const text = [
      "---",
      "id: char-linyuan",
      "type: character",
      "name: 林渊",
      "layer: characters",
      "aliases: []",
      "refs: []",
      "source_chapters: []",
      "visibility: hidden",
      "format_version: 1",
      "extensions:",
      "  power_log:",
      "    - chapter: 第 3 章",
      "      tier: 3",
      "      combat_power: 100",
      "    - chapter: 第 4 章",
      "      tier: 4",
      "      combat_power: 80",
      "---",
      "",
      "正文。",
      "",
    ].join(LF);
    const spans = locatePowerLogSpans(text);
    expect(spans).toHaveLength(2);
    const second = spans[1]!;
    expect(second.chapterNo).toBe(4);
    expect(text.slice(second.start, second.end)).toContain("combat_power: 80");
  });

  it("卡里没有 power_log 时返回空数组（不造区间）", () => {
    const text = ["---", "id: a", "type: character", "name: A", "layer: characters", "---", "", "正文。", ""].join(LF);
    expect(locatePowerLogSpans(text)).toEqual([]);
  });
});

/**
 * 派系包结论并入同一份报告（R57 的收口处）。
 *
 * 结构类结论与包规则结论必须走**同一条**报告通路：同一套 span、同一套豁免、同一个面板。
 * 长出第二套结果结构，是 docs/04 反复避免的事（T3-13 的 finding 同形口径同理）。
 */
describe("派系包结论并入同一份报告（R57）", () => {
  const entities = [
    {
      id: "char-linyuan",
      type: "character",
      layer: "characters",
      name: "林渊",
      aliases: [],
      visibility: "hidden",
      filePath: "world/cards/character/char-linyuan.md",
    },
  ];
  const cardText = [
    "---",
    "id: char-linyuan",
    "type: character",
    "name: 林渊",
    "layer: characters",
    "aliases: []",
    "refs: []",
    "source_chapters: []",
    "visibility: hidden",
    "format_version: 1",
    "extensions:",
    "  power_log:",
    "    - chapter: 第 3 章",
    "      tier: 3",
    "      combat_power: 100",
    "    - chapter: 第 4 章",
    "      tier: 4",
    "      combat_power: 80",
    "---",
    "",
    "正文。",
    "",
  ].join(LF);

  const packFinding = {
    rule: "power-no-regress",
    severity: "error",
    subject: "char-linyuan",
    related: "第 4 章",
    evidence: "战力台账：第 3 章 境界 3 / 战力 100 → 第 4 章 境界 4 / 战力 80",
    fix: "补一条能解释回落的事件，或下调第 4 章的战斗表现",
    origin: "派系包 xuanhuan-xitong（rules/power-consistency.yaml）",
  };

  it("包规则结论带出处进报告，span 落在战力台账那一行而不是 refs", () => {
    const result = buildConsistencyReport({
      findings: [packFinding],
      entities,
      cardTexts: { "world/cards/character/char-linyuan.md": cardText },
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.rule).toBe("power-no-regress");
    expect(result.entries[0]!.origin).toContain("xuanhuan-xitong");
    const span = result.entries[0]!.span;
    expect(span).not.toBeNull();
    expect(cardText.slice(span!.start, span!.end)).toContain("combat_power: 80");
    expect(result.entries[0]!.fix).toContain("下调");
  });

  it("豁免清单能豁免包规则：进 suppressed 带理由，不是静默消失", () => {
    const allow = parseConsistencyAllowList(["apiVersion: yushu.consistency-allow/v1", "entries:", "  - rule: power-no-regress", "    subject: char-linyuan", "    related: 第 4 章", "    reason: 作者确认这段是刻意反转", ""].join(LF), ["ref-dangling", "power-no-regress"]);
    const result = buildConsistencyReport({
      findings: [packFinding],
      entities,
      cardTexts: { "world/cards/character/char-linyuan.md": cardText },
      allow,
    });
    expect(result.entries).toEqual([]);
    expect(result.suppressed).toHaveLength(1);
    expect(result.suppressed[0]!.reason).toContain("刻意");
    expect(result.unusedAllow).toEqual([]);
  });

  it("找不到对应台账行时给 null 区间，不造 0-0 假位置", () => {
    const result = buildConsistencyReport({
      findings: [{ ...packFinding, related: "第 99 章" }],
      entities,
      cardTexts: { "world/cards/character/char-linyuan.md": cardText },
    });
    expect(result.entries[0]!.span).toBeNull();
  });
});

/**
 * 采样类结论自带区间（R58）。
 *
 * AI 采样指认的是**章节正文里的某一段**，不是设定卡 frontmatter 的某条引用——
 * 所以这条结论必须能把区间直接带进来，而不是只能靠"按 related 去卡里找"。
 * 找不到卡不等于找不到原文。
 */
describe("结论自带原文区间（R58 采样类）", () => {
  it("自带 span 的结论原样带出，不因不在设定卡里就塌成 null", () => {
    const result = buildConsistencyReport({
      findings: [
        {
          rule: "ai-sampled-drift",
          severity: "warn",
          subject: "ch-001",
          evidence: "该段断言「玉佩出自皇室」，设定库与出处记忆中均无支撑",
          fix: "补一条设定来源，或改写为角色猜测",
          origin: "AI 采样（mock / mock-model）",
          span: { file: "chapters/vol-1/ch-001.md", start: 4, end: 20, text: "夜色像水一样" },
        },
      ],
      entities: [],
      cardTexts: {},
    });
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.span).toMatchObject({ file: "chapters/vol-1/ch-001.md", start: 4, end: 20 });
    expect(result.entries[0]!.origin).toContain("AI 采样");
  });
});

