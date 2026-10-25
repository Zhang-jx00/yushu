/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countWords } from "@yushu/core";
import {
  OUTLINE_PATH,
  PUBLISH_LEDGER_API_VERSION,
  PUBLISH_LEDGER_PATH,
  chapterPath,
  parseOutline,
  readChapterFile,
  serializeChapterFile,
  serializePublishLedger,
  type PublishEvent,
} from "@yushu/world-engine";
import {
  readPublishBoard,
  scheduleChapterPublish,
  setChapterPublishStatus,
} from "../src/main/publish-ops.js";
import { createOutlineChapter, createProject, generateOutline } from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

/**
 * 存稿池与续航的桌面侧（R174 / M5 T5-6 剩余片之一）。
 *
 * 判据在引擎（`@yushu/world-engine/publish-stock.ts`，出处 I01 §3.5 存稿池与续航天数），
 * 这里验**接上真项目**后那几件宿主级的事：
 *
 * ① **列表条数与真源逐字一致**——池子里的每一行都对得上盘上那一份章；
 *    这条最怕的是"引擎自己算、面板自己报"，两边各数一遍就会长歪。
 *    ⇒ 这里的"真源条数"是**直接按文件文本数出来的**（不经过引擎那条路），
 *    引擎哪天改了筛选条件，这条当场红。
 * ② **临期 / 到期的判定与 `publish_at` 一致**——到期的那一条必须同时出现在提醒队列里
 *    （同一个判定函数 ⇒ 面板上不会出现两个"到期 N 条"）。
 * ③ **一键进发布状态机**——池子里那一行点一下就进发布状态机，台账照旧留痕。
 * ④ **到期提醒可撤销**——撤下之后 `publish_at` 清空、不再到期，
 *    但**稿子仍在存稿池里**（撤的是提醒，不是稿子）。
 * ⑤ **续航只从发布台账实测**——没有发布记录就明写算不出，不拿 0 充数。
 */

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

const NOW = "2026-10-25T20:00:00+08:00";

let dir: string;
let gateway: ProjectGateway;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-stock-"));
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
    chaptersPerVolume: Math.max(3, count),
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

/** 往章里写正文（写完的稿子才算"存稿"；frontmatter 的 word_count 同步写上） */
async function writeBody(path: string, text: string): Promise<void> {
  const snap = await gateway.readDoc(path);
  const { chapter, body } = readChapterFile(snap.content);
  await gateway.writeDoc(
    path,
    serializeChapterFile({ ...chapter, word_count: countWords(text) }, `${body}\n\n${text}\n`),
    snap.hash,
  );
}

/**
 * 真源里"写完还没发"的章数与清单 —— **直接按文件文本数**（不经过引擎那条路）。
 *
 * 这就是"列表条数与真源逐字一致"的对账基准：引擎哪天改了筛选条件（把 0 字的算进来、
 * 把已发布的算进来……），这里立刻对不上。
 */
async function stockTruth(): Promise<string[]> {
  const snap = await gateway.readDoc(OUTLINE_PATH);
  const outline = parseOutline(snap.content);
  const ids: string[] = [];
  for (const volume of outline.volumes) {
    for (const chapter of volume.chapters) {
      if (!chapter.chapter_id) continue;
      const file = await gateway.readDoc(chapterPath(volume.id, chapter.chapter_id)).catch(() => null);
      if (file === null) continue;
      const status = /^status:\s*(\S+)/m.exec(file.content);
      const words = /^word_count:\s*(\d+)/m.exec(file.content);
      if (status === null || words === null) continue;
      if (status[1] !== "draft") continue;
      if (Number(words[1]) <= 0) continue;
      ids.push(chapter.chapter_id);
    }
  }
  return ids.sort();
}

/** 往发布台账里写几条留痕（用来把日更速率钉成确定值，不依赖墙钟） */
async function writeLedger(events: PublishEvent[]): Promise<void> {
  await gateway.writeDoc(
    PUBLISH_LEDGER_PATH,
    serializePublishLedger({ apiVersion: PUBLISH_LEDGER_API_VERSION, events }),
  );
}

