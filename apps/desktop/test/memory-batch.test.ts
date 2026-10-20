/* SPDX-License-Identifier: Apache-2.0 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { YushuError } from "@yushu/core";
import { LLM_API_VERSION, LLM_FORMAT_VERSION, serializeLlmConfig } from "@yushu/llm";
import { MEMORY_CHAPTER_SUMMARIES_DIR, MEMORY_VOLUME_SUMMARIES_DIR, OUTLINE_PATH, parseOutline } from "@yushu/world-engine";
import { setAiEnabled } from "../src/main/ai-ops.js";
import { writeChapterBody } from "../src/main/chapter-ops.js";
import { summarizeMemoryBatch } from "../src/main/memory-ops.js";
import { createOutlineChapter, createProject, generateOutline } from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

/**
 * 批量补摘要候选的主进程侧（M5 / T5-9 第二段，R106）。
 *
 * 判据回源 **J09 §3.3**：「生成前成本预估 → 批量任务弹"预计消耗 ¥x / N tokens"，
 * **超预算需用户确认**」；**J09 §3.8**：本地端点零成本。
 *
 * 这一层要钉三件宿主级的事：
 * ① **A4 闸门对批量同样生效**：AI 关闭时批量一个字都不发（它也是联网入口）；
 * ② **超预算 ⇒ 拒绝跑**，且拒在**发请求之前**（未确认就发出去 = 钱已经花了）；
 * ③ **本地端点零成本**：没配月度上限也**不需要**确认（真 0 与"算不出"是两回事）。
 *
 * **候选化不变**：批量跑出来的也只是候选，写库要作者逐条采纳（这条由预演 step68 取证）。
 */

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

/** 一条带价格的云端 provider（单价口径：每 1M tokens） */
const PRICED_CLOUD = (baseUrl: string): string =>
  serializeLlmConfig({
    apiVersion: LLM_API_VERSION,
    format_version: LLM_FORMAT_VERSION,
    providers: [
      {
        id: "cloud",
        kind: "cloud",
        protocol: "openai_chat",
        base_url: baseUrl,
        models: [
          {
            name: "m1",
            tier: "small",
            limits: { context: 32000, max_output: 2048 },
            pricing: { input: 1000, output: 2000, currency: "CNY" },
          },
        ],
      },
    ],
  });

/** 本地端点（kind: local）——J09 §3.8：零成本 */
const LOCAL_FREE = (baseUrl: string): string =>
  serializeLlmConfig({
    apiVersion: LLM_API_VERSION,
    format_version: LLM_FORMAT_VERSION,
    providers: [
      {
        id: "local",
        kind: "local",
        protocol: "openai_chat",
        base_url: baseUrl,
        models: [{ name: "m1", tier: "small", limits: { context: 32000, max_output: 2048 } }],
      },
    ],
  });

let dir: string;
let gateway: ProjectGateway;
let chapterPath: string;
/** 本地 mock 端点：让"批量真的跑出候选"这件事能被测到（否则"没写库"是空跑） */
let mock: Server;
let mockBaseUrl: string;

