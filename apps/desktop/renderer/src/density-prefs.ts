/* SPDX-License-Identifier: Apache-2.0 */

/**
 * 界面密度档的**持久化偏好**（R117）。
 *
 * 放在 `localStorage` 而不是项目真源，理由是产品决策不是技术偷懒：
 * **密度档是"这个人的阅读偏好"，不是"这个项目的内容"**。
 * 它跟着人走（换台机器打开同一个项目，你想要的还是那档密度），
 * 而且**不写进项目真源** ⇒ 导出 / 迁移 / 打包时不会把界面偏好混进作者的作品里。
 * R109 当时明写"密度档的持久化还没定论（界面偏好算不算项目内容）"——这一轮把它定掉。
 *
 * 两条纪律：
 * ① **只认白名单里的值**：存坏了、被人手改过、旧版本留下的值 ⇒ 一律回落到 `cozy`，
 *    绝不把一个来路不明的值塞进 `data-density`（那会让整张表的字号全乱）。
 * ② **键名带前缀**：Electron 里 `file://` 的 localStorage 是按 origin 共享的，
 *    不加前缀会和别的应用撞车。
 */

/** 三档密度（id 与 `data-density` 的取值一致；label 是界面文案）——**唯一来源** */
export const DENSITIES = [
  { id: "compact", label: "紧凑" },
  { id: "cozy", label: "标准" },
  { id: "roomy", label: "宽松" },
] as const;

export type DensityId = (typeof DENSITIES)[number]["id"];

/** 白名单（由 DENSITIES 派生 ⇒ 不会与界面那份说法分叉） */
export const DENSITY_IDS: readonly DensityId[] = DENSITIES.map((item) => item.id);

/** 缺省档：`cozy`（R109 定过：默认档的取值 = 改版前的样子） */
export const DEFAULT_DENSITY: DensityId = "cozy";

/** localStorage 的键（带前缀，避开同 origin 的其它应用） */
export const DENSITY_PREF_KEY = "yushu.ui.density";

/**
 * 读回一个密度档：只认白名单里的值，其余（含 null / 空串 / 乱写的值）一律回落 `cozy`。
 *
 * 为什么不"尽量猜"：存坏了就回落，是**可预期的**；猜出一个作者没选过的档，
 * 才是真正让他找不到原因的那种坑。
 */
export function readDensityPref(raw: string | null | undefined): DensityId {
  if (raw === null || raw === undefined) return DEFAULT_DENSITY;
  const trimmed = raw.trim();
  return (DENSITY_IDS as readonly string[]).includes(trimmed) ? (trimmed as DensityId) : DEFAULT_DENSITY;
}

/** 取当前存着的密度档（读 storage；读不到就回落） */
export function loadDensityPref(storage: { getItem(key: string): string | null } | null | undefined): DensityId {
  if (storage === null || storage === undefined) return DEFAULT_DENSITY;
  try {
    return readDensityPref(storage.getItem(DENSITY_PREF_KEY));
  } catch {
    // storage 被禁（隐私模式 / 配额满）⇒ 回落，不让它把界面搞崩
    return DEFAULT_DENSITY;
  }
}

/** 存一档密度（只存白名单里的值；存失败不抛——偏好存不下不该挡住界面） */
export function saveDensityPref(
  storage: { setItem(key: string, value: string): void } | null | undefined,
  id: DensityId,
): boolean {
  if (storage === null || storage === undefined) return false;
  if (!(DENSITY_IDS as readonly string[]).includes(id)) return false;
  try {
    storage.setItem(DENSITY_PREF_KEY, id);
    return true;
  } catch {
    return false;
  }
}
