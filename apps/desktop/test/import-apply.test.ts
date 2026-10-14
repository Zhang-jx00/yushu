/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OUTLINE_PATH, parseOutline, serializeOutline, type Outline } from "@yushu/world-engine";
import { countWords } from "@yushu/core";
import { ImportGate } from "../src/main/import-gate.js";
import { applyImport } from "../src/main/import-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

/**
 * 存量导入的入库那一步（M5 / T5-7 桌面侧第三段，R79）。
 *
 * 这一步开始**写真源**，所以断言的重心从"报告说得对不对"转到"写下去的东西对得上吗"：
 * ① **预演与入库共用同一条计算管线**——字数对账只有在两侧算法一致时才有意义，
 *    所以这里逐章比对"预演报的字数"与"落盘读回的字数"，对不上就点名，不静默算成功；
 * ② **冲突先于写入**：大纲 hash 过期 ⇒ 当场拒，且**一个草稿文件都不许留下**
 *    （写序是"先大纲后草稿"，宁可留下看得见的缺草稿，也不留看不见的孤儿文件）；
 * ③ **破坏前必有快照**：建卷建章会改大纲与新增章节文件，快照拿不到就阻断；
 * ④ **票据一次性**：入库成功即作废，同一张票不能把同一部稿子导两遍；
 * ⑤ **不替作者猜结构**：整篇没切开要显式确认；楔子不并进第一章；幕名认不出就报错并列出可选。
 */

let dir: string;
let srcDir: string;
let gateway: ProjectGateway;
let gate: ImportGate;

/** 选一份外部稿件：写进临时源目录（项目目录之外），再经闸门登记成票据 */
const pick = async (name: string, text: string): Promise<string> => {
  const path = join(srcDir, name);
  await writeFile(path, text, "utf8");
  const picked = await gate.register(path);
  return picked.ticket;
};

const outlineWith = (acts: string[]): Outline => ({
  apiVersion: "yushu.outline/v1",
  format_version: 1,
  id: "ol-test-0001",
  master: {
    title: "测试书",
    logline: "",
    theme: "",
    notes: "",
    acts: acts.map((name) => ({ name, desc: "" })),
  },
  volumes: [],
});

const listChapterFiles = async (): Promise<string[]> => {
  const tree = await gateway.listTree();
  return tree.filter((entry) => entry.path.startsWith("chapters/") && entry.path.endsWith(".md")).map((entry) => entry.path);
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-import-apply-"));
  srcDir = await mkdtemp(join(tmpdir(), "yushu-import-src-"));
  gateway = new ProjectGateway(dir);
  gate = new ImportGate();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(srcDir, { recursive: true, force: true });
});

const THREE_CHAPTERS = [
  "作品简介：一段楔子，不该并进第一章。",
  "第一章 起",
  "夜色压下来。",
  "第二章 承",
  "林渊拔剑而起。",
  "第三章 转",
  "剑光落下，风声停了。",
].join("\n");

