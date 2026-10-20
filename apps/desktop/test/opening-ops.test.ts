/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  OPENING_CHECK_ORIGIN,
  OUTLINE_PATH,
  chapterPath,
  checkStructureFromSources,
  parseOutline,
  readChapterFile,
  serializeChapterFile,
  type IndexEntityRow,
} from "@yushu/world-engine";
import { openingReportFindings, openingUnreadable } from "../src/main/opening-ops.js";
import { gatewayReader } from "../src/main/index-ops.js";
import { createOutlineChapter, createProject, generateOutline, writeCardDoc } from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

/**
 * 黄金三章核对的桌面侧（M4 / T4-2 第五批，R104）。
 *
 * 判定全在引擎（`opening-check.ts`，判据 F02 §5 + F11 §3），这里只验四件宿主级的事：
 * ① **具名角色是真扫出来的**——把四个角色卡的名字写进第 1 章正文，结论必须数到 4；
 *    只写三个就必须零结论。这条是"用实体表数，不靠词表猜"的唯一证明；
 * ② **只读开局窗口**（前三章）：第四章正文里塞十个人名也不该被扫；
 * ③ 章文件读不动时**退回「没有草稿」**，同时单独点名它——不拿空正文当"这章没人出场"；
 * ④ 结论落在章纲条目（`co-*`）上，与豁免清单/两次重跑的自洽。
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
  dir = await mkdtemp(join(tmpdir(), "yushu-open-"));
  gateway = new ProjectGateway(dir);
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

function entitiesOf(): Promise<IndexEntityRow[]> {
  return checkStructureFromSources(gatewayReader(gateway)).then((report) => report.entities);
}

async function addCharacter(id: string, name: string): Promise<void> {
  await writeCardDoc(gateway, {
    card: { id, type: "character", name, layer: "characters", visibility: "revealed" },
    body: `## ${name}\n`,
  });
}

/** 生成大纲并给第 1 章建草稿，返回 { 章纲 id, 正文章 id, 章文件路径 } */
async function draftFirstChapter(chaptersPerVolume = 4): Promise<{ outlineId: string; chapterId: string; path: string }> {
  await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume,
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
  return { outlineId: chapter.id, chapterId: created.chapterId, path: chapterPath(volume.id, created.chapterId) };
}

/** 改写章文件正文（保留 frontmatter，只换 body——不动别的字段） */
async function writeBody(path: string, body: string): Promise<void> {
  const snap = await gateway.readDoc(path);
  const { chapter } = readChapterFile(snap.content);
  await gateway.writeDoc(path, serializeChapterFile({ ...chapter, word_count: body.length }, body), snap.hash);
}

