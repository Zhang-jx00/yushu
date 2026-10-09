import { describe, expect, it } from "vitest";
import { summarizeAttempts, type StepAttempt } from "../src/main/walkthrough-attempts.js";

/**
 * 预演步骤重试的汇总口径（R55）。
 *
 * 登记在 docs/06 §七 的遗留：step17（本地快照列表）与 step21（富文本 @ 菜单高亮）偶发失败、
 * 根因未定。之前的处置是"重跑一次取好看的"，那等于把抖动洗成"一次通过"。
 * 现在改成**最多重试一次并把抖动如实记进报告**，这里钉住三件事：
 * ① 一次过的步骤不得被标成 flaky（否则 flaky 名单失去意义）；
 * ② 重试后才过的必须同时 `ok:true` 与 `flaky:true`，且第一次的失败说明留在 detail 里（可审计）；
 * ③ 两次都失败就是失败，不许被"重试过"洗绿。
 */

const A = (ok: boolean, detail: string): StepAttempt => ({ ok, detail });

describe("预演步骤重试汇总", () => {
  it("一次通过不算抖动，detail 原样", () => {
    expect(summarizeAttempts([A(true, "快照列表 3 条")])).toEqual({ ok: true, flaky: false, detail: "快照列表 3 条" });
  });

  it("重试后通过标为抖动，并保留第一次的失败说明", () => {
    const r = summarizeAttempts([A(false, "未找到 .snapshot-row"), A(true, "快照列表 3 条")]);
    expect(r.ok).toBe(true);
    expect(r.flaky).toBe(true);
    expect(r.detail).toContain("重试后通过");
    expect(r.detail).toContain("未找到 .snapshot-row");
    expect(r.detail).toContain("快照列表 3 条");
  });

  it("两次都失败仍是失败，两次说明都在", () => {
    const r = summarizeAttempts([A(false, "第一次的原因"), A(false, "第二次的原因")]);
    expect(r.ok).toBe(false);
    expect(r.flaky).toBe(false);
    expect(r.detail).toContain("第一次的原因");
    expect(r.detail).toContain("第二次的原因");
  });

  it("只跑了一次且失败：不标抖动、不编造第二次", () => {
    const r = summarizeAttempts([A(false, "脚本异常：x")]);
    expect(r).toEqual({ ok: false, flaky: false, detail: "脚本异常：x" });
  });

  it("没有执行记录时不算通过（fail-safe：没跑过就没有证据）", () => {
    const r = summarizeAttempts([]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("无执行记录");
  });
});
