/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ImportGate, IMPORT_MAX_BYTES } from "../src/main/import-gate.js";

/**
 * 存量导入的「挑选闸门」（M5 / T5-7 桌面侧，R77）。
 *
 * 为什么要有这一道：红线 5 说一切读写走 FileGateway、拒绝绝对路径逃逸。而导入外部稿件
 * 天生要读项目目录**之外**的文件——如果开一条"渲染层传绝对路径进来"的通道，
 * 那等于把护栏拆了：渲染层里任何一段被注入的代码都能拿它去读 `~/.ssh/id_rsa`、
 * `config/llm.yaml`，甚至别的项目的稿子。
 *
 * 所以通道只认**票据**：路径只能由主进程的原生对话框结果登记进来（用户亲手选的），
 * 渲染层拿到的是一个一次性 ticket，永远不把路径当参数传。闸门再叠三条限制：
 * TTL、单次可读字节上限、目录拒读。
 */

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-import-gate-"));
  file = join(dir, "旧稿第一章.txt");
  await writeFile(file, "第一章 起\n夜色压下来。\n", "utf8");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("登记：只有真实存在且大小合适的文件才发得出票", () => {
  it("用户经对话框选中的文件 ⇒ 发票，并回报路径与字节数", async () => {
    const gate = new ImportGate();
    const picked = await gate.register(file);
    expect(picked.path).toBe(file);
    expect(picked.bytes).toBeGreaterThan(0);
    expect(picked.ticket.length).toBeGreaterThanOrEqual(16);
  });

  it("路径不存在 ⇒ 拒绝，不发空头票", async () => {
    const gate = new ImportGate();
    await expect(gate.register(join(dir, "没有这个文件.txt"))).rejects.toThrow(/读不到/);
  });

  it("目录 ⇒ 拒绝（否则能拿它去试探目录树）", async () => {
    const gate = new ImportGate();
    const sub = join(dir, "某个目录");
    await mkdir(sub);
    await expect(gate.register(sub)).rejects.toThrow(/不是文件/);
  });

  it("超过上限的文件当场拒，不等读完才说", async () => {
    const gate = new ImportGate();
    const big = join(dir, "超大.txt");
    await writeFile(big, Buffer.alloc(IMPORT_MAX_BYTES + 1024, 0x41));
    await expect(gate.register(big)).rejects.toThrow(/超过上限/);
  });
});

describe("取回：票据是唯一入口，且有 TTL 与一次性语义", () => {
  it("凭票能读到字节，且内容与磁盘一致", async () => {
    const gate = new ImportGate();
    const picked = await gate.register(file);
    const read = await gate.readTicket(picked.ticket);
    expect(read.path).toBe(file);
    expect(Buffer.from(read.bytes).toString("utf8")).toContain("夜色压下来。");
  });

  it("伪造 / 未知票据 ⇒ 拒绝，不碰磁盘", async () => {
    const gate = new ImportGate();
    await expect(gate.readTicket("0000000000000000000000")).rejects.toThrow(/票据无效/);
  });

  it("TTL 到点就作废", async () => {
    const gate = new ImportGate({ ttlMs: 1000 });
    const picked = await gate.register(file);
    await expect(gate.readTicket(picked.ticket, Date.now() + 2000)).rejects.toThrow(/过期/);
  });

  it("同一张票可以取两次（预览→确认入库是同一次导入动作），但换票要重新选", async () => {
    const gate = new ImportGate();
    const picked = await gate.register(file);
    const a = await gate.readTicket(picked.ticket);
    const b = await gate.readTicket(picked.ticket);
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
  });

  it("revoke 之后立刻读不到（用户取消导入时调用）", async () => {
    const gate = new ImportGate();
    const picked = await gate.register(file);
    gate.revoke(picked.ticket);
    await expect(gate.readTicket(picked.ticket)).rejects.toThrow(/票据无效/);
  });

  it("票据之间互不串台：A 票读不到 B 路径", async () => {
    const gate = new ImportGate();
    const other = join(dir, "另一份.txt");
    await writeFile(other, "秘密内容", "utf8");
    const a = await gate.register(file);
    await gate.register(other);
    const read = await gate.readTicket(a.ticket);
    expect(read.path).toBe(file);
  });
});

describe("确定性", () => {
  it("同一份文件两次登记的字节内容一致（探测与清洗在下一层，这里只管取字节）", async () => {
    const gate = new ImportGate();
    const one = await gate.readTicket((await gate.register(file)).ticket);
    const two = await gate.readTicket((await gate.register(file)).ticket);
    expect(Buffer.from(one.bytes).equals(Buffer.from(two.bytes))).toBe(true);
  });
});
