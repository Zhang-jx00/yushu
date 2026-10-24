/* SPDX-License-Identifier: Apache-2.0 */
import { GLOBAL_SHORTCUT_COUNT, SHORTCUTS, keysLabel } from "./shortcuts";

/**
 * 「键盘在哪」面板（R157）。
 *
 * 作者记不住哪个键在哪儿能按 ⇒ 与其让人猜，不如把**代码里真的绑着的**那些摆出来。
 * 但这份清单**必须是真的**：它从 `shortcuts.ts` 那份登记表渲染，而登记表有判据对着源码
 * **逐处**对账（`apps/desktop/test/shortcuts.test.ts`）⇒ 面板上的条目数与真实绑定数
 * 对不上时当场红 ⇒ **"照抄一份自己想象的清单"过不了关**。
 *
 * 两类**分开摆**（混在一起作者会以为那个键随时都能按）：
 * - **全局**：绑在窗口上，任何时候都能按；
 * - **局部**：焦点在某个东西上（画布 / 输入框 / 某个节点）时才生效。
 */

/** 一条快捷键（一行）：键 / 按了会怎样 / 什么时候能按 */
function ShortcutRow({ entry }: { entry: (typeof SHORTCUTS)[number] }) {
  return (
    <li data-shortcut-row={entry.scope}>
      <span className="shortcut-keys">{keysLabel(entry.keys)}</span>
      <span className="shortcut-action">{entry.action}</span>
      <span className="muted">{entry.when}</span>
    </li>
  );
}

export function ShortcutPanel({ onClose }: { onClose: () => void }) {
  const global = SHORTCUTS.filter((entry) => entry.scope === "global");
  const contextual = SHORTCUTS.filter((entry) => entry.scope === "contextual");
  return (
    <section
      className="shortcut-panel"
      data-shortcut-panel="1"
      data-shortcut-count={SHORTCUTS.length}
      data-shortcut-global-count={GLOBAL_SHORTCUT_COUNT}
    >
      <div className="panel-title">
        <span>
          键盘在哪（共 {SHORTCUTS.length} 条，其中全局 {GLOBAL_SHORTCUT_COUNT} 条）
        </span>
        <button type="button" className="shortcut-close" onClick={onClose}>
          收起
        </button>
      </div>
      <div className="muted">
        这一栏是**从代码里那一份登记表**渲染出来的，不是手写文案 —— 登记表对着源码逐处对账，
        所以「按了没反应」这件事在这儿是可见的：哪一条按不动，就是登记与代码脱节了。
      </div>
      <h3>全局（任何时候都能按）</h3>
      <ul className="shortcut-list">
        {global.map((entry) => (
          <ShortcutRow key={entry.id} entry={entry} />
        ))}
      </ul>
      <h3>局部（焦点在某个东西上时才生效）</h3>
      <ul className="shortcut-list">
        {contextual.map((entry) => (
          <ShortcutRow key={entry.id} entry={entry} />
        ))}
      </ul>
    </section>
  );
}