describe("入库：建一卷、建章纲、写草稿，并逐章对账", () => {
  it("三章稿件 ⇒ 一卷三章纲 + 三个草稿文件，正文落盘", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起"])));
    const ticket = await pick("稿.txt", THREE_CHAPTERS);
    const before = await gateway.readDoc(OUTLINE_PATH);
    const result = await applyImport(gateway, { ticket, baseHash: before.hash }, gate);
    expect(result.created).toHaveLength(3);
    expect(await listChapterFiles()).toHaveLength(3);
    const outline = parseOutline((await gateway.readDoc(OUTLINE_PATH)).content);
    expect(outline.volumes).toHaveLength(1);
    expect(outline.volumes[0]?.chapters.map((c) => c.title)).toEqual(["第一章 起", "第二章 承", "第三章 转"]);
    // 章纲回填 chapter_id：大纲与草稿双向对得上，稿件总览才看得见
    for (const chapter of outline.volumes[0]?.chapters ?? []) {
      expect(chapter.chapter_id).toBeTruthy();
    }
    const first = (await gateway.readDoc(result.created[0]?.path ?? "")).content;
    expect(first).toContain("夜色压下来。");
  });

  it("字数对账：预演报的字数 = 落盘读回的字数，逐章成立且总数成立", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起"])));
    const ticket = await pick("对账.txt", THREE_CHAPTERS);
    const before = await gateway.readDoc(OUTLINE_PATH);
    const result = await applyImport(gateway, { ticket, baseHash: before.hash }, gate);
    expect(result.created.map((row) => row.reconciled)).toEqual([true, true, true]);
    expect(result.created.map((row) => row.writtenWords)).toEqual([
      countWords("夜色压下来。"),
      countWords("林渊拔剑而起。"),
      countWords("剑光落下，风声停了。"),
    ]);
    expect(result.totalWrittenWords).toBe(result.totalExpectedChars);
    expect(result.mismatched).toEqual([]);
  });

  it("对账是真的读回比对：落盘字数被改动时必须报出不符，而不是照抄预演的数", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起"])));
    const ticket = await pick("篡改.txt", THREE_CHAPTERS);
    // 只代理"读"：章节文件读回来时字数被改成别的数，产品必须发现对不上
    const spy = new Proxy(gateway, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key !== "readDoc") return value;
        return async (path: string) => {
          const snap = await target.readDoc(path);
          if (!path.startsWith("chapters/")) return snap;
          return { ...snap, content: snap.content.replace(/word_count: \d+/, "word_count: 999999") };
        };
      },
    });
    const result = await applyImport(spy as ProjectGateway, { ticket }, gate);
    expect(result.created.every((row) => row.reconciled === false)).toBe(true);
    expect(result.created.every((row) => row.writtenWords === 999999)).toBe(true);
    expect(result.mismatched).toHaveLength(3);
    expect(result.totalWrittenWords).not.toBe(result.totalExpectedChars);
    // 对账不符**不回滚也不静默成功**：文件是作者要的，只是数字对不上，必须点名让人去看
    expect(result.note).toContain("对不上");
  });

  it("项目还没有大纲 ⇒ 自己建一份最小大纲，不要求先跑 AI 生成（离线可用是红线）", async () => {
    const ticket = await pick("无纲.txt", "第一章 起\n夜色压下来。\n");
    const result = await applyImport(gateway, { ticket }, gate);
    const outline = parseOutline((await gateway.readDoc(OUTLINE_PATH)).content);
    expect(outline.volumes).toHaveLength(1);
    expect(outline.master.acts.length).toBeGreaterThanOrEqual(1);
    expect(outline.volumes[0]?.act).toBe(outline.master.acts[0]?.name);
    expect(result.created).toHaveLength(1);
  });

  it("默认卷名带文件名，传入则用传入的", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起"])));
    const a = await pick("旧稿.txt", "第一章 起\n夜色压下来。\n");
    const first = await applyImport(gateway, { ticket: a }, gate);
    expect(first.volumeTitle).toContain("旧稿");
    const b = await pick("另一份.txt", "第一章 起\n剑光落下。\n");
    const second = await applyImport(gateway, { ticket: b, volumeTitle: "作者命名卷" }, gate);
    expect(second.volumeTitle).toBe("作者命名卷");
    // 两次导入并存，卷与章 id 不互相覆盖
    const outline = parseOutline((await gateway.readDoc(OUTLINE_PATH)).content);
    expect(outline.volumes).toHaveLength(2);
    expect(await listChapterFiles()).toHaveLength(2);
  });
});

