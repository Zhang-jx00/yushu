/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **第二个十轮总复核**（R170）：R161–R169 的做法沉淀进 docs/11 §7.52
 * ——这一组判据都在、口径成文，由本文件钉住（R160 给 §7.40 立过同一条锁）。
 *
 * 三个方向都要拦住：
 * ① **十轮口径一节不缺**（§7.41–§7.51 逐节在，节头带各自的轮号；§7.52 成文且带通则）；
 * ② **十轮判据一组不缺**（预演 step153 的回执里写着群巡礼的数 —— 跑过才算）；
 * ③ R161 的口径重核还在（docs/11 §8 的"逐条重核"引言——那是这一组的第一块基石）。
 */

const ROOT = join(__dirname, "..", "..", "..");
const doc = readFileSync(join(ROOT, "docs", "11-UI重构调研与设计规范.md"), "utf8");
const walk = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "walkthrough.ts"), "utf8");
const report = JSON.parse(
  readFileSync(join(ROOT, "docs", "assets", "m1-preview", "walkthrough-report.json"), "utf8"),
) as { steps: Array<{ step: number; ok: boolean; detail: string }> };

/** 逐节头（节号 + 该节自己的措辞——认精确形态，不认"出现过 7.41"这种子串） */
const SECTION_HEADERS = [
  "### 7.41 世界观档案三栏",
  "### 7.42 AI 副驾三栏",
  "### 7.43 三级大纲三栏",
  "### 7.44 编辑器页右栏",
  "### 7.45 标注的批量管理",
  "### 7.46 存稿池",
  "### 7.47 平台规则包",
  "### 7.48 排版巡检的盲区",
  "### 7.49 逐章字数分布",
  "### 7.50 卷章树虚拟滚动",
  "### 7.51 预演卫生",
] as const;

describe("第二个十轮总复核（R170）：R161–R169 的口径与判据成文且都在", () => {
  it("**十轮口径一节不缺**（§7.41–§7.51 逐节在，节头带轮号）", () => {
    const missing = SECTION_HEADERS.filter((header) => !doc.includes(header));
    expect(missing, "docs/11 缺了这些节：" + missing.join("、")).toEqual([]);
    // 每节都带自己的轮号（节头里括注的那一个）——改节名不许把轮号抹掉
    const roundTags: Array<[string, string]> = [
      ["### 7.41", "R162"],
      ["### 7.42", "R163"],
      ["### 7.43", "R164"],
      ["### 7.44", "R165"],
      ["### 7.45", "R171"],
      ["### 7.46", "R174"],
      ["### 7.47", "R177"],
      ["### 7.48", "R166"],
      ["### 7.49", "R167"],
      ["### 7.50", "R168"],
      ["### 7.51", "R169"],
    ];
    const lost = roundTags.filter(([header, tag]) => {
      const idx = doc.indexOf(header);
      return idx < 0 || !doc.slice(idx, idx + 120).includes(tag);
    });
    expect(lost, "这些节的节头丢了轮号：" + lost.map(([h]) => h).join("、")).toEqual([]);
  });

  it("**§7.52 成文**（这一组的总复核节：九轮一句不少 + 通则成文 + R161–R169 全员点名）", () => {
    const idx = doc.indexOf("### 7.52");
    expect(idx, "docs/11 没有 §7.52（第二个十轮总复核）那一节").toBeGreaterThanOrEqual(0);
    const section = doc.slice(idx, doc.indexOf("### 8.", idx));
    // 九轮逐个点名（R170 是本节本身，不计入）
    for (const round of ["R161", "R162", "R163", "R164", "R165", "R166", "R167", "R168", "R169"]) {
      expect(section, `§7.52 的表里没有 ${round}`).toContain(round);
    }
    // 通则成文（§7.40 的续篇：五条，编号仍在）
    expect(section, "§7.52 没有通则块 ⇒ 口径没有落在纸上").toContain("⇒ **通则");
    expect(section, "通则没有接 §7.40（两段通则是连续的五加五）").toContain("接 §7.40 的五条");
  });

  it("**R161 的口径重核还在**（docs/11 §8 的引言——这一组的第一块基石）", () => {
    expect(
      doc,
      "docs/11 §8 的「R161 逐条重核过一遍」引言不见了 ⇒ 状态标记的出处断了",
    ).toContain("R161 逐条重核过一遍");
  });

  it("**预演真的跑了**（认回执 + 认源码两条腿：step153 的群巡礼写着各项的数）", () => {
    // 源码腿：群巡礼的**判定本体**在（认 need/found/miss 的完整记账形态，不认措辞）。
    // 切片边界 = STEPS 数组收尾（step153 是最后一步，"下一个 step"不存在 ⇒ 不能拿它当界）。
    const start = walk.indexOf("step: 153,");
    const arrEnd = walk.indexOf("\n];", start);
    const body = walk.slice(start, arrEnd < 0 ? walk.length : arrEnd);
    expect(body, "没找到 step153 的脚本").not.toBe("");
    expect(body, "群巡礼没有 need 记账（found/miss 两条腿的完整形态）").toContain(
      "const need = (id, ok) => { if (ok) found.push(id); else miss.push(id); };",
    );
    expect(body, "群巡礼没有以 miss.length 判通过").toContain("ok: miss.length === 0");
    // 回执腿：跑过才算（报告里那一步的 detail）
    const step = report.steps.find((row) => row.step === 153);
    expect(step, "报告里没有 step153（十轮群巡礼）那一步").toBeTruthy();
    const detail = (step as { detail: string }).detail;
    expect(detail, "step153 的回执里没有「屏上痕迹」").toContain("屏上痕迹：在=6");
    // 回执只在有缺项时才列出「缺=…」⇒ 断言**不许出现**（出现即红——变异可证：
    // 废掉任一屏上痕迹，群巡礼就在这里翻红）
    expect(detail, "step153 的群巡礼有缺项").not.toContain("缺=");
  });
});
