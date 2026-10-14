/* SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useId, useState } from "react";

/**
 * 展开 / 收起（R63 交互精修）：**按真实内容高度连续过渡**，不猜 max-height。
 *
 * 为什么不用原生 `<details>`：它只有"在 / 不在"两态，内容瞬间出现，眼睛跟不上"这块是从哪长出来的"。
 * 为什么不用 `max-height: 2000px`：过渡时长实际作用在 2000px 上，视觉上就是"先卡一下再动"，
 *   内容超过猜测值还会被裁掉。
 *
 * 这里用 `grid-template-rows: 0fr → 1fr`：由浏览器按子元素的**真实高度**插值，
 * 内容变多变少都跟得上，不需要 JS 量高度（量了反而是第二个真相源，异步内容一改就飘）。
 * 箭头转 180° 与面板同源；`aria-expanded` / `aria-controls` 同步；
 * `prefers-reduced-motion` 下由 CSS 直接把过渡时长归零（组件不关心动效开关，职责单一）。
 */
export function Disclosure({
  label,
  children,
  defaultOpen = false,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const toggleId = `disclosure-toggle-${useId()}`;
  const panelId = `disclosure-panel-${useId()}`;

  return (
    <div className={"disclosure" + (open ? " open" : "") + (className ? " " + className : "")}>
      <button
        type="button"
        id={toggleId}
        className="disclosure-toggle"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={toggle}
      >
        <svg className="disclosure-caret" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
          <path
            d="M4 6l4 4 4-4"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span>{label}</span>
      </button>
      <div id={panelId} className="disclosure-panel" role="region" aria-labelledby={toggleId}>
        <div className="disclosure-body">{children}</div>
      </div>
    </div>
  );
}
