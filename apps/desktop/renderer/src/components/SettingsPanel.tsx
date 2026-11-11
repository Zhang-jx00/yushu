/* SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useRef } from "react";
import { DENSITIES, type DensityId } from "../density-prefs";
import { THEMES, type ThemeId } from "../theme-prefs";

/**
 * **设置浮层**（R183 · UI Phase 2「设置中心归位」）：主题与密度两项**用户级偏好**
 * 的唯一入口——原先它们是 App 顶栏的两个 `<select>`（R117/R121 时代顶栏还有别的事，
 * 偏好就顺手摆在了那儿）；顶栏回归「项目」语义后，偏好归位到一个**低频、按需唤起**的浮层。
 *
 * 口径：
 * ① **归位不是新造**：状态与持久化仍在 App（`yushu.ui.theme` / `yushu.ui.density`，
 *    R121/R117 的键一个没动）——浮层只是这两个偏好的**新视图**，不是第二份状态；
 * ② **导航折叠不进浮层**：它跟着 rail 走（rail 底部的收起按钮就是它的现场），
 *    浮层里写一句话告诉作者它在哪儿——一个偏好只有一个控件，不摆两份；
 * ③ Esc 关闭（登记进 shortcuts.ts，与命令面板同一条键盘路）；
 *    点遮罩也关（与命令面板同一套浮层交互）。
 * 样式全走令牌（复用 `.command-overlay` 的浮层级阴影 `--elev-overlay`，契约 §4）。
 */
export function SettingsPanel({
  open,
  theme,
  density,
  onTheme,
  onDensity,
  onClose,
}: {
  open: boolean;
  theme: ThemeId;
  density: DensityId;
  onTheme: (theme: ThemeId) => void;
  onDensity: (density: DensityId) => void;
  onClose: () => void;
}) {
  const firstFieldRef = useRef<HTMLSelectElement | null>(null);

  useEffect(() => {
    if (open) {
      // 等 overlay 渲染完再聚焦（第一个字段可直接改 ⇒ 键盘可达前提）
      requestAnimationFrame(() => firstFieldRef.current?.focus());
    }
  }, [open]);

  if (!open) return null;

  return (
    <div className="settings-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="设置"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="settings-title">设置</div>
        <label className="settings-row">
          <span className="settings-label">主题</span>
          <select
            ref={firstFieldRef}
            value={theme}
            aria-label="主题"
            onChange={(event) => onTheme(event.target.value as ThemeId)}
          >
            {THEMES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-row">
          <span className="settings-label">界面密度</span>
          <select
            value={density}
            aria-label="界面密度"
            onChange={(event) => onDensity(event.target.value as DensityId)}
          >
            {DENSITIES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <p className="muted settings-note">
          导航栏的收起 / 展开在左侧导航底部的按钮（Esc 关闭这里）
        </p>
      </div>
    </div>
  );
}
