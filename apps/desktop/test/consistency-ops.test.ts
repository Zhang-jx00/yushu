/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readChapter } from "../src/main/chapter-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import {
  createOutlineChapter,
  createProject,
  generateOutline,
  writeCardDoc,
} from "../src/main/project-ops.js";
import { isConsistencyStale, markConsistencyStale, postAdoptAudit, runConsistencyCheck } from "../src/main/consistency-ops.js";
import { setAiEnabled, saveAiConfig } from "../src/main/ai-ops.js";
import { closeAllMocks, startReplyMock } from "./helpers/mock-chat.js";

/**
 * 一致性体检的桌面接入（M4 / T4-4 三态时机 + T4-3 报告呈现，R54）。
 *
 * 两条最要紧的断言：
 * ① **全程只读**——三种时机跑完，章节正文与 config/consistency.yaml 的字节都不能变；
 * ② **豁免清单坏了要照报问题**（fail-safe）——清单解析失败时绝不能"没有豁免"地放行，
 *    也不能静默把结论清空，作者必须看见"你的豁免文件读不了，所以这次没应用任何豁免"。
 */

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

let dir: string;
let gateway: ProjectGateway;
let chapterPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-cons-"));
  markConsistencyStale();
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(dir);
  await writeCardDoc(gateway, {
    card: {
      id: "char-linyuan",
      type: "character",
      name: "林渊",
      layer: "characters",
      refs: [{ relation: "师从", target: "fac-ghost" }],
    },
    body: "边城少年，剑道天赋被夺。",
  });
  await writeCardDoc(gateway, {
    card: { id: "char-haize", type: "character", name: "海泽", layer: "characters" },
    body: "同日入城的另一人。",
  });
  const generated = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 2,
  });
  const volume = generated.doc.volumes[0]!;
  const draft = await createOutlineChapter(gateway, {
    volumeId: volume.id,
    chapterId: volume.chapters[0]!.id,
    baseHash: generated.hash,
  });
  chapterPath = draft.chapterPath;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeAllow(text: string): Promise<void> {
  const existing = await gateway.readDoc("config/consistency.yaml").catch(() => null);
  await gateway.writeDoc("config/consistency.yaml", text, existing?.hash);
}

const CARD_PATH = "world/cards/character/char-linyuan.md";

describe("手动全书体检（manual）", () => {
  it("给出悬空引用条目：span 指向卡文件、切片含被引用的目标，fix 给可执行方向", async () => {
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(report.timing).toBe("manual");
    expect(report.entries).toHaveLength(1);
    const entry = report.entries[0]!;
    expect(entry.rule).toBe("ref-dangling");
    expect(entry.severity).toBe("error");
    expect(entry.span).not.toBeNull();
    expect(entry.span!.file).toBe(CARD_PATH);
    expect(entry.span!.text).toContain("fac-ghost");
    // 区间必须能用同一个下标口径从原文切出来（面板高亮就这么用）
    const card = await gateway.readDoc(CARD_PATH);
    expect(card.content.slice(entry.span!.start, entry.span!.end)).toContain("relation: 师从");
    expect(entry.fix).toContain("config/consistency.yaml");
    expect(report.counted.entries).toBe(1);
  });

  it("未纳入范围的章节类引用如实列出（不把「没判」藏起来）", async () => {
    await writeCardDoc(gateway, {
      card: { id: "itm-xiantieling", type: "item", name: "玄铁令", layer: "storylines", refs: [{ relation: "appears_in", target: "ch-none" }] },
      body: "第一章末出现的关键道具。",
    });
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(report.outOfScope.map((item) => item.target)).toContain("ch-none");
  });

  it("跑完三种时机后正文与豁免文件都没被改动（只读）", async () => {
    const before = await readChapter(gateway, chapterPath);
    await writeAllow("apiVersion: yushu.consistency-allow/v1\nentries: []\n");
    const allowBefore = await gateway.readDoc("config/consistency.yaml");
    await runConsistencyCheck(gateway, { timing: "manual" });
    await runConsistencyCheck(gateway, { timing: "post-save" });
    await runConsistencyCheck(gateway, { timing: "post-generate", entityIds: ["char-linyuan"] });
    const after = await readChapter(gateway, chapterPath);
    const allowAfter = await gateway.readDoc("config/consistency.yaml");
    expect(after.hash).toBe(before.hash);
    expect(allowAfter.content).toBe(allowBefore!.content);
    expect(allowAfter.hash).toBe(allowBefore!.hash);
  });
});

