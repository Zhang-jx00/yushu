/* SPDX-License-Identifier: Apache-2.0 */
/**
 * 渲染层启动耗时归一（R83；纯函数，主进程侧只做算术）。
 *
 * 背景：本轮要回答"1.5 MB 的单包要不要按标签页拆"。这个问题不能凭感觉答，
 * 得把**模块解析 + 执行**从"冷启动到可编辑"里单独拎出来看。Chromium 的 Performance API
 * 正好给得出来：
 * - `navigation.domContentLoadedEventStart − responseEnd` ≈ 首屏那批 `<script>` 的执行耗时
 *   （我们的包是 `type=module`，DCL 必须等它执行完）；
 * - `paint['first-contentful-paint']` = 首次有内容的绘制（用户眼里的"出来了"）。
 *
 * 三条口径：① 取不到条目 ⇒ `null` + 原因，**不猜 0**（0 会被门禁读成"飞快"）；
 * ② 非有限值或算出非正数 ⇒ 同样判为没测到；③ 两项各自独立，一个缺失不牵连另一个。
 */

export interface RendererTimingRaw {
  /** 渲染层有没有 navigation 计时条目 */
  hasNavigation: boolean;
  /** navigation.responseEnd（毫秒，相对导航起点） */
  responseEnd: number;
  /** navigation.domContentLoadedEventStart */
  domContentLoadedStart: number;
  /** paint['first-paint']，没有则 null */
  firstPaint: number | null;
  /** paint['first-contentful-paint']，没有则 null */
  firstContentfulPaint: number | null;
}

export interface RendererBootSummary {
  /** 首屏脚本"解析 + 执行"耗时；没测到为 null */
  module_exec_ms: number | null;
  /** 首次内容绘制；没测到为 null */
  fcp_ms: number | null;
  /** 没测到 / 不可信的原因清单（逐条列，不合并成一句） */
  notes: string[];
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

export function summarizeRendererBoot(raw: RendererTimingRaw): RendererBootSummary {
  const notes: string[] = [];

  let moduleExecMs: number | null = null;
  if (!raw.hasNavigation) {
    notes.push("navigation 计时条目缺失 ⇒ module_exec_ms 未测（不猜 0）");
  } else if (!isFiniteNumber(raw.responseEnd) || !isFiniteNumber(raw.domContentLoadedStart)) {
    notes.push("navigation 端点非有限值 ⇒ module_exec_ms 未测");
  } else {
    const delta = Math.round(raw.domContentLoadedStart - raw.responseEnd);
    if (delta > 0) {
      moduleExecMs = delta;
    } else {
      notes.push(`navigation 算出非正耗时（${String(delta)}ms）⇒ module_exec_ms 未测`);
    }
  }

  let fcpMs: number | null = null;
  if (raw.firstContentfulPaint === null) {
    notes.push("first-contentful-paint 条目缺失 ⇒ fcp_ms 未测");
  } else if (!isFiniteNumber(raw.firstContentfulPaint)) {
    notes.push("first-contentful-paint 非有限值 ⇒ fcp_ms 未测");
  } else if (raw.firstContentfulPaint <= 0) {
    notes.push(`first-contentful-paint 非正（${String(raw.firstContentfulPaint)}）⇒ fcp_ms 未测`);
  } else {
    fcpMs = Math.round(raw.firstContentfulPaint);
  }

  return { module_exec_ms: moduleExecMs, fcp_ms: fcpMs, notes };
}
