/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME,
  THEME_IDS,
  THEME_PREF_KEY,
  loadThemePref,
  readThemePref,
  saveThemePref,
} from "../renderer/src/theme-prefs.js";

/**
 * 主题档持久化（R121）的单测。
 *
 * 判据盯三件事（与密度档 R117 同一条口径）：
 * ① **只认白名单里的值**（存坏了就回落，不猜）——猜出一个作者没选过的主题，
 *    才是真正让他找不到原因的那种坑；
 * ② 缺省是 `light`（默认色板一个像素都没动，浅色 = 改版前的样子）；
 * ③ 存盘失败不炸界面（偏好存不下不该挡住作者干活）。
 */

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}

describe("主题档持久化（R121；R129 加了「深色·柔和高对比」第三档）", () => {
  it("三档齐备，缺省是 light（默认色板一个像素都没动）", () => {
    expect(THEME_IDS).toEqual(["light", "dark", "dark-soft"]);
    expect(DEFAULT_THEME).toBe("light");
  });

  it("读回白名单里的值；**存坏了 / 乱写的值一律回落 light**（不猜）", () => {
    expect(readThemePref("light")).toBe("light");
    expect(readThemePref("dark")).toBe("dark");
    expect(readThemePref(" dark ")).toBe("dark");
    // R129：第三档也在白名单里（它是"用户显式选的"⇒ 不许被当成乱写的值回落掉）
    expect(readThemePref("dark-soft")).toBe("dark-soft");
    expect(readThemePref(" dark-soft ")).toBe("dark-soft");
    expect(readThemePref("neon")).toBe("light");
    expect(readThemePref("")).toBe("light");
    expect(readThemePref(null)).toBe("light");
    expect(readThemePref(undefined)).toBe("light");
  });

  it("键名带前缀（Electron 的 file:// localStorage 按 origin 共享，不带前缀会撞车）", () => {
    expect(THEME_PREF_KEY).toBe("yushu.ui.theme");
  });

  it("存取往返：存进去再读回来就是那一档", () => {
    const storage = fakeStorage();
    expect(saveThemePref(storage, "dark")).toBe(true);
    expect(storage.map.get(THEME_PREF_KEY)).toBe("dark");
    expect(loadThemePref(storage)).toBe("dark");
  });

  it("白名单之外的值**不许存**（别把来路不明的值写进偏好）", () => {
    const storage = fakeStorage();
    expect(saveThemePref(storage, "neon" as never)).toBe(false);
    expect(storage.map.size).toBe(0);
  });

  it("storage 不可用（隐私模式 / 配额满）⇒ 回落且不抛（偏好存不下不该挡住界面）", () => {
    const broken = {
      getItem: () => {
        throw new Error("SecurityError");
      },
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
    };
    expect(loadThemePref(broken)).toBe("light");
    expect(saveThemePref(broken, "dark")).toBe(false);
    expect(loadThemePref(null)).toBe("light");
    expect(saveThemePref(null, "dark")).toBe(false);
  });
});