describe("豁免与 fail-safe", () => {
  it("合法豁免：条目进 suppressed 并带理由与决策时间（审计入口）", async () => {
    await writeAllow(
      [
        "apiVersion: yushu.consistency-allow/v1",
        "entries:",
        "  - rule: ref-dangling",
        "    subject: char-linyuan",
        "    related: fac-ghost",
        "    reason: 该门派第二部才登场",
        "    decided_at: 2026-10-09T10:00:00.000Z",
      ].join("\n"),
    );
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(report.entries).toEqual([]);
    expect(report.suppressed).toHaveLength(1);
    expect(report.suppressed[0]!.reason).toContain("第二部");
    expect(report.suppressed[0]!.decidedAt).toBe("2026-10-09T10:00:00.000Z");
    expect(report.allowError).toBeNull();
  });

  it("豁免清单读不了 → 报错外显，且结论照旧报出（不静默放行也不清空）", async () => {
    await writeAllow("apiVersion: yushu.consistency-allow/v1\nentries:\n  - rule: ref-dangling\n    subject: char-linyuan\n");
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(report.allowError).toContain("reason");
    expect(report.entries).toHaveLength(1);
    expect(report.suppressed).toEqual([]);
  });
});

describe("三态时机的范围与缓存", () => {
  it("生成后即时轻校验只看本次涉及的实体，范围外条数如实计数", async () => {
    const all = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(all.entries).toHaveLength(1);
    const light = await runConsistencyCheck(gateway, { timing: "post-generate", entityIds: ["char-haize"] });
    expect(light.entries).toEqual([]);
    expect(light.counted.findings).toBe(1);
    expect(light.counted.filteredOut).toBe(1);
  });

  it("保存后异步：置脏后必须重算，未置脏时可复用缓存", async () => {
    markConsistencyStale();
    const first = await runConsistencyCheck(gateway, { timing: "post-save" });
    expect(first.ranAgain).toBe(true);
    expect(isConsistencyStale()).toBe(false);
    const cached = await runConsistencyCheck(gateway, { timing: "post-save" });
    expect(cached.ranAgain).toBe(false);
    markConsistencyStale();
    expect(isConsistencyStale()).toBe(true);
    const recomputed = await runConsistencyCheck(gateway, { timing: "post-save" });
    expect(recomputed.ranAgain).toBe(true);
    expect(recomputed.entries).toHaveLength(1);
  });

  it("手动体检永远重算（作者点按钮就是要看当下的真结果）", async () => {
    await runConsistencyCheck(gateway, { timing: "post-save" });
    const manual = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(manual.ranAgain).toBe(true);
  });
});
/**
 * 采纳后即时轻校验（M4 / T4-4 的最后一个调用点，R56）。
 *
 * 范围由**采纳的正文自己决定**：作者刚写了谁，就该看见谁的结构性问题。
 * 三条口径要钉死：
 * ① 只报范围内实体的结论，范围外条数如实计 filteredOut（悄悄少掉＝假干净）；
 * ② 正文里谁都没提到 → 范围空 → 一条也不报，**不许退化成"那就全书都报"**（那是拿用户的
 *    等待时间换虚假的安全感）；
 * ③ 轻校验失败不能把已成功的采纳报成失败——采纳已经落盘了，这时抛错会让作者重复采纳。
 */
