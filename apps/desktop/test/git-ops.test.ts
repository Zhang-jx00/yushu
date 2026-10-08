import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectGateway } from "../src/main/file-gateway.js";
import {
  gitCommit,
  gitInit,
  gitRollback,
  gitState,
  GIT_DEFAULT_AUTHOR,
  GIT_EXCLUDES,
  isTransientScanError,
  withTransientRetry,
} from "../src/main/git-ops.js";
import { createProject } from "../src/main/project-ops.js";
import { snapshotState } from "../src/main/snapshot-ops.js";

/**
 * Git 版本管理（T2-7 切片 B）：初始化 / 变更识别 / 一次批量改动 = 一次提交 /
 * 整体回滚（工作区语义——不改写历史、新增保守保留、回滚前强制 pre_restore 快照）/ 错误路径。
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
  dir = await mkdtemp(join(tmpdir(), "yushu-git-"));
  await createProject({ dir, title: "天启界", packIds: ["xuanhuan-xitong"], axes: AXES });
  gateway = new ProjectGateway(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

describe("Git 版本管理（T2-7 切片 B）", () => {
  it("未初始化 → init（main 分支，仓库级作者兜底）→ 全部首次提交可见", async () => {
    const before = await gitState(gateway);
    expect(before).toMatchObject({ initialized: false, branch: null, head: null, changes: [], log: [] });

    const initialized = await gitInit(gateway);
    expect(initialized.initialized).toBe(true);
    expect(initialized.branch).toBe("main");
    expect(initialized.head).toBeNull(); // 空仓库无 HEAD
    expect(initialized.changes.length).toBeGreaterThanOrEqual(2); // project.toml / world/world.yaml（新建项目脚手架）
    expect(initialized.changes.every((change) => change.state === "new")).toBe(true);

    const commit = await gitCommit(gateway, "首次提交");
    expect(commit.oid).toMatch(/^[0-9a-f]{40}$/);
    expect(commit.files).toBe(initialized.changes.length);

    const after = await gitState(gateway);
    expect(after.changes).toEqual([]);
    expect(after.head).toBe(commit.shortOid);
    expect(after.log).toHaveLength(1);
    expect(after.log[0]).toMatchObject({ message: "首次提交", author: GIT_DEFAULT_AUTHOR.name });
  });

  it("一次批量改动 = 一次提交：修改 + 新增一并入同一个提交；变更分类正确", async () => {
    await gitInit(gateway);
    await gitCommit(gateway, "基线");
    const world = await gateway.readDoc("world/world.yaml");
    await gateway.writeDoc("world/world.yaml", world.content + "# 批量改动一\n", world.hash);
    await gateway.writeDoc("notes/批注.txt", "一次提交里的新增文件\n");

    const staged = await gitState(gateway);
    expect(staged.changes).toEqual([
      { path: "notes/批注.txt", state: "new" },
      { path: "world/world.yaml", state: "modified" },
    ]);

    const commit = await gitCommit(gateway, "批量改动二");
    expect(commit.files).toBe(2);
    const after = await gitState(gateway);
    expect(after.changes).toEqual([]);
    expect(after.log.map((entry) => entry.message)).toEqual(["批量改动二", "基线"]);
  });

  it("删除的文件计入 deleted 变更并在提交后从索引移除", async () => {
    await gitInit(gateway);
    await gitCommit(gateway, "基线");
    await rm(join(dir, "project.toml"), { force: true });

    const staged = await gitState(gateway);
    expect(staged.changes).toEqual([{ path: "project.toml", state: "deleted" }]);
    const commit = await gitCommit(gateway, "删除 project.toml");
    expect(commit.files).toBe(1);
    expect((await gitState(gateway)).changes).toEqual([]);
  });

  it("整体回滚：工作区回到旧提交内容（HEAD 不动）、之后新增文件保守保留、回滚前强制 pre_restore 快照", async () => {
    await gitInit(gateway);
    const first = await gitCommit(gateway, "基线");

    // 第二个提交：改 world.yaml + 新增 notes/later.txt
    const world = await gateway.readDoc("world/world.yaml");
    await gateway.writeDoc("world/world.yaml", world.content + "# 之后改动\n", world.hash);
    await gateway.writeDoc("notes/later.txt", "回滚后应保留\n");
    const second = await gitCommit(gateway, "之后改动");

    const rollback = await gitRollback(gateway, first.oid);
    expect(rollback).toMatchObject({ shortOid: first.shortOid, restored: 1, recreated: 0 });
    expect(rollback.kept).toEqual(["notes/later.txt"]);
    expect(rollback.preRestoreId).not.toBeNull();

    // 内容回到基线；later.txt 保留；HEAD 仍指向第二提交（不改写历史）——回滚结果成为新的待提交改动
    const reverted = await gateway.readDoc("world/world.yaml");
    expect(reverted.content).not.toContain("# 之后改动");
    expect((await gateway.readDoc("notes/later.txt")).content).toBe("回滚后应保留\n");
    const after = await gitState(gateway);
    expect(after.head).toBe(second.shortOid);
    // later.txt 与 HEAD 一致（不在变更集），只列出回滚造成的 world.yaml 改动——回滚结果成为新的待提交改动
    expect(after.changes).toEqual([{ path: "world/world.yaml", state: "modified" }]);

    // 回滚前快照（撤销窗口）：最近一份 pre_restore
    const snap = await snapshotState(gateway);
    const pre = snap.snapshots.filter((item) => item.reason === "pre_restore");
    expect(pre.length).toBeGreaterThanOrEqual(1);
    expect(pre[0]!.id).toBe(rollback.preRestoreId);
  });

  it("错误路径：空信息 / 无变更提交 / 未初始化 / 坏 oid 给出明确错误", async () => {
    await expect(gitCommit(gateway, "  ")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
    await expect(gitCommit(gateway, "未初始化")).rejects.toMatchObject({ code: "E_GIT_NOT_INIT" });

    await gitInit(gateway);
    await gitCommit(gateway, "基线");
    await expect(gitCommit(gateway, "无变更")).rejects.toMatchObject({ code: "E_GIT_NO_CHANGES" });
    await expect(gitRollback(gateway, "deadbeef")).rejects.toMatchObject({ code: "E_GIT_BAD_REF" });
    await expect(gitRollback(gateway, "../bad ref")).rejects.toMatchObject({ code: "E_INVALID_INPUT" });
  });
});

/**
 * 项目根 `.gitignore`（T3-14 / T2-7 收口）：
 * 此前"派生目录不入 Git"只靠**结果侧过滤**（`isGitPath` / `isSnapshotSource`），遍历仍会 stat `.yushu/` 里
 * 每个文件——SQLite 的 `-wal` / `-shm` 侧车在扫描中途消失就抛 `ENOENT ... lstat`（e2e 实测撞到过），
 * 而且用户自己 `git add .` 时应用内过滤根本不管用，凭据库密文与索引库会被提交。
 * 写进 `.gitignore` 后：isomorphic-git 在 map 阶段就按 ignore 剪掉整棵子树（不再 stat），
 * 外部 git 客户端也与我们同一口径——安全承诺从"我们看得见时过滤"升级为"仓库本身就不收"。
 */
