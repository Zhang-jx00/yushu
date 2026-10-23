/* SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it } from "vitest";
import { THEMES, blockBodies, contrast, css, declaredTokens, valueOf } from "./helpers/css-contrast.js";

/**
 * 「当前模式要看得见」门禁（R144）。
 *
 * 起因：R144 把地图面板的五个编辑入口收成了一个分段控件（`map-mode-group`），
 * 口径写着「模式态要看得见（高亮 + aria-pressed），不能只靠按钮文案」。
 * 但**高亮那一半其实没做到**：选中态底色用的是 `--accent-soft`（#f0e2ce），
 * 常态底色是 `--panel`（#fffdf8）—— 实测两者只有 **1.25:1**（浅色档），
 * 暗色 1.16、柔和高对比 1.10、系统高对比浅 1.27、系统高对比暗 1.54。
 * ⇒ **五套主题全部低于 WCAG 1.4.11 的非文本对比度 3:1**，也就是"当前在哪一档"在屏幕上根本分不出来。
 * 截图里五个胶囊按钮长得一模一样，正是这件事的可见后果。
 *
 * ⇒ 改成实心强调底 + 反色字（`--accent` / `--ink-on-accent`），实测底色差 5.72~15.68:1。
 * 这条门禁把两件事钉住：
 * ① **看得见**：选中态底色 vs 常态底色 ≥ **3:1**（WCAG 1.4.11 非文本对比度）；
 * ② **读得清**：选中态文字 vs 选中态底色 ≥ **4.5**（docs/13 §3 的正文级底线）。
 *
 * 三条防自指的自我约束（防"恒绿判据等于没锁"）：
 * ① **不许靠删 CSS 绕过**：两个规则块（常态 / 选中）必须**各存在且各只有一个**，
 *    少一个就红——否则"把 `.is-on` 那条规则删了"就能让门禁变绿。
 * ② **不许靠"文件里出现过某个词"过关**：判据只认**那两个规则块里**声明的
 *    `background` / `color` 令牌 ⇒ 写在别处的同名声明不算数。
 * ③ **不许靠解析器坏掉变绿**：五套主题里两个底色与一个字色都必须解析出具体色值，
 *    解析不出来就红（不猜、不空过）。
 *
 * 判据数据来源：`helpers/css-contrast.ts`（与 `contrast-gate.test.ts` **同一套**解析与算法，
 * 免得两份实现长出两个数）。
 */

/** 常态（未选中的档位按钮） */
const NORMAL_SELECTOR = /\.map-mode-group \.map-mode-btn \{/g;
/** 选中（当前档位） */
const ON_SELECTOR = /\.map-mode-group \.map-mode-btn\.is-on \{/g;

/** 非文本对比度：WCAG 1.4.11 —— 状态/选中这类元素要能被分辨 */
const STATE_FLOOR = 3;
/** 正文级对比度：docs/13 §3 */
const TEXT_FLOOR = 4.5;

const normalBodies = blockBodies(css, NORMAL_SELECTOR);
const onBodies = blockBodies(css, ON_SELECTOR);
const normal = declaredTokens(normalBodies[0] ?? "");
const on = declaredTokens(onBodies[0] ?? "");

describe("分段控件的当前档位要看得见（R144）", () => {
  it("两个规则块都在，且各只有一个（删掉就红，不许靠删 CSS 绕过）", () => {
    expect(normalBodies.length, "常态档位的规则块不是恰好一个（多了会被下面取到别的块，少了说明被删了）").toBe(1);
    expect(onBodies.length, "选中档位的规则块不是恰好一个（`.map-mode-group .map-mode-btn.is-on` 被删或改名了？）").toBe(1);
    expect(normal.background, "常态档位那条规则里没有声明 background").not.toBeNull();
    expect(normal.color, "常态档位那条规则里没有声明 color").not.toBeNull();
    expect(on.background, "选中档位那条规则里没有声明 background").not.toBeNull();
    expect(on.color, "选中档位那条规则里没有声明 color").not.toBeNull();
  });

  for (const [themeName, primitives] of Object.entries(THEMES)) {
    it(`${themeName} 档：选中底 vs 常态底 ≥ ${STATE_FLOOR}，选中字 vs 选中底 ≥ ${TEXT_FLOOR}`, () => {
      const normalBg = valueOf(primitives, normal.background ?? "");
      const onBg = valueOf(primitives, on.background ?? "");
      const onFg = valueOf(primitives, on.color ?? "");
      // 防自指：解析不出来就红，不许空过
      expect(normalBg, `${themeName} 档：常态底色（${normal.background}）没解析出取值`).not.toBeNull();
      expect(onBg, `${themeName} 档：选中底色（${on.background}）没解析出取值`).not.toBeNull();
      expect(onFg, `${themeName} 档：选中字色（${on.color}）没解析出取值`).not.toBeNull();
      if (normalBg === null || onBg === null || onFg === null) return;

      const stateRatio = contrast(onBg, normalBg);
      expect(
        stateRatio,
        `${themeName} 档：当前档位看不出来 —— 选中底 ${onBg} vs 常态底 ${normalBg} = ${stateRatio.toFixed(2)}:1（低于 ${STATE_FLOOR}）`,
      ).toBeGreaterThanOrEqual(STATE_FLOOR);

      const textRatio = contrast(onFg, onBg);
      expect(
        textRatio,
        `${themeName} 档：选中档位的字读不清 —— ${onFg} on ${onBg} = ${textRatio.toFixed(2)}:1（低于 ${TEXT_FLOOR}）`,
      ).toBeGreaterThanOrEqual(TEXT_FLOOR);
    });
  }
});