describe("采纳后即时轻校验（post-generate 的调用点）", () => {
  it("范围来自正文提及：只报被提到的实体，范围外计数可见", async () => {
    const report = await runConsistencyCheck(gateway, { timing: "post-generate", scopeText: "林渊收剑入鞘。" });
    expect(report.scopeIds).toEqual(["char-linyuan"]);
    expect(report.entries.map((e) => e.subject)).toEqual(["char-linyuan"]);
    expect(report.counted.filteredOut).toBe(0);
  });

  it("正文只提到干净的实体时零结论，但范围外那条要看得见", async () => {
    const report = await runConsistencyCheck(gateway, { timing: "post-generate", scopeText: "海泽在门口等着。" });
    expect(report.scopeIds).toEqual(["char-haize"]);
    expect(report.entries).toEqual([]);
    expect(report.counted.filteredOut).toBe(1);
  });

  it("正文谁都没提到：范围为空、零结论，且不把全书结论倒给作者", async () => {
    const report = await runConsistencyCheck(gateway, { timing: "post-generate", scopeText: "夜色压下来。" });
    expect(report.scopeIds).toEqual([]);
    expect(report.entries).toEqual([]);
    expect(report.counted.filteredOut).toBeGreaterThan(0);
  });

  it("别名也算提及：正文用别名提到实体，范围就要认它", async () => {
    await writeCardDoc(gateway, {
      card: {
        id: "char-xiaoyuan",
        type: "character",
        name: "林小渊",
        aliases: ["小渊"],
        layer: "characters",
        refs: [{ relation: "师从", target: "fac-alias-ghost" }],
      },
      body: "别名测试卡。",
    });
    const report = await runConsistencyCheck(gateway, { timing: "post-generate", scopeText: "小渊回头看了一眼。" });
    expect(report.scopeIds).toContain("char-xiaoyuan");
    expect(report.entries.map((e) => e.subject)).toContain("char-xiaoyuan");
  });

  it("没给范围时不装作跑过轻校验：post-generate 无范围等于报全部（清零比全报更像「没问题」）", async () => {
    const full = await runConsistencyCheck(gateway, { timing: "manual" });
    const unscoped = await runConsistencyCheck(gateway, { timing: "post-generate" });
    expect(unscoped.scopeIds).toEqual([]);
    expect(unscoped.entries).toHaveLength(full.entries.length);
    expect(unscoped.counted.filteredOut).toBe(0);
  });

  it("轻校验依旧只读：跑完之后正文字节不变", async () => {
    const before = await gateway.readDoc(chapterPath);
    await postAdoptAudit(gateway, "林渊与海泽同行。");
    const after = await gateway.readDoc(chapterPath);
    expect(after!.content).toBe(before!.content);
    expect(after!.hash).toBe(before!.hash);
  });

  it("postAdoptAudit 命中范围内实体时给出结论", async () => {
    const audit = await postAdoptAudit(gateway, "林渊想起师承之事。");
    expect(audit.ran).toBe(true);
    expect(audit.error).toBe("");
    expect(audit.scopeIds).toEqual(["char-linyuan"]);
    expect(audit.entries.map((e) => e.rule)).toEqual(["ref-dangling"]);
  });

  it("postAdoptAudit 不抛：拿不到数据时 ran=false 并给出原因，采纳结果不受影响", async () => {
    const broken = { root: gateway.root, readDoc: async () => { throw new Error("读不了"); }, listFiles: async () => { throw new Error("读不了"); } } as unknown as ProjectGateway;
    const audit = await postAdoptAudit(broken, "林渊。");
    expect(audit.ran).toBe(false);
    expect(audit.error.length).toBeGreaterThan(0);
    expect(audit.entries).toEqual([]);
  });
});


/**
 * 派系包结论并入同一份体检报告（R57 的桌面侧）。
 *
 * 这一组盯的是"两条通路会不会走岔"：包规则结论必须和内置结构结论**共用**同一份报告、
 * 同一套 span、同一条豁免清单；同时没跑的规则要在汇总里看得见。
 */
