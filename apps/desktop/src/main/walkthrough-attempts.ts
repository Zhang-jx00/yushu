/** 一次步骤执行的结果（ok + 可审计的说明） */
export interface StepAttempt {
  ok: boolean;
  detail: string;
}

/** 单个步骤最多执行几次（1 次正常 + 1 次重试）。再多就是"重跑到好看"，不是可审计的重试。 */
export const MAX_STEP_ATTEMPTS = 2;

/**
 * 步骤重试的汇总口径（R55，收口 docs/06 §七「预演偶发抖动」）。
 *
 * 为什么要显式记 flaky：step17 / step21 偶发失败、根因未定，而"重跑一次取好看的"
 * 会把抖动洗成一次通过，下轮就没人知道它抖过。这里把重试**结果**如实标出来——
 * 抖动通过仍是通过（退出码 0），但报告里有名单，文档里就不许再声称一次过。
 */
export function summarizeAttempts(attempts: readonly StepAttempt[]): { ok: boolean; flaky: boolean; detail: string } {
  const first = attempts.at(0) ?? { ok: false, detail: "(无执行记录)" };
  if (attempts.length <= 1) return { ok: first.ok, flaky: false, detail: first.detail };
  const last = attempts.at(-1) ?? first;
  if (first.ok) return { ok: true, flaky: false, detail: first.detail };
  if (last.ok) return { ok: true, flaky: true, detail: `重试后通过（第 1 次：${first.detail}）｜ ${last.detail}` };
  return { ok: false, flaky: false, detail: `两次均未过（第 1 次：${first.detail}）｜ ${last.detail}` };
}
