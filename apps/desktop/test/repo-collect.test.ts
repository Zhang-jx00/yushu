import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectWithFs, incrementalWithFs, resolveInsideRoot } from "../src/worker/repo-collect.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-repo-collect-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 }).catch(() => undefined);
});

describe("utilityProcess 仓库解析（T2-11 切片 A）", () => {
  it("resolveInsideRoot：root 内放行；../ 与绝对路径逃逸拒绝（防御纵深）", () => {
    expect(resolveInsideRoot(dir, "world/world.yaml")).toBe(join(dir, "world", "world.yaml"));
    expect(() => resolveInsideRoot(dir, "../outside.md")).toThrow(/越界/);
    expect(() => resolveInsideRoot(dir, join(tmpdir(), "outside.md"))).toThrow(/越界/);
  });

  it("collectWithFs：读取文件产出索引输入；进按可索引文件推进；读取失败单文件跳过", async () => {
    await mkdir(join(dir, "world"), { recursive: true });
    await writeFile(join(dir, "world", "world.yaml"), "title: 天启界\n", "utf8");
    await writeFile(join(dir, "README.txt"), "hello\n", "utf8");
    await writeFile(join(dir, "cover.png"), "binary", "utf8");

    const files = [
      { path: "world/world.yaml", size: 14, mtime: "2026-10-05T00:00:00.000Z" },
      { path: "README.txt", size: 6 },
      { path: "cover.png", size: 6 },
      { path: "missing.md", size: 3 },
    ];
    const progress: { done: number; total: number }[] = [];
    const input = await collectWithFs(dir, files, (done, total) => progress.push({ done, total }));

    // .png 不在索引白名单：不读取、不产出；missing.md 读取失败进 skipped
    expect(input.files.map((file) => file.path)).toEqual(["README.txt", "world/world.yaml"]);
    expect(input.skipped.map((item) => item.path)).toEqual(["missing.md"]);
    expect(progress).toEqual([
      { done: 1, total: 3 },
      { done: 2, total: 3 },
    ]);
  });

  it("collectWithFs：越界文件读取被拒绝并记入 skipped（不阻断整体）", async () => {
    await writeFile(join(dir, "ok.txt"), "ok\n", "utf8");
    const input = await collectWithFs(dir, [
      { path: "ok.txt", size: 3 },
      { path: "../escape.txt", size: 1 },
    ]);
    expect(input.files.map((file) => file.path)).toEqual(["ok.txt"]);
    expect(input.skipped.map((item) => item.path)).toEqual(["../escape.txt"]);
    expect(input.skipped[0]!.error).toContain("越界");
  });
});

describe("utilityProcess 增量解析（T2-11 切片 B）", () => {
  it("incrementalWithFs：复用未变文件、定向解析新增、移除已删；越界读取被拒绝", async () => {
    await mkdir(join(dir, "world"), { recursive: true });
    const yamlText = "title: 天启界\n";
    await writeFile(join(dir, "world", "world.yaml"), yamlText, "utf8");
    await writeFile(join(dir, "README.txt"), "hello\n", "utf8");

    const files = [
      { path: "world/world.yaml", size: 14, mtime: "2026-01-01T00:00:00.000Z" },
      { path: "README.txt", size: 6, mtime: "2026-01-01T00:00:00.000Z" },
      { path: "../escape.txt", size: 1, mtime: "2026-01-01T00:00:00.000Z" },
    ];
    const prev = [
      { path: "world/world.yaml", mtime: "2026-01-01T00:00:00.000Z", hash: sha(yamlText), bytes: 14 },
      { path: "gone.md", mtime: "2026-01-01T00:00:00.000Z", hash: sha("gone"), bytes: 4 },
    ];
    const progress: { done: number; total: number; currentPath: string }[] = [];
    const delta = await incrementalWithFs(dir, files, prev, "2026-02-01T00:00:00.000Z", (done, total, currentPath) =>
      progress.push({ done, total, currentPath }),
    );

    // world.yaml 快速跳过不读；README.txt 与越界文件新增 → 定向解析（越界进 skipped）
    expect(delta.removedPaths).toEqual(["gone.md"]);
    expect(delta.updatedFiles).toBe(2);
    expect(delta.reusedFiles).toBe(1);
    expect(delta.removedFiles).toBe(1);
    expect(delta.input?.files.map((file) => file.path)).toEqual(["README.txt"]);
    expect(delta.input?.skipped.map((item) => item.path)).toEqual(["../escape.txt"]);
    expect(delta.input?.skipped[0]!.error).toContain("越界");
    // 进度只统计成功读取（README 一次；world.yaml 不读，escape 读取被拒绝）
    expect(progress).toEqual([{ done: 1, total: 3, currentPath: "README.txt" }]);
  });

  it("incrementalWithFs：改动 → hash 确认后变更；mtime 变但内容同 → touch（不重解析）", async () => {
    await writeFile(join(dir, "modify.txt"), "v2\n", "utf8");
    await writeFile(join(dir, "touch.txt"), "same\n", "utf8");
    const builtAt = "2026-03-01T00:00:00.000Z";
    const files = [
      { path: "modify.txt", size: 3, mtime: builtAt }, // racy → hash 确认 → 变更
      { path: "touch.txt", size: 5, mtime: "2026-04-01T00:00:00.000Z" }, // mtime 变 → hash 相同 → touch
    ];
    const prev = [
      { path: "modify.txt", mtime: builtAt, hash: sha("v1\n"), bytes: 3 },
      { path: "touch.txt", mtime: "2026-01-01T00:00:00.000Z", hash: sha("same\n"), bytes: 5 },
    ];
    const delta = await incrementalWithFs(dir, files, prev, builtAt);

    expect(delta.updatedFiles).toBe(1);
    expect(delta.input?.files.map((file) => file.path)).toEqual(["modify.txt"]);
    expect(delta.touchedFiles.map((file) => file.path)).toEqual(["touch.txt"]);
    expect(delta.reusedFiles).toBe(1); // touch 计入复用
    expect(delta.removedPaths).toEqual([]);
  });
});