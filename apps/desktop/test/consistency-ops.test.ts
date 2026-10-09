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
import { isConsistencyStale, markConsistencyStale, runConsistencyCheck } from "../src/main/consistency-ops.js";

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
