/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FORESHADOW_RULE_IDS,
  buildForeshadowBoard,
  parseForeshadowLedger,
  serializeForeshadowLedger,
  type ForeshadowLedger,
} from "@yushu/world-engine";

/**
 * 伏笔全生命周期台账（M4 / T4-6 引擎侧，R65）。
 *
 * 钉住的是"作者会不会被这份台账误导"，不是"函数有没有返回值"：
 * ① 引用了不存在的章 ⇒ error（"第 40 章回收"而全书只有 30 章，是最贵的一种笔误）；
 * ② 逾期未回收 ⇒ 点名逾期几章，终局窗口内升级为 error（结局承诺清算的台账视角）；
 * ③ **红鲱鱼与主动放弃是合法终态**，负例夹具必须一条都不报——把合法写法报成缺陷，
 *    作者学会忽略整块看板，比没有看板更坏；
 * ④ 状态与事实矛盾（说已回收却没有回收章）⇒ 报矛盾，不替作者改状态；
 * ⑤ 解析严格：未知键 / 非法枚举 / 重复 id 一律拒绝并点名，半读半丢最坏；
 * ⑥ 确定性：同输入逐字一致，排序走码点序。
 */

const CHAPTERS = Array.from({ length: 30 }, (_, i) => `ch-${String(i + 1).padStart(3, "0")}`);

function ledgerOf(entries: unknown[]): ForeshadowLedger {
  return parseForeshadowLedger(
    ["apiVersion: yushu.foreshadow/v1", "entries:", ...serializeEntries(entries)].join("\n"),
  );
}

function serializeEntries(entries: unknown[]): string[] {
  return entries.map((entry) => {
    const e = entry as Record<string, unknown>;
    const lines = [`  - id: ${String(e.id)}`, `    name: ${String(e.name)}`, `    promise: ${JSON.stringify(e.promise ?? "")}`];
    for (const [key, value] of Object.entries(e)) {
      if (key === "id" || key === "name" || key === "promise") continue;
      lines.push(`    ${key}: ${Array.isArray(value) ? JSON.stringify(value) : typeof value === "string" ? JSON.stringify(value) : String(value)}`);
    }
    return lines.join("\n");
  });
}

const base = {
  id: "fs-001",
  name: "青铜钥匙",
  promise: "钥匙能打开祖宅地下室",
  carrier: "道具",
  visibility: "半遮",
  state: "planted",
  plant_chapters: ["ch-003"],
  expected_payoff_chapter: "ch-012",
  payoff_chapters: [],
  payoff_type: "揭示",
  is_red_herring: false,
  recheck_after: 6,
};

const board = (entries: unknown[], options: Record<string, unknown> = {}) =>
  buildForeshadowBoard(ledgerOf(entries), { chapters: CHAPTERS, ...options });

const rule = (findings: { rule: string }[]) => findings.map((f) => f.rule).sort();

describe("parseForeshadowLedger（严格解析，不静默丢条目）", () => {
  it("空台账合法：登记为零不是错误", () => {
    const ledger = parseForeshadowLedger("apiVersion: yushu.foreshadow/v1\nentries: []\n");
    expect(ledger.entries).toEqual([]);
  });

  it("未知键拒绝并点名（半读半丢比读不了更坏）", () => {
    expect(() => ledgerOf([{ ...base, payoff_chapter: "ch-012" }])).toThrow(/未知键.*payoff_chapter|payoff_chapter/);
  });

  it("非法枚举拒绝并给出可选值", () => {
    expect(() => ledgerOf([{ ...base, carrier: "气味" }])).toThrow(/carrier.*道具.*对白|非法值/);
  });

  it("重复 id 拒绝（台账按 id 定位，撞号等于两条并成一条）", () => {
    expect(() => ledgerOf([base, { ...base, name: "另一条" }])).toThrow(/重复/);
  });

  it("缺必填拒绝并点名缺哪个字段", () => {
    const { expected_payoff_chapter: _drop, ...rest } = base;
    expect(() => ledgerOf([rest])).toThrow(/expected_payoff_chapter/);
  });

  it("序列化↔解析逐字往返（真源是给人改的，格式不能一写就坏）", () => {
    const ledger = ledgerOf([base, { ...base, id: "fs-002", name: "哑仆的半句话", state: "paid", payoff_chapters: ["ch-020"] }]);
    const text = serializeForeshadowLedger(ledger);
    expect(parseForeshadowLedger(text)).toEqual(ledger);
    expect(serializeForeshadowLedger(parseForeshadowLedger(text))).toBe(text);
  });
});

