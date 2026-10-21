/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YushuError } from "@yushu/core";
import { IMPORT_CORRECTION_KINDS } from "@yushu/text";
import { IMPORT_JOB_CORRECTION_KINDS, parseOutline } from "@yushu/world-engine";
import { ImportGate } from "../src/main/import-gate.js";
import {
  applyImport,
  cancelImport,
  clearImportCancel,
  decideImportCancel,
  isImportCancelRequested,
  listResumableImportJobs,
  pickImportSource,
  previewImport,
  requestImportCancel,
} from "../src/main/import-ops.js";
import { importJobPath, readImportJob } from "../src/main/import-job-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

/**
 * 存量导入的**可中断续跑**（M5 / T5-7 第三段，R108；判据回源 I09 §2.7 / §3.1 / §5）。
 *
 * 这一层要守住的四件事，每一条都是"看起来能跑、其实在骗作者"的高危项：
 * ① **中断点在章的边界上**：半章写进去是半个章——草稿要么完整要么不存在；
 * ② **断点落盘且可续**：任务记录写"最后成功章号"，中断后重选同一份稿子能接着写；
 * ③ **续跑只认同一份稿子 + 同一份切分**：把两本书接在一起，比续跑失败更坏；
 * ④ **已写好的那几章不动**：续跑不覆盖作者的东西。
 *
 * 另外两条是这轮自己发现的：
 * ⑤ **续跑不能把同一卷加两遍**（卷已经在盘上了，重写大纲会既覆盖作者改动、又多一卷）；
 * ⑥ **任务记录不是项目内容**（落 `.yushu/imports/`，不进迁移包）。
 */

/** 三章的稿子（每章两行，够切出三章） */
const THREE_CHAPTERS = [
  "第一章 起",
  "夜色压下来，林渊拔剑而起。",
  "第二章 承",
  "林渊走过长街，风从窗缝里灌进来。",
  "第三章 转",
  "停。",
].join("\n");

let srcDir: string;
let projectDir: string;
let gate: ImportGate;
let gateway: ProjectGateway;

beforeEach(async () => {
  srcDir = await mkdtemp(join(tmpdir(), "yushu-job-src-"));
  projectDir = await mkdtemp(join(tmpdir(), "yushu-job-proj-"));
  gate = new ImportGate();
  gateway = new ProjectGateway(projectDir);
});

afterEach(async () => {
  clearImportCancel("cleanup");
  await rm(srcDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
  await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

/** 写一份稿子并登记成票 */
async function ticketFor(name: string, content: string): Promise<string> {
  const path = join(srcDir, name);
  await writeFile(path, content, "utf8");
  const picked = await pickImportSource(async () => ({ canceled: false, filePaths: [path] }), gate);
  if (picked === null) throw new Error("夹具没能登记出票据");
  return picked.ticket;
}

/** 项目目录下的章草稿（相对路径，排序） */
async function draftPaths(): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(current, entry.name), rel);
      else if (rel.startsWith("chapters/")) out.push(rel);
    }
  };
  await walk(projectDir, "");
  return out.sort();
}

/**
 * 一个"写完第一份草稿就请求取消"的网关。
 *
 * 为什么用网关而不是定时器：定时器版会**依赖时序**（apply 在进循环前有很多 await，
 * 定时器可能早一步触发 ⇒ 变成"一章都没写"），那条用例就会是**抖的**。
 * 卡在"第一次写章草稿"上 ⇒ 停在哪一章是确定的。
 */
class CancelAfterFirstDraft extends ProjectGateway {
  ticket = "";
  override async writeDoc(relPath: string, content: string, baseHash?: string) {
    const snap = await super.writeDoc(relPath, content, baseHash);
    if (relPath.startsWith("chapters/")) requestImportCancel(this.ticket);
    return snap;
  }
}

