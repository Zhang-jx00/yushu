/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YushuError } from "@yushu/core";
import {
  OUTLINE_PATH,
  PUBLISH_LEDGER_PATH,
  parseOutline,
  readChapterFile,
} from "@yushu/world-engine";
import {
  readPublishBoard,
  scheduleChapterPublish,
  setChapterPublishStatus,
} from "../src/main/publish-ops.js";
import { createOutlineChapter, createProject, generateOutline } from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

/**
 * 发布状态机的桌面侧（M5 / T5-6，R105）。
 *
 * 判据在引擎（`@yushu/world-engine/publish.ts`，出处 I01 §5 状态机与 I07 平台规则包），
 * 这里验**接上真项目**后那几件宿主级的事：
 * ① **写入点真的存在**：章 frontmatter 的 `status` 能改，改完台账里多一条留痕；
 * ② **非法迁移不许落盘**：草稿 → 修订中 被拒时，**章与台账都一个字节没动**；
 * ③ **不留半截状态**：章节写失败（baseHash 冲突）时，台账里刚写的那条留痕必须被撤回去——
 *    "留痕说有、状态没改"的半截状态会让当日字数口径**静默**算错，那是最坏的一种坏；
 * ④ **定时发布只是本地提醒**：到点且未发布才进提醒队列，已发布的不进。
 *
 * 与 R102 同口径：路径不出主进程、一切写入带 baseHash、结论只讲事实。
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
  dir = await mkdtemp(join(tmpdir(), "yushu-publish-"));
  gateway = new ProjectGateway(dir);
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

/** 建 N 章草稿（逐章重取大纲 baseHash：建章会回填 chapter_id 改写大纲） */
async function draft(count: number): Promise<string[]> {
  await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 3,
  });
  const snap = await gateway.readDoc(OUTLINE_PATH);
  const outline = parseOutline(snap.content);
  const paths: string[] = [];
  for (const volume of outline.volumes) {
    for (const chapter of volume.chapters) {
      if (paths.length >= count) break;
      const fresh = await gateway.readDoc(OUTLINE_PATH);
      const created = await createOutlineChapter(gateway, {
        volumeId: volume.id,
        chapterId: chapter.id,
        baseHash: fresh.hash,
      });
      paths.push(created.chapterPath);
    }
  }
  return paths;
}

async function chapterOf(path: string): Promise<{ status: string; publishAt: string }> {
  const snap = await gateway.readDoc(path);
  const { chapter } = readChapterFile(snap.content);
  return {
    status: chapter.status,
    publishAt: typeof chapter.publish_at === "string" ? chapter.publish_at : "",
  };
}

async function ledgerRaw(): Promise<string | null> {
  return gateway.readDoc(PUBLISH_LEDGER_PATH).then(
    (snap) => snap.content,
    () => null,
  );
}

describe("发布看板：状态分组与定时提醒", () => {
  it("刚建好的章都是草稿，台账还没有留痕", async () => {
    await draft(2);
    const board = await readPublishBoard(gateway, "2026-10-20T20:00:00+08:00");
    expect(board.groups).toEqual({ draft: 2, revised: 0, published: 0 });
    expect(board.ledgerEvents).toBe(0);
    expect(board.reminders).toEqual([]);
  });

  it("到点且未发布的章进提醒队列；已发布的不进", async () => {
    const [path] = await draft(1);
    if (path === undefined) throw new Error("夹具没能建出章节草稿");
    const hash = (await gateway.readDoc(path)).hash;
    await scheduleChapterPublish(gateway, { path, publishAt: "2026-10-20T09:00:00+08:00", baseHash: hash });
    const due = await readPublishBoard(gateway, "2026-10-20T20:00:00+08:00");
    expect(due.reminders).toHaveLength(1);
    expect(due.reminders[0]?.publishAt).toBe("2026-10-20T09:00:00+08:00");

    const fresh = (await gateway.readDoc(path)).hash;
    await setChapterPublishStatus(gateway, { path, to: "published", baseHash: fresh });
    const after = await readPublishBoard(gateway, "2026-10-20T20:00:00+08:00");
    expect(after.groups.published).toBe(1);
    expect(after.reminders).toEqual([]);
  });
});