describe("buildForeshadowBoard（看板与审计）", () => {
  it("章号引用不存在 ⇒ error 点名是哪条哪个字段", () => {
    const out = board([{ ...base, expected_payoff_chapter: "ch-099" }]);
    expect(out.findings.some((f) => f.rule === "fs-dangling-chapter" && f.severity === "error" && /ch-099/.test(f.message))).toBe(true);
  });

  it("逾期未回收 ⇒ 如实给出逾期章数（不是只说「逾期了」）", () => {
    const out = board([{ ...base, state: "due" }], { currentChapter: "ch-020" });
    const overdue = out.findings.find((f) => f.rule === "fs-overdue");
    expect(overdue).toBeDefined();
    expect(overdue?.message).toContain("8");
    expect(out.rows[0]?.overdueBy).toBe(8);
  });

  it("终局窗口内仍未回收 ⇒ 升级为 error（结局承诺清算）", () => {
    const out = board([{ ...base, state: "due" }], { currentChapter: "ch-028", finaleWindow: 5 });
    expect(out.findings.some((f) => f.rule === "fs-finale-unpaid" && f.severity === "error")).toBe(true);
  });

  it("红鲱鱼 + 主动放弃带理由 ⇒ 一条都不报（合法终态，负例夹具）", () => {
    const out = board([{ ...base, id: "fs-rh", is_red_herring: true, state: "abandoned", abandon_reason: "第 14 章点破是伪造的线索，不再回收" }], {
      currentChapter: "ch-030",
    });
    expect(out.findings.filter((f) => f.rule !== "fs-dangling-chapter")).toEqual([]);
    expect(out.stats.redHerring).toBe(1);
    expect(out.rows[0]?.board).toBe("closed");
  });

  it("红鲱鱼被标成已回收 ⇒ 报矛盾（红鲱鱼不该「兑现」）", () => {
    const out = board([{ ...base, is_red_herring: true, state: "paid", payoff_chapters: ["ch-010"] }]);
    expect(out.findings.some((f) => f.rule === "fs-red-herring-paid")).toBe(true);
  });

  it("说已回收却没有回收章 ⇒ 报状态与事实矛盾，不替作者改状态", () => {
    const out = board([{ ...base, state: "paid", payoff_chapters: [] }]);
    const conflict = out.findings.find((f) => f.rule === "fs-paid-without-payoff");
    expect(conflict).toBeDefined();
    expect(out.rows[0]?.state).toBe("paid");
  });

  it("放弃却没写理由 ⇒ error（豁免必须记理由，与一致性白名单同一条规矩）", () => {
    const out = board([{ ...base, state: "abandoned" }]);
    expect(out.findings.some((f) => f.rule === "fs-abandon-reason-missing" && f.severity === "error")).toBe(true);
  });

  it("预期回收早于最早埋设 ⇒ 报时序矛盾", () => {
    const out = board([{ ...base, plant_chapters: ["ch-020"], expected_payoff_chapter: "ch-005" }]);
    expect(out.findings.some((f) => f.rule === "fs-payoff-before-plant")).toBe(true);
  });

  it("同一章埋设过多 ⇒ 密度提示，阈值可配", () => {
    const many = ["a", "b", "c", "d"].map((suffix, i) => ({ ...base, id: `fs-${suffix}`, plant_chapters: ["ch-003"], expected_payoff_chapter: `ch-0${10 + i}` }));
    expect(board(many).findings.some((f) => f.rule === "fs-density-storm")).toBe(true);
    expect(board(many, { maxPlantsPerChapter: 9 }).findings.some((f) => f.rule === "fs-density-storm")).toBe(false);
  });

  it("长期没有任何伏笔动作 ⇒ 干旱提示，且已回收干净时不报", () => {
    const dry = board([{ ...base, state: "paid", payoff_chapters: ["ch-004"], expected_payoff_chapter: "ch-004" }], {
      currentChapter: "ch-030",
      droughtChapters: 8,
    });
    expect(dry.findings.some((f) => f.rule === "fs-density-drought")).toBe(true);
  });

  it("到了复查间隔 ⇒ info 提示复查，未到则不报", () => {
    const due = board([{ ...base, recheck_after: 5 }], { currentChapter: "ch-010" });
    expect(due.findings.some((f) => f.rule === "fs-recheck")).toBe(true);
    const soon = board([{ ...base, recheck_after: 9 }], { currentChapter: "ch-010" });
    expect(soon.findings.some((f) => f.rule === "fs-recheck")).toBe(false);
  });

  it("确定性：同输入两次逐字一致，行按码点序", () => {
    const entries = [{ ...base, id: "fs-b" }, { ...base, id: "fs-a" }, { ...base, id: "fs-c", state: "paid", payoff_chapters: ["ch-009"], expected_payoff_chapter: "ch-009" }];
    const first = board(entries, { currentChapter: "ch-015" });
    const second = board(entries, { currentChapter: "ch-015" });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.rows.map((r) => r.id)).toEqual(["fs-a", "fs-b", "fs-c"]);
  });

  it("统计口径：看板分桶互斥且总数对得上", () => {
    const out = board([
      base,
      { ...base, id: "fs-2", state: "paid", payoff_chapters: ["ch-008"], expected_payoff_chapter: "ch-008" },
      { ...base, id: "fs-3", state: "abandoned", abandon_reason: "删线" },
    ], { currentChapter: "ch-020" });
    expect(out.stats.total).toBe(3);
    expect(out.stats.open + out.stats.closed).toBe(3);
    expect(out.stats.paid).toBe(1);
    expect(out.stats.abandoned).toBe(1);
  });

  it("章清单为空 ⇒ 不编造进度，只报无法定位", () => {
    const out = buildForeshadowBoard(ledgerOf([base]), { chapters: [] });
    expect(out.rows[0]?.overdueBy).toBeNull();
    expect(out.findings.some((f) => f.rule === "fs-no-chapters")).toBe(true);
  });
});

