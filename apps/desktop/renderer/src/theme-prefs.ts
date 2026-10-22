/* SPDX-License-Identifier: Apache-2.0 */

/**
 * 主题档（浅色 / 深色）的**持久化偏好**（R121）。
 *
 * 放在 `localStorage` 而不是项目真源，理由与密度档（R117）**同一条**：
 * **界面偏好是这个人的阅读偏好，不是这个项目的内容**——
 * 它跟着人走（换台机器打开同一个项目，你想要的还是深色），
 * 而且不写进项目真源 ⇒ 导出 / 迁移 / 打包时不会把界面偏好混进作者的作品里。
 *
 * 两条纪律：
 * ① **只认白名单里的值**：存坏了、被人手改过、旧版本留下的值 ⇒ 一律回落到 `light`，
 *    绝不把一个来路不明的值塞进 `data-theme`（那会让半张界面没有底色）。
 * ② **键名带前缀**：Electron 里 `file://` 的 localStorage 是按 origin 共享的，
 *    不加前缀会和别的应用撞车。
 *
 * **它只决定"用哪一套 primitive"**：暗色那套色值在 CSS 里（`:root[data-theme="dark"]`），
 * 这里是"选哪一套"——两者分开，改色板的人不必碰这里，改这里的人不必碰色板。
 */

/** 三档主题（id 与 `data-theme` 的取值一致；label 是界面文案）——**唯一来源** */
export const THEMES = [
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
  // R129：深色档下的**柔和高对比**（docs/13 §6 明写没做的那条）——
  // 系统「高对比度」在深色下是纯黑底 + 纯白字（拉到两头），夜里看久了晃眼；
  // 这一档**按纸墨底调**：底还是那张暗纸，字是暖白，描边加重 ⇒ 依然是高对比，但不刺眼。
  { id: "dark-soft", label: "深色·柔和高对比" },
] as const;

export type ThemeId = (typeof THEMES)[number]["id"];

/** 白名单（由 THEMES 派生 ⇒ 不会与界面那份说法分叉） */
export const THEME_IDS: readonly ThemeId[] = THEMES.map((item) => item.id);

/** 缺省档：`light`（R116 定过：默认色板一个像素都没动，浅色就是改版前的样子） */
export const DEFAULT_THEME: ThemeId = "light";

/** localStorage 的键（带前缀，避开同 origin 的其它应用） */
export const THEME_PREF_KEY = "yushu.ui.theme";

/**
 * 读回一个主题档：只认白名单里的值，其余（含 null / 空串 / 乱写的值）一律回落 `light`。
 *
 * 为什么不"尽量猜"：存坏了就回落，是**可预期的**；猜出一个作者没选过的主题，
 * 才是真正让他找不到原因的那种坑（"界面怎么变成深的了？"）。
 */
export function readThemePref(raw: string | null | undefined): ThemeId {
  if (raw === null || raw === undefined) return DEFAULT_THEME;
  const trimmed = raw.trim();
  return (THEME_IDS as readonly string[]).includes(trimmed) ? (trimmed as ThemeId) : DEFAULT_THEME;
}

/** 取当前存着的主题档（读 storage；读不到就回落） */
export function loadThemePref(storage: { getItem(key: string): string | null } | null | undefined): ThemeId {
  if (storage === null || storage === undefined) return DEFAULT_THEME;
  try {
    return readThemePref(storage.getItem(THEME_PREF_KEY));
  } catch {
    // storage 被禁（隐私模式 / 配额满）⇒ 回落，不让它把界面搞崩
    return DEFAULT_THEME;
  }
}

/** 存一档主题（只存白名单里的值；存失败不抛——偏好存不下不该挡住界面） */
export function saveThemePref(
  storage: { setItem(key: string, value: string): void } | null | undefined,
  id: ThemeId,
): boolean {
  if (storage === null || storage === undefined) return false;
  if (!(THEME_IDS as readonly string[]).includes(id)) return false;
  try {
    storage.setItem(THEME_PREF_KEY, id);
    return true;
  } catch {
    return false;
  }
}
