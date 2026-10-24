/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import type { ExportRunResult } from "../src/shared/ipc.js";
import {
  EMPTY_EXPORT_NOTE,
  exportArtifactDir,
  summarizeExportArtifacts,
} from "../renderer/src/components/export-artifacts.js";

/**
 * 导出产物的**纯函数**判据（R156）。
 *
 * 右栏那一栏（最近一次导出与产物清单）的每一个数都必须从**同一份导出结果载荷**现算：
 * 写死一个字面量、或另取一份数，都会在这一组用例里当场红。
 */

function makeResult(overrides: Partial<ExportRunResult> = {}): ExportRunResult {
  return {
    path: "exports/天启界-20261024-1612.txt",
    hash: "abc123",
    chapters: 3,
    words: 4321,
    clean: true,
    format: "txt",
    ...overrides,
  };
}

describe("导出产物清单（R156）：右栏的数都从同一份载荷现算", () => {
  it("没导出过时**如实说「还没有导出过」**（不许装成有）", () => {
    const summary = summarizeExportArtifacts(null);
    expect(summary.hasExport).toBe(false);
    expect(summary.emptyNote).toBe("还没有导出过");
    expect(EMPTY_EXPORT_NOTE).toBe("还没有导出过");
    // 一个数都不许给：没导出过就没有产物可报
    expect(summary.path).toBe("");
    expect(summary.chapters).toBe(0);
    expect(summary.words).toBe(0);
    expect(summary.artifacts).toEqual([]);
    expect(summary.hasDirectory).toBe(false);
  });

  it("路径 / 章数 / 字数 / 格式**逐字取自载荷**（不许写死）", () => {
    const summary = summarizeExportArtifacts(makeResult());
    expect(summary.hasExport).toBe(true);
    expect(summary.path).toBe("exports/天启界-20261024-1612.txt");
    expect(summary.chapters).toBe(3);
    expect(summary.words).toBe(4321);
    expect(summary.format).toBe("TXT");
    expect(summary.hash).toBe("abc123");
  });

  it("换个载荷就换一套数（写死字面量的话这里必红）", () => {
    const summary = summarizeExportArtifacts(
      makeResult({ path: "exports/别的书.txt", chapters: 7, words: 12345, format: "epub" }),
    );
    expect(summary.path).toBe("exports/别的书.txt");
    expect(summary.chapters).toBe(7);
    expect(summary.words).toBe(12345);
    expect(summary.format).toBe("EPUB");
  });

  it("产物清单分清**目录与文件**（作者要知道去哪儿找产物）", () => {
    const summary = summarizeExportArtifacts(makeResult());
    expect(summary.dir).toBe("exports");
    expect(summary.hasDirectory).toBe(true);
    expect(summary.artifacts.map((item) => item.kind)).toEqual(["目录", "文件"]);
    expect(summary.artifacts[0]?.path).toBe("exports");
    expect(summary.artifacts[1]?.path).toBe("exports/天启界-20261024-1612.txt");
  });

  it("没有目录层级时**目录就是空串**（不许瞎编一个目录）", () => {
    expect(exportArtifactDir("x.txt")).toBe("");
    expect(exportArtifactDir("exports/x.txt")).toBe("exports");
    const summary = summarizeExportArtifacts(makeResult({ path: "x.txt" }));
    expect(summary.dir).toBe("");
    expect(summary.hasDirectory).toBe(false);
    expect(summary.artifacts.map((item) => item.kind)).toEqual(["文件"]);
  });

  it("非 TXT 格式**多一件源稿**（pandoc 的中间稿也是产物）", () => {
    const summary = summarizeExportArtifacts(
      makeResult({ format: "epub", sourcePath: "exports/天启界-20261024-1612.md" }),
    );
    expect(summary.sourcePath).toBe("exports/天启界-20261024-1612.md");
    expect(summary.artifacts.map((item) => item.kind)).toEqual(["目录", "文件", "文件"]);
    expect(summary.artifacts[2]?.path).toBe("exports/天启界-20261024-1612.md");
  });

  it("敏感词结论**照回执的 clean 说**（不许自己乐观）", () => {
    expect(summarizeExportArtifacts(makeResult({ clean: true })).sensitive).toContain("无 error 级");
    expect(summarizeExportArtifacts(makeResult({ clean: false })).sensitive).toContain("仍有 error 级");
  });
});