describe("中断：取消真的接上电了（R108）", () => {
  it("作者在入库途中取消 ⇒ 在章的边界上停，断点落盘，剩下的可续", async () => {
    const cancelGateway = new CancelAfterFirstDraft(projectDir);
    const ticket = await ticketFor("a.txt", THREE_CHAPTERS);
    cancelGateway.ticket = ticket;

    const result = await applyImport(cancelGateway, { ticket }, gate);

    expect(result.stopped).toBe(true);
    expect(result.writtenChapters).toBe(1);
    expect(result.totalChapters).toBe(3);
    // 半章不许存在：停下来的那一刻盘上只有整整的一章
    expect(await draftPaths()).toHaveLength(1);
  });

  it("中断后任务记录是 needs_review、断点记着最后成功章号、而且说清可续", async () => {
    const cancelGateway = new CancelAfterFirstDraft(projectDir);
    const ticket = await ticketFor("b.txt", THREE_CHAPTERS);
    cancelGateway.ticket = ticket;

    const result = await applyImport(cancelGateway, { ticket }, gate);
    const job = await readImportJob(projectDir, result.jobId);
    expect(job?.status).toBe("needs_review");
    expect(job?.checkpoint.last_chapter).toBe(1);
    expect(job?.checkpoint.resumable).toBe(true);
    expect(job?.chapters).toHaveLength(3);
  });

  it("取消标记是按票据走的：上一次入库留下的标记不会波及下一张票", async () => {
    const ticket = await ticketFor("c.txt", THREE_CHAPTERS);
    requestImportCancel(ticket);
    expect(isImportCancelRequested(ticket)).toBe(true);
    expect(isImportCancelRequested("别的票")).toBe(false);
    clearImportCancel(ticket);
    expect(isImportCancelRequested(ticket)).toBe(false);
  });

  it("「取消导入」这条通道两件事都做：作废票据 + 记一次取消", async () => {
    const ticket = await ticketFor("d.txt", THREE_CHAPTERS);
    cancelImport(ticket, gate);
    expect(isImportCancelRequested(ticket)).toBe(true);
    // 票据已作废 ⇒ 拿它再预演一次会被拒（不是悄悄读到了）
    await expect(previewImport(ticket, { gate })).rejects.toThrow(/票据无效/);
  });

  it("入库途中的取消**只记标记、不作废票据**（作废了这一批自己就读不到票了）", async () => {
    // 这条是预演 step70 当场撞出来的：取消把票作废了 ⇒ 入库读到一半报 E_IMPORT_TICKET
    // ⇒ 一次"停下"把整批导入变成了失败。
    const cancelGateway = new CancelAfterFirstDraft(projectDir);
    const ticket = await ticketFor("d2.txt", THREE_CHAPTERS);
    cancelGateway.ticket = ticket;
    const result = await applyImport(cancelGateway, { ticket }, gate);
    expect(result.stopped).toBe(true);
    // 票据仍然有效（没被作废）⇒ 还能再预演一次（作者可以改主意接着导）
    await expect(previewImport(ticket, { gate })).resolves.toBeTruthy();
  });

  it("没在入库时的取消 ⇒ 走「放弃」那一条（票据作废）", async () => {
    const ticket = await ticketFor("d3.txt", THREE_CHAPTERS);
    const decided = decideImportCancel(ticket, gate);
    expect(decided.stopped).toBe(false);
    expect(decided.revoked).toBe(true);
    await expect(previewImport(ticket, { gate })).rejects.toThrow(/票据无效/);
  });
});