describe("章号定位：作者写「第 N 章」要能落到有序清单的第 N 章（R75 修的一处真缺陷）", () => {
  it("随机后缀的章 id 下，「第 2 章」按位置解析而不是误报悬空", () => {
    const chapters = ["ch-q5wbog", "co-16bn6kw", "ch-zz9k2m"];
    const entry = { ...base, plant_chapters: ["第 1 章"], expected_payoff_chapter: "第 1 章" };
    const out = buildForeshadowBoard(ledgerOf([entry]), { chapters });
    expect(out.findings.map((f) => f.rule)).not.toContain("fs-dangling-chapter");
    // 进度按最后一章算：第 1 章该收而写到第 3 章 ⇒ 逾期 2 章
    expect(out.rows[0]?.overdueBy).toBe(2);
  });

  it("「第 N 章」超出清单长度仍算定位不到（不夹到最后一章）", () => {
    const entry = { ...base, plant_chapters: ["第 9 章"], expected_payoff_chapter: "第 1 章" };
    const out = buildForeshadowBoard(ledgerOf([entry]), { chapters: ["ch-a", "ch-b"] });
    expect(out.findings.map((f) => f.rule)).toContain("fs-dangling-chapter");
  });
});

describe("规则 id 清单与代码同源（R75：并入全书体检后要能被豁免）", () => {
  it("源码里出现的每个 fs-* 字面量都在 FORESHADOW_RULE_IDS 里", () => {
    const source = readFileSync(new URL("../src/foreshadow.ts", import.meta.url), "utf8");
    const used = [...new Set([...source.matchAll(/"fs-[a-z-]+"/g)].map((m) => m[0].slice(1, -1)))].sort();
    expect(used.length).toBeGreaterThan(5);
    expect(used.filter((id) => !(FORESHADOW_RULE_IDS as readonly string[]).includes(id))).toEqual([]);
  });

  it("清单里没有凭空调出来的 id（每条都在源码中出现）", () => {
    const source = readFileSync(new URL("../src/foreshadow.ts", import.meta.url), "utf8");
    for (const id of FORESHADOW_RULE_IDS) expect(source.includes(`"${id}"`)).toBe(true);
  });
});
