import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectGateway } from "../src/main/file-gateway.js";
import { gitCommit, gitInit, gitRollback, gitState, GIT_DEFAULT_AUTHOR } from "../src/main/git-ops.js";
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