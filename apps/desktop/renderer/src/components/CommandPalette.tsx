/* SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useMemo, useRef, useState } from "react";

/**
 * **命令面板**（R173-UI）：Ctrl/Cmd+K 唤起，跳转与高频动作的统一入口。
 *
 * 自研轻量实现（不引 cmdk 等依赖）：输入过滤 + ↑↓/Enter/Esc 全键盘操作，
 * 样式全走令牌，浮层阴影只用 `--elev-overlay`（契约 §4：只有浮层允许 overlay 级）。
 *
 * 口径：
 * ① 过滤是**子串匹配**（码点序语义，不用 localeCompare）⇒ 同输入同结果；
 * ② 动作由调用方给（`actions`）——面板自己不认识任何具体页面 ⇒
 *    加动作不改面板（开闭原则）；
 * ③ 关闭后状态清零（下次打开从空查询、第一项开始 ⇒ 可预期）。
 */

export interface CommandAction {
  id: string;
  label: string;
  /** 补充说明（如「跳转」）——可省 */
  hint?: string;
  run: () => void;
}

export function CommandPalette({
  open,
  onClose,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  actions: CommandAction[];
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // 等 overlay 渲染完再聚焦（挂载即聚焦是面板的键盘可达前提）
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (keyword === "") return actions;
    return actions.filter(
      (action) =>
        action.label.toLowerCase().includes(keyword) ||
        (action.hint ?? "").toLowerCase().includes(keyword),
    );
  }, [actions, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  if (!open) return null;

  const run = (index: number) => {
    const action = filtered[index];
    if (!action) return;
    onClose();
    action.run();
  };

  return (
    <div
      className="command-overlay"
      onMouseDown={onClose}
      role="presentation"
    >
      <div
        className="command-panel"
        role="dialog"
        aria-modal="true"
        aria-label="命令面板"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="command-input"
          value={query}
          placeholder="跳转到…（输入以过滤）"
          aria-label="命令面板搜索"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((prev) => Math.min(prev + 1, Math.max(filtered.length - 1, 0)));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((prev) => Math.max(prev - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              run(active);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <ul className="command-list" role="listbox" aria-label="命令列表">
          {filtered.map((action, index) => (
            <li key={action.id} role="option" aria-selected={index === active}>
              <button
                type="button"
                className={"command-item" + (index === active ? " on" : "")}
                onMouseEnter={() => setActive(index)}
                onClick={() => run(index)}
              >
                <span>{action.label}</span>
                {action.hint !== undefined && <span className="command-hint muted">{action.hint}</span>}
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="muted command-empty">没有匹配的命令</li>
          )}
        </ul>
      </div>
    </div>
  );
}
