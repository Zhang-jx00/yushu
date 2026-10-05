import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OutlineDocPayload } from "../src/shared/ipc.js";
import { adoptDraft } from "../src/main/ai-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { createProject, generateOutline, writeOutline } from "../src/main/project-ops.js";
import { snapshotState } from "../src/main/snapshot-ops.js";

/**
 * 破坏性操作强制 pre_destructive 快照（T2-8 切片 B；docs/03 §12 / K10）：
 * - 覆盖既有大纲（重新生成 / 空白创建）：写入前强制快照；
 * - 保存大纲时删除卷 / 章纲（批量替换）：按新旧文档对比检出，写入前强制快照；
 * - AI 采纳「整段替换正文」：写入前强制快照；append 追加不触发；
 * - 非破坏性改动（改标题 / 增补）：不产生多余快照。
 */

let dir: string;
let gateway: ProjectGateway;

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

async function preDestructiveCount(): Promise<number> {
  const state = await snapshotState(gateway);
  return state.snapshots.filter((snapshot) => snapshot.reason === "pre_destructive").length;
}

async function setupOutline(chaptersPerVolume = 2): Promise<{ doc: OutlineDocPayload; hash: string }> {
  const generated = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume,
  });
  return { doc: generated.doc, hash: generated.hash };
}

function clone(doc: OutlineDocPayload): OutlineDocPayload {
  return JSON.parse(JSON.stringify(doc)) as OutlineDocPayload;
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-predestructive-"));
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

describe("破坏前快照（T2-8 切片 B）", () => {
  it("首次生成不触发；覆盖生成触发一次（含空白创建覆盖）；改标题保存不触发", async () => {
    const first = await setupOutline();
    expect(await preDestructiveCount()).toBe(0);

    // 覆盖生成（重新生成）：覆盖前强制快照
    const second = await generateOutline(gateway, {
      templateId: "xuanhuan-xitong/three-act-upgrade",
      title: "天启界",
      volumeCount: 1,
      chaptersPerVolume: 2,
      baseHash: first.hash,
    });
    expect(await preDestructiveCount()).toBe(1);

    // 非破坏性保存（仅改总纲标题）：不再新增快照
    const doc = clone(second.doc);
    doc.master.title = "天启界（改名）";
    await writeOutline(gateway, { doc, baseHash: second.hash });
    expect(await preDestructiveCount()).toBe(1);
  });

  it("保存时删除卷：检出并强制快照（撤销窗口）；随后普通保存不重复触发", async () => {
    const made = await setupOutline();
    const doc = clone(made.doc);
    doc.volumes = doc.volumes.slice(0, 0); // 删掉唯一一卷 = 清空大纲
    const afterDelete = await writeOutline(gateway, { doc, baseHash: made.hash });
    expect(await preDestructiveCount()).toBe(1);

    const again = clone(afterDelete.doc);
    again.master.title = "再改一次";
    await writeOutline(gateway, { doc: again, baseHash: afterDelete.hash });
    expect(await preDestructiveCount()).toBe(1);
  });

  it("保存时删除单个章纲：同样触发（无卷删除也检出）", async () => {
    const made = await setupOutline(2);
    const doc = clone(made.doc);
    doc.volumes[0]!.chapters = doc.volumes[0]!.chapters.slice(0, 1); // 2 章 → 1 章
    await writeOutline(gateway, { doc, baseHash: made.hash });
    expect(await preDestructiveCount()).toBe(1);
  });

  it("AI 采纳替换正文触发；追加不触发", async () => {
    const made = await setupOutline(1);
    const volume = made.doc.volumes[0]!;
    const chapter = volume.chapters[0]!;
    const { createOutlineChapter } = await import("../src/main/project-ops.js");
    await createOutlineChapter(gateway, { volumeId: volume.id, chapterId: chapter.id, baseHash: made.hash });

    await adoptDraft(gateway, { usageId: "t1", volumeId: volume.id, chapterId: chapter.id, text: "第一段。", mode: "append" });
    expect(await preDestructiveCount()).toBe(0);

    await adoptDraft(gateway, { usageId: "t2", volumeId: volume.id, chapterId: chapter.id, text: "替换全文。", mode: "replace" });
    expect(await preDestructiveCount()).toBe(1);
  });
});