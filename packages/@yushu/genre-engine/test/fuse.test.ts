import { describe, expect, it } from "vitest";
import { fuse } from "@yushu/genre-engine";
import { makePack } from "./pack.test.js";

describe("fuse 融合预演", () => {
  it("空选择给出 error 冲突且未就绪", () => {
    const report = fuse([]);
    expect(report.ready).toBe(false);
    expect(report.conflicts[0]?.kind).toBe("empty-selection");
  });

  it("四维并集去重且保留顺序", () => {
    const a = makePack();
    const b = makePack();
    b.manifest.metadata.id = "test-pack-b";
    b.manifest.genre_axes = {
      channel: ["男频"],
      world: ["玄幻", "仙侠"],
      technique: ["系统流", "凡人流"],
      tone: ["爽文", "热血"],
    };
    const report = fuse([a, b]);
    expect(report.ready).toBe(true);
    expect(report.genre_axes.channel).toEqual(["男频"]);
    expect(report.genre_axes.world).toEqual(["玄幻", "仙侠"]);
    expect(report.genre_axes.technique).toEqual(["系统流", "凡人流"]);
    expect(report.genre_axes.tone).toEqual(["爽文", "热血"]);
  });

  it("显式互斥声明被识别为 error 冲突", () => {
    const a = makePack();
    const b = makePack();
    b.manifest.metadata.id = "guiju-guaitan";
    b.manifest.fusions = {
      conflicts_with: [{ pack: "test-pack", reason: "规则解谜节奏与战力爽点节拍冲突" }],
    };
    const report = fuse([a, b]);
    expect(report.ready).toBe(false);
    const conflict = report.conflicts.find((c) => c.kind === "pack-explicit-conflict");
    expect(conflict?.severity).toBe("error");
    expect(conflict?.message).toContain("规则解谜节奏");
  });

  it("感情线形态不一致给出 warn 冲突但不阻断", () => {
    const a = makePack();
    a.manifest.genre_axes.romance_mode_default = "无女主";
    const b = makePack();
    b.manifest.metadata.id = "test-pack-b";
    b.manifest.genre_axes.romance_mode_default = "单CP";
    const report = fuse([a, b]);
    expect(report.ready).toBe(true);
    expect(report.conflicts.some((c) => c.kind === "romance-mode-conflict")).toBe(true);
  });

  it("同名元素进入 overridden 并给出暂定胜出者", () => {
    const a = makePack();
    a.resolvedFiles = { rules: ["C:/fake/test-pack/rules/shared.yaml"] };
    const b = makePack();
    b.manifest.metadata.id = "test-pack-b";
    b.dir = "C:/fake/test-pack-b";
    b.resolvedFiles = { rules: ["C:/fake/test-pack-b/rules/shared.yaml"] };
    const report = fuse([a, b]);
    expect(report.overridden).toHaveLength(1);
    expect(report.overridden[0]?.winner).toBe("test-pack-b");
    expect(report.conflicts.some((c) => c.kind === "piece-name-collision")).toBe(true);
  });

  it("added 汇总各包全部件套条目", () => {
    const a = makePack();
    a.resolvedFiles = {
      rules: ["C:/fake/test-pack/rules/a.yaml", "C:/fake/test-pack/rules/b.yaml"],
      glossary: ["C:/fake/test-pack/glossary.yaml"],
    };
    const report = fuse([a]);
    expect(report.added).toHaveLength(3);
    expect(report.added.map((x) => x.ref)).toContain("rules/a.yaml");
  });
});