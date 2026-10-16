/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { parsePovConfig, serializePovConfig, POV_CONFIG_PATH } from "../src/pov-config.js";
import { checkPovConsistency, POV_CHECK_ORIGIN, POV_RULE_IDS, type PovChapterRow } from "../src/pov-check.js";

/**
 * 视角（POV）声明与可判定检查（M4 / T4-2 第三批，R102）。
 *
 * 判据出处 docs/research/F-叙事与故事构建/F04-视角与人称.md §3.1/§3.2/§3.6 与 §5 的 L1–L5，
 * 但**本轮只落可判定的那部分**（声明层 + 悬空 + 白名单 + 切换预算）。
 * L1"场景内 ≥2 个角色内心直写"靠标记词表猜，本仓库的口径是**不靠关键词猜**（R74 的裁决），
 * 那条留给下一轮配合既有的 AI 采样核验机制一起做——所以这里不假装它能用。
 *
 * 一条贯穿的口径：**没声明就不判**。`pov.yaml` 缺省 ⇒ 只报"策略未声明"这一条 info，
 * 不拿"多数网文是三限"当默认去给每个作者发一堆假警告（误报的代价是作者学会忽略整块看板）。
 */

const YAML = [
  "mode: third_limited",
  "distance: 贴近",
  "default_pov: char-linyuan",
  "allowed_povs:",
  "  - char-linyuan",
  "  - char-xiu",
  "switch_policy:",
  "  granularity: scene",
  "  min_gap_chapters: 2",
  "  signal_required: true",
  "exemptions:",
  "  - {scope: chapter, id: ch-000000, reason: 楔子用全知}",
].join("\n");

function chapter(pov: string, id = "ch-a", idx = 1): PovChapterRow {
  return { chapterId: id, path: `chapters/vol-1/${id}.md`, title: `第${idx}章`, idx, pov };
}

describe("pov.yaml 严格解析", () => {
  it("路径常量与配置字段逐字对上（文件放在 config/ 下，与豁免清单/阈值同一族）", () => {
    expect(POV_CONFIG_PATH).toBe("config/pov.yaml");
  });

  it("不存在的文件 ⇒ null（不是空配置、也不是报错）", () => {
    expect(parsePovConfig("")).toBeNull();
  });

  it("完整配置能读回来，字段一个都不掉", () => {
    const parsed = parsePovConfig(YAML);
    expect(parsed).not.toBeNull();
    expect(parsed?.mode).toBe("third_limited");
    expect(parsed?.allowed_povs).toEqual(["char-linyuan", "char-xiu"]);
    expect(parsed?.switch_policy?.min_gap_chapters).toBe(2);
    expect(parsed?.switch_policy?.signal_required).toBe(true);
    expect(parsed?.exemptions?.[0]?.reason).toBe("楔子用全知");
  });

  it("序列化往返逐字稳定（真源写回不该每次换个样子）", () => {
    const parsed = parsePovConfig(YAML);
    expect(parsed).not.toBeNull();
    const once = serializePovConfig(parsed!);
    expect(parsePovConfig(once)).toEqual(parsed);
    expect(serializePovConfig(parsePovConfig(once)!)).toBe(once);
  });

  it("未知键 ⇒ 读错并点名（悄悄忽略的字段比报错危险）", () => {
    expect(() => parsePovConfig("mode: third_limited\npolicy: loose")).toThrow(/policy/);
  });

  it("mode 不在五种里 ⇒ 读错并列出允许值（不猜作者想写什么）", () => {
    expect(() => parsePovConfig("mode: 全知")).toThrow(/third_omniscient/);
  });

  it("min_gap_chapters 不是非负整数 ⇒ 读错（切换预算的阈值不能是字符串或负数）", () => {
    expect(() => parsePovConfig("mode: third_limited\nswitch_policy:\n  min_gap_chapters: 两章")).toThrow(/min_gap_chapters/);
    expect(() => parsePovConfig("mode: third_limited\nswitch_policy:\n  min_gap_chapters: -1")).toThrow(/min_gap_chapters/);
  });
});

