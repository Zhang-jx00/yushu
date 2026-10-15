/* SPDX-License-Identifier: Apache-2.0 */

/**
 * 确定性比较器（红线 5：同输入同序，换机器换 locale 不许换序）。
 *
 * 实现取 `<` / `>`，也就是 **UTF-16 码元序**：BMP 之内它与码点序完全一致，
 * 只有涉代理对（emoji 等天文字符）时才有差别——而本项目排序的对象是
 * 章节 id（`ch-*`）、文件路径、设定卡名与关系名，全在 BMP 内。
 * 这与仓库里原有的两份私有副本（`llm/cost.ts` 的 `byCode`、
 * `world-engine/propagate.ts` 的 `byCodePoint`）逐字同序，本模块把它们收成一份。
 *
 * 为什么不用 `String#localeCompare`：它跟着 ICU 数据与运行环境走，
 * 同一份正文在两台机器上可能排出不同的顺序——而顺序会进导出、进索引、进报告，
 * 一旦漂，"删掉索引库结论不变"（A5）这类断言就失去了意义。
 */
export function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
