/* SPDX-License-Identifier: Apache-2.0 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YushuError } from "@yushu/core";
import { LLM_API_VERSION, LLM_FORMAT_VERSION, serializeLlmConfig } from "@yushu/llm";
import { setAiEnabled } from "../src/main/ai-ops.js";
import { ImportGate } from "../src/main/import-gate.js";
import { pickImportSource, previewImport } from "../src/main/import-ops.js";
import { correctImportSplit, filterImportSplitByAi } from "../src/main/import-split-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

/**
 * 存量导入的**第二段**桌面侧（M5 / T5-7 第二段，R107；判据回源 I09 §3.4 / §3.5）。
 *
 * 这一层要守住的四件事，每一条都是"看起来能跑、其实在骗作者"的高危项：
 * ① **AI 筛过之后章数真的会变**，而且**界面上那个章数也真的会变**——
 *    R107 的 UI 预演第一跑就栽在这里：预演载荷的"分章预演：N 章"取的是**原始切分**的章数，
 *    人工合并之后数字纹丝不动 ⇒ 作者以为合并了，其实什么都没发生（这条现在锁死在下面）；
 * ② **AI 只能指认候选序号**：越界 / 重复逐条丢弃并点名，不整份作废；
 * ③ **筛不出来就回退正则切分，并把理由摆到界面上**——不静默换一个算法；
 * ④ **只改计划，不写盘**：真源写仍是「确认入库」那条通道。
 *
 * 另外两条是这轮补上的（预演之外自己发现的）：
 * ⑤ **AI 筛与人工校正必须用与预演同一套清洗规则**——清洗会删行，规则对不上，
 *    AI 认下的"第 N 行"就指到了别的文字上，作者看到的候选却是按另一套算的；
 * ⑥ **拆分的落点要把原稿行号换算成章内行号**——章正文入库前 trim 过，
 *    直接拿原稿行号切会切在错误的句子上（章还在、字数还对，只有内容错位）。
 */

/**
 * 切错了的稿子：三处候选（第一章 / 第三章 / 第四章）。
 *
 * 两处误切信号各摆一处：
 * ① **章号不连续**（第一章 → 第三章）：源稿自己跳了一章；
 * ② **章节字数离群**（第四章只有两个字）：中位数二十多字，它只有 2 字。
 *
 * 正文要够长，否则"离群"判不出来（中位数 7 字时，2 字并不离群——那是判据的门槛，不是 bug）。
 */
const MISCUT_TEXT = [
  "第一章 起",
  "夜色压下来，林渊拔剑而起，天启界的夜色里有什么在等着他。",
  "第三章 承",
  "林渊走过长街，风从窗缝里灌进来，脚下的石板还是凉的。",
  "第四章 转",
  "停。",
].join("\n");

/** 带一个**非严筛**候选的稿子：「【第三章 转】」看着像标题，正则不认 ⇒ 可当切点 */
const SPLIT_TEXT = ["第一章 起", "正文甲", "【第三章 转】", "正文乙"].join("\n");

/** 清洗规则会删掉一行 ⇒ 候选行号会整体前移（规则对不上就会指错行） */
const CLEANABLE_TEXT = ["第一章 起", "这段要删掉", "正文甲", "第二章 承", "正文乙"].join("\n");

let srcDir: string;
let projectDir: string;
let gate: ImportGate;
let gateway: ProjectGateway;
let mock: Server;
let mockBaseUrl: string;
/** mock 回给模型的正文（每次测试改这个，就能造出"越界 / 重复 / 一条不留"几种情况） */
let mockReply = '{"keeps":[]}';
/** mock 收到的请求次数：用来证"AI 关闭时一个请求都不发" */
let requestCount = 0;
/** mock 收到的最后一次请求正文：用来证"候选表与预演的是同一批" */
let lastPrompt = "";

