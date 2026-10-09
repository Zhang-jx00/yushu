/**
 * e2e 断言的具名清单（R55）。
 *
 * 名字直接用表达式原文：e2e 失败时窗口已经关了，能留下的只有 stdout 里这一行，
 * "哪条没成立"必须当场可读——否则只能拿绿跑和红跑两份结果 JSON 逐项 diff。
 */
export type E2eAssertion = readonly [name: string, passed: boolean];

/** 未满足项的名字，顺序与声明顺序一致 */
export function unmetAssertions(pairs: readonly E2eAssertion[]): string[] {
  return pairs.filter(([, passed]) => !passed).map(([name]) => name);
}