describe("体检报告并入派系包规则（R57）", () => {
  // 走**应用真实的卡片写入路径**（writeCardDoc）而不是手写 YAML：手写会绕过 frontmatter 序列化，
  // 正是 R57 预演 step43 抓到的那条盲区——单测绿、应用里读不到台账。
  const powerCard = (
    id: string,
    name: string,
    log: Array<Record<string, unknown>>,
  ) =>
    writeCardDoc(gateway, {
      card: {
        id,
        type: "character",
        name,
        layer: "characters",
        aliases: [],
        refs: [],
        source_chapters: [],
        visibility: "hidden",
        format_version: 1,
        extensions: { power_log: log },
      },
      body: "正文。",
    });

  const REGRESS = [
    { chapter: "第 3 章", tier: 3, combat_power: 100 },
    { chapter: "第 4 章", tier: 4, combat_power: 80 },
  ];

  it("包规则结论与内置结构结论同表出现，各带自己的出处", async () => {
    await powerCard("char-power", "林渊战力样本", REGRESS);
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    const rules = report.entries.map((entry) => entry.rule);
    expect(rules).toContain("ref-dangling");
    expect(rules).toContain("power-no-regress");
    const pack = report.entries.find((entry) => entry.rule === "power-no-regress")!;
    expect(pack.origin).toContain("xuanhuan-xitong");
    expect(pack.subject).toBe("char-power");
    // span 落在台账那一行，面板可切片（与 refs 类同一口径）
    const cardText = (await gateway.readDoc("world/cards/character/char-power.md"))!.content;
    expect(pack.span).not.toBeNull();
    expect(cardText.slice(pack.span!.start, pack.span!.end)).toContain("combat_power: 80");
  });

  it("没数据可跑的包规则在汇总里点名，不静默算通过（R74：参与与否由数据回答）", async () => {
    // 这个夹具里**一张战力台账都没有** ⇒ 连 power-no-regress 自己也没真的跑过。
    // R57 的旧口径按手写名单把它算成"参与"，那等于告诉作者"这条查过了、没问题"——
    // R74 改成按表达式声明的 var 路径比对实际数据，取不到就进 notEvaluated 并写明原因。
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(report.pack.evaluated).toEqual([]);
    expect(report.pack.notEvaluated).toHaveLength(6);
    for (const item of report.pack.notEvaluated) {
      expect(item.reason).toContain("没有可比对的相邻战力数据");
    }
    // 另一半口径：数据齐了它就必须参与，且其余五条各自点名缺哪些路径
    await powerCard("char-power", "林渊战力样本", REGRESS);
    const withData = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(withData.pack.evaluated).toEqual(["power-no-regress"]);
    expect(withData.pack.notEvaluated).toHaveLength(5);
    expect(withData.pack.notEvaluated.map((item) => item.id)).not.toContain("power-no-regress");
  });

  it("豁免清单能豁免包规则：进 suppressed 带理由（knownIds 已放开到参与求值的集合）", async () => {
    await powerCard("char-power", "林渊战力样本", REGRESS);
    await writeAllow(
      [
        "apiVersion: yushu.consistency-allow/v1",
        "entries:",
        "  - rule: power-no-regress",
        "    subject: char-power",
        "    related: 第 4 章",
        "    reason: 作者确认第 4 章是刻意反转（天赋被夺后的虚弱期）",
        "    decided_at: 2026-10-09",
        "",
      ].join("\n"),
    );
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(report.allowError).toBeNull();
    expect(report.entries.map((entry) => entry.rule)).not.toContain("power-no-regress");
    expect(report.suppressed.map((entry) => entry.rule)).toContain("power-no-regress");
    expect(report.unusedAllow).toEqual([]);
  });

  it("台账本身读不出时把错误带到报告里，而不是当没这条规则", async () => {
    await powerCard("char-bad", "坏台账样本", [{ chapter: "序章", tier: 1, combat_power: 10 }]);
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(report.pack.errors.length).toBe(1);
    expect(report.pack.errors[0]).toContain("char-bad");
  });
});

