/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OUTLINE_PATH, VISIBILITY_CHECK_ORIGIN, parseOutline } from "@yushu/world-engine";
import { visibilityReportFindings, visibilityUnreadable } from "../src/main/visibility-ops.js";
import { createOutlineChapter, createProject, generateOutline, writeCardDoc } from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

/**
 * 信息可见性核对的桌面侧（M4 / T4-2 第四批·第一段，R103）。
 *
 * 判定全在引擎（`visibility-check.ts`，判据 docs/01 §4.2 + A08 §3/§5 + K05:80 的合法形状），
 * 这里只验三件宿主级的事：
 * ① **卡上的 `source_chapters` 真被读进来**——它不在 `CardSummary`（列表摘要）里，
 *    也不在索引的实体行里，所以这条链必须自己走一遍真源，否则核对拿到的是空数组、
 *    结论永远是"没登记"（那是假绿灯的一种）；
 * ② **坏卡不静默丢掉**：读不动的卡进 `visibilityUnreadable` 点名，并作为一条 warn 结论进体检表
 *    （`fs-ledger-unreadable` / `pov-config-unreadable` 同一条路子）；
 * ③ **章序来自大纲的 `chapter_id` 回填**，不读章节文件正文（这条链只认 id）。
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

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-vis-"));
  gateway = new ProjectGateway(dir);
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

async function addCard(input: {
  id: string;
  name: string;
  visibility: string;
  sourceChapters?: string[];
  type?: string;
  layer?: string;
}): Promise<string> {
  const written = await writeCardDoc(gateway, {
    card: {
      id: input.id,
      type: input.type ?? "character",
      name: input.name,
      layer: input.layer ?? "characters",
      visibility: input.visibility,
      ...(input.sourceChapters ? { source_chapters: input.sourceChapters } : {}),
    },
    body: `## ${input.name}\n`,
  });
  return written.path;
}

/** 建一章草稿并回填 chapter_id，返回该章 id（可见性核对要的正是这个 id） */
async function draftFirstChapter(): Promise<string> {
  await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 2,
  });
  const snap = await gateway.readDoc(OUTLINE_PATH);
  const outline = parseOutline(snap.content);
  const volume = outline.volumes[0];
  const chapter = volume?.chapters[0];
  if (volume === undefined || chapter === undefined) throw new Error("夹具没能生成大纲章纲");
  const created = await createOutlineChapter(gateway, {
    volumeId: volume.id,
    chapterId: chapter.id,
    baseHash: snap.hash,
  });
  return created.chapterId;
}

describe("可见性结论进体检表的那三件事", () => {
  it("一张卡都没有 ⇒ 零结论（新项目的空状态不该被念成问题）", async () => {
    expect(await visibilityReportFindings(gateway)).toEqual([]);
  });

  it("卡上登记的 source_chapters 真被读到：hidden + 出处 ⇒ 一条 warn，主体是卡 id", async () => {
    const chapterId = await draftFirstChapter();
    await addCard({ id: "char-linyuan", name: "林渊", visibility: "hidden", sourceChapters: [chapterId] });
    const rows = await visibilityReportFindings(gateway);
    expect(rows.map((row) => [row.rule, row.severity, row.subject])).toEqual([
      ["vis-hidden-but-sourced", "warn", "char-linyuan"],
    ]);
    expect(rows[0]?.origin).toBe(VISIBILITY_CHECK_ORIGIN);
    expect(rows[0]?.related).toBe(chapterId);
    expect((rows[0]?.fix ?? "").length).toBeGreaterThan(8);
  });

  it("全项目没人登记出处 ⇒ 只有一条 info 总述（不逐卡刷警告）", async () => {
    await draftFirstChapter();
    await addCard({ id: "char-a", name: "甲", visibility: "revealed" });
    await addCard({ id: "char-b", name: "乙", visibility: "hidden" });
    const rows = await visibilityReportFindings(gateway);
    expect(rows.map((row) => [row.rule, row.severity])).toEqual([["vis-no-source-registered", "info"]]);
    // 体检表只渲染 evidence / fix 两列，没有 message 列——所以那句"不等于"必须落在 evidence 里，
    // 否则投影到表上就丢了（这条断言就是钉住这件事的）
    expect(rows[0]?.evidence).toContain("不等于");
  });

  it("坏卡不静默丢掉：单独点名它，并且它自己那条结论也进表", async () => {
    const chapterId = await draftFirstChapter();
    const goodPath = await addCard({ id: "char-ok", name: "干净卡", visibility: "hidden", sourceChapters: [chapterId] });
    await gateway.writeDoc("world/cards/character/broken-card.md", "---\nid: [不合法的 frontmatter\n---\n正文\n");
    const bad = await visibilityUnreadable(gateway);
    expect(bad.map((row) => row.path)).toEqual(["world/cards/character/broken-card.md"]);
    const rows = await visibilityReportFindings(gateway);
    expect(rows.map((row) => row.rule).sort()).toEqual(["vis-card-unreadable", "vis-hidden-but-sourced"]);
    expect(rows.some((row) => row.subject === goodPath || row.subject === "char-ok")).toBe(true);
    const unreadableRow = rows.find((row) => row.rule === "vis-card-unreadable");
    expect(unreadableRow?.evidence).toContain("broken-card");
  });

  it("没回填 chapter_id 的章纲不进章序（那条链的 id 无从谈起）", async () => {
    await generateOutline(gateway, {
      templateId: "xuanhuan-xitong/three-act-upgrade",
      title: "天启界",
      volumeCount: 1,
      chaptersPerVolume: 2,
    });
    // 一条出处指向"章纲 id"（co-…）而不是章节 id：这种登记必须被点名为悬空
    await addCard({ id: "char-x", name: "错登记", visibility: "revealed", sourceChapters: ["co-1"] });
    const rows = await visibilityReportFindings(gateway);
    expect(rows.map((row) => row.rule)).toEqual(["vis-source-chapter-unknown"]);
    expect(rows[0]?.evidence).toContain("co-1");
  });

  it("同一条结论只算一次：重复读两遍结果逐字一致（红线 5）", async () => {
    const chapterId = await draftFirstChapter();
    await addCard({ id: "char-a", name: "甲", visibility: "hidden", sourceChapters: [chapterId] });
    await addCard({ id: "char-b", name: "乙", visibility: "hidden", sourceChapters: [chapterId] });
    const first = await visibilityReportFindings(gateway);
    const second = await visibilityReportFindings(gateway);
    expect(second).toEqual(first);
    expect(first.map((row) => row.subject)).toEqual(["char-a", "char-b"]);
  });
});
