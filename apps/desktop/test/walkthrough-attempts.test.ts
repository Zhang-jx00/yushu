import { describe, expect, it } from "vitest";
import { stepBodySyntaxError, summarizeAttempts, type StepAttempt } from "../src/main/walkthrough-attempts.js";

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

/**
 * 步骤脚本的语法自检（R58）。
 *
 * 起因很实在：step44 的三个 bug（少一个 `)`、正则写成 `/.../\.`、`\s+` 归一化把空格吃掉）
 * 每个都要跑满一整轮 70 秒预演才暴露出来，而它们全是**纯解析期**错误——根本不需要窗口、
 * 不需要项目、不需要等 DOM。开跑前把每段脚本按真实包装器解析一遍，就能把它们挡在 0 秒处。
 *
 * 边界说清楚：自检只挡解析期错误。`match(/丢弃 \d+ 条/)[1]`（少了捕获组）语法完全合法，
 * 运行期返回 undefined，这类只能靠断言里把原始值打出来（note 里就是 `-1`）事后看。
 */
describe("预演步骤脚本语法自检", () => {
  it("合法脚本返回 null（不误伤）", () => {
    expect(stepBodySyntaxError(1, "await tab('规则'); return { ok: true, note: '行' };")).toBeNull();
  });

  it("少一个右括号：点名步骤号，不等 70 秒预演才发现", () => {
    const msg = stepBodySyntaxError(44, "const i = (a ?? -1;");
    expect(msg).not.toBeNull();
    expect(msg).toContain("step44");
  });

  it("正则后面跟脏字符（/.../\\.）也是解析期错误", () => {
    expect(stepBodySyntaxError(44, "const re = /已核验 \\d+ 段/\\.;")).not.toBeNull();
  });

  it("async 包装外的 await 不会误判成语法错（脚本体本来就在 async 里）", () => {
    expect(stepBodySyntaxError(43, "const v = await waitFor(() => 1, 100); return { ok: v === 1, note: '' };")).toBeNull();
  });
});