/**
 * AI 采样结论并入同一份体检报告（R58）。
 *
 * 两条口径：① **默认不跑**——采样要烧 token，不能让"点一下全书体检"悄悄花钱；
 * ② 跑不成（AI 关闭等）只报告 `aiAudit.ran:false + reason`，**结构结论一条都不能少**。
 */
describe("全书体检并入 AI 采样结论（R58）", () => {
  it("默认不请求 AI：aiAudit.ran=false 且写明未请求", async () => {
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(report.aiAudit.ran).toBe(false);
    expect(report.aiAudit.reason).toContain("未请求");
  });

  it("轻校验绝不顺手跑采样（post-generate 是采纳路径上的同步动作）", async () => {
    const report = await runConsistencyCheck(gateway, { timing: "post-generate", scopeText: "林渊", aiAudit: true });
    expect(report.aiAudit.ran).toBe(false);
    expect(report.aiAudit.reason).toContain("不跑采样");
  });

  it("请求采样但 AI 关闭：结构结论照旧，aiAudit 给出原因", async () => {
    setAiEnabled(false);
    const report = await runConsistencyCheck(gateway, { timing: "manual", aiAudit: true });
    expect(report.entries.map((entry) => entry.rule)).toContain("ref-dangling");
    expect(report.aiAudit.ran).toBe(false);
    expect(report.aiAudit.reason).toContain("AI");
  });

  it("请求采样且模型给出结论：并入同一张表，带出处与章节区间", async () => {
    setAiEnabled(true);
    const baseUrl = await startReplyMock(
      JSON.stringify({ issues: [{ index: 0, kind: "hallucination", why: "该断言在设定库中无支撑" }] }),
    );
    await saveAiConfig(gateway, {
      providers: [
        {
          id: "mock",
          kind: "local",
          protocol: "openai_chat",
          base_url: baseUrl,
          models: [{ name: "mock-model", tier: "flagship", limits: { context: 32768, max_output: 2048 } }],
        },
      ] as never,
    });
    const before = await gateway.readDoc(chapterPath);
    const splitAt = before!.content.indexOf("\n---\n") + 5;
    await gateway.writeDoc(
      chapterPath,
      before!.content.slice(0, splitAt) + "\n林渊按剑立在城口，那枚玉佩出自皇室，夜色漫过整座边城。" + before!.content.slice(splitAt),
      before!.hash,
    );
    const report = await runConsistencyCheck(gateway, { timing: "manual", aiAudit: true });
    expect(report.aiAudit.ran).toBe(true);
    expect(report.aiAudit.sampled).toBeGreaterThan(0);
    const rules = report.entries.map((entry) => entry.rule);
    expect(rules).toContain("ref-dangling");
    expect(rules).toContain("ai-sampled-hallucination");
    const ai = report.entries.find((entry) => entry.rule === "ai-sampled-hallucination")!;
    expect(ai.origin).toContain("AI 采样");
    expect(ai.span?.file).toContain("chapters/");
    expect(ai.span?.text).toContain("玉佩出自皇室");
    await closeAllMocks();
    setAiEnabled(false);
  });
});

/** 伏笔台账结论并入全书体检（M4 / T4-2，R75）：判定在引擎，报告只投影 */
async function writeForeshadow(entries: string[]): Promise<void> {
  await gateway.writeDoc("world/foreshadow.yaml", ["apiVersion: yushu.foreshadow/v1", "entries:", ...entries, ""].join("\n"));
}