describe("视角检查：只判能判的", () => {
  it("策略未声明 ⇒ 只报一条 info 总述，不给每章发警告", () => {
    const rows = checkPovConsistency({
      chapters: [chapter(""), chapter("", "ch-b", 2)],
      characterIds: ["char-linyuan"],
      config: null,
    });
    expect(rows.map((row) => [row.rule, row.severity])).toEqual([["pov-policy-undeclared", "info"]]);
    // 关键是这句：没核对过 ≠ 没问题
    expect(rows[0]?.message).toContain("不等于");
    expect(rows[0]?.origin).toBe(POV_CHECK_ORIGIN);
  });

  it("三限模式下章没写视角 ⇒ 逐章 warn（豁免清单里的章除外）", () => {
    const config = parsePovConfig(YAML)!;
    const rows = checkPovConsistency({
      chapters: [chapter("", "ch-000000", 1), chapter("", "ch-b", 2), chapter("char-xiu", "ch-c", 3)],
      characterIds: ["char-linyuan", "char-xiu"],
      config,
    });
    expect(rows.filter((row) => row.rule === "pov-missing").map((row) => row.subject)).toEqual(["ch-b"]);
    expect(rows.filter((row) => row.rule === "pov-missing")).toHaveLength(1);
  });

  it("写了不存在的角色 ⇒ 悬空引用 warn（与 refs 悬空同一族）", () => {
    const rows = checkPovConsistency({
      chapters: [chapter("char-ghost")],
      characterIds: ["char-linyuan"],
      config: parsePovConfig(YAML),
    });
    expect(rows.filter((row) => row.rule === "pov-unknown").map((row) => row.message)).toEqual([
      expect.stringContaining("char-ghost"),
    ]);
  });

  it("在白名单外的角色 ⇒ pov-not-allowed，白名单为空时不判", () => {
    const config = parsePovConfig(YAML)!;
    const restricted = checkPovConsistency({
      chapters: [chapter("char-other")],
      characterIds: ["char-linyuan", "char-xiu", "char-other"],
      config,
    });
    expect(restricted.map((row) => row.rule)).toContain("pov-not-allowed");
    const open = checkPovConsistency({
      chapters: [chapter("char-other")],
      characterIds: ["char-linyuan", "char-other"],
      config: { ...config, allowed_povs: [] },
    });
    expect(open.map((row) => row.rule)).not.toContain("pov-not-allowed");
  });

  it("切换预算：同一角色隔得比 min_gap 还近 ⇒ 提示；宽松档降一级", () => {
    const config = parsePovConfig(YAML)!; // min_gap_chapters = 2 ⇒ 第1章与第2章同视角违规
    const chapters = [chapter("char-linyuan", "ch-a", 1), chapter("char-linyuan", "ch-b", 2)];
    const strict = checkPovConsistency({ chapters, characterIds: ["char-linyuan"], config, strict: true });
    const gap = strict.filter((row) => row.rule === "pov-switch-gap");
    expect(gap.map((row) => row.severity)).toEqual(["warn"]);
    expect(gap[0]?.message).toContain("char-linyuan");
    const loose = checkPovConsistency({ chapters, characterIds: ["char-linyuan"], config, strict: false });
    expect(loose.filter((row) => row.rule === "pov-switch-gap").map((row) => row.severity)).toEqual(["info"]);
  });

  it("间隔够就不报（判据要能绿）", () => {
    const config = parsePovConfig(YAML)!;
    const rows = checkPovConsistency({
      chapters: [
        chapter("char-linyuan", "ch-a", 1),
        chapter("char-xiu", "ch-b", 2),
        chapter("char-linyuan", "ch-c", 3),
      ],
      characterIds: ["char-linyuan", "char-xiu"],
      config,
    });
    expect(rows).toEqual([]);
  });

  it("全知 / 第一人称模式下不要求逐章绑定视角", () => {
    const omni = checkPovConsistency({
      chapters: [chapter("")],
      characterIds: [],
      config: { mode: "third_omniscient" },
    });
    expect(omni.map((row) => row.rule)).not.toContain("pov-missing");
    const first = checkPovConsistency({
      chapters: [chapter("")],
      characterIds: [],
      config: { mode: "first" },
    });
    expect(first.map((row) => row.rule)).not.toContain("pov-missing");
  });

  it("结论顺序只由章序决定（打乱输入 ⇒ 同样顺序，红线 5）", () => {
    const config = parsePovConfig(YAML)!;
    // 章 id 故意取 ch-z / ch-a：码点序与章序相反，实现若按 id 排序而不是按 idx 就会被这条抓到
    const chapters = [chapter("", "ch-a", 2), chapter("char-ghost", "ch-z", 1)];
    const forward = checkPovConsistency({ chapters, characterIds: ["char-linyuan"], config });
    const reversed = checkPovConsistency({ chapters: [...chapters].reverse(), characterIds: ["char-linyuan"], config });
    expect(reversed.map((row) => `${row.rule}:${row.subject}`)).toEqual(
      forward.map((row) => `${row.rule}:${row.subject}`),
    );
    // 顺序按 idx（章序），不是按数组里谁在前，也不是按 id 的码点
    expect(forward.map((row) => row.subject)).toEqual(["ch-z", "ch-a"]);
  });

  it("规则 id 清单与实际产出一致（新增一条就要在这里现身）", () => {
    // 三种触发各占一章：查不到角色 / 角色存在但不在白名单 / 干脆没写。
    // 「查不到角色」不再顺带报「不在白名单」：一章只有一个根因，两条红字会把作者引向错的修法。
    const rows = checkPovConsistency({
      chapters: [
        chapter("char-ghost", "ch-a", 1),
        chapter("char-other", "ch-b", 2),
        chapter("", "ch-c", 3),
      ],
      characterIds: ["char-linyuan", "char-other"],
      config: parsePovConfig(YAML),
    });
    const produced = [...new Set(rows.map((row) => row.rule))].sort();
    expect(produced).toEqual(["pov-missing", "pov-not-allowed", "pov-unknown"]);
    expect([...POV_RULE_IDS].sort()).toEqual(
      ["pov-missing", "pov-not-allowed", "pov-policy-undeclared", "pov-switch-gap", "pov-unknown"].sort(),
    );
  });
});