describe("黄金三章结论进体检表的那四件事", () => {
  it("没有大纲 ⇒ 零结论（空项目不该被念成「开局有问题」）", async () => {
    expect(await openingReportFindings(gateway, await entitiesOf())).toEqual([]);
  });

  it("第 1 章正文里点了四个建过卡的角色 ⇒ 一条 open-cast-overload，证据是名字不是猜测", async () => {
    const { outlineId, chapterId, path } = await draftFirstChapter();
    for (const person of [
      { id: "char-a", name: "林渊" },
      { id: "char-b", name: "苏婉" },
      { id: "char-c", name: "陈长老" },
      { id: "char-d", name: "血手魔头" },
    ]) {
      await addCharacter(person.id, person.name);
    }
    await writeBody(path, "林渊握剑，苏婉在身后，陈长老叹了一声，血手魔头从崖上落下。\n");

    const rows = await openingReportFindings(gateway, await entitiesOf());
    const cast = rows.filter((row) => row.rule === "open-cast-overload");
    expect(cast.map((row) => [row.severity, row.subject, row.related])).toEqual([["warn", outlineId, chapterId]]);
    expect(cast[0]?.evidence).toContain("林渊");
    expect(cast[0]?.evidence).toContain("血手魔头");
    expect(cast[0]?.origin).toBe(OPENING_CHECK_ORIGIN);
  });

  it("同样四个人名写在第四章 ⇒ 不扫它：开局窗口只有前三章，也是这条链的成本上限", async () => {
    await draftFirstChapter();
    for (const person of [
      { id: "char-a", name: "林渊" },
      { id: "char-b", name: "苏婉" },
      { id: "char-c", name: "陈长老" },
      { id: "char-d", name: "血手魔头" },
    ]) {
      await addCharacter(person.id, person.name);
    }
    const snap = await gateway.readDoc(OUTLINE_PATH);
    const outline = parseOutline(snap.content);
    const volume = outline.volumes[0];
    const fourth = volume?.chapters[3];
    if (volume === undefined || fourth === undefined) throw new Error("夹具章纲不足四章");
    const created = await createOutlineChapter(gateway, { volumeId: volume.id, chapterId: fourth.id, baseHash: snap.hash });
    await writeBody(chapterPath(volume.id, created.chapterId), "林渊、苏婉、陈长老与血手魔头同桌吃饭。\n");

    const rows = await openingReportFindings(gateway, await entitiesOf());
    expect(rows.filter((row) => row.rule === "open-cast-overload")).toEqual([]);
  });

  it("只点三个 ⇒ 不报（阈值就是 F02 写的那个 3，不多不少）", async () => {
    const { path } = await draftFirstChapter();
    await addCharacter("char-a", "林渊");
    await addCharacter("char-b", "苏婉");
    await addCharacter("char-c", "陈长老");
    await writeBody(path, "林渊、苏婉、陈长老三人立于崖前。\n");
    const rows = await openingReportFindings(gateway, await entitiesOf());
    expect(rows.filter((row) => row.rule === "open-cast-overload")).toEqual([]);
  });

  it("没建卡的人名不算具名角色：写了十个路人也不报（口径写进证据行）", async () => {
    const { path } = await draftFirstChapter();
    await addCharacter("char-a", "林渊");
    await addCharacter("char-b", "苏婉");
    await addCharacter("char-c", "陈长老");
    await writeBody(path, "林渊、苏婉、陈长老，外加王二、张三、李四、赵五、钱六、孙七、周八。\n");
    const rows = await openingReportFindings(gateway, await entitiesOf());
    expect(rows.filter((row) => row.rule === "open-cast-overload")).toEqual([]);
  });

  it("章文件读不动 ⇒ 退回「没有草稿」并单独点名它，不拿空正文当证据", async () => {
    const { path } = await draftFirstChapter();
    await gateway.writeDoc(path, "---\nid: [坏的 frontmatter\n---\n正文\n", (await gateway.readDoc(path)).hash);
    const bad = await openingUnreadable(gateway, await entitiesOf());
    expect(bad.map((row) => row.path)).toEqual([path]);

    const rows = await openingReportFindings(gateway, await entitiesOf());
    expect(rows.filter((row) => row.rule === "open-source-unreadable").map((row) => row.subject)).toEqual([path]);
    /** 章纲层面的结论照发（读不动的是章文件，不是章纲）；但正文类结论一条都不许发 */
    expect(rows.some((row) => row.rule === "open-cast-overload" || row.rule === "open-protagonist-absent")).toBe(false);
  });

  it("视角换出与主角没露面都从章 frontmatter 走：绑定谁就用谁判", async () => {
    const { outlineId, path } = await draftFirstChapter();
    await addCharacter("char-a", "林渊");
    await addCharacter("char-b", "苏婉");
    const snap = await gateway.readDoc(path);
    const { chapter } = readChapterFile(snap.content);
    // 正文只点到林渊，而这一章的视角登记成苏婉 ⇒ 视角角色没露面（info，不是缺陷）
    await gateway.writeDoc(
      path,
      serializeChapterFile({ ...chapter, pov: "char-b" }, "林渊独自走在山道上。\n"),
      snap.hash,
    );

    const rows = await openingReportFindings(gateway, await entitiesOf());
    const absent = rows.filter((row) => row.rule === "open-protagonist-absent");
    expect(absent.map((row) => row.subject)).toEqual([outlineId]);
    expect(absent[0]?.severity).toBe("info");
    /** 表上没有 message 列，所以"登记的是谁"必须落在 evidence 里（R103 的教训） */
    expect(absent[0]?.evidence).toContain("苏婉");
    /** 证据要说清"扫到的是谁"，作者才知道该改登记还是该改正文 */
    expect(absent[0]?.evidence).toContain("林渊");
  });

  it("干净项目跑一遍不许冒出「读不动」：这条假警告本轮真的自己冒出来过", async () => {
    /**
     * R104 实撞：采集器里一句遗留代码抛 ReferenceError，被本模块的 catch 当成"章文件读不动"
     * 报了进去——结论照发（数据已经写进 row 了）、警告也发，一次坏把两件事都污染了。
     * 所以healthy 路径必须显式断言零 unreadable，而"读不动"的那条测试也必须看得到真数据被抹掉。
     */
    const { path } = await draftFirstChapter();
    await addCharacter("char-a", "林渊");
    await writeBody(path, "林渊独自上路。\n");
    expect(await openingUnreadable(gateway, await entitiesOf())).toEqual([]);
    const rows = await openingReportFindings(gateway, await entitiesOf());
    expect(rows.filter((row) => row.rule === "open-source-unreadable")).toEqual([]);
  });

  it("两次重跑逐字一致（红线 5）", async () => {
    const { path } = await draftFirstChapter();
    for (const person of [
      { id: "char-a", name: "林渊" },
      { id: "char-b", name: "苏婉" },
      { id: "char-c", name: "陈长老" },
      { id: "char-d", name: "血手魔头" },
    ]) {
      await addCharacter(person.id, person.name);
    }
    await writeBody(path, "林渊、苏婉、陈长老、血手魔头俱在。\n");
    const first = await openingReportFindings(gateway, await entitiesOf());
    const second = await openingReportFindings(gateway, await entitiesOf());
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(0);
  });
});