const OVERDUE_ENTRY = [
  "  - id: fs-cons-1",
  "    name: 断剑的重铸",
  "    promise: 重铸断剑",
  "    carrier: 道具",
  "    visibility: 半遮",
  "    state: planted",
  "    plant_chapters: [\"第 1 章\"]",
  "    expected_payoff_chapter: 第 1 章",
  "    payoff_type: 揭示",
  "    is_red_herring: false",
  "    recheck_after: 3",
];

describe("伏笔结论并入体检同表（R75）", () => {
  it("逾期伏笔出现在同表里，带台账出处与可切片的原文区间", async () => {
    await writeForeshadow(OVERDUE_ENTRY);
    const before = await gateway.readDoc("world/foreshadow.yaml");
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    // 夹具只有 2 章，必然落进终局窗口（finaleWindow 默认 5）⇒ 引擎按既定优先级报 finale-unpaid 而非 overdue
    const entry = report.entries.find((item) => item.rule === "fs-finale-unpaid");
    expect(entry).toBeDefined();
    expect(entry!.subject).toBe("fs-cons-1");
    expect(entry!.origin).toContain("伏笔台账");
    // 区间必须真的落在台账里那条上：切片要同时含 id 与名字（不给假区间）
    expect(entry!.span).not.toBeNull();
    const ledgerText = (await gateway.readDoc("world/foreshadow.yaml"))!.content;
    const sliced = ledgerText.slice(entry!.span!.start, entry!.span!.end);
    expect(sliced).toContain("fs-cons-1");
    expect(sliced).toContain("断剑的重铸");
    expect(entry!.span!.file).toBe("world/foreshadow.yaml");
    // 跑完体检台账一个字节都不能动
    const after = await gateway.readDoc("world/foreshadow.yaml");
    expect(after!.hash).toBe(before!.hash);
  });

  it("台账读不懂 ⇒ 如实报一条 fs-ledger-unreadable，不静默贡献零结论", async () => {
    await writeForeshadow([...OVERDUE_ENTRY, "    未知键: 会整份拒绝"]);
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    const entry = report.entries.find((item) => item.rule === "fs-ledger-unreadable");
    expect(entry).toBeDefined();
    expect(entry!.severity).toBe("warn");
    expect(entry!.evidence).toContain("未知键");
    // 关键：读不懂时不能"看起来没问题"——除这条之外不该有任何伏笔结论
    expect(report.entries.filter((item) => item.rule.startsWith("fs-") && item.rule !== "fs-ledger-unreadable")).toEqual([]);
  });

  it("伏笔结论能被豁免（规则 id 清单与引擎同源，否则报得出来却豁免不掉）", async () => {
    await writeForeshadow(OVERDUE_ENTRY);
    await writeAllow([
      "apiVersion: yushu.consistency-allow/v1",
      "entries:",
      "  - rule: fs-finale-unpaid",
      "    subject: fs-cons-1",
      "    reason: 作者确认这把剑第 1 章不收，改到卷末",
      "    decided_at: 2026-10-13",
      "",
    ].join("\n"));
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    expect(report.allowError).toBeNull();
    expect(report.entries.map((item) => item.rule)).not.toContain("fs-finale-unpaid");
    expect(report.suppressed.map((item) => item.rule)).toContain("fs-finale-unpaid");
    expect(report.suppressed.find((item) => item.rule === "fs-finale-unpaid")!.reason).toContain("卷末");
  });

  it("包规则的生效期真的被判定（主进程给日期，引擎不读墙钟）——T4-12 / R85", async () => {
    const report = await runConsistencyCheck(gateway, { timing: "manual" });
    // 这条断言防的是"字段解析了但没人消费"：dateCheck 若恒为 skipped，
    // 生效日期就只是包件里一段没人看的注释，而面板上看起来像"规则都在有效期内"
    expect(report.pack.merge.dateCheck).toBe("applied");
    expect(Array.isArray(report.pack.merge.overrides)).toBe(true);
    expect(Array.isArray(report.pack.merge.ambiguous)).toBe(true);
  });
});
