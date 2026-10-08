import { createServer, type Server } from "node:http";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { countWords } from "@yushu/core";
import { readChapterFile } from "@yushu/world-engine";
import type { AiStreamEvent } from "../src/shared/ipc.js";
import {
  adoptDraft,
  listDraftTargets,
  readAiConfig,
  readAiContext,
  readAiUsageState,
  runAiGenerate,
  setAiEnabled,
  saveAiConfig,
} from "../src/main/ai-ops.js";
import { appendAiUsage, readAiUsage } from "../src/main/ai-usage.js";
import { analyzeDraft, assembleMessages, buildContextPreview } from "../src/main/prompt-ops.js";
import {
  createOutlineChapter,
  createProject,
  generateOutline,
  writeCardDoc,
} from "../src/main/project-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";

let dir: string;
let servers: Server[] = [];

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-ai-"));
  // A4 闸门默认关闭：本文件测的是"已开启之后"的生成链路，必须显式开启（与用户勾选等价）
  setAiEnabled(true);
});

afterEach(async () => {
  setAiEnabled(false);
  await rm(dir, { recursive: true, force: true });
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  servers = [];
});

/** 本地 OpenAI 兼容 mock（SSE），delayMs 控制分块节奏（测试中止用） */
async function startMock(delayMs = 0): Promise<string> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunks = ["天启", "界的", "夜色"];
      let sent = 0;
      const writeNext = () => {
        if (sent >= chunks.length) {
          res.write(
            `data: ${JSON.stringify({
              choices: [{ delta: {}, finish_reason: "stop" }],
              usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
            })}\n\n`,
          );
          res.write("data: [DONE]\n\n");
          res.end();
          return;
        }
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[sent] } }] })}\n\n`);
        sent += 1;
        setTimeout(writeNext, delayMs);
      };
      setTimeout(writeNext, delayMs);
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return `http://127.0.0.1:${port}/v1`;
}

interface Fixture {
  gateway: ProjectGateway;
  volumeId: string;
  chapterId: string;
  chapterPath: string;
}

async function setupProject(): Promise<Fixture> {
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  const gateway = new ProjectGateway(dir);
  await writeCardDoc(gateway, {
    card: { type: "character", name: "林渊", layer: "characters", visibility: "hidden" },
    body: "## 出身\n边城少年，剑道天赋被夺。",
  });
  await writeCardDoc(gateway, {
    card: { type: "law", name: "灵气法则", layer: "laws", visibility: "revealed" },
    body: "天地灵气随境界潮汐涨落。",
  });
  const generated = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 3,
    chaptersPerVolume: 2,
  });
  const volume = generated.doc.volumes[0]!;
  const chapter = volume.chapters[0]!;
  const draft = await createOutlineChapter(gateway, {
    volumeId: volume.id,
    chapterId: chapter.id,
    baseHash: generated.hash,
  });
  return { gateway, volumeId: volume.id, chapterId: chapter.id, chapterPath: draft.chapterPath };
}