beforeEach(async () => {
  mock = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "m1",
          choices: [{ message: { role: "assistant", content: "要点一：林渊抵达天启界。\n要点二：夜色里有变。" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const address = mock.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  mockBaseUrl = `http://127.0.0.1:${String(port)}/v1`;

  dir = await mkdtemp(join(tmpdir(), "yushu-batch-"));
  gateway = new ProjectGateway(dir);
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 3,
  });
  // 建一章草稿并写上正文（没有素材就没有待补目标——那是设计，不是缺陷）
  const snap = await gateway.readDoc(OUTLINE_PATH);
  const outline = parseOutline(snap.content);
  const volume = outline.volumes[0];
  const chapter = volume?.chapters[0];
  if (volume === undefined || chapter === undefined) throw new Error("夹具没能建出章纲");
  const created = await createOutlineChapter(gateway, {
    volumeId: volume.id,
    chapterId: chapter.id,
    baseHash: snap.hash,
  });
  chapterPath = created.chapterPath;
  const chapterSnap = await gateway.readDoc(chapterPath);
  await writeChapterBody(gateway, {
    path: chapterPath,
    body: "夜色压下来。林渊拔剑而起，天启界的夜色里有什么在等着他。",
    baseHash: chapterSnap.hash,
  });
});

afterEach(async () => {
  setAiEnabled(false);
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
  await new Promise<void>((resolve) => mock.close(() => resolve()));
});

async function codeOf(fn: () => Promise<unknown>): Promise<string> {
  return fn().then(
    () => "NO_THROW",
    (err: unknown) => (err instanceof YushuError ? err.code : `NOT_YUSHU:${String(err)}`),
  );
}

describe("批量补摘要：闸门与预算护栏（R106）", () => {
  it("AI 关闭时批量也一个请求都不发（A4 闸门对批量同样生效）", async () => {
    setAiEnabled(false);
    await gateway.writeDoc("config/llm.yaml", PRICED_CLOUD(mockBaseUrl));
    const code = await codeOf(() => summarizeMemoryBatch(gateway, { limit: 1 }));
    expect(code).toBe("E_AI_DISABLED");
  });

  it("设了月度上限而这批会超 ⇒ 未确认就拒（拒在发请求之前）", async () => {
    setAiEnabled(true);
    await gateway.writeDoc("config/llm.yaml", PRICED_CLOUD(mockBaseUrl));
    // 上限给到 0.0001：这批的预估必然超
    await gateway.writeDoc(
      "config/budget.yaml",
      "apiVersion: yushu.budget/v1\nmonthly_cap: 0.0001\ncurrency: CNY\n",
    );
    const code = await codeOf(() => summarizeMemoryBatch(gateway, { limit: 1 }));
    expect(code).toBe("E_MEMORY_BATCH_CONFIRM");
    // 拒了就不该有候选，更不该写库
    const summaries = await gateway.listTree();
    expect(summaries.some((entry) => entry.path.startsWith(MEMORY_CHAPTER_SUMMARIES_DIR))).toBe(false);
  });

  it("确认之后才放行：候选真的跑出来，且预算结论带着确认理由", async () => {
    setAiEnabled(true);
    await gateway.writeDoc("config/llm.yaml", PRICED_CLOUD(mockBaseUrl));
    await gateway.writeDoc(
      "config/budget.yaml",
      "apiVersion: yushu.budget/v1\nmonthly_cap: 0.0001\ncurrency: CNY\n",
    );
    const result = await summarizeMemoryBatch(gateway, { limit: 1, confirm: true });
    expect(result.budget.needsConfirm).toBe(true);
    expect(result.budget.confirmReasons.join("")).toContain("月度上限");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.text).toContain("要点一");
    expect(result.failed).toEqual([]);
  });

  it("本地端点零成本 ⇒ 哪怕上限极小也不需要确认（真 0 与「算不出」是两回事）", async () => {
    setAiEnabled(true);
    await gateway.writeDoc("config/llm.yaml", LOCAL_FREE(mockBaseUrl));
    await gateway.writeDoc(
      "config/budget.yaml",
      "apiVersion: yushu.budget/v1\nmonthly_cap: 0.0001\ncurrency: CNY\n",
    );
    const result = await summarizeMemoryBatch(gateway, { limit: 1 });
    expect(result.budget.needsConfirm).toBe(false);
    expect(result.budget.estimatedCost).toBe(0);
    expect(result.budget.unpricedIds).toEqual([]);
    expect(result.candidates).toHaveLength(1);
  });

  it("云端 provider 没配单价 ⇒ 算不出金额 ⇒ 护栏对它无效 ⇒ 必须显式确认", async () => {
    setAiEnabled(true);
    // 同一个云端配置，但去掉 pricing
    const unpriced = serializeLlmConfig({
      apiVersion: LLM_API_VERSION,
      format_version: LLM_FORMAT_VERSION,
      providers: [
        {
          id: "cloud",
          kind: "cloud",
          protocol: "openai_chat",
          base_url: mockBaseUrl,
          models: [{ name: "m1", tier: "small", limits: { context: 32000, max_output: 2048 } }],
        },
      ],
    });
    await gateway.writeDoc("config/llm.yaml", unpriced);
    const code = await codeOf(() => summarizeMemoryBatch(gateway, { limit: 1 }));
    expect(code).toBe("E_MEMORY_BATCH_CONFIRM");
  });

  it("候选化不变：批量真的跑出候选，但盘上仍然没有摘要文件（写库要作者逐条采纳）", async () => {
    setAiEnabled(true);
    await gateway.writeDoc("config/llm.yaml", LOCAL_FREE(mockBaseUrl));
    const result = await summarizeMemoryBatch(gateway, { limit: 1 });
    // 先确认"批量真的跑出了候选"——否则"没写库"只是因为什么都没跑
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.text).toContain("要点一");
    // **卷摘要与章摘要都要查**：批次的顺序是卷摘要在前，只查 chapters/ 会把
    // "写进 volumes/ 了"看成"没写"（这条盲区是被变异 M3 抓出来的）。
    const tree = await gateway.listTree();
    const written = tree.filter(
      (entry) =>
        entry.type === "file" &&
        (entry.path.startsWith(MEMORY_CHAPTER_SUMMARIES_DIR) || entry.path.startsWith(MEMORY_VOLUME_SUMMARIES_DIR)),
    );
    expect(written).toEqual([]);
  });
});
