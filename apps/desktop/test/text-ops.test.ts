import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readChapter, writeChapterBody } from "../src/main/chapter-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { createOutlineChapter, createProject, generateOutline } from "../src/main/project-ops.js";
import { buildFixedBody, readProofreadPanel } from "../src/main/text-ops.js";

/**
 * 中文自查主进程接线（M3 / T3-13 桌面端，J14）。
 *
 * 最要紧的两条断言：
 * ① **两个通道都不写盘**——`buildFixedBody` 跑完后磁盘正文必须仍是改前内容（落盘只属于 chapter:write）；
 * ② **未确认即不改**——`confirmed:false` 时返回的 `body` 必须与 `beforeBody` 逐字相同。
 */

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

/** 含一处别字 + 一处半角标点 + 一处繁简歧义 + 一处状语「的」的正文 */
const DIRTY_BODY = "他走头无路,只能甘败下风。头发被风吹乱，慢慢的退后三步。";

let dir: string;
let gateway: ProjectGateway;
let chapterPath: string;
/** 落盘后读回的正文（序列化会补尾换行，断言一律以它为准，不假设序列化细节） */
let baseBody: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-text-"));
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(dir);
  const outline = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 1,
  });
  const volume = outline.doc.volumes[0]!;
  const draft = await createOutlineChapter(gateway, {
    volumeId: volume.id,
    chapterId: volume.chapters[0]!.id,
    baseHash: outline.hash,
  });
  chapterPath = draft.chapterPath;
  const initial = await readChapter(gateway, chapterPath);
  // 用产品自身的保存路径植入待修正文（含 frontmatter 字数同步），避免测试自造一套写入
  const written = await writeChapterBody(gateway, { path: chapterPath, body: DIRTY_BODY, baseHash: initial.hash });
  expect(written.hash).toBeTruthy();
  baseBody = (await readChapter(gateway, chapterPath)).body;
  expect(baseBody.startsWith(DIRTY_BODY)).toBe(true);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

describe("readProofreadPanel（只读检测）", () => {
  it("检测本章正文：命中别字与半角标点，span 可切片回正文本体（不含 frontmatter）", async () => {
    const panel = await readProofreadPanel(gateway, { path: chapterPath });
    expect(panel.chars).toBe(baseBody.length);
    expect(panel.counts.warn).toBeGreaterThanOrEqual(2);
    const typo = panel.findings.find((f) => f.rule === "proofread-typo");
    expect(typo?.span.text).toBe("走头无路");
    expect(typo?.suggestion).toBe("走投无路");
    expect(typo?.evidence.length).toBeGreaterThan(8);
    for (const finding of panel.findings) {
      expect(baseBody.slice(finding.span.start, finding.span.end)).toBe(finding.span.text);
      expect(finding.span.chapter).toBe(panel.chapterId);
    }
    expect(panel.checkedRules.length).toBe(6);
    expect(panel.skippedRules).toEqual([]);
  });

  it("路径不存在 / 为空时给可操作错误，不静默返回空面板", async () => {
    await expect(readProofreadPanel(gateway, { path: "chapters/nope.md" })).rejects.toMatchObject({
      code: "E_INVALID_INPUT",
    });
    await expect(readProofreadPanel(gateway, { path: "  " })).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });

  it("路径防护仍然生效（越界路径不得读到项目外文件）", async () => {
    await expect(readProofreadPanel(gateway, { path: "../secrets.txt" })).rejects.toMatchObject({
      code: expect.stringMatching(/^E_/),
    });
  });
});