describe("上下文组装（T1-13 / T1-14）", () => {
  it("槽位固定顺序、稳定前缀标记、约束来自派系包禁忌与设定卡", async () => {
    const fixture = await setupProject();
    const preview = await buildContextPreview(fixture.gateway, {
      volumeId: fixture.volumeId,
      chapterId: fixture.chapterId,
    });
    expect(preview.slots.map((slot) => slot.slot)).toEqual([
      "system_prompt",
      "world_core",
      "world_constraints",
      "outline_chapter",
      "recent_prose",
    ]);
    expect(preview.slots.filter((slot) => slot.stable).map((slot) => slot.slot)).toEqual([
      "system_prompt",
      "world_core",
      "world_constraints",
    ]);
    expect(preview.cacheBreakpointAfter).toBe("world_constraints");
    const worldCore = preview.slots.find((slot) => slot.slot === "world_core")!;
    expect(worldCore.text).toContain("林渊");
    expect(worldCore.text).toContain("灵气法则");
    const constraints = preview.slots.find((slot) => slot.slot === "world_constraints")!;
    expect(constraints.text).toContain("不得越级战斗");
    expect(preview.constraints.some((item) => item.includes("系统沦为无代价发奖机器"))).toBe(true);
    expect(preview.stableChars).toBeGreaterThan(0);
    expect(preview.target?.chapterPath).toBe(fixture.chapterPath);
    expect(preview.target?.hasProse).toBe(false);
  });

  it("同一项目的稳定前缀不随章节变化（prompt caching 前提）", async () => {
    const fixture = await setupProject();
    const previewOne = await buildContextPreview(fixture.gateway, {
      volumeId: fixture.volumeId,
      chapterId: fixture.chapterId,
    });
    // 不选定目标的预览：稳定槽位应与选定章节时完全一致
    const previewTwo = await buildContextPreview(fixture.gateway);
    const stableText = (preview: typeof previewOne) =>
      preview.slots
        .filter((slot) => slot.stable)
        .map((slot) => slot.text)
        .join("\n");
    expect(stableText(previewTwo)).toBe(stableText(previewOne));
    // 易变槽位不同：未选章节时 outline/recent 为空
    expect(previewTwo.slots.find((slot) => slot.slot === "outline_chapter")?.text).toBe("");
  });

  it("messages：稳定前缀独立成 system 消息置头，任务与细纲进 user 消息", async () => {
    const fixture = await setupProject();
    const preview = await buildContextPreview(fixture.gateway, {
      volumeId: fixture.volumeId,
      chapterId: fixture.chapterId,
    });
    const messages = assembleMessages(preview, { kind: "draft-first", targetWords: 1800, instruction: "开篇要快" });
    expect(messages[0]?.role).toBe("system");
    expect(messages[0]?.content).toContain("林渊");
    expect(messages[0]?.content).not.toContain("本章细纲");
    expect(messages[1]?.role).toBe("user");
    expect(messages[1]?.content).toContain("【本章细纲】");
    expect(messages[1]?.content).toContain("约 1800 字");
    expect(messages[1]?.content).toContain("开篇要快");
  });

  it("analyzeDraft：隐藏设定泄底 / 关闭层级 / 未引用设定三类轻提示", () => {
    const cardIndex = [
      { id: "char-linyuan", name: "林渊", aliases: [], visibility: "hidden", layer: "characters" },
      { id: "law-lingqi", name: "灵气法则", aliases: ["灵气"], visibility: "revealed", layer: "laws" },
      { id: "spe-yaozu", name: "妖族", aliases: [], visibility: "revealed", layer: "ecology" },
    ];
    const layers = { characters: true, laws: true, ecology: false };
    const leak = analyzeDraft("林渊拔剑而起，灵气翻涌。", cardIndex, layers);
    expect(leak.referenced).toContain("林渊");
    expect(leak.hints.some((hint) => hint.includes("隐藏设定"))).toBe(true);
    expect(leak.hints.some((hint) => hint.includes("灵气"))).toBe(false);

    const closed = analyzeDraft("远处妖族大军压境。", cardIndex, layers);
    expect(closed.hints.some((hint) => hint.includes("已关闭层级"))).toBe(true);

    const none = analyzeDraft("天色渐暗，少年沉默不语。", cardIndex, layers);
    expect(none.referenced).toEqual([]);
    expect(none.hints.some((hint) => hint.includes("未引用任何已建档设定"))).toBe(true);
  });
});

describe("AI 使用记录（T1-17）", () => {
  it("append-only JSONL：追加、倒序读取、损坏行容错", async () => {
    await appendAiUsage(dir, { id: "ai-1", type: "generate", status: "ok", chars: 10 });
    await appendAiUsage(dir, { id: "ai-2", type: "adopt", usage_id: "ai-1", chars: 10 });
    const entries = await readAiUsage(dir, 10);
    expect(entries.map((entry) => entry.id)).toEqual(["ai-2", "ai-1"]);
    expect(entries[0]?.time).toBeTruthy();

    const file = join(dir, ".yushu", "ai-usage.jsonl");
    await appendAiUsage(dir, { id: "ai-3", type: "generate", status: "error" });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(file, "not-json\n", "utf8");
    const tolerant = await readAiUsage(dir, 10);
    expect(tolerant).toHaveLength(3);
  });
});

