import { Script } from "node:vm";

/** 一次步骤执行的结果（ok + 可审计的说明） */
export interface StepAttempt {
  ok: boolean;
  detail: string;
}

/**
 * 步骤脚本的解析期自检（R58）：只编译、不执行，所以不需要窗口、不需要项目、零耗时。
 *
 * 只挡解析期错误（少括号、脏正则后缀、关键字用错位置）。语义 bug——比如
 * `match(/丢弃 \d+ 条/)[1]` 少了捕获组、或 `\s+` 归一化把要匹配的空格吃掉——
 * 语法完全合法，挡不住，只能靠断言把原始值写进 note 留证。
 */
export function stepBodySyntaxError(step: number, body: string): string | null {
  try {
    new Script(`(async () => {\n${body}\n})()`);
    return null;
  } catch (err) {
    return `step${step} 脚本语法错：${err instanceof Error ? err.message : String(err)}`;
  }
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