describe("改发布状态：写入点与留痕", () => {
  it("草稿 → 已发布：章 frontmatter 改了，台账多一条留痕", async () => {
    const [path] = await draft(1);
    if (path === undefined) throw new Error("夹具没能建出章节草稿");
    const hash = (await gateway.readDoc(path)).hash;
    const result = await setChapterPublishStatus(gateway, { path, to: "published", baseHash: hash });
    expect(result.from).toBe("draft");
    expect(result.to).toBe("published");
    expect(result.rollback).toBe(false);
    expect(result.ledgerEvents).toBe(1);
    expect((await chapterOf(path)).status).toBe("published");
    expect(await ledgerRaw()).toContain("to: published");
  });

  it("非法迁移（草稿 → 修订中）被拒，章与台账都一个字节没动", async () => {
    const [path] = await draft(1);
    if (path === undefined) throw new Error("夹具没能建出章节草稿");
    const hash = (await gateway.readDoc(path)).hash;
    const before = (await gateway.readDoc(path)).content;
    await expect(
      setChapterPublishStatus(gateway, { path, to: "revised", baseHash: hash }),
    ).rejects.toThrow();
    expect((await gateway.readDoc(path)).content).toBe(before);
    expect(await ledgerRaw()).toBeNull();
  });

  it("回退（已发布 → 草稿）合法，且留痕里标着回退", async () => {
    const [path] = await draft(1);
    if (path === undefined) throw new Error("夹具没能建出章节草稿");
    const hash = (await gateway.readDoc(path)).hash;
    await setChapterPublishStatus(gateway, { path, to: "published", baseHash: hash });
    const fresh = (await gateway.readDoc(path)).hash;
    const back = await setChapterPublishStatus(gateway, {
      path,
      to: "draft",
      baseHash: fresh,
      note: "平台审稿没过",
    });
    expect(back.rollback).toBe(true);
    expect(back.ledgerEvents).toBe(2);
    expect((await chapterOf(path)).status).toBe("draft");
    const raw = await ledgerRaw();
    expect(raw).toContain("rollback: true");
    expect(raw).toContain("平台审稿没过");
  });

  it("章节写失败时，留痕被撤回去——不留半截状态", async () => {
    const [path] = await draft(1);
    if (path === undefined) throw new Error("夹具没能建出章节草稿");
    // 故意给一个错的 baseHash：章节那一步必然失败（并发冲突）
    const wrongHash = "0".repeat(64);
    await expect(
      setChapterPublishStatus(gateway, { path, to: "published", baseHash: wrongHash }),
    ).rejects.toThrow();
    // 台账必须回到"没有留痕"——否则"留痕说有、状态没改"会让当日字数口径静默算错
    expect(await ledgerRaw()).toBeNull();
    expect((await chapterOf(path)).status).toBe("draft");
  });

  it("并发冲突报的是既有错误码，不是新造一个", async () => {
    const [path] = await draft(1);
    if (path === undefined) throw new Error("夹具没能建出章节草稿");
    const wrongHash = "0".repeat(64);
    const code = await setChapterPublishStatus(gateway, { path, to: "published", baseHash: wrongHash }).then(
      () => "NO_THROW",
      (err: unknown) => (err instanceof YushuError ? err.code : `NOT_YUSHU:${String(err)}`),
    );
    expect(code).toBe("E_DOC_CONFLICT");
  });
});

describe("定时发布：写进章 frontmatter，可清除", () => {
  it("设定后盘上真有 publish_at；清除后没了", async () => {
    const [path] = await draft(1);
    if (path === undefined) throw new Error("夹具没能建出章节草稿");
    const hash = (await gateway.readDoc(path)).hash;
    await scheduleChapterPublish(gateway, { path, publishAt: "2026-10-21T08:00:00+08:00", baseHash: hash });
    expect((await chapterOf(path)).publishAt).toBe("2026-10-21T08:00:00+08:00");
    const fresh = (await gateway.readDoc(path)).hash;
    await scheduleChapterPublish(gateway, { path, publishAt: "", baseHash: fresh });
    expect((await chapterOf(path)).publishAt).toBe("");
  });

  it("时刻解析不了 ⇒ 报错，不写盘", async () => {
    const [path] = await draft(1);
    if (path === undefined) throw new Error("夹具没能建出章节草稿");
    const hash = (await gateway.readDoc(path)).hash;
    const before = (await gateway.readDoc(path)).content;
    await expect(
      scheduleChapterPublish(gateway, { path, publishAt: "下周二", baseHash: hash }),
    ).rejects.toThrow();
    expect((await gateway.readDoc(path)).content).toBe(before);
  });
});
