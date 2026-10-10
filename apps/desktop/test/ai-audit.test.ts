import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAllMocks, startReplyMock } from "./helpers/mock-chat.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { createOutlineChapter, createProject, generateOutline, writeCardDoc } from "../src/main/project-ops.js";
import { readAiUsage } from "../src/main/ai-usage.js";
import { saveAiConfig, setAiEnabled } from "../src/main/ai-ops.js";
import { runAiAudit } from "../src/main/ai-audit.js";

/**
 * 全书体检的 AI 采样核验（M4 / T4-4 的"重规则 + AI 采样"，R58）。
 *
 * 三条最要紧的断言：
 * ① **AI 只能指认我们给它的片段**：返回的 index 越界、kind 不在白名单，一律丢弃并计 `rejected`——
 *    接受 AI 自己报的原文区间，等于把幻觉写进真源旁边（第二真源的入口）；
 * ② **跑不成不阻断体检**：AI 关闭 / 无 provider / 输出不是合法 JSON，都只回 `ran:false + reason`；
 * ③ **烧了钱就要看得见**：一次采样记一条 usage（估算与实报双口径），成本面板按任务分解。
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

/** 固定回答的 chat/completions mock 见 ./helpers/mock-chat.ts（两处测试共用，避免各写一份模型行为） */

async function useMock(reply: string): Promise<void> {
  const baseUrl = await startReplyMock(reply);
  await saveAiConfig(gateway, {
    providers: [
      {
        id: "mock",
        kind: "local",
        protocol: "openai_chat",
        base_url: baseUrl,
        models: [{ name: "mock-model", tier: "flagship", limits: { context: 32768, max_output: 2048 } }],
      },
    ] as never,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-audit-"));
  setAiEnabled(true);
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(dir);
  await writeCardDoc(gateway, {
    card: { id: "char-linyuan", type: "character", name: "林渊", layer: "characters" },
    body: "边城少年。",
  });
  const generated = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 2,
  });
  const volume = generated.doc.volumes[0]!;
  const draft = await createOutlineChapter(gateway, {
    volumeId: volume.id,
    chapterId: volume.chapters[0]!.id,
    baseHash: generated.hash,
  });
  const path = draft.chapterPath;
  const snap = await gateway.readDoc(path);
  await gateway.writeDoc(
    path,
    snap!.content.replace(
      /^\uFEFF/,
      "",
    ),
    snap!.hash,
  );
  // 正文两段：够长才会进采样（第一段含"玉佩出自皇室"这类无出处断言）
  const body = [
    "林渊按剑立在城口，那枚玉佩出自皇室，夜色像水一样漫过整座边城。",
    "海泽带来一封没有落款的信，信纸边缘被火燎过，署名一栏空着。",
  ].join("\n\n");
  const reSnap = await gateway.readDoc(path);
  await gateway.writeDoc(path, reSnap!.content.replace(/^([\s\S]*?\n---\n)/, `$1\n${body}\n`), reSnap!.hash);
});

afterEach(async () => {
  setAiEnabled(false);
  await rm(dir, { recursive: true, force: true });
  await closeAllMocks();
});

describe("全书体检的 AI 采样核验", () => {
  it("指认给定片段：结论带出处、severity=warn、span 落在采样的那一段", async () => {
    await useMock(JSON.stringify({ issues: [{ index: 0, kind: "hallucination", why: "玉佩来历在设定库中无支撑" }] }));
    const audit = await runAiAudit(gateway, { limit: 4 });
    expect(audit.ran).toBe(true);
    expect(audit.reason).toBe("");
    expect(audit.sampled).toBeGreaterThanOrEqual(2);
    expect(audit.rejected).toBe(0);
    expect(audit.findings).toHaveLength(1);
    const finding = audit.findings[0]!;
    expect(finding.rule).toBe("ai-sampled-hallucination");
    expect(finding.severity).toBe("warn");
    expect(finding.origin).toContain("AI 采样");
    expect(finding.span).not.toBeNull();
    expect(finding.span!.file).toContain("chapters/");
    expect(finding.span!.text).toContain("玉佩出自皇室");
  });

  it("index 越界一律丢弃并计数：不接受 AI 自己编的原文位置", async () => {
    await useMock(JSON.stringify({ issues: [{ index: 99, kind: "hallucination", why: "编造的位置" }] }));
    const audit = await runAiAudit(gateway, { limit: 4 });
    expect(audit.ran).toBe(true);
    expect(audit.findings).toEqual([]);
    expect(audit.rejected).toBe(1);
  });

  it("kind 不在白名单也丢弃：不拿模型随口写的标签当真源结论", async () => {
    await useMock(JSON.stringify({ issues: [{ index: 0, kind: "看着不太对", why: "自创分类" }] }));
    const audit = await runAiAudit(gateway, { limit: 4 });
    expect(audit.findings).toEqual([]);
    expect(audit.rejected).toBe(1);
  });

  it("AI 关闭时不抛错：ran=false 并给出原因（结构体检照旧跑）", async () => {
    await useMock(JSON.stringify({ issues: [] }));
    setAiEnabled(false);
    const audit = await runAiAudit(gateway, { limit: 4 });
    expect(audit.ran).toBe(false);
    expect(audit.reason).toContain("AI");
    expect(audit.findings).toEqual([]);
  });

  it("模型输出不是合法 JSON：ran=false + 原因，不把失败洗成「没问题」", async () => {
    await useMock("我觉得没什么问题。");
    const audit = await runAiAudit(gateway, { limit: 4 });
    expect(audit.ran).toBe(false);
    expect(audit.reason.length).toBeGreaterThan(0);
    expect(audit.findings).toEqual([]);
  });

  it("一次采样记一条 usage（估算与实报双口径，成本面板按任务可分解）", async () => {
    await useMock(JSON.stringify({ issues: [] }));
    const before = await readAiUsage(dir, 50);
    await runAiAudit(gateway, { limit: 4 });
    const after = await readAiUsage(dir, 50);
    const added = after.filter((entry) => entry.task === "audit");
    expect(added).toHaveLength(1);
    expect(added[0]!.provider_id).toBe("mock");
    expect(added[0]!.estimate!.prompt).toBeGreaterThan(0);
    expect(before.filter((entry) => entry.task === "audit")).toHaveLength(0);
  });
});