/** v2 provider 载荷（T3-1：mock 为本地 openai_chat 端点） */
function v2Providers(baseUrl: string) {
  return [
    {
      id: "mock",
      kind: "local",
      protocol: "openai_chat",
      base_url: baseUrl,
      models: [
        { name: "mock-model", tier: "flagship", limits: { context: 32768, max_output: 2048 } },
      ],
    },
  ];
}

describe("AI 生成与采纳（T1-15 / T1-16 / T1-17）", () => {
  it("配置：默认主干+本地兜底（v2 能力矩阵）；保存后指向本地 mock 且 canGenerate", async () => {
    const fixture = await setupProject();
    const initial = await readAiConfig(fixture.gateway);
    expect(initial.exists).toBe(false);
    expect(initial.config.providers.map((provider) => provider.id)).toEqual(["primary", "local"]);
    expect(initial.config.format_version).toBe(2);
    expect(initial.config.providers[0]?.kind).toBe("cloud");
    expect(initial.config.providers[0]?.protocol).toBe("openai_chat");
    expect(initial.config.providers[0]?.models[0]?.tier).toBe("small");
    // 能力矩阵为保守默认合并后的完整矩阵（未声明的字段为 false）
    expect(initial.config.providers[1]?.models[0]?.capabilities.stream).toBe(true);
    expect(initial.config.providers[1]?.models[0]?.capabilities.tools).toBe(false);

    const baseUrl = await startMock();
    const saved = await saveAiConfig(fixture.gateway, { providers: v2Providers(baseUrl) });
    expect(saved.exists).toBe(true);
    expect(saved.canGenerate).toBe(true);
    expect(saved.keyStates[0]?.ready).toBe(true);
    expect(saved.hash).toBeTruthy();
    expect(saved.config.providers[0]?.models[0]?.name).toBe("mock-model");
  });

  it("v1 配置迁移（T3-1）：读取按 v2 返回；覆盖前自动备份 v1（幂等，可回滚）", async () => {
    const fixture = await setupProject();
    const v1Text = [
      "apiVersion: yushu.llm/v1",
      "format_version: 1",
      "providers:",
      "  - id: mock",
      "    kind: openai-compatible",
      "    base_url: http://127.0.0.1:11434/v1",
      "    model: legacy-model",
      "    context_window: 32768",
      "",
    ].join("\n");
    await fixture.gateway.writeDoc("config/llm.yaml", v1Text);

    const migrated = await readAiConfig(fixture.gateway);
    expect(migrated.config.format_version).toBe(2);
    const provider = migrated.config.providers[0]!;
    expect(provider.kind).toBe("local");
    expect(provider.protocol).toBe("openai_chat");
    expect(provider.models[0]?.name).toBe("legacy-model");
    expect(provider.models[0]?.limits?.context).toBe(32768);

    // 保存（v2）→ 覆盖前自动备份 v1 原文
    const baseUrl = await startMock();
    const saved = await saveAiConfig(fixture.gateway, {
      providers: v2Providers(baseUrl),
      baseHash: migrated.hash,
    });
    expect(saved.config.providers[0]?.models[0]?.name).toBe("mock-model");
    const backup = await readFile(join(dir, "config", "llm.yaml.bak-v1"), "utf8");
    expect(backup).toContain("legacy-model");
    expect(backup).toContain("format_version: 1");

    // 幂等：已成为 v2 后再保存不重写备份
    await saveAiConfig(fixture.gateway, {
      providers: v2Providers(baseUrl),
      baseHash: saved.hash,
    });
    expect(await readFile(join(dir, "config", "llm.yaml.bak-v1"), "utf8")).toBe(backup);
  });

  it("生成：流式事件 → done（含轻提示与使用记录）；采纳写入章节正文", async () => {
    const fixture = await setupProject();
    const baseUrl = await startMock();
    await saveAiConfig(fixture.gateway, { providers: v2Providers(baseUrl) });

    const targets = await listDraftTargets(fixture.gateway);
    expect(targets).toHaveLength(1);
    expect(targets[0]?.chapterPath).toBe(fixture.chapterPath);

    const events: AiStreamEvent[] = [];
    await runAiGenerate(fixture.gateway, {
      streamId: "s1",
      payload: { volumeId: fixture.volumeId, chapterId: fixture.chapterId, task: "draft-first" },
      sink: (event) => events.push(event),
      signal: new AbortController().signal,
    });

    const deltas = events.filter((event) => event.type === "delta");
    expect(deltas.map((event) => (event.type === "delta" ? event.text : "")).join("")).toBe("天启界的夜色");
    const done = events.find((event) => event.type === "done");
    expect(done && done.type === "done" && done.aborted).toBe(false);
    if (done?.type === "done") {
      expect(done.text).toBe("天启界的夜色");
      expect(done.providerId).toBe("mock");
      expect(done.chars).toBe(6);
      expect(Array.isArray(done.hints.hints)).toBe(true);

      // 采纳（追加）：正文写入 + 字数对账 + 使用记录
      const adopted = await adoptDraft(fixture.gateway, {
        usageId: done.usageId,
        volumeId: fixture.volumeId,
        chapterId: fixture.chapterId,
        text: done.text,
        mode: "append",
      });
      expect(adopted.chapterPath).toBe(fixture.chapterPath);
      expect(adopted.wordCount).toBe(6);
      const parsed = readChapterFile(await readFile(join(dir, adopted.chapterPath), "utf8"));
      expect(parsed.body).toContain("天启界的夜色");

      // 采纳（替换）覆盖旧正文
      const replaced = await adoptDraft(fixture.gateway, {
        usageId: done.usageId,
        volumeId: fixture.volumeId,
        chapterId: fixture.chapterId,
        text: "新的开场……",
        mode: "replace",
      });
      expect(replaced.wordCount).toBe(countWords("新的开场……"));
      const reparsed = readChapterFile(await readFile(join(dir, replaced.chapterPath), "utf8"));
      expect(reparsed.body).not.toContain("天启界的夜色");

      const usage = await readAiUsageState(fixture.gateway);
      expect(usage.entries.filter((entry) => entry.type === "generate")).toHaveLength(1);
      const adoptEntries = usage.entries.filter((entry) => entry.type === "adopt");
      expect(adoptEntries.length).toBe(2);
      expect(adoptEntries[0]?.usage_id).toBe(done.usageId);
    }
  });

  it("中止：done.aborted=true 且保留已生成部分，记录 status=aborted", async () => {
    const fixture = await setupProject();
    const baseUrl = await startMock(30);
    await saveAiConfig(fixture.gateway, { providers: v2Providers(baseUrl) });

    const controller = new AbortController();
    const events: AiStreamEvent[] = [];
    await runAiGenerate(fixture.gateway, {
      streamId: "s2",
      payload: { volumeId: fixture.volumeId, chapterId: fixture.chapterId, task: "continue" },
      sink: (event) => {
        events.push(event);
        if (event.type === "delta") controller.abort();
      },
      signal: controller.signal,
    });

    const done = events.find((event) => event.type === "done");
    expect(done?.type === "done" && done.aborted).toBe(true);
    expect(done?.type === "done" && done.text).toBe("天启");
    const usage = await readAiUsageState(fixture.gateway);
    expect(usage.entries.some((entry) => entry.status === "aborted")).toBe(true);
  });

  it("未创建草稿章节时采纳给出明确错误", async () => {
    const fixture = await setupProject();
    const outline = await fixture.gateway.readDoc("outline/outline.yaml");
    const { parseOutline } = await import("@yushu/world-engine");
    const parsed = parseOutline(outline.content);
    const volume = parsed.volumes[0]!;
    const chapterTwo = volume.chapters[1]!; // 第二章未创建草稿章节
    await expect(
      adoptDraft(fixture.gateway, {
        usageId: "ai-none",
        volumeId: volume.id,
        chapterId: chapterTwo.id,
        text: "内容",
        mode: "append",
      }),
    ).rejects.toThrowError(/尚未创建草稿章节/);
  });
});