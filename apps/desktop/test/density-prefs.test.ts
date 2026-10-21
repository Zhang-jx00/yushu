/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENSITY,
  DENSITY_IDS,
  DENSITY_PREF_KEY,
  loadDensityPref,
  readDensityPref,
  saveDensityPref,
} from "../renderer/src/density-prefs.js";

/**
 * 密度档持久化（R117）的单测。
 *
 * 这一轮把 R109 悬着的问题定掉：**界面偏好是用户级的，不进项目真源**。
 * 判据盯三件事：① 只认白名单里的值（存坏了就回落，不猜）；② 缺省是 `cozy`；
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

describe("密度档持久化（R117）", () => {
  it("三档齐备，缺省是 cozy（R109 定过：默认档 = 改版前的样子）", () => {
    expect(DENSITY_IDS).toEqual(["compact", "cozy", "roomy"]);
    expect(DEFAULT_DENSITY).toBe("cozy");
  });

  it("读回白名单里的值；**存坏了 / 乱写的值一律回落 cozy**（不猜）", () => {
    expect(readDensityPref("compact")).toBe("compact");
    expect(readDensityPref("roomy")).toBe("roomy");
    expect(readDensityPref(" cozy ")).toBe("cozy");
    for (const bad of [null, undefined, "", "   ", "huge", "Cozy", "cozy; drop", "1"]) {
      expect(readDensityPref(bad), `存坏了的值 ${JSON.stringify(bad)} 不该被采信`).toBe("cozy");
    }
  });

  it("写进 storage 的值永远合法（白名单外的值拒写）", () => {
    const storage = fakeStorage();
    expect(saveDensityPref(storage, "compact")).toBe(true);
    expect(storage.map.get(DENSITY_PREF_KEY)).toBe("compact");
    expect(saveDensityPref(storage, "nope" as never)).toBe(false);
    expect(storage.map.get(DENSITY_PREF_KEY)).toBe("compact");
  });

  it("跨会话恢复：写进去的档，下一次读回就是它", () => {
    const storage = fakeStorage();
    saveDensityPref(storage, "roomy");
    expect(loadDensityPref(storage)).toBe("roomy");
    // 换一个"新会话"（同一个 storage、重新读一次）
    expect(loadDensityPref(storage)).toBe("roomy");
  });

  it("storage 不可用（隐私模式 / 配额满）⇒ 回落且不抛，不让它把界面搞崩", () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(loadDensityPref(broken)).toBe("cozy");
    expect(saveDensityPref(broken, "compact")).toBe(false);
    expect(loadDensityPref(null)).toBe("cozy");
    expect(saveDensityPref(null, "compact")).toBe(false);
  });

  it("键名带前缀（Electron 里 file:// 的 localStorage 按 origin 共享，不加前缀会撞车）", () => {
    expect(DENSITY_PREF_KEY.startsWith("yushu.")).toBe(true);
  });
});
