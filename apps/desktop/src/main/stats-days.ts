/* SPDX-License-Identifier: Apache-2.0 */

/**
 * 码字统计的**日期算术**（R158：从 `stats-ops.ts` 里搬出来，给 `stats-pace.ts` 共用）。
 *
 * 为什么搬：右栏那一列要的是「最近 30 天」的**逐日序列**，而补齐这 30 天就得有日期平移；
 * 主进程算窗口 ⇒ 算窗口的日期算术也得在主进程 ⇒ 它得住在一处，不能两处各写一份
 * （同一份算术写两遍，漂移是时间问题）。
 * 留在 `stats-ops.ts` 里的话，`stats-pace.ts` 就得反向导入它 ⇒ 两个模块互相依赖。
 * 搬成一份，两边都从这儿取 ⇒ **日期算术只有一份**。
 */

/** 本地时区日期键（YYYY-MM-DD） */
export function localDateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 两日期键之间的整天差（to - from；按 UTC 解析避免夏令时误差） */
export function diffDays(from: string, to: string): number {
  const parse = (key: string) => Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, Number(key.slice(8, 10)));
  return Math.round((parse(to) - parse(from)) / 86_400_000);
}

/** 日期键平移 N 天（UTC 算术，跨月 / 跨年安全） */
export function shiftDateKey(key: string, deltaDays: number): string {
  const parse = (k: string) => Date.UTC(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
  const shifted = new Date(parse(key) + deltaDays * 86_400_000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}