describe("项目根 .gitignore（init 补齐，派生目录连遍历都不进）", () => {
  it("init 写出 .gitignore 含三个派生目录，且其中的真实文件不出现在变更清单", async () => {
    await gitInit(gateway);
    const ignore = await readFile(join(dir, ".gitignore"), "utf8");
    expect(ignore).toContain(".yushu/");
    expect(ignore).toContain("exports/");
    expect(ignore).toContain("node_modules/");

    await mkdir(join(dir, ".yushu"), { recursive: true });
    await writeFile(join(dir, ".yushu", "index.db"), "sqlite-ish-bytes", "utf8");
    await mkdir(join(dir, "exports"), { recursive: true });
    await writeFile(join(dir, "exports", "out.txt"), "导出产物", "utf8");
    const state = await gitState(gateway);
    expect(state.changes.some((c) => c.path.startsWith(".yushu/"))).toBe(false);
    expect(state.changes.some((c) => c.path.startsWith("exports/"))).toBe(false);
    // `.gitignore` 本身**不进提交**：纳入范围一直是「作者内容白名单」（md / yaml / toml…），点文件不在其列。
    // 这不影响效力——ignore 规则读的是工作区文件，外部 git 的效力由下面 `git check-ignore` 用例单独证明。
    expect(state.changes.some((c) => c.path === ".gitignore")).toBe(false);
  });

  it("已有 .gitignore 保留用户内容只补缺失行；重复 init 幂等（不重复追加）", async () => {
    await writeFile(join(dir, ".gitignore"), "# 我自己的规则\n*.tmp\n.yushu/\n", "utf8");
    await gitInit(gateway);
    const once = await readFile(join(dir, ".gitignore"), "utf8");
    expect(once).toContain("# 我自己的规则");
    expect(once).toContain("*.tmp");
    expect(once).toContain(".yushu/");
    expect(once.match(/\.yushu\//g)).toHaveLength(1);
    await gitInit(gateway);
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(once);
  });

  it("凭据库密文与 SQLite 侧车不进提交（安全承诺落到仓库本身）", async () => {
    await mkdir(join(dir, ".yushu"), { recursive: true });
    await writeFile(join(dir, ".yushu", "secrets.json"), JSON.stringify({ version: 1, entries: [] }), "utf8");
    await writeFile(join(dir, ".yushu", "index.db-shm"), "shm", "utf8");
    await writeFile(join(dir, ".yushu", "index.db-wal"), "wal", "utf8");
    await gitInit(gateway);
    const commit = await gitCommit(gateway, "基线（含 .gitignore）");
    expect(commit.files).toBeGreaterThan(0);
    const after = await gitState(gateway);
    expect(after.changes.filter((c) => c.path.startsWith(".yushu/"))).toEqual([]);
    // 提交后工作区应干净：若 .yushu 未被 ignore，此处会残留 3 条 new
    expect(after.changes).toEqual([]);
  });

  it("与 GIT_EXCLUDES 同源：新增派生目录不会漏写进 .gitignore（`.git/` 由 git 自身处理）", async () => {
    await gitInit(gateway);
    const ignore = await readFile(join(dir, ".gitignore"), "utf8");
    const lines = ignore.split(/\r?\n/);
    for (const prefix of GIT_EXCLUDES) {
      if (prefix === ".git/") continue;
      expect(lines).toContain(prefix);
    }
  });

  it("外部 git 客户端同口径：`git check-ignore` 认 .yushu/secrets.json（凭据不会被 git add . 收走）", async () => {
    await mkdir(join(dir, ".yushu"), { recursive: true });
    await writeFile(join(dir, ".yushu", "secrets.json"), JSON.stringify({ version: 1, entries: [] }), "utf8");
    await gitInit(gateway);
    const verdict = await new Promise<{ code: number; err: string }>((resolve) => {
      execFile("git", ["-C", dir, "check-ignore", "-q", ".yushu/secrets.json"], (err) => {
        // code 0 = 命中 ignore；code 1 = 未命中；其它 = git 不可用（环境缺依赖时不误判为失败）
        resolve({ code: err ? ((err as unknown as { code?: number }).code ?? -1) : 0, err: err?.message ?? "" });
      });
    });
    if (verdict.code === 1) throw new Error(`.yushu/secrets.json 未被 .gitignore 命中：外部 git add . 会提交凭据库`);
    if (verdict.code !== 0 && verdict.code !== 1) return; // git 不可用：跳过外部对照
  });
});
/**
 * 易失文件竞态重试（第 45 轮）：`.yushu/` 里 SQLite `-wal` / `-shm` 侧车会在索引写入瞬间出现又消失，
 * isomorphic-git 遍历 lstat 落空即抛 ENOENT。这不是仓库故障，重试即可；
 * 但**只能对这一类错误重试**——业务错误码借道重试会把真故障藏起来。
 */
describe("易失文件竞态重试（withTransientRetry / isTransientScanError）", () => {
  it("识别：ENOENT + lstat/readdir 才算竞态；ENOENT 之外的错误不算", () => {
    expect(isTransientScanError(new Error("ENOENT: no such file or directory, lstat '.yushu/index.db-shm'"))).toBe(true);
    expect(isTransientScanError(Object.assign(new Error("boom"), { code: "ENOENT", syscall: "readdir" }))).toBe(false);
    expect(isTransientScanError(new Error("EACCES: permission denied, lstat 'x'"))).toBe(false);
    expect(isTransientScanError(new Error("[E_GIT_NOT_INIT] 尚未初始化"))).toBe(false);
    expect(isTransientScanError(undefined)).toBe(false);
  });

  it("竞态错误重试到成功为止（第 3 次通过）", async () => {
    let calls = 0;
    const value = await withTransientRetry("probe", async () => {
      calls += 1;
      if (calls < 3) throw new Error("ENOENT: no such file or directory, lstat '.yushu/index.db-wal'");
      return "ok";
    });
    expect(value).toBe("ok");
    expect(calls).toBe(3);
  });

  it("非竞态错误**立即上抛**，不重试也不改写", async () => {
    let calls = 0;
    await expect(
      withTransientRetry("probe", async () => {
        calls += 1;
        throw new Error("[E_DOC_CONFLICT] 并发修改");
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("E_DOC_CONFLICT") });
    expect(calls).toBe(1);
  });

  it("重试仍失败时给可操作错误码与次数（不静默吞掉）", async () => {
    let calls = 0;
    await expect(
      withTransientRetry("statusMatrix", async () => {
        calls += 1;
        throw new Error("ENOENT: no such file or directory, lstat '.yushu/index.db-shm'");
      }),
    ).rejects.toMatchObject({ code: "E_GIT_SCAN" });
    expect(calls).toBe(3);
  });

  it("git 初始化 + 提交在存在易失侧车文件时仍成功（回归：曾经打断 e2e 的那类错误）", async () => {
    await mkdir(join(dir, ".yushu"), { recursive: true });
    await writeFile(join(dir, ".yushu", "index.db-shm"), "shm", "utf8");
    await writeFile(join(dir, ".yushu", "index.db-wal"), "wal", "utf8");
    await gitInit(gateway);
    const commit = await gitCommit(gateway, "含侧车文件时提交");
    expect(commit.files).toBeGreaterThan(0);
    const state = await gitState(gateway);
    expect(state.changes).toEqual([]);
    // 中途删掉侧车文件：后续扫描不应因此报错
    await rm(join(dir, ".yushu", "index.db-shm"), { force: true });
    expect((await gitState(gateway)).initialized).toBe(true);
  });
});