describe("buildFixedBody（只算文本，不写盘）", () => {
  it("未确认：body === beforeBody，blocked 计条数，磁盘一字未动", async () => {
    const before = await readChapter(gateway, chapterPath);
    const panel = await readProofreadPanel(gateway, { path: chapterPath });
    const edit = panel.findings
      .filter((f) => f.rule === "proofread-typo")
      .map((f) => ({ start: f.span.start, rule: f.rule }));

    const result = await buildFixedBody(gateway, { path: chapterPath, edits: edit, confirmed: false });
    expect(result.applied).toEqual([]);
    expect(result.blocked).toBe(edit.length);
    expect(result.body).toBe(result.beforeBody);
    expect(result.body).toBe(baseBody);

    const after = await readChapter(gateway, chapterPath);
    expect(after.body).toBe(before.body);
  });

  it("已确认：返回改后正文，但磁盘仍是改前内容（落盘属编辑器的保存路径）", async () => {
    const panel = await readProofreadPanel(gateway, { path: chapterPath });
    const edits = panel.findings
      .filter((f) => f.autofix)
      .map((f) => ({ start: f.span.start, rule: f.rule }));
    expect(edits.length).toBeGreaterThanOrEqual(3); // 两个别字 + 半角逗号

    const result = await buildFixedBody(gateway, { path: chapterPath, edits, confirmed: true });
    expect(result.body).toContain("走投无路");
    expect(result.body).toContain("甘拜下风");
    expect(result.body).toContain("无路，只能"); // 逗号在原标点位置被全角化
    expect(result.applied.length).toBe(edits.length);
    expect(result.beforeBody).toBe(baseBody);

    const onDisk = await readChapter(gateway, chapterPath);
    expect(onDisk.body).toBe(baseBody); // 关键：本通道不写盘
  });

  it("只提交一条时也只改那一条（逐条采纳，不「顺手全改」）", async () => {
    const panel = await readProofreadPanel(gateway, { path: chapterPath });
    const first = panel.findings.find((f) => f.rule === "proofread-typo")!;
    const result = await buildFixedBody(gateway, {
      path: chapterPath,
      edits: [{ start: first.span.start, rule: first.rule }],
      confirmed: true,
    });
    expect(result.applied.length).toBe(1);
    expect(result.body).toContain("走投无路");
    expect(result.body).toContain("甘败下风"); // 未提交的条目保持原样
  });

  it("条目已不存在（正文或口径变化）时逐条拒绝并说明原因", async () => {
    const result = await buildFixedBody(gateway, {
      path: chapterPath,
      edits: [{ start: 999, rule: "proofread-typo" }],
      confirmed: true,
    });
    expect(result.applied).toEqual([]);
    expect(result.rejected[0]!.reason).toContain("该位置已无对应检测条目");
  });

  it("繁简歧义必须从候选里选：给候选则改，给任意文本则拒", async () => {
    const panel = await readProofreadPanel(gateway, { path: chapterPath });
    const ambiguous = panel.findings.find((f) => f.rule === "proofread-conversion-ambiguous")!;
    expect(ambiguous.candidates?.length).toBeGreaterThanOrEqual(2);
    expect(ambiguous.autofix).toBe(false);

    const chosen = await buildFixedBody(gateway, {
      path: chapterPath,
      edits: [{ start: ambiguous.span.start, rule: ambiguous.rule, replacement: "髮" }],
      confirmed: true,
    });
    expect(chosen.applied[0]!.to).toBe("髮");

    const bogus = await buildFixedBody(gateway, {
      path: chapterPath,
      edits: [{ start: ambiguous.span.start, rule: ambiguous.rule, replacement: "随便改点什么" }],
      confirmed: true,
    });
    expect(bogus.applied).toEqual([]);
    expect(bogus.rejected[0]!.reason).toContain("候选");
    expect(bogus.body).toBe(baseBody);
  });

  it("不给候选的 info 条目（状语的「的」）不得自动修", async () => {
    const panel = await readProofreadPanel(gateway, { path: chapterPath });
    const de = panel.findings.find((f) => f.rule === "proofread-demiscue")!;
    expect(de.autofix).toBe(false);
    const result = await buildFixedBody(gateway, {
      path: chapterPath,
      edits: [{ start: de.span.start, rule: de.rule }],
      confirmed: true,
    });
    expect(result.applied).toEqual([]);
    expect(result.rejected[0]!.reason).toContain("需显式选定候选");
  });

  it("非法下标与空 edits 都不改动文本", async () => {
    const bad = await buildFixedBody(gateway, {
      path: chapterPath,
      edits: [{ start: -3, rule: "proofread-typo" }],
      confirmed: true,
    });
    expect(bad.body).toBe(baseBody);
    expect(bad.rejected[0]!.reason).toContain("起始下标非法");

    const empty = await buildFixedBody(gateway, { path: chapterPath, edits: [], confirmed: true });
    expect(empty.body).toBe(baseBody);
    expect(empty.applied).toEqual([]);
  });
});
