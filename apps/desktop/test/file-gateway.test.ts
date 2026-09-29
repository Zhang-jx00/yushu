import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DocConflictError,
  PathSafetyError,
  ProjectGateway,
  sha256,
} from "../src/main/file-gateway.js";

let dir: string;
let gw: ProjectGateway;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yushu-gw-"));
  gw = new ProjectGateway(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ProjectGateway 读写与并发检测", () => {
  it("新建写入并读回，hash 为内容 sha256", async () => {
    const snap = await gw.writeDoc("world/world.yaml", "apiVersion: yushu.world/v1\n");
    expect(snap.hash).toBe(sha256("apiVersion: yushu.world/v1\n"));
    const read = await gw.readDoc("world/world.yaml");
    expect(read.content).toBe("apiVersion: yushu.world/v1\n");
    expect(read.hash).toBe(snap.hash);
  });

  it("未携带 baseHash 时禁止覆盖已有文件", async () => {
    await gw.writeDoc("a.md", "v1");
    await expect(gw.writeDoc("a.md", "v2")).rejects.toBeInstanceOf(DocConflictError);
  });

  it("baseHash 不匹配时拒绝写入，匹配时成功", async () => {
    const first = await gw.writeDoc("a.md", "v1");
    await expect(gw.writeDoc("a.md", "v2", "deadbeef")).rejects.toBeInstanceOf(DocConflictError);
    const second = await gw.writeDoc("a.md", "v2", first.hash);
    expect(second.hash).toBe(sha256("v2"));
    const read = await gw.readDoc("a.md");
    expect(read.content).toBe("v2");
  });

  it("文件不存在时携带 baseHash 视为冲突", async () => {
    await expect(gw.writeDoc("missing.md", "x", sha256("x"))).rejects.toBeInstanceOf(
      DocConflictError,
    );
  });

  it("路径越界被拒绝（穿越 / 绝对路径 / 引擎目录写入）", async () => {
    await expect(gw.readDoc("../secret.txt")).rejects.toBeInstanceOf(PathSafetyError);
    await expect(gw.writeDoc("/etc/passwd", "x")).rejects.toBeInstanceOf(PathSafetyError);
    await expect(gw.writeDoc("C:/windows/x", "x")).rejects.toBeInstanceOf(PathSafetyError);
    await expect(gw.writeDoc(".yushu/index.db", "x")).rejects.toBeInstanceOf(PathSafetyError);
    await expect(gw.writeDoc("world/node_modules/x", "x")).rejects.toBeInstanceOf(PathSafetyError);
  });

  it("重命名成功；目标已存在时冲突", async () => {
    await gw.writeDoc("a.md", "v1");
    await gw.renameDoc("a.md", "world/cards/character/a.md");
    const read = await gw.readDoc("world/cards/character/a.md");
    expect(read.content).toBe("v1");
    await gw.writeDoc("b.md", "v2");
    await expect(gw.renameDoc("b.md", "world/cards/character/a.md")).rejects.toBeInstanceOf(
      DocConflictError,
    );
  });

  it("目录树排除 .yushu 与 node_modules，按路径排序", async () => {
    await gw.writeDoc("world/world.yaml", "w");
    await gw.writeDoc("chapters/vol1/ch-001.md", "c");
  });
});

describe("ProjectGateway 目录树", () => {
  it("列出项目文件并排除引擎/依赖目录", async () => {
    const { promises: fs } = await import("node:fs");
    await fs.mkdir(join(dir, ".yushu"), { recursive: true });
    await fs.writeFile(join(dir, ".yushu", "index.db"), "x");
    await fs.mkdir(join(dir, "node_modules"), { recursive: true });
    await fs.writeFile(join(dir, "node_modules", "pkg.js"), "x");
    await fs.writeFile(join(dir, "a.tmp"), "x");
    await gw.writeDoc("world/world.yaml", "w");
    await gw.writeDoc("chapters/vol1/ch-001.md", "c");

    const tree = await gw.listTree();
    const paths = tree.map((t) => t.path);
    expect(paths).toEqual([
      "chapters",
      "chapters/vol1",
      "chapters/vol1/ch-001.md",
      "world",
      "world/world.yaml",
    ]);
    expect(tree.find((t) => t.path === "world/world.yaml")?.type).toBe("file");
    expect(tree.find((t) => t.path === "world")?.type).toBe("dir");
  });
});