describe("写入前的闸门：冲突、确认、快照", () => {
  it("大纲 hash 过期 ⇒ 拒绝，且一个草稿文件都不留下", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起"])));
    const ticket = await pick("冲突.txt", THREE_CHAPTERS);
    await expect(applyImport(gateway, { ticket, baseHash: "0".repeat(64) }, gate)).rejects.toThrow(/冲突|E_DOC_CONFLICT/);
    expect(await listChapterFiles()).toEqual([]);
    expect(parseOutline((await gateway.readDoc(OUTLINE_PATH)).content).volumes).toHaveLength(0);
  });

  it("没切开又没确认 ⇒ 不写；显式确认才整篇作一章入库，标题取文件名", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起"])));
    const ticket = await pick("整篇一章.txt", "这是一段没有标题的正文。\n");
    await expect(applyImport(gateway, { ticket }, gate)).rejects.toThrow(/确认/);
    expect(await listChapterFiles()).toEqual([]);
    const result = await applyImport(gateway, { ticket, confirmSingleChapter: true }, gate);
    expect(result.created).toHaveLength(1);
    expect(result.created[0]?.title).toContain("整篇一章");
  });

  it("幕名在总纲里认不出 ⇒ 报错并列出可选，不猜也不静默新增一幕", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起", "承"])));
    const ticket = await pick("幕.txt", "第一章 起\n夜色压下来。\n");
    await expect(applyImport(gateway, { ticket, act: "合" }, gate)).rejects.toThrow(/起/);
    expect(await listChapterFiles()).toEqual([]);
  });

  it("入库前强制破坏前快照（撤销窗口必须在写之前存在）", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起"])));
    const ticket = await pick("快照.txt", THREE_CHAPTERS);
    const result = await applyImport(gateway, { ticket }, gate);
    expect(result.snapshotId).toBeTruthy();
    const manifests = await readdir(join(dir, ".yushu", "snapshots", "manifests")).catch(() => []);
    expect(manifests.length).toBeGreaterThan(0);
  });
});

describe("入库不越界：楔子、密钥、坏输入", () => {
  it("首章之前的内容不并进第一章，也不静默丢：结果里点名", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起"])));
    const ticket = await pick("楔子.txt", THREE_CHAPTERS);
    const result = await applyImport(gateway, { ticket }, gate);
    expect(result.preamble?.chars).toBe(countWords("作品简介：一段楔子，不该并进第一章。"));
    expect(result.preamble?.excerpt).toContain("作品简介");
    const first = (await gateway.readDoc(result.created[0]?.path ?? "")).content;
    expect(first).not.toContain("作品简介");
  });

  it("正文里的疑似密钥不落盘（红线 3 的导入侧落点）", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起"])));
    const ticket = await pick("密钥.txt", "第一章 起\n我的 key 是 sk-abcdefghijklmnopqrstuvwx\n");
    const result = await applyImport(gateway, { ticket }, gate);
    const written = (await gateway.readDoc(result.created[0]?.path ?? "")).content;
    expect(written).not.toContain("abcdefghijklmnopqrstuvwx");
    expect(written).toContain("[已剔除疑似密钥]");
  });

  it("自定义正则读不懂 ⇒ 抛错且什么都不写", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起"])));
    const ticket = await pick("坏规则.txt", THREE_CHAPTERS);
    await expect(
      applyImport(gateway, { ticket, rules: [{ id: "bad", pattern: "([没写完" }] }, gate),
    ).rejects.toThrow(/正则读不了/);
    expect(await listChapterFiles()).toEqual([]);
    expect(parseOutline((await gateway.readDoc(OUTLINE_PATH)).content).volumes).toHaveLength(0);
  });

  it("空文件 ⇒ 没内容可入库，不建空卷", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起"])));
    const ticket = await pick("空.txt", "");
    await expect(applyImport(gateway, { ticket, confirmSingleChapter: true }, gate)).rejects.toThrow(/没有|空/);
    expect(await listChapterFiles()).toEqual([]);
  });
});

describe("票据一次性", () => {
  it("入库成功后票据立即作废：同票不能再导，也不能再预演", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起"])));
    const ticket = await pick("一次性.txt", "第一章 起\n夜色压下来。\n");
    await applyImport(gateway, { ticket }, gate);
    expect(gate.size()).toBe(0);
    await expect(applyImport(gateway, { ticket }, gate)).rejects.toThrow(/票据/);
  });

  it("入库失败（冲突）时票据不作废——作者改一改还能重试，不必重新选文件", async () => {
    await gateway.writeDoc(OUTLINE_PATH, serializeOutline(outlineWith(["起"])));
    const ticket = await pick("可重试.txt", "第一章 起\n夜色压下来。\n");
    await expect(applyImport(gateway, { ticket, baseHash: "f".repeat(64) }, gate)).rejects.toThrow(/冲突|E_DOC_CONFLICT/);
    expect(gate.size()).toBe(1);
    const ok = await applyImport(gateway, { ticket }, gate);
    expect(ok.created).toHaveLength(1);
  });
});
