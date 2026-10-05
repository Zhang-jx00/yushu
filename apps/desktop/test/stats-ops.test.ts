import { countWords } from "@yushu/core";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptDraft } from "../src/main/ai-ops.js";
import { writeChapterBody } from "../src/main/chapter-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { createOutlineChapter, createProject, generateOutline } from "../src/main/project-ops.js";
import { STATS_PATH, diffDays, localDateKey, readStatsState, recordChapterDelta, setStatsGoal } from "../src/main/stats-ops.js";

/**
 * 码字统计（T2-9 切片 A）：记账（净增 / 负值 / 空保存不计） / 多日汇总与断更 / 目标 / 损坏容错。
 * 口径：章节净增字数（编辑器保存与 AI 采纳均计；本地时区日键）。
 */

let dir: string;
let gateway: ProjectGateway;

const AXES = {
  channel: ["男频"],
  world: ["玄幻"],
  technique: ["系统流"],
  tone: ["爽文"],
  romance_mode_default: "无女主",
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-stats-"));
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

async function setupDraft(): Promise<{ chapterPath: string; volumeId: string; chapterId: string }> {
  const generated = await generateOutline(gateway, {
    templateId: "xuanhuan-xitong/three-act-upgrade",
    title: "天启界",
    volumeCount: 1,
    chaptersPerVolume: 1,
  });
  const volume = generated.doc.volumes[0]!;
  const chapter = volume.chapters[0]!;
  const draft = await createOutlineChapter(gateway, {
    volumeId: volume.id,
    chapterId: chapter.id,
    baseHash: generated.hash,
  });
  return { chapterPath: draft.chapterPath, volumeId: volume.id, chapterId: chapter.id };
}

const BODY_A = "甲";
const BODY_B = "甲乙丙丁戊";

describe("码字统计（T2-9 切片 A）", () => {
  it("章节保存记账：净增累计 / 删字为负 / 同内容空保存不计", async () => {
    const { chapterPath } = await setupDraft();
    const initial = await gateway.readDoc(chapterPath);

    const first = await writeChapterBody(gateway, { path: chapterPath, body: BODY_A, baseHash: initial.hash });
    let state = await readStatsState(gateway);
    expect(state.today.delta).toBe(countWords(BODY_A) - countWords(""));
    expect(state.today.saves).toBe(1);

    const second = await writeChapterBody(gateway, { path: chapterPath, body: BODY_B, baseHash: first.hash });
    state = await readStatsState(gateway);
    expect(state.today.delta).toBe(countWords(BODY_B));
    expect(state.today.saves).toBe(2);

    // 删字：负 delta
    const third = await writeChapterBody(gateway, { path: chapterPath, body: BODY_A, baseHash: second.hash });
    state = await readStatsState(gateway);
    expect(state.today.delta).toBe(countWords(BODY_A));
    expect(state.today.saves).toBe(3);

    // 同内容空保存：不计入（避免污染活跃日）
    await writeChapterBody(gateway, { path: chapterPath, body: BODY_A, baseHash: third.hash });
    state = await readStatsState(gateway);
    expect(state.today.saves).toBe(3);
    expect(state.today.delta).toBe(countWords(BODY_A));
  });

  it("AI 采纳计入（章节净增口径）", async () => {
    const { volumeId, chapterId } = await setupDraft();
    await adoptDraft(gateway, { usageId: "test", volumeId, chapterId, text: "采纳的正文甲乙丙。", mode: "append" });
    const state = await readStatsState(gateway);
    expect(state.today.delta).toBeGreaterThan(0);
    expect(state.today.saves).toBe(1);
  });

  it("多日汇总 / 断更 / 连续天数（注入时间口径）", async () => {
    await mkdir(join(dir, ".yushu"), { recursive: true });
    await writeFile(
      join(dir, STATS_PATH),
      JSON.stringify({
        schema_version: 1,
        goal: { daily: 3000 },
        updated_at: "",
        daily: {
          "2026-10-01": { delta: 1000, saves: 2 },
          "2026-10-02": { delta: 2000, saves: 3 },
          "2026-10-04": { delta: -500, saves: 1 },
          "2026-10-05": { delta: 300, saves: 1 },
        },
      }),
      "utf8",
    );

    // 当日（10-05）视角：连续 2 天（05、04 连续；03 缺）
    const today = await readStatsState(gateway, new Date("2026-10-05T12:00:00"));
    expect(today.today).toEqual({ date: "2026-10-05", delta: 300, saves: 1 });
    expect(today.summary.total).toBe(2800);
    expect(today.summary.week).toBe(2800);
    expect(today.summary.month).toBe(2800);
    expect(today.summary.activeDays).toBe(4);
    expect(today.summary.avgActiveDay).toBe(700);
    expect(today.summary.bestDay).toEqual({ date: "2026-10-02", delta: 2000, saves: 3 });
    expect(today.daysSinceLastWriting).toBe(0);
    expect(today.streakDays).toBe(2);

    // 三天后（10-08）视角：断更 3 天、连续中断为 0、7 天窗口含 10-02（6 天前）/10-04/10-05
    const later = await readStatsState(gateway, new Date("2026-10-08T09:00:00"));
    expect(later.today.delta).toBe(0);
    expect(later.daysSinceLastWriting).toBe(3);
    expect(later.streakDays).toBe(0);
    expect(later.summary.week).toBe(1800);
    expect(later.summary.total).toBe(2800);

    // 从未写作：daysSinceLastWriting = null、streak = 0
    await mkdir(join(dir, ".yushu"), { recursive: true });
    await writeFile(join(dir, STATS_PATH), JSON.stringify({ schema_version: 1, goal: { daily: 0 }, updated_at: "", daily: {} }), "utf8");
    const empty = await readStatsState(gateway, new Date("2026-10-05T12:00:00"));
    expect(empty.daysSinceLastWriting).toBeNull();
    expect(empty.streakDays).toBe(0);
    expect(empty.summary.bestDay).toBeNull();
  });

  it("目标：默认 3000 / 持久化 / 非法值拒绝 / 0 清除", async () => {
    expect((await readStatsState(gateway)).goal.daily).toBe(3000);
    await setStatsGoal(gateway, 2000);
    expect((await readStatsState(gateway)).goal.daily).toBe(2000);
    await expect(setStatsGoal(gateway, -5)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(setStatsGoal(gateway, 1.5)).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await setStatsGoal(gateway, 0);
    expect((await readStatsState(gateway)).goal.daily).toBe(0);
  });

  it("损坏 stats.json：读取回退默认值（不崩），记账覆盖修复", async () => {
    await mkdir(join(dir, ".yushu"), { recursive: true });
    await writeFile(join(dir, STATS_PATH), "{ not-json", "utf8");
    const state = await readStatsState(gateway);
    expect(state.summary.total).toBe(0);
    expect(state.goal.daily).toBe(3000);

    await recordChapterDelta(gateway, { path: "chapters/vol-a/ch-1.md", oldWords: 0, newWords: 5 });
    const repaired = await readStatsState(gateway);
    expect(repaired.today.delta).toBe(5);
    expect(repaired.today.saves).toBe(1);
  });

  it("部分损坏 daily：坏条目保守丢弃，汇总不抛错、不产生 NaN（第 16 轮复核）", async () => {
    await mkdir(join(dir, ".yushu"), { recursive: true });
    await writeFile(
      join(dir, STATS_PATH),
      JSON.stringify({
        schema_version: 1,
        goal: { daily: 3000 },
        updated_at: "",
        daily: {
          "2026-10-05": { delta: 100, saves: 1 },
          "2026-10-04": null,
          "2026-10-03": "oops",
          "2026-10-02": { delta: "10", saves: 2 },
        },
      }),
      "utf8",
    );
    const state = await readStatsState(gateway, new Date("2026-10-05T12:00:00"));
    expect(state.summary.total).toBe(100);
    expect(state.summary.activeDays).toBe(1);
    expect(state.today.delta).toBe(100);

    // 记账写回仅含清洗后的数据：坏条目不会复活、累计正确
    await recordChapterDelta(gateway, { path: "chapters/vol-a/ch-1.md", oldWords: 0, newWords: 5 });
    const after = await readStatsState(gateway, new Date("2026-10-05T12:00:00"));
    expect(after.today.delta).toBe(105);
  });

  it("并发记账与目标设置串行化（第 16 轮复核）：互不覆盖、不丢记账", async () => {
    const [goal] = await Promise.all([
      setStatsGoal(gateway, 2000),
      recordChapterDelta(gateway, { path: "chapters/vol-a/ch-1.md", oldWords: 0, newWords: 5 }),
      recordChapterDelta(gateway, { path: "chapters/vol-a/ch-2.md", oldWords: 0, newWords: 7 }),
    ]);
    expect(goal.daily).toBe(2000);
    const state = await readStatsState(gateway);
    expect(state.goal.daily).toBe(2000);
    expect(state.today.delta).toBe(12);
    expect(state.today.saves).toBe(2);
  });

  it("localDateKey 本地时区 / diffDays 跨月边界", () => {
    expect(localDateKey(new Date(2026, 9, 5, 23, 30))).toBe("2026-10-05");
    expect(localDateKey(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
    expect(diffDays("2026-10-04", "2026-10-05")).toBe(1);
    expect(diffDays("2026-09-30", "2026-10-01")).toBe(1);
    expect(diffDays("2026-10-05", "2026-10-05")).toBe(0);
  });
});