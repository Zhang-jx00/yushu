import { describe, expect, it } from "vitest";
import {
  STRUCTURE_RULE_IDS,
  cardPath,
  checkStructureFromSources,
  createSettingCard,
  serializeCardFile,
  type IndexSourceReader,
  type StructureRuleId,
} from "@yushu/world-engine";

/**
 * T4-11 规则回归集（结构完整性三条 error 级规则）。
 *
 * 与 consistency.test.ts 的分工：那份按规则逐条验语义，这份按**整套规则**跑同一批夹具，
 * 钉两件事：
 * ① 干净语料**零误报**（误报率断言为 0——作者看到假问题就会开始无视真问题）；
 * ② 单点故障**只点亮对应那一条**（注入了悬空引用却同时报出层级倒置，说明规则互相污染）。
 * 夹具全部走纯真源（readerOf 内存文件），不碰 SQLite：索引可删，删库后结论必须不变（A5）。
 */

function readerOf(files: Record<string, string>): IndexSourceReader {
  return {
    listFiles: async () => Object.entries(files).map(([path, text]) => ({ path, size: text.length })),
    readText: async (path) => {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
  };
}

const card = (id: string, type: string, layer: string, refs: Array<{ relation: string; target: string }> = []) =>
  serializeCardFile(createSettingCard({ id, type, name: id, layer, aliases: [], refs }), `${id} 的正文。`);

/** 把卡按权威路径铺成内存语料（路径写错会让 collectIndexInput 认不出类型，夹具就白搭） */
function corpus(cards: Array<{ id: string; type: string; layer: string; refs?: Array<{ relation: string; target: string }> }>): Record<string, string> {
  const files: Record<string, string> = {};
  for (const c of cards) files[cardPath(c.type, c.id)] = card(c.id, c.type, c.layer, c.refs ?? []);
  return files;
}

/**
 * 干净语料：依赖一律**指向更上游的层**（characters→geography→laws），无环、无悬空。
 * 层序口径见 docs/03：LAYER_KEYS 靠前者是上游，上游引用下游才是倒置。
 */
const CLEAN = [
  { id: "law-qi", type: "skill", layer: "laws" as const },
  { id: "geo-city", type: "location", layer: "geography" as const, refs: [{ relation: "受制于", target: "law-qi" }] },
  { id: "char-linyuan", type: "character", layer: "characters" as const, refs: [{ relation: "生于", target: "geo-city" }] },
  { id: "evt-duel", type: "event", layer: "events" as const, refs: [{ relation: "涉及", target: "char-linyuan" }] },
];

interface FaultCase {
  name: string;
  /** 期望且仅期望出现的规则（顺序无关） */
  expect: StructureRuleId[];
  cards: typeof CLEAN;
}

const FAULT_CASES: FaultCase[] = [
  {
    name: "悬空引用（指向不存在的实体）",
    expect: ["ref-dangling"],
    cards: [
      ...CLEAN,
      { id: "char-other", type: "character", layer: "characters", refs: [{ relation: "师从", target: "fac-ghost" }] },
    ],
  },
  {
    name: "引用成环（同层互指，不叠加层级倒置）",
    expect: ["ref-cycle"],
    cards: [
      ...CLEAN,
      { id: "char-a", type: "character", layer: "characters", refs: [{ relation: "依赖", target: "char-b" }] },
      { id: "char-b", type: "character", layer: "characters", refs: [{ relation: "依赖", target: "char-a" }] },
    ],
  },
  {
    name: "层级倒置（上游 laws 引用下游 characters）",
    expect: ["layer-order-violation"],
    cards: [
      ...CLEAN,
      { id: "law-extra", type: "skill", layer: "laws", refs: [{ relation: "依赖", target: "char-linyuan" }] },
    ],
  },
];

async function run(files: Record<string, string>) {
  const report = await checkStructureFromSources(readerOf(files));
  return {
    rules: report.findings.map((f) => f.rule).sort(),
    findings: report.findings,
    refs: report.checked.refs,
  };
}

describe("T4-11 结构规则回归集", () => {
  it("干净语料零误报（误报率必须为 0）", async () => {
    const r = await run(corpus(CLEAN));
    const falsePositiveRate = r.findings.length === 0 ? 0 : r.findings.length / Math.max(1, r.refs);
    expect(r.findings.map((f) => [f.rule, f.subject, f.related])).toEqual([]);
    expect(falsePositiveRate).toBe(0);
    // 语料确实被读进来了：零发现不能是"什么都没扫"造成的假绿
    expect(r.refs).toBe(3);
  });

  for (const item of FAULT_CASES) {
    it(`${item.name}：只点亮这一条规则，不牵连其他`, async () => {
      const r = await run(corpus(item.cards));
      expect(r.rules).toEqual([...item.expect].sort());
      for (const finding of r.findings) expect(finding.severity).toBe("error");
    });
  }

  it("回归集覆盖全部已实现的结构规则（新增规则不补样例就红）", () => {
    const covered = new Set(FAULT_CASES.flatMap((c) => c.expect));
    for (const id of STRUCTURE_RULE_IDS) {
      expect(covered.has(id), `缺少 ${id} 的正例夹具`).toBe(true);
    }
    expect(STRUCTURE_RULE_IDS.length).toBe(3);
  });

  it("同一语料两次求值结论逐字一致（确定性）", async () => {
    const files = corpus(FAULT_CASES[1]!.cards);
    const a = await run(files);
    const b = await run(files);
    expect(JSON.stringify(a.findings)).toEqual(JSON.stringify(b.findings));
  });
});
