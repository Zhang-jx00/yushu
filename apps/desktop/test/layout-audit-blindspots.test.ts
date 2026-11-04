/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **巡检补盲区**（R166）：step88 的排版巡检补两项 —— 字号与行高 / 命中区。
 *
 * 上一版半成品的教训（b087ba6 撤掉的那 53 行）：`fontIssues` / `hitSamples` 采到了
 * 却**从不接进判定、也从不写进回执** —— 那等于"假装查过"，宁可没有。
 * 所以本文件的判据盯三条，两条腿走路（回执 + 源码，同 R159 的形态）：
 *
 * ① **两项各自的数出现在回执里**（认归档报告那一行的 detail —— 源码写了不算，跑过才算）；
 * ② **两项接进了判定**（认源码：`fontIssues` / `hitFloorIssues` 必须 push 进 `problems`，
 *    否则"采了不报"又回来了）；
 * ③ **阈值走共享前置段的常量**（`HIT_FLOOR` / `HIT_MIN`），不许散成步骤里的魔数 ——
 *    命中区是**两层口径**：底线 24px（WCAG 2.5.8 AA）接判定，目标 32px（R110 的治理目标）
 *    只报数 —— v417 实测 467 个 button 落在 24~32px 区间，那是整套按钮基调的事，
 *    硬接判定等于这一轮重做按钮体系；拆成"底线拦门禁、目标报数"才既诚实又可治理。
 */

const ROOT = join(__dirname, "..", "..", "..");
const walk = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "walkthrough.ts"), "utf8");
const report = JSON.parse(
  readFileSync(join(ROOT, "docs", "assets", "m1-preview", "walkthrough-report.json"), "utf8"),
) as { steps: Array<{ step: number; title: string; ok: boolean; detail: string }> };

/** 取某一步的脚本体（认位置：step N 与 step N+1 之间那一段） */
const stepBody = (step: number): string => {
  const start = walk.indexOf("step: " + String(step) + ",");
  if (start < 0) return "";
  const end = walk.indexOf("step: " + String(step + 1) + ",", start);
  return walk.slice(start, end < 0 ? walk.length : end);
};

describe("巡检补盲区（R166）：字号行高 / 命中区", () => {
  it("**两项各自的数出现在 step88 的回执里**（认归档报告的 detail，跑过才算）", () => {
    const audit = report.steps.find((row) => row.step === 88);
    expect(audit, "报告里没有 step88（排版巡检）那一步").toBeTruthy();
    const detail = (audit as { detail: string }).detail;
    // 回执里出现**两项自己的数**——不是只并进「问题=N」三个字（那三个字什么都说了又什么都没说）
    expect(
      detail,
      "step88 的回执里没有「字号行高违规=N 处」⇒ 这项巡检没在跑（源码写了不算，跑过才算）",
    ).toContain("字号行高违规=");
    expect(
      detail,
      "step88 的回执里没有「命中区底线违规=N 处」⇒ 底线那层没在跑（源码写了不算，跑过才算）",
    ).toContain("命中区底线违规=");
    expect(
      detail,
      "step88 的回执里没有「命中区距 32px 目标=N 处」⇒ 目标那层的数没报（治理没数可照）",
    ).toContain("命中区距 32px 目标=");
    expect(
      detail,
      "step88 的回执里没有「豁免族（essential，报数治理）=N 处」⇒ 豁免的没有单独报数（豁免不等于藏起来）",
    ).toContain("豁免族（essential，报数治理）=");
    // 两项都量了**真实的数**（「量了 N 个控件」的 N 必须 > 0：零命中不冒充巡检过，
    // 这是本文件防"解析器坏掉假装全绿"的绝对下限）
    const hitTotal = /命中区距 32px 目标=\d+ 处（量了 (\d+) 个控件/.exec(detail);
    expect(hitTotal, "回执里解析不出「量了 N 个控件」").not.toBeNull();
    expect(Number(hitTotal?.[1]), "命中区一项量到的控件数为 0 ⇒ 量法坏了（零命中不冒充巡检过）").toBeGreaterThan(0);
  });

  it("**两项接进了判定**（认源码：采到了就要报，不许再犯「采到了却不报」）", () => {
    const audit = stepBody(88);
    expect(audit, "没找到 step88 的脚本").not.toBe("");
    // 两项的采集必须在，且**接进了 problems**（判定用 problems，不接进去 = 白采）
    expect(audit, "step88 里没有 fontIssues 的采集").toContain("fontIssues.push(");
    expect(audit, "step88 里没有命中区底线的采集").toContain("hitFloorIssues.push(");
    expect(
      audit,
      "step88 采了 fontIssues 却没接进 problems —— 又是「采到了却不报」（b087ba6 撤掉的那版的病）",
    ).toContain("problems.push(...fontIssues");
    expect(
      audit,
      "step88 采了 hitFloorIssues 却没接进 problems —— 同上",
    ).toContain("problems.push(...fontIssues, ...hitFloorIssues)");
  });

  it("**阈值走共享前置段的常量，量法认精确形态**（不许散成魔数）", () => {
    const audit = stepBody(88);
    // 底线认 HIT_FLOOR（共享前置段 = 24，WCAG 2.5.8），目标认 HIT_MIN（= 32）。
    // 认**用法**（minSide < HIT_FLOOR 的比较本身），不认"出现过"——变异实测：注释里提到
    // 常量名也能把"出现过"喂绿（§8.2 形态 #1 的自反例，变异当场抓到后改的）。
    expect(
      audit,
      "step88 的命中区判据没用共享常量 HIT_FLOOR 做比较 ⇒ 阈值散成魔数，与共享前置段会漂",
    ).toContain("minSide < HIT_FLOOR");
    expect(audit, "step88 没用 HIT_MIN 比较目标线 ⇒ 32px 那层的数没法报").toContain("minSide < HIT_MIN");
    // 量法认**精确形态**：min(width, height) 才是"最小边长"，只量 width 或只量 height 都会漏
    expect(audit, "命中区没按「最小边长」量（Math.min(width, height)）").toContain("Math.min(box.width, box.height)");
    // 同档判据认**双向**偏差（|h3 - 标题条| —— 只查"小了"会漏掉改版前那种"层级反了"的老病）
    expect(audit, "同档判据不是双向的（要用 Math.abs 比偏差）").toContain("Math.abs(hSize - tSize)");
  });
});
