import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  aiEnabledFlag,
  assertAiEnabled,
  readAiConfig,
  runAiGenerate,
  setAiEnabled,
} from "../src/main/ai-ops.js";
import { summarizeMemory } from "../src/main/memory-ops.js";
import { previewSettingExtraction } from "../src/main/extract-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { createOutlineChapter, createProject, generateOutline } from "../src/main/project-ops.js";

/**
 * AI 总开关（A4「AI 可整体关闭」的进程侧闸门）。
 *
 * 这组断言的意义在于**关闭态是默认值、且拦在被调用那一侧**：
 * 只看渲染层按钮禁用，等于把整条红线交给 UI——程序化调用（或多一个入口忘了禁用）就会
 * 在用户以为关闭时发请求。所以三个真会联网的入口都必须拒绝。
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
let chapterPath: string;
let chapterId: string;
let volumeId: string;

beforeEach(async () => {
  setAiEnabled(false);
  dir = await mkdtemp(join(tmpdir(), "yushu-gate-"));
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(dir);
  const outline = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 1,
  });
  const volume = outline.doc.volumes[0]!;
  volumeId = volume.id;
  chapterId = volume.chapters[0]!.id;
  const draft = await createOutlineChapter(gateway, {
    volumeId,
    chapterId,
    baseHash: outline.hash,
  });
  chapterPath = draft.chapterPath;
});

afterEach(async () => {
  setAiEnabled(false); // 别把开启态漏给下一个用例
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

describe("AI 总开关（默认关闭 + 三入口拒绝）", () => {
  it("默认态：主进程 flag=false，且配置回读也如实标 false", async () => {
    expect(aiEnabledFlag()).toBe(false);
    expect((await readAiConfig(gateway)).aiEnabled).toBe(false);
    // 错误码在 err.code 上（IPC 包装后才在 message 前面加 [E_*]）——按码断言，别去匹配文案
    let thrown: { code?: string } | null = null;
    try {
      assertAiEnabled();
    } catch (err) {
      thrown = err as { code?: string };
    }
    expect(thrown?.code).toBe("E_AI_DISABLED");
  });

  it("生成入口：关闭时抛 E_AI_DISABLED，且不写任何使用记录", async () => {
    await expect(
      runAiGenerate(gateway, {
        streamId: "gate-1",
        payload: { streamId: "gate-1", volumeId, chapterId, task: "draft-first", targetWords: 200 },
        sink: () => undefined,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "E_AI_DISABLED" });
    const usage = await gateway.readDoc(".yushu/ai-usage.jsonl").catch(() => null);
    expect(usage).toBeNull(); // 关闭态连记录都不该产生（可审计 = 没有偷偷用过）
  });

  it("摘要入口：关闭时同样被拒", async () => {
    await expect(
      summarizeMemory(gateway, { layer: "chapter_summary", id: chapterId, volumeId }),
    ).rejects.toMatchObject({ code: "E_AI_DISABLED" });
  });

  it("抽取入口：关闭时同样被拒（三个联网入口一个都不能漏）", async () => {
    await expect(previewSettingExtraction(gateway, { chapterId })).rejects.toMatchObject({
      code: "E_AI_DISABLED",
    });
  });

  it("开启后闸门放行：flag 与配置同步为 true，再关回 false", async () => {
    setAiEnabled(true);
    expect(aiEnabledFlag()).toBe(true);
    expect((await readAiConfig(gateway)).aiEnabled).toBe(true);
    expect(() => assertAiEnabled()).not.toThrow();
    setAiEnabled(false);
    expect((await readAiConfig(gateway)).aiEnabled).toBe(false);
  });

  it("非 true 的值不得当作开启（防 undefined / 字符串混进来变成后门）", () => {
    setAiEnabled("true" as unknown as boolean);
    expect(aiEnabledFlag()).toBe(false);
    setAiEnabled(undefined as unknown as boolean);
    expect(aiEnabledFlag()).toBe(false);
  });

  it("本地能力不受闸门影响：读配置与真源写入照常", async () => {
    const state = await readAiConfig(gateway);
    expect(state.config.providers.length).toBeGreaterThan(0);
    const doc = await gateway.readDoc(chapterPath);
    expect(doc.content).toContain("---");
  });
});
