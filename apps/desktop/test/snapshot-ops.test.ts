import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { createProject } from "../src/main/project-ops.js";
import {
  SNAPSHOT_BLOBS_DIR,
  SNAPSHOT_MANIFESTS_DIR,
  SnapshotLoop,
  isSnapshotSource,
  restoreSnapshot,
  snapshotState,
  takeSnapshot,
} from "../src/main/snapshot-ops.js";

/**
 * 本地快照（T2-7 切片 A·内容寻址）：生成 / 增量复用 / 最小间隔 / 环形保留 / 整体回滚 / 损坏容错。
 * 约定：源文件 = listTree 可见且扩展名在白名单（.md/.yaml/.yml/.toml/.txt/.json）、排除 exports/。
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
  dir = await mkdtemp(join(tmpdir(), "yushu-snapshot-"));
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(dir);
  // 确定性素材：两个源文件 + 两个"非源文件"（导出产物 / 非文本扩展名）
  await gateway.writeDoc("chapters/vol-a/ch-1.md", "第一版甲。");
  await gateway.writeDoc("world/cards/character/c1.md", "原始乙。");
  await gateway.writeDoc("exports/out.txt", "导出产物不参与。");
  await gateway.writeDoc("world/cover.png", "二进制示意（扩展名不在白名单）。");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

function blobAbs(blob: string): string {
  return join(dir, SNAPSHOT_BLOBS_DIR, blob.slice(0, 2), blob);
}

function hashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function exists(abs: string): Promise<boolean> {
  return readFile(abs)
    .then(() => true)
    .catch(() => false);
}

async function manifestFiles(): Promise<string[]> {
  return (await readdir(join(dir, SNAPSHOT_MANIFESTS_DIR))).filter((name) => name.endsWith(".json")).sort();
}

async function blobFiles(): Promise<string[]> {
  const root = join(dir, SNAPSHOT_BLOBS_DIR);
  const out: string[] = [];
  const walk = async (abs: string): Promise<void> => {
    const dirents = await readdir(abs, { withFileTypes: true }).catch(() => []);
    for (const dirent of dirents) {
      if (dirent.isDirectory()) await walk(join(abs, dirent.name));
      else if (!dirent.name.endsWith(".tmp")) out.push(dirent.name);
    }
  };
  await walk(root);
  return out.sort();
}

describe("本地快照（T2-7 切片 A）", () => {
  it("生成快照：manifest + 内容寻址 blob 落盘；exports / 非文本扩展名不参与", async () => {
    const take = await takeSnapshot(gateway, "manual", { force: true });
    expect(take.outcome).toBe("taken");
    expect(take.snapshot?.files).toBeGreaterThan(0);
    expect(await manifestFiles()).toHaveLength(1);

    const manifest = JSON.parse(await readFile(join(dir, SNAPSHOT_MANIFESTS_DIR, `${take.snapshot!.id}.json`), "utf8")) as {
      entries: { path: string; blob: string }[];
      reason: string;
    };
    expect(manifest.reason).toBe("manual");
    const paths = manifest.entries.map((entry) => entry.path);
    expect(paths).toContain("chapters/vol-a/ch-1.md");
    expect(paths).toContain("world/cards/character/c1.md");
    expect(paths).not.toContain("exports/out.txt");
    expect(paths).not.toContain("world/cover.png");
    // 每个条目的 blob 均已落盘；blob 数 = 唯一内容数（内容寻址去重，无多余副本）
    for (const entry of manifest.entries) {
      expect(await exists(blobAbs(entry.blob))).toBe(true);
    }
    const distinct = new Set(manifest.entries.map((entry) => entry.blob)).size;
    expect(await blobFiles()).toHaveLength(distinct);
  });

  it("内容未变 → unchanged；单个文件变更 → 新 manifest 且未变文件复用 blob（去重）", async () => {
    const first = await takeSnapshot(gateway, "manual", { force: true });
    expect(first.outcome).toBe("taken");
    const blobsAfterFirst = await blobFiles();

    // 同内容重写（mtime 变化）：内容寻址视角仍为 unchanged
    await writeFile(join(dir, "chapters/vol-a/ch-1.md"), "第一版甲。", "utf8");
    const again = await takeSnapshot(gateway, "manual", { force: true });
    expect(again.outcome).toBe("unchanged");
    expect(await manifestFiles()).toHaveLength(1);

    // 变更一个文件：新 manifest，仅新增该内容的 blob（其余复用）
    await writeFile(join(dir, "chapters/vol-a/ch-1.md"), "第二版甲。", "utf8");
    const changed = await takeSnapshot(gateway, "manual", { force: true });
    expect(changed.outcome).toBe("taken");
    expect(await manifestFiles()).toHaveLength(2);
    const blobsAfterChange = await blobFiles();
    expect(blobsAfterChange.length).toBe(blobsAfterFirst.length + 1);
    expect(blobsAfterChange).toContain(hashOf("第二版甲。"));
    expect(blobsAfterChange).toContain(hashOf("原始乙。"));
  });

  it("60s 最小间隔：自动策略窗口内 too_soon、到期 taken；手动强制不受限", async () => {
    const base = new Date("2026-01-01T00:00:00.000Z");
    const first = await takeSnapshot(gateway, "auto", { now: base }); // 无上一份 → 生成基线
    expect(first.outcome).toBe("taken");

    await writeFile(join(dir, "chapters/vol-a/ch-1.md"), "改稿一。", "utf8");
    const soon = await takeSnapshot(gateway, "auto", { now: new Date(base.getTime() + 30_000) });
    expect(soon.outcome).toBe("too_soon");
    expect(soon.latest?.id).toBe(first.snapshot!.id);

    const due = await takeSnapshot(gateway, "auto", { now: new Date(base.getTime() + 61_000) });
    expect(due.outcome).toBe("taken");

    await writeFile(join(dir, "chapters/vol-a/ch-1.md"), "改稿二。", "utf8");
    const forced = await takeSnapshot(gateway, "manual", { force: true, now: new Date(base.getTime() + 62_000) });
    expect(forced.outcome).toBe("taken");
  });

  it(
    "环形保留 20：超出裁掉最旧 manifest，其独占 blob 被清理、共用 blob 保留",
    async () => {
      const base = new Date("2026-01-01T00:00:00.000Z").getTime();
      const ids: string[] = [];
      for (let i = 1; i <= 22; i += 1) {
        await writeFile(join(dir, "chapters/vol-a/ch-1.md"), `第${i}版。`, "utf8");
        const take = await takeSnapshot(gateway, "manual", { force: true, now: new Date(base + i * 1000), keep: 20 });
        expect(take.outcome).toBe("taken");
        ids.push(take.snapshot!.id);
      }
      const files = await manifestFiles();
      expect(files).toHaveLength(20);
      expect(files).not.toContain(`${ids[0]}.json`);
      expect(files).not.toContain(`${ids[1]}.json`);
      expect(files).toContain(`${ids[21]}.json`);

      const blobs = await blobFiles();
      expect(blobs).not.toContain(hashOf("第1版。")); // 独占内容随 manifest 裁掉
      expect(blobs).not.toContain(hashOf("第2版。"));
      expect(blobs).toContain(hashOf("第3版。")); // 保留范围内
      expect(blobs).toContain(hashOf("原始乙。")); // 所有 manifest 共用 → 保留
    },
    // 22 次 fsync 原子写快照（含环形清理）：默认 5s 在并行全量测试（含索引重建等重 IO 用例）下会偶发超时——
    // 显式放宽测试预算（单跑约 1s，仅为负载敏感的时间预算，不改变任何产品行为）。
    30_000,
  );

  it("整体回滚：改写写回 / 被删重建 / 快照后新增保守保留；恢复前强制 pre_restore 快照", async () => {
    const s1 = await takeSnapshot(gateway, "manual", { force: true });
    expect(s1.outcome).toBe("taken");

    // 误改 + 误删 + 快照后新增
    await writeFile(join(dir, "chapters/vol-a/ch-1.md"), "被改写的甲。", "utf8");
    await rm(join(dir, "world/cards/character/c1.md"));
    await writeFile(join(dir, "world/new-note.md"), "快照之后新增。", "utf8");

    const restore = await restoreSnapshot(gateway, s1.snapshot!.id);
    expect(restore.restoredFiles).toBeGreaterThanOrEqual(1);
    expect(restore.recreatedFiles).toBe(1);
    expect(restore.extraFiles).toContain("world/new-note.md");
    expect(restore.preRestoreTaken).toBe(true);

    // 内容写回与重建
    expect(await readFile(join(dir, "chapters/vol-a/ch-1.md"), "utf8")).toBe("第一版甲。");
    expect(await readFile(join(dir, "world/cards/character/c1.md"), "utf8")).toBe("原始乙。");
    expect(await readFile(join(dir, "world/new-note.md"), "utf8")).toBe("快照之后新增。");

    // 恢复前快照可再回滚（撤销窗口）：pre_restore 记录的是"被改写的甲"
    const state = await snapshotState(gateway);
    const pre = state.snapshots.find((item) => item.id === restore.preRestoreId);
    expect(pre?.reason).toBe("pre_restore");
    await restoreSnapshot(gateway, restore.preRestoreId);
    expect(await readFile(join(dir, "chapters/vol-a/ch-1.md"), "utf8")).toBe("被改写的甲。");
  });

  it("损坏 manifest：list 跳过不崩；恢复报 E_SNAPSHOT_INVALID", async () => {
    await takeSnapshot(gateway, "manual", { force: true });
    await mkdir(join(dir, SNAPSHOT_MANIFESTS_DIR), { recursive: true });
    await writeFile(join(dir, SNAPSHOT_MANIFESTS_DIR, "snap-broken.json"), "{ not-json", "utf8");
    const state = await snapshotState(gateway);
    expect(state.snapshots).toHaveLength(1);
    await expect(restoreSnapshot(gateway, "snap-broken")).rejects.toMatchObject({ code: "E_SNAPSHOT_INVALID" });
  });

  it("源文件白名单：扩展名 / exports 前缀判定", () => {
    expect(isSnapshotSource("chapters/vol-a/ch-1.md")).toBe(true);
    expect(isSnapshotSource("project.toml")).toBe(true);
    expect(isSnapshotSource("wordlists/platform.yaml")).toBe(true);
    expect(isSnapshotSource("exports/out.txt")).toBe(false);
    expect(isSnapshotSource("world/cover.png")).toBe(false);
    expect(isSnapshotSource("world/noext")).toBe(false);
  });

  it("并发 take 串行化（第 14 轮复核）：第二个看到第一个的结果 → unchanged、仅 1 份 manifest，引用 blob 无缺失", async () => {
    const [first, second] = await Promise.all([
      takeSnapshot(gateway, "manual", { force: true }),
      takeSnapshot(gateway, "manual", { force: true }),
    ]);
    expect(first.outcome).toBe("taken");
    expect(second.outcome).toBe("unchanged");
    expect(await manifestFiles()).toHaveLength(1);

    const state = await snapshotState(gateway);
    expect(state.snapshots).toHaveLength(1);
    const manifest = JSON.parse(
      await readFile(join(dir, SNAPSHOT_MANIFESTS_DIR, `${first.snapshot!.id}.json`), "utf8"),
    ) as { entries: { blob: string }[] };
    for (const entry of manifest.entries) {
      expect(await exists(blobAbs(entry.blob))).toBe(true);
    }
  });

  it("blob 损坏：恢复时内容校验失败 → E_SNAPSHOT_INVALID（绝不静默写回坏内容）", async () => {
    const s1 = await takeSnapshot(gateway, "manual", { force: true });
    const manifest = JSON.parse(
      await readFile(join(dir, SNAPSHOT_MANIFESTS_DIR, `${s1.snapshot!.id}.json`), "utf8"),
    ) as { entries: { path: string; blob: string }[] };
    const victim = manifest.entries[0]!;
    await writeFile(blobAbs(victim.blob), "已被篡改的坏内容。", "utf8");

    await expect(restoreSnapshot(gateway, s1.snapshot!.id)).rejects.toMatchObject({ code: "E_SNAPSHOT_INVALID" });
    // 真源未被写入坏内容（校验在写回之前拦截）
    expect(await readFile(join(dir, victim.path), "utf8")).not.toContain("已被篡改的坏内容");
  });

  it("非法 manifest（id / blob / path 含路径穿越字段）：列表跳过、恢复拒绝（防御纵深）", async () => {
    await takeSnapshot(gateway, "manual", { force: true });
    const evil = {
      schema_version: 1,
      id: "snap-../../evil",
      createdAt: new Date().toISOString(),
      reason: "manual",
      entries: [{ path: "../../outside.md", blob: "../../x", size: 1, mtime: "" }],
    };
    await mkdir(join(dir, SNAPSHOT_MANIFESTS_DIR), { recursive: true });
    await writeFile(join(dir, SNAPSHOT_MANIFESTS_DIR, "snap-evil.json"), JSON.stringify(evil), "utf8");

    const state = await snapshotState(gateway);
    expect(state.snapshots).toHaveLength(1); // 非法条目被跳过（原文件保留不删）
    await expect(restoreSnapshot(gateway, "snap-../../evil")).rejects.toMatchObject({ code: "E_SNAPSHOT_INVALID" });
    expect(await exists(join(dir, SNAPSHOT_MANIFESTS_DIR, "snap-evil.json"))).toBe(true);
  });

  it("prune 顺带清理 blob 目录中原子写崩溃残留的 .tmp", async () => {
    await takeSnapshot(gateway, "manual", { force: true });
    const orphanTmp = join(dir, SNAPSHOT_BLOBS_DIR, "ab", "deadbeef.tmp");
    await mkdir(dirname(orphanTmp), { recursive: true });
    await writeFile(orphanTmp, "残留", "utf8");

    await writeFile(join(dir, "chapters/vol-a/ch-1.md"), "触发新快照以执行 prune。", "utf8");
    const again = await takeSnapshot(gateway, "manual", { force: true });
    expect(again.outcome).toBe("taken");
    expect(await exists(orphanTmp)).toBe(false);
  });
});

describe("快照循环（T2-7 切片 A：自动 60s 检查）", () => {
  it("start 立即检查一次并按间隔触发；stop 后不再触发", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const loop = new SnapshotLoop(async () => {
        calls += 1;
      }, 1000);
      loop.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      loop.stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(calls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("单飞：上一轮未结束则跳过本轮，结束后恢复", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      let release: (() => void) | null = null;
      const loop = new SnapshotLoop(async () => {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
      }, 1000);
      loop.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1000); // 上一轮挂起 → 跳过
      expect(calls).toBe(1);
      release!();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("失败不打断：异常被吞掉，下个周期继续", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const loop = new SnapshotLoop(async () => {
        calls += 1;
        if (calls === 1) throw new Error("E_IO");
      }, 1000);
      loop.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls).toBe(2);
      loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});