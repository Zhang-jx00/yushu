import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectWithFs, resolveInsideRoot } from "../src/worker/repo-collect.js";

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