beforeEach(async () => {
  requestCount = 0;
  lastPrompt = "";
  mockReply = '{"keeps":[]}';
  mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      requestCount += 1;
      lastPrompt = raw;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "mock-model",
          choices: [{ message: { role: "assistant", content: mockReply }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const address = mock.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  mockBaseUrl = `http://127.0.0.1:${String(port)}/v1`;

  srcDir = await mkdtemp(join(tmpdir(), "yushu-split-src-"));
  projectDir = await mkdtemp(join(tmpdir(), "yushu-split-proj-"));
  gate = new ImportGate();
  gateway = new ProjectGateway(projectDir);
  await mkdir(join(projectDir, "config"), { recursive: true });
  await writeFile(
    join(projectDir, "config", "llm.yaml"),
    serializeLlmConfig({
      apiVersion: LLM_API_VERSION,
      format_version: LLM_FORMAT_VERSION,
      providers: [
        {
          id: "mock",
          kind: "local",
          protocol: "openai_chat",
          base_url: mockBaseUrl,
          models: [{ name: "mock-model", tier: "flagship", limits: { context: 32768, max_output: 2048 } }],
        },
      ],
    }),
    "utf8",
  );
});

afterEach(async () => {
  setAiEnabled(false);
  await rm(srcDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
  await rm(projectDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
  await new Promise<void>((resolve) => mock.close(() => resolve()));
});

/** 写一份稿子并登记成票（路径只在主进程这里出现，渲染层拿不到） */
async function ticketFor(name: string, content: string): Promise<string> {
  const path = join(srcDir, name);
  await writeFile(path, content, "utf8");
  const picked = await pickImportSource(async () => ({ canceled: false, filePaths: [path] }), gate);
  if (picked === null) throw new Error("夹具没能登记出票据");
  return picked.ticket;
}

/** 项目目录下的全部条目（相对路径 + 大小）：用来证"只改计划，一个字节没动" */
async function listAll(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`;
      out.push(rel);
      if (entry.isDirectory()) await walk(join(current, entry.name), rel);
    }
  };
  await walk(root, "");
  return out.sort();
}

/** 从 mock 收到的提示词里抠出候选表（"#0 第1行：…"）⇒ 证 AI 看到的就是预演那份 */
function promptCandidates(): Array<{ index: number; line: number }> {
  const out: Array<{ index: number; line: number }> = [];
  for (const match of lastPrompt.matchAll(/#(\d+)\s*第(\d+)行/g)) {
    out.push({ index: Number(match[1]), line: Number(match[2]) });
  }
  return out;
}

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => "NO_THROW",
    (err: unknown) => (err instanceof YushuError ? err.code : `NOT_YUSHU:${String(err)}`),
  );
}

describe("AI 二次筛选切分（I09 §3.4）：筛完章数要真的变", () => {
  it("AI 关闭时一个请求都不发（A4 闸门对这条路径同样生效）", async () => {
    setAiEnabled(false);
    const ticket = await ticketFor("m.txt", MISCUT_TEXT);
    const code = await codeOf(() =>
      filterImportSplitByAi(gateway, ticket, { ticket }, gate),
    );
    expect(code).toBe("E_AI_DISABLED");
    expect(requestCount).toBe(0);
  });

  it("AI 认下两条 ⇒ 章数从 3 变 2，且切分来源变成「AI 筛过」", async () => {
    setAiEnabled(true);
    mockReply = JSON.stringify({ keeps: [{ index: 0 }, { index: 1 }] });
    const ticket = await ticketFor("m.txt", MISCUT_TEXT);
    const before = await previewImport(ticket, { gate });
    expect(before.split.chapterCount).toBe(3);
    expect(before.ai.used).toBe(false);

    const result = await filterImportSplitByAi(gateway, ticket, { ticket }, gate);
    expect(result.preview.split.chapterCount).toBe(2);
    expect(result.preview.ai.used).toBe(true);
    expect(result.preview.ai.kept).toBe(2);
    expect(result.preview.ai.fallback).toBe("");
    expect(result.preview.chapters.map((chapter) => chapter.title)).toEqual(["第一章 起", "第三章 承"]);
  });

  it("越界 / 重复的指认逐条丢弃并点名（不整份作废，有效的那条仍然算数）", async () => {
    setAiEnabled(true);
    mockReply = JSON.stringify({ keeps: [{ index: 0 }, { index: 0 }, { index: 9 }] });
    const ticket = await ticketFor("m.txt", MISCUT_TEXT);
    const result = await filterImportSplitByAi(gateway, ticket, { ticket }, gate);
    expect(result.preview.ai.kept).toBe(1);
    expect(result.preview.ai.rejected).toHaveLength(2);
    expect(result.preview.ai.rejected.join("；")).toContain("重复");
    expect(result.preview.ai.rejected.join("；")).toContain("超出候选范围");
    expect(result.preview.split.chapterCount).toBe(1);
  });

  it("AI 一条都没留 ⇒ 回退正则切分，理由必须摆到界面上（不静默换一个算法）", async () => {
    setAiEnabled(true);
    mockReply = JSON.stringify({ keeps: [] });
    const ticket = await ticketFor("m.txt", MISCUT_TEXT);
    const result = await filterImportSplitByAi(gateway, ticket, { ticket }, gate);
    expect(result.preview.ai.used).toBe(false);
    expect(result.preview.ai.fallback).toContain("回退");
    expect(result.preview.split.chapterCount).toBe(3);
    expect(result.note).toContain("回退");
  });
});

describe("人工校正（I09 §3.5）：改的是计划，界面的章数必须跟着变", () => {
  it("合并两章 ⇒ 预演章数真的少一个（R107 预演当场抓到过：数字不动等于什么都没发生）", async () => {
    const ticket = await ticketFor("m.txt", MISCUT_TEXT);
    const before = await previewImport(ticket, { gate });
    expect(before.split.chapterCount).toBe(3);
    const result = await correctImportSplit(
      gateway,
      ticket,
      { ticket, correction: { kind: "merge", at: 0 } },
      gate,
    );
    expect(result.preview.split.chapterCount).toBe(2);
    expect(result.preview.chapters).toHaveLength(2);
    expect(result.preview.ai.corrections).toBe(1);
    // 合并后第一章是前两章的正文接起来
    expect(result.preview.chapters[0]?.excerpt).toContain("夜色压下来");
    expect(result.preview.chapters[0]?.excerpt).toContain("林渊走过长街");
  });

  it("误切清单按三类校验点名（章号不连续 / 标题过长 / 字数离群）", async () => {
    const ticket = await ticketFor("m.txt", MISCUT_TEXT);
    const view = await previewImport(ticket, { gate });
    const codes = view.miscuts.flatMap((row) => row.issues.map((issue) => issue.code));
    expect(codes).toContain("chapter-index-gap");
    expect(codes).toContain("chapter-length-outlier");
  });

  it("章号不连续报在**断号后的那一章**上（第一章 → 第三章，断的是第三章那一行）", async () => {
    const ticket = await ticketFor("m.txt", MISCUT_TEXT);
    const view = await previewImport(ticket, { gate });
    const gap = view.miscuts.find((row) => row.issues.some((issue) => issue.code === "chapter-index-gap"));
    // 行号 2 = 第 3 章（第一章在第 1 章，中间少了一章 ⇒ 报在第 3 章这一行）
    expect(gap?.index).toBe(1);
    expect(gap?.title).toBe("第三章 承");
  });

  it("下移一章 ⇒ 顺序真的变了，章数不变", async () => {
    const ticket = await ticketFor("m.txt", MISCUT_TEXT);
    const result = await correctImportSplit(
      gateway,
      ticket,
      { ticket, correction: { kind: "move", from: 0, to: 1 } },
      gate,
    );
    expect(result.preview.split.chapterCount).toBe(3);
    expect(result.preview.chapters.map((chapter) => chapter.title)).toEqual([
      "第三章 承",
      "第一章 起",
      "第四章 转",
    ]);
  });

  it("拆分的落点换算成章内行号 ⇒ 切出来的是对的句子（不是切在候选行的后面）", async () => {
    const ticket = await ticketFor("s.txt", SPLIT_TEXT);
    const before = await previewImport(ticket, { gate });
    expect(before.split.chapterCount).toBe(1);
    // 候选 #1 = 第 3 行「【第三章 转】」（非严筛：正则不认它，所以它不是现成的边界）
    const result = await correctImportSplit(
      gateway,
      ticket,
      { ticket, correction: { kind: "split", candidateIndex: 1 } },
      gate,
    );
    expect(result.preview.split.chapterCount).toBe(2);
    // 候选行本身当新章的标题，正文一分为二
    expect(result.preview.chapters[0]?.title).toBe("第一章 起");
    expect(result.preview.chapters[0]?.excerpt).toBe("正文甲");
    expect(result.preview.chapters[1]?.title).toBe("【第三章 转】");
    expect(result.preview.chapters[1]?.excerpt).toBe("正文乙");
  });

  it("候选序号越界 ⇒ 报错，不静默当成没这回事", async () => {
    const ticket = await ticketFor("s.txt", SPLIT_TEXT);
    const code = await codeOf(() =>
      correctImportSplit(
        gateway,
        ticket,
        { ticket, correction: { kind: "split", candidateIndex: 99 } },
        gate,
      ),
    );
    expect(code).toBe("E_IMPORT_CORRECTION");
  });
});

describe("这一段只改计划：盘上一个字节都不动", () => {
  it("AI 筛 + 人工合并跑完，项目目录的条目一个不多一个不少", async () => {
    setAiEnabled(true);
    mockReply = JSON.stringify({ keeps: [{ index: 0 }, { index: 1 }] });
    const ticket = await ticketFor("m.txt", MISCUT_TEXT);
    const before = await listAll(projectDir);
    await filterImportSplitByAi(gateway, ticket, { ticket }, gate);
    await correctImportSplit(
      gateway,
      ticket,
      { ticket, correction: { kind: "merge", at: 0 } },
      gate,
    );
    const after = await listAll(projectDir);
    // 只允许多出 AI 使用记录（.yushu/ai-usage.jsonl，运行期产物，不在真源里）
    const truthBefore = before.filter((entry) => !entry.startsWith("/.yushu"));
    const truthAfter = after.filter((entry) => !entry.startsWith("/.yushu"));
    expect(truthAfter).toEqual(truthBefore);
  });
});

describe("清洗规则必须三处一致（预演 / AI 筛 / 人工校正）", () => {
  it("带自定义规则时，AI 看到的候选表与预演给出的候选表是同一批行号", async () => {
    setAiEnabled(true);
    mockReply = JSON.stringify({ keeps: [{ index: 0 }] });
    const rules = [{ id: "drop", pattern: "这段要删掉" }];
    const ticket = await ticketFor("c.txt", CLEANABLE_TEXT);

    const view = await previewImport(ticket, { gate, rules });
    // 规则删掉第 2 行 ⇒ 候选行号整体前移（不传规则时第二章在第 4 行）
    expect(view.candidates.map((candidate) => candidate.line)).toEqual([1, 3]);

    await filterImportSplitByAi(gateway, ticket, { ticket, rules }, gate);
    expect(promptCandidates()).toEqual([
      { index: 0, line: 1 },
      { index: 1, line: 3 },
    ]);
  });

  it("不带规则时，AI 看到的是另一批行号（证明上一条真的会因为规则而变）", async () => {
    setAiEnabled(true);
    mockReply = JSON.stringify({ keeps: [{ index: 0 }] });
    const ticket = await ticketFor("c.txt", CLEANABLE_TEXT);
    await filterImportSplitByAi(gateway, ticket, { ticket }, gate);
    expect(promptCandidates()).toEqual([
      { index: 0, line: 1 },
      { index: 1, line: 4 },
    ]);
  });
});
