import { countWords } from "@yushu/core";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adoptDraft } from "../src/main/ai-ops.js";
import { writeChapterBody } from "../src/main/chapter-ops.js";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { createOutlineChapter, createProject, generateOutline } from "../src/main/project-ops.js";
import {
  STATS_PATH,
  countEffectiveChars,
  diffDays,
  localDateKey,
  readStatsState,
  recordActivity,
  recordChapterDelta,
  setStatsGoal,
  shiftDateKey,
} from "../src/main/stats-ops.js";

/**
 * 码字统计（T2-9 切片 A/B）：记账（净增 / 负值 / 空保存不计） / 多日汇总与断更 / 目标 / 损坏容错；
 * 切片 B：有效字数口径与记账 / 旧数据兼容 / 速度序列（30 天补零 + 7 日滑动平均）/ 档位常量。
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
    expect(state.today.effective).toBe(countEffectiveChars("采纳的正文甲乙丙。"));
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
    expect(today.today).toEqual({ date: "2026-10-05", delta: 300, saves: 1, effective: 0, activeMs: 0, sessions: 0 });
    expect(today.summary.total).toBe(2800);
    expect(today.summary.week).toBe(2800);
    expect(today.summary.month).toBe(2800);
    expect(today.summary.activeDays).toBe(4);
    expect(today.summary.avgActiveDay).toBe(700);
    expect(today.summary.bestDay).toEqual({ date: "2026-10-02", delta: 2000, saves: 3, effective: 0, activeMs: 0, sessions: 0 });
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

    // 记账写回仅含清洗后的数据：坏条目不会复活、累计正确（now 注入与读取同口径，避免日历跨天致断言漂移）
    await recordChapterDelta(gateway, {
      path: "chapters/vol-a/ch-1.md",
      oldWords: 0,
      newWords: 5,
      now: new Date("2026-10-05T12:00:00"),
    });
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

  it("切片 B：countEffectiveChars 去空白口径（保留标点 / 全角空格 / 换行）与 shiftDateKey 跨月年", () => {
    expect(countEffectiveChars("甲 乙\n丙\t丁。！")).toBe(6);
    expect(countEffectiveChars("a b 中 文")).toBe(4);
    expect(countEffectiveChars("　全角　空格")).toBe(4);
    expect(countEffectiveChars("")).toBe(0);
    expect(shiftDateKey("2026-10-01", -1)).toBe("2026-09-30");
    expect(shiftDateKey("2026-12-31", 1)).toBe("2027-01-01");
    expect(shiftDateKey("2026-03-01", -28)).toBe("2026-02-01");
  });

  it("切片 B：编辑器保存记账有效字数净增（可负；空保存不计）", async () => {
    const { chapterPath } = await setupDraft();
    const initial = await gateway.readDoc(chapterPath);

    const first = await writeChapterBody(gateway, { path: chapterPath, body: BODY_A, baseHash: initial.hash });
    let state = await readStatsState(gateway);
    expect(state.today.effective).toBe(countEffectiveChars(BODY_A));

    const second = await writeChapterBody(gateway, { path: chapterPath, body: BODY_B, baseHash: first.hash });
    state = await readStatsState(gateway);
    expect(state.today.effective).toBe(countEffectiveChars(BODY_B));

    // 删字：有效字数净减；同内容空保存不改变累计
    const third = await writeChapterBody(gateway, { path: chapterPath, body: BODY_A, baseHash: second.hash });
    await writeChapterBody(gateway, { path: chapterPath, body: BODY_A, baseHash: third.hash });
    state = await readStatsState(gateway);
    expect(state.today.effective).toBe(countEffectiveChars(BODY_A));
    expect(state.summary.monthEffective).toBe(countEffectiveChars(BODY_A));
  });

  it("切片 B：旧条目无 effective → 缺失按 0 处理，写回不补造历史", async () => {
    await mkdir(join(dir, ".yushu"), { recursive: true });
    await writeFile(
      join(dir, STATS_PATH),
      JSON.stringify({
        schema_version: 1,
        goal: { daily: 3000 },
        updated_at: "",
        daily: {
          "2026-10-05": { delta: 100, saves: 1 },
          "2026-10-04": { delta: 500, saves: 2, effective: 480 },
        },
      }),
      "utf8",
    );
    const state = await readStatsState(gateway, new Date("2026-10-05T12:00:00"));
    expect(state.today.effective).toBe(0);
    expect(state.summary.monthEffective).toBe(480);

    await recordChapterDelta(gateway, {
      path: "chapters/x.md",
      oldWords: 0,
      newWords: 5,
      oldEffective: 0,
      newEffective: 6,
      now: new Date("2026-10-05T12:00:00"),
    });
    const after = await readStatsState(gateway, new Date("2026-10-05T12:00:00"));
    expect(after.today.effective).toBe(6);
    expect(after.summary.monthEffective).toBe(486);

    // 写回后旧条目保持「无 effective」原样（不补造 0 值历史）
    const raw = JSON.parse(await readFile(join(dir, STATS_PATH), "utf8")) as {
      daily: Record<string, Record<string, unknown>>;
    };
    expect(raw.daily["2026-10-04"]).toEqual({ delta: 500, saves: 2, effective: 480 });
    expect(raw.daily["2026-10-05"]).toEqual({ delta: 105, saves: 2, effective: 6 });
  });

  it("切片 B：速度序列 30 天补零 + 7 日滑动平均（末尾满窗取均值、窗口首端按可得天数）；档位常量", async () => {
    const daily: Record<string, { delta: number; saves: number }> = {};
    for (const date of ["10-01", "10-02", "10-03", "10-04", "10-05", "10-06", "10-07"]) {
      daily[`2026-${date}`] = { delta: 100, saves: 1 };
    }
    await mkdir(join(dir, ".yushu"), { recursive: true });
    await writeFile(
      join(dir, STATS_PATH),
      JSON.stringify({ schema_version: 1, goal: { daily: 3000 }, updated_at: "", daily }),
      "utf8",
    );

    const state = await readStatsState(gateway, new Date("2026-10-07T12:00:00"));
    expect(state.speed).toHaveLength(30);
    expect(state.tiers).toEqual({ basic: 4000, advanced: 6000 });
    // 末点（10-07）：窗口 10-01..10-07 全有数据 → 100
    expect(state.speed[29]).toEqual({ date: "2026-10-07", delta: 100, avg: 100 });
    // 前一点（10-06）：窗口 09-30..10-06（09-30 无数据按 0）→ 600 / 7 ≈ 86
    expect(state.speed[28]!.avg).toBe(86);
    // 窗口首端（09-08）：仅当日、无数据 → 0；日期连续递增
    expect(state.speed[0]).toEqual({ date: "2026-09-08", delta: 0, avg: 0 });
    // 10-01：窗口 09-25..10-01 内仅 10-01 有数据 → 100 / 7 ≈ 14
    expect(state.speed[23]).toEqual({ date: "2026-10-01", delta: 100, avg: 14 });
  });
});

describe("码字统计（T2-9 切片 C：写作会话与真实速度）", () => {
  const T0 = new Date("2026-10-06T10:00:00");

  it("活动心跳：首次开新会话（活跃 0）；同会话间隔累计活跃；超空闲阈值开新会话（大间隔不计）", async () => {
    expect(await recordActivity(gateway, T0)).toEqual({ activeMs: 0, sessions: 1 });
    expect(await recordActivity(gateway, new Date(T0.getTime() + 90_000))).toEqual({ activeMs: 90_000, sessions: 1 });
    // 距上次 10 分钟 > 空闲阈值（2 分钟）：新会话，间隔不计入活跃
    expect(await recordActivity(gateway, new Date(T0.getTime() + 690_000))).toEqual({
      activeMs: 90_000,
      sessions: 2,
    });
    // 新会话内继续累计
    expect(await recordActivity(gateway, new Date(T0.getTime() + 720_000))).toEqual({
      activeMs: 120_000,
      sessions: 2,
    });
  });

  it("跨日：昨日条目不并入今日（新日首 ping 开新会话，昨日保留活跃与会话数）", async () => {
    await recordActivity(gateway, new Date("2026-10-05T23:50:00"));
    await recordActivity(gateway, new Date("2026-10-05T23:52:00"));
    expect(await recordActivity(gateway, new Date("2026-10-06T09:00:00"))).toEqual({ activeMs: 0, sessions: 1 });

    const state = await readStatsState(gateway, new Date("2026-10-06T12:00:00"));
    expect(state.today.activeMs).toBe(0);
    expect(state.today.sessions).toBe(1);
    const yesterday = state.daily.find((entry) => entry.date === "2026-10-05");
    expect(yesterday).toMatchObject({ activeMs: 120_000, sessions: 1 });
  });

  it("今日速度：净增 / 活跃分钟；活跃不足 1 分钟或净增非正为 null", async () => {
    await recordChapterDelta(gateway, {
      path: "chapters/a.md",
      oldWords: 0,
      newWords: 10,
      now: T0,
    });
    await recordActivity(gateway, T0); // 活跃 0 → 速度 null
    expect((await readStatsState(gateway, T0)).todaySpeedCpm).toBeNull();

    await recordActivity(gateway, new Date(T0.getTime() + 60_000)); // 活跃 1 分钟
    expect((await readStatsState(gateway, T0)).todaySpeedCpm).toBe(10);

    // 删回 0 字（净增 10 → -10 = 0）：净增非正 → null
    await recordChapterDelta(gateway, {
      path: "chapters/a.md",
      oldWords: 10,
      newWords: 0,
      now: new Date(T0.getTime() + 61_000),
    });
    const state = await readStatsState(gateway, T0);
    expect(state.today.delta).toBe(0);
    expect(state.todaySpeedCpm).toBeNull();
  });

  it("记账与心跳并发（同一串行队列）：互不覆盖；活跃 30s 时速度仍为 null", async () => {
    await Promise.all([
      recordChapterDelta(gateway, { path: "chapters/a.md", oldWords: 0, newWords: 30, now: T0 }),
      recordActivity(gateway, T0),
      recordActivity(gateway, new Date(T0.getTime() + 30_000)),
    ]);
    const state = await readStatsState(gateway, T0);
    expect(state.today.delta).toBe(30);
    expect(state.today.activeMs).toBe(30_000);
    expect(state.today.sessions).toBe(1);
    expect(state.todaySpeedCpm).toBeNull(); // 活跃不足 1 分钟
  });

  it("旧条目无 activeMs/sessions：读取按 0，写回不补造历史", async () => {
    await mkdir(join(dir, ".yushu"), { recursive: true });
    await writeFile(
      join(dir, STATS_PATH),
      JSON.stringify({
        schema_version: 1,
        goal: { daily: 3000 },
        updated_at: "",
        daily: { "2026-10-05": { delta: 100, saves: 1, effective: 90 } },
      }),
      "utf8",
    );
    await recordActivity(gateway, T0);
    const state = await readStatsState(gateway, T0);
    const old = state.daily.find((entry) => entry.date === "2026-10-05");
    expect(old).toMatchObject({ activeMs: 0, sessions: 0 });

    const raw = JSON.parse(await readFile(join(dir, STATS_PATH), "utf8")) as {
      daily: Record<string, Record<string, unknown>>;
      last_active_at?: string;
    };
    expect(raw.daily["2026-10-05"]).toEqual({ delta: 100, saves: 1, effective: 90 });
    expect(raw.last_active_at).toBe(T0.toISOString());
  });
});