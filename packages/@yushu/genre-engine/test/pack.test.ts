import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PACK_API_VERSION,
  lintPack,
  loadPack,
  type GenrePackManifest,
  type LoadedPack,
} from "@yushu/genre-engine";

const builtinDir = fileURLToPath(
  new URL("../../../../packs/xuanhuan-xitong", import.meta.url),
);

export function makePack(overrides: Partial<GenrePackManifest> = {}): LoadedPack {
  const manifest: GenrePackManifest = {
    apiVersion: PACK_API_VERSION,
    kind: "GenrePack",
    metadata: {
      id: "test-pack",
      name: "测试包",
      version: "1.0.0",
      license: "CC0-1.0",
      requires: { yushu: ">=0.1.0" },
    },
    genre_axes: { channel: ["男频"], world: ["玄幻"], technique: ["系统流"], tone: ["爽文"] },
    content: {
      world_preset: "presets/world.yaml",
      schema_extensions: ["schemas/a.yaml"],
      rules: ["rules/a.yaml"],
      beat_sheets: ["beats/a.yaml"],
      satisfaction_patterns: ["patterns/a.yaml"],
      prompt_templates: ["prompts/a.yaml"],
      glossary: "glossary.yaml",
      taboos: "taboos.yaml",
      outline_templates: ["outlines/a.yaml"],
      evolution: { origin_work: "《示例》", era: 2020, chain: ["开山：《示例》"] },
      platform_mapping: "mappings.yaml",
    },
    ...overrides,
  };
  return { dir: "C:/fake/test-pack", manifest, resolvedFiles: {}, missingFiles: [] };
}

describe("loadPack（内置派系包）", () => {
  it("加载成功且无缺失文件", () => {
    const pack = loadPack(builtinDir);
    expect(pack.manifest.metadata.id).toBe("xuanhuan-xitong");
    expect(pack.manifest.genre_axes.world).toContain("玄幻");
    expect(pack.missingFiles).toEqual([]);
  });

  it("11 件套文件全部解析到绝对路径", () => {
    const pack = loadPack(builtinDir);
    expect(pack.resolvedFiles.schema_extensions).toHaveLength(2);
    expect(pack.resolvedFiles.rules).toHaveLength(2);
    expect(pack.resolvedFiles.outline_templates).toHaveLength(1);
    expect(pack.resolvedFiles.platform_mapping).toHaveLength(1);
  });
});

describe("lintPack", () => {
  it("内置派系包 lint 通过（无 error）", () => {
    const report = lintPack(loadPack(builtinDir));
    expect(report.ok).toBe(true);
    expect(report.issues.filter((i) => i.severity === "error")).toEqual([]);
  });

  it("词表外取值被打回", () => {
    const pack = makePack();
    pack.manifest.genre_axes.world = ["克苏鲁流"];
    const report = lintPack(pack);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.rule === "pack-wordlist-drift")).toBe(true);
  });

  it("channel 为空被打回（多维多选但仍须非空）", () => {
    const pack = makePack();
    pack.manifest.genre_axes.channel = [];
    const report = lintPack(pack);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.rule === "pack-genre-axes")).toBe(true);
  });

  it("缺 11 件套被打回", () => {
    const pack = makePack();
    delete (pack.manifest.content as Record<string, unknown>)["taboos"];
    const report = lintPack(pack);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.rule === "pack-eleven-piece")).toBe(true);
  });

  it("非法版本号 / 非法 id 被打回", () => {
    const pack = makePack();
    pack.manifest.metadata.version = "1.0";
    pack.manifest.metadata.id = "Bad_ID";
    const report = lintPack(pack);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.rule === "pack-version-semver")).toBe(true);
    expect(report.issues.some((i) => i.rule === "pack-id-namespace")).toBe(true);
  });

  it("引用文件缺失被打回", () => {
    const pack = makePack();
    pack.missingFiles = ["rules/missing.yaml"];
    const report = lintPack(pack);
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.rule === "pack-file-missing")).toBe(true);
  });
});