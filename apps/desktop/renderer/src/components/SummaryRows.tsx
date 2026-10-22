/* SPDX-License-Identifier: Apache-2.0 */
import type { SummaryRow } from "../../../src/shared/ipc";

/**
 * 面板汇总的**结构化键值行**（R126）。
 *
 * 为什么要有它：各面板的汇总原先都是**一长串自由文本**
 * （"13 个实体 · 4 条引用行 → 1 条边；全图；悬空引用 3 条未成边"），
 * 在窄栏里会折成三四行、读起来像碎片；更要紧的是——**切出来的"项"会丢掉句子里的限定词**
 * （"读到 3 个爽点 · 3 条承诺"切成两项后，前一项的"读到"就管不到后一项了）
 * ⇒ 所以结构**由后端给**（载荷里带 `summary`），界面只负责排版，不切字符串。
 *
 * 行不是"标签：值"挤在一行，而是**标签一列、值一列**（`grid-template-columns`）⇒
 * 值再长也不会把标签挤歪，多行值也只在值那一列折行。
 *
 * **行类型只有一个来源**（`src/shared/ipc.ts` 的 `SummaryRow`）⇒ 后端载荷与界面组件
 * 不会各写一份、慢慢长歪。
 */
export type { SummaryRow };

export function SummaryRows(props: { rows: SummaryRow[]; className?: string }) {
  if (props.rows.length === 0) return null;
  return (
    <dl className={"summary-rows" + (props.className === undefined ? "" : " " + props.className)}>
      {props.rows.map((row, index) => (
        <div className="summary-row" key={row.label + ":" + String(index)}>
          <dt>{row.label}</dt>
          <dd className={row.tone === "warn" ? "summary-warn" : undefined}>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}