describe("续跑：只认同一份稿子、同一份切分（R108）", () => {
  it("重选同一份稿子 ⇒ 接着写剩下的那几章，已写好的那章不动", async () => {
    const cancelGateway = new CancelAfterFirstDraft(projectDir);
    const ticket = await ticketFor("e.txt", THREE_CHAPTERS);
    cancelGateway.ticket = ticket;
    const stopped = await applyImport(cancelGateway, { ticket }, gate);
    const firstDraft = (await draftPaths())[0] ?? "";

    // 作者手工改过已经写好的那一章（模拟"导完之后我改了改"）——带 baseHash 是网关的规矩
    const before = await gateway.readDoc(firstDraft);
    await gateway.writeDoc(firstDraft, before.content + "\n作者自己加的一行。\n", before.hash);

    // 重新选同一份稿子（票据是新的：路径永远只从原生对话框来）
    const ticket2 = await ticketFor("e.txt", THREE_CHAPTERS);
    const done = await applyImport(gateway, { ticket: ticket2, jobId: stopped.jobId }, gate);

    expect(done.stopped).toBe(false);
    expect(done.created).toHaveLength(3);
    expect(await draftPaths()).toHaveLength(3);
    // 已写好的那一章**没有被覆盖**（作者加的那一行还在）
    const after = await gateway.readDoc(firstDraft);
    expect(after.content).toContain("作者自己加的一行。");
  });

  it("续跑完任务记录是 done、不可再续，且对账的差值照实记着", async () => {
    const cancelGateway = new CancelAfterFirstDraft(projectDir);
    const ticket = await ticketFor("f.txt", THREE_CHAPTERS);
    cancelGateway.ticket = ticket;
    const stopped = await applyImport(cancelGateway, { ticket }, gate);

    const ticket2 = await ticketFor("f.txt", THREE_CHAPTERS);
    await applyImport(gateway, { ticket: ticket2, jobId: stopped.jobId }, gate);

    const job = await readImportJob(projectDir, stopped.jobId);
    expect(job?.status).toBe("done");
    expect(job?.checkpoint.resumable).toBe(false);
    expect(job?.reconcile?.delta).toBe(0);
  });

  it("续跑不会把同一卷加两遍（卷已经在盘上了）", async () => {
    const cancelGateway = new CancelAfterFirstDraft(projectDir);
    const ticket = await ticketFor("g.txt", THREE_CHAPTERS);
    cancelGateway.ticket = ticket;
    const stopped = await applyImport(cancelGateway, { ticket }, gate);

    const ticket2 = await ticketFor("g.txt", THREE_CHAPTERS);
    await applyImport(gateway, { ticket: ticket2, jobId: stopped.jobId }, gate);

    const outline = parseOutline((await gateway.readDoc("outline/outline.yaml")).content);
    expect(outline.volumes).toHaveLength(1);
    expect(outline.volumes[0]?.chapters).toHaveLength(3);
  });

  it("选了另一份稿子 ⇒ 拒（把两本书接在一起，比续跑失败更坏）", async () => {
    const cancelGateway = new CancelAfterFirstDraft(projectDir);
    const ticket = await ticketFor("h.txt", THREE_CHAPTERS);
    cancelGateway.ticket = ticket;
    const stopped = await applyImport(cancelGateway, { ticket }, gate);

    const other = await ticketFor("i.txt", "第一章 起\n完全不同的一份稿子。\n");
    await expect(applyImport(gateway, { ticket: other, jobId: stopped.jobId }, gate)).rejects.toThrow(
      /不是同一份/,
    );
  });

  it("切分变了 ⇒ 拒（续跑要重放同一份切分）", async () => {
    const cancelGateway = new CancelAfterFirstDraft(projectDir);
    const ticket = await ticketFor("j.txt", THREE_CHAPTERS);
    cancelGateway.ticket = ticket;
    const stopped = await applyImport(cancelGateway, { ticket }, gate);

    const ticket2 = await ticketFor("j.txt", THREE_CHAPTERS);
    // 这次用一条把第二章标题也删掉的规则 ⇒ 切出来只有一章 ⇒ 与上次不是同一份切分
    await expect(
      applyImport(
        gateway,
        { ticket: ticket2, jobId: stopped.jobId, rules: [{ id: "drop2", pattern: "^第二章" }] },
        gate,
      ),
    ).rejects.toThrow(/切分与上次不一样|字节/);
  });

  it("已完成的任务不能续跑（done 是终态）", async () => {
    const ticket = await ticketFor("k.txt", THREE_CHAPTERS);
    const done = await applyImport(gateway, { ticket }, gate);
    const ticket2 = await ticketFor("k.txt", THREE_CHAPTERS);
    await expect(applyImport(gateway, { ticket: ticket2, jobId: done.jobId }, gate)).rejects.toThrow(
      /不能续跑/,
    );
  });
  it("预演显示的切分与续跑会写的那份一致（续跑重放任务记录里的计划）", async () => {
    // 这次导入带了一个人工校正（合并前两章）⇒ 任务记录里存的是"校正过的计划"（2 章）
    const cancelGateway = new CancelAfterFirstDraft(projectDir);
    const ticket = await ticketFor("q.txt", THREE_CHAPTERS);
    gate.setPlan(ticket, { corrections: [{ kind: "merge", at: 0 }] });
    cancelGateway.ticket = ticket;
    const stopped = await applyImport(cancelGateway, { ticket }, gate);
    const job = await readImportJob(projectDir, stopped.jobId);
    expect(job?.chapters).toHaveLength(2);

    // 重选同一份稿子：新票上没有上次的计划（AI 筛过哪些、校正过什么都丢了），
    // 但预演必须显示**续跑真正会写的那份**（2 章），而不是正则切的 3 章
    const ticket2 = await ticketFor("q.txt", THREE_CHAPTERS);
    const view = await previewImport(ticket2, { gate, gateway });
    expect(view.chapters).toHaveLength(2);
    expect(view.resume?.total_chapters).toBe(2);
  });
});

