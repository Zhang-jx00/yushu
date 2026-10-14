/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { summarizeRendererBoot, type RendererTimingRaw } from "../src/main/perf-boot.js";

/**
 * 渲染层启动耗时的归一（R83）。
 *
 * 为什么要这个函数：本轮要回答"1.5 MB 的单包要不要按标签页拆"。这个问题不能靠感觉答，
 * 需要把"模块解析 + 执行"从"冷启动到可编辑"里单独拎出来看——
 * Chromium 的 Performance API 正好给得出来：
 *   `navigation.domContentLoadedEventStart − responseEnd` ≈ 首屏那批 `<script>` 的执行耗时
 *   （我们的包是 `type=module`，DCL 必等它执行完），
 *   `paint['first-contentful-paint']` = 首次有内容的绘制。
 * 主进程拿到的是原始对象，**这里只做算术与"取不到怎么办"的裁决**（纯函数、可单测）。
 *
 * 三条口径要钉住：
 * ① 取不到 navigation 条目 ⇒ `null` + 原因，**不猜 0**（0 会被门禁当成"飞快"）；
 * ② 负数 / 非有限值 ⇒ 同样 `null`（时钟或实现异常时宁可没测到）；
 * ③ 两项各自独立：有 FCP 不代表有 navigation 条目，反之亦然。
 */

const base: RendererTimingRaw = {
  hasNavigation: true,
  responseEnd: 120,
  domContentLoadedStart: 640,
  firstPaint: 500,
  firstContentfulPaint: 610,
};

describe("渲染层启动耗时归一（R83：模块执行与首绘分开看）", () => {
  it("正常情形：模块执行 = DCL 起点 − responseEnd，FCP 原样带出", () => {
    expect(summarizeRendererBoot(base)).toEqual({
      module_exec_ms: 520,
      fcp_ms: 610,
      notes: [],
    });
  });

  it("没有 navigation 条目 ⇒ module_exec_ms 为 null 并写明原因（不猜 0）", () => {
    const result = summarizeRendererBoot({ ...base, hasNavigation: false });
    expect(result.module_exec_ms).toBeNull();
    expect(result.notes.join(" ")).toContain("navigation");
    // FCP 与它是两件事：条目缺失不该把另一项也判成没测到
    expect(result.fcp_ms).toBe(610);
  });

  it("paint 条目缺失 ⇒ fcp_ms 为 null 并写明原因，模块执行照常", () => {
    const result = summarizeRendererBoot({ ...base, firstContentfulPaint: null });
    expect(result.fcp_ms).toBeNull();
    expect(result.notes.join(" ")).toContain("first-contentful-paint");
    expect(result.module_exec_ms).toBe(520);
  });

  it("算出负数（时钟回拨 / 实现异常）⇒ 判为没测到，不给出负的耗时", () => {
    const result = summarizeRendererBoot({ ...base, domContentLoadedStart: 80 });
    expect(result.module_exec_ms).toBeNull();
    expect(result.notes.join(" ")).toContain("非正");
  });

  it("非有限值（NaN / Infinity）同样判为没测到", () => {
    const result = summarizeRendererBoot({ ...base, firstContentfulPaint: Number.NaN });
    expect(result.fcp_ms).toBeNull();
    expect(result.notes.length).toBe(1);
  });

  it("两个原因同时存在时两条都列（清单要能逐条核对，不合并成一句）", () => {
    const result = summarizeRendererBoot({
      ...base,
      hasNavigation: false,
      firstContentfulPaint: null,
    });
    expect(result.module_exec_ms).toBeNull();
    expect(result.fcp_ms).toBeNull();
    expect(result.notes.length).toBe(2);
  });
});