function publishedEvent(chapterId: string, at: string): PublishEvent {
  return { chapterId, from: "draft", to: "published", at, wordCount: 2000, rollback: false };
}

describe("存稿池：列表与真源逐字一致（R174）", () => {
  it("池子只收「写完还没发」的章：条数与清单都和盘上逐字一致", async () => {
    const paths = await draft(3);
    await writeBody(paths[0] as string, "他伸手推开门，夜色涌了进来。");
    await writeBody(paths[1] as string, "刀光在墙上一闪，灯灭了。");
    // 第三章不写正文 ⇒ 它在草稿箱里，不算"攒下的稿"

    const board = await readPublishBoard(gateway, NOW);
    const truth = await stockTruth();

    expect(truth).toHaveLength(2);
    expect(board.stock.endurance.poolCount).toBe(truth.length);
    expect(board.stock.rows).toHaveLength(truth.length);
    expect(board.stock.rows.map((row) => row.id).sort()).toEqual(truth);
  });

  it("池子里的每一行都带着写入点要的路径与 hash（不然面板上的按钮点不动）", async () => {
    const paths = await draft(1);
    await writeBody(paths[0] as string, "刀光在墙上一闪，灯灭了。");
    const board = await readPublishBoard(gateway, NOW);
    const row = board.stock.rows[0];
    expect(row?.path).toBe(paths[0]);
    expect(row?.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("存稿池：临期 / 到期的判定与 publish_at 一致（R174）", () => {
  it("到期 / 临期 / 已定时 / 存稿四种处境按 publish_at 分，且到期的那条也在提醒队列里", async () => {
    const paths = await draft(4);
    for (const path of paths) await writeBody(path as string, "刀光在墙上一闪，灯灭了。");

    const hashOf = async (path: string) => (await gateway.readDoc(path)).hash;
    // 已过点 ⇒ 到期
    await scheduleChapterPublish(gateway, {
      path: paths[0] as string,
      publishAt: "2026-10-25T09:00:00+08:00",
      baseHash: await hashOf(paths[0] as string),
    });
    // 13 小时后 ⇒ 临期（48 小时窗口内）
    await scheduleChapterPublish(gateway, {
      path: paths[1] as string,
      publishAt: "2026-10-26T09:00:00+08:00",
      baseHash: await hashOf(paths[1] as string),
    });
    // 60 小时后 ⇒ 已定时（还没进临期窗口）
    await scheduleChapterPublish(gateway, {
      path: paths[2] as string,
      publishAt: "2026-10-28T09:00:00+08:00",
      baseHash: await hashOf(paths[2] as string),
    });
    // paths[3] 没定时 ⇒ 存稿

    const board = await readPublishBoard(gateway, NOW);
    const states = board.stock.rows.map((row) => row.dueState).sort();
    const dueIds = board.stock.rows.filter((row) => row.dueState === "due").map((row) => row.id);

    expect(states).toEqual(["due", "scheduled", "soon", "stock"]);
    expect(dueIds).toHaveLength(1);
    // 同一个判定口径：池子里到期的那些，提醒队列里也一定在（面板上不会出现两个"到期 N 条"）
    for (const id of dueIds) expect(board.reminders.map((item) => item.id)).toContain(id);
    expect(board.stock.endurance.dueCount).toBe(1);
    expect(board.stock.endurance.soonCount).toBe(1);
    expect(board.stock.endurance.scheduledCount).toBe(1);
    expect(board.stock.endurance.stockCount).toBe(1);
    // 四个数加起来 = 池子章数（不许有一个数是"另外算的"）
    expect(
      board.stock.endurance.dueCount +
        board.stock.endurance.soonCount +
        board.stock.endurance.scheduledCount +
        board.stock.endurance.stockCount,
    ).toBe(board.stock.endurance.poolCount);
  });
});

describe("存稿池：一键进发布状态机与撤销提醒（R174）", () => {
  it("一键进发布状态机：章真的变成已发布，台账照旧留痕，它也从池子里走了", async () => {
    const paths = await draft(1);
    await writeBody(paths[0] as string, "刀光在墙上一闪，灯灭了。");
    const before = await readPublishBoard(gateway, NOW);
    const row = before.stock.rows[0];
    if (row === undefined) throw new Error("池子里没有章");

    const result = await setChapterPublishStatus(gateway, {
      path: row.path,
      to: "published",
      baseHash: row.hash,
    });
    expect(result.to).toBe("published");
    expect(result.ledgerEvents).toBe(1);

    const after = await readPublishBoard(gateway, NOW);
    expect(after.stock.rows).toHaveLength(0);
    expect(after.stock.endurance.poolCount).toBe(0);
  });

  it("到期提醒可撤销：撤下后 publish_at 清空、不再到期，稿子仍在池子里", async () => {
    const paths = await draft(1);
    await writeBody(paths[0] as string, "刀光在墙上一闪，灯灭了。");
    const hash = (await gateway.readDoc(paths[0] as string)).hash;
    await scheduleChapterPublish(gateway, {
      path: paths[0] as string,
      publishAt: "2026-10-25T09:00:00+08:00",
      baseHash: hash,
    });

    const due = await readPublishBoard(gateway, NOW);
    expect(due.stock.endurance.dueCount).toBe(1);
    expect(due.reminders).toHaveLength(1);
    const row = due.stock.rows[0];
    if (row === undefined) throw new Error("池子里没有章");

    await scheduleChapterPublish(gateway, { path: row.path, publishAt: "", baseHash: row.hash });

    const after = await readPublishBoard(gateway, NOW);
    const content = (await gateway.readDoc(row.path)).content;
    expect(content).not.toContain("publish_at");
    expect(after.stock.endurance.dueCount).toBe(0);
    expect(after.reminders).toHaveLength(0);
    // 撤的是提醒，不是稿子：池子里仍然是这一章
    expect(after.stock.rows).toHaveLength(1);
    expect(after.stock.rows[0]?.dueState).toBe("stock");
    expect(after.stock.endurance.poolCount).toBe(1);
  });
});

describe("存稿池：续航只从发布台账实测（R174）", () => {
  it("台账里没有发布记录 ⇒ 明写算不出，不拿 0 充数", async () => {
    const paths = await draft(1);
    await writeBody(paths[0] as string, "刀光在墙上一闪，灯灭了。");
    const board = await readPublishBoard(gateway, NOW);
    expect(board.stock.endurance.dailyChapters).toBeNull();
    expect(board.stock.endurance.days).toBeNull();
    expect(board.stock.endurance.note).toContain("发布记录");
    expect(board.stock.endurance.warning).toBe("");
  });

  it("台账里有发布记录 ⇒ 日更章数与可撑天数按实测算出来", async () => {
    const paths = await draft(3);
    for (const path of paths) await writeBody(path as string, "刀光在墙上一闪，灯灭了。");
    // 三天各发一章 ⇒ 日均 1 章；池子里 3 章 ⇒ 可撑 3 天
    await writeLedger([
      publishedEvent("ch-old", "2026-10-23T09:00:00+08:00"),
      publishedEvent("ch-mid", "2026-10-24T09:00:00+08:00"),
      publishedEvent("ch-new", "2026-10-25T09:00:00+08:00"),
    ]);
    const board = await readPublishBoard(gateway, NOW);
    expect(board.stock.endurance.windowDays).toBe(3);
    expect(board.stock.endurance.dailyChapters).toBe(1);
    expect(board.stock.endurance.days).toBe(3);
    expect(board.stock.endurance.warning).toBe("");
  });

  it("可撑天数低于阈值 ⇒ 报断更预警（阈值 3 天）", async () => {
    const paths = await draft(1);
    await writeBody(paths[0] as string, "刀光在墙上一闪，灯灭了。");
    await writeLedger([
      publishedEvent("ch-a", "2026-10-23T09:00:00+08:00"),
      publishedEvent("ch-b", "2026-10-24T09:00:00+08:00"),
      publishedEvent("ch-c", "2026-10-25T09:00:00+08:00"),
    ]);
    const board = await readPublishBoard(gateway, NOW);
    expect(board.stock.endurance.days).toBe(1);
    expect(board.stock.endurance.warning).not.toBe("");
    expect(board.stock.endurance.warning).toContain("3");
  });
});