describe("任务记录：不是项目内容（R108）", () => {
  it("落在 .yushu/imports/ 下（网关的写禁区，不进迁移包）", async () => {
    const ticket = await ticketFor("l.txt", THREE_CHAPTERS);
    const done = await applyImport(gateway, { ticket }, gate);
    expect(importJobPath(done.jobId)).toBe(`.yushu/imports/job-${done.jobId}.yaml`);
    const entries = await readdir(join(projectDir, ".yushu", "imports"));
    expect(entries).toEqual([`job-${done.jobId}.yaml`]);
  });

  it("可续跑的任务清单只列还没导完的", async () => {
    const cancelGateway = new CancelAfterFirstDraft(projectDir);
    const ticket = await ticketFor("m.txt", THREE_CHAPTERS);
    cancelGateway.ticket = ticket;
    const stopped = await applyImport(cancelGateway, { ticket }, gate);
    const jobs = await listResumableImportJobs(gateway);
    expect(jobs.map((job) => job.id)).toEqual([stopped.jobId]);

    const ticket2 = await ticketFor("m.txt", THREE_CHAPTERS);
    await applyImport(gateway, { ticket: ticket2, jobId: stopped.jobId }, gate);
    expect(await listResumableImportJobs(gateway)).toEqual([]);
  });

  it("预演把续跑线索摆出来（主进程按源文件指纹核对，渲染层不自己判）", async () => {
    const cancelGateway = new CancelAfterFirstDraft(projectDir);
    const ticket = await ticketFor("n.txt", THREE_CHAPTERS);
    cancelGateway.ticket = ticket;
    const stopped = await applyImport(cancelGateway, { ticket }, gate);

    const ticket2 = await ticketFor("n.txt", THREE_CHAPTERS);
    const view = await previewImport(ticket2, { gate, gateway });
    expect(view.resume?.job_id).toBe(stopped.jobId);
    expect(view.resume?.last_chapter).toBe(1);
    expect(view.resume?.total_chapters).toBe(3);

    // 另一份稿子 ⇒ 没有续跑线索（没有就是没有，不给"可能是"的线索）
    const other = await ticketFor("o.txt", THREE_CHAPTERS);
    const otherView = await previewImport(other, { gate, gateway });
    expect(otherView.resume).toBeNull();
  });
});

describe("两边的校正动作种类表必须逐字一致（R108）", () => {
  it("@yushu/text 的那份与 world-engine 的那份一样（续跑才不会静默丢掉新动作）", () => {
    expect([...IMPORT_JOB_CORRECTION_KINDS]).toEqual([...IMPORT_CORRECTION_KINDS]);
  });
});

describe("错误码用 YushuError 抛（上层能分辨是哪种错）", () => {
  it("找不到任务记录 ⇒ E_IMPORT_RESUME", async () => {
    const ticket = await ticketFor("p.txt", THREE_CHAPTERS);
    const code = await applyImport(gateway, { ticket, jobId: "imp-nope" }, gate).then(
      () => "NO_THROW",
      (err: unknown) => (err instanceof YushuError ? err.code : `NOT_YUSHU:${String(err)}`),
    );
    expect(code).toBe("E_IMPORT_RESUME");
  });
});
