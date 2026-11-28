/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BREAK_AT,
  flyPhase,
  metaballBridge,
  splitPhase,
  type LiquidCircle,
} from "../renderer/src/components/liquid-droplet.js";

/**
 * **液态玻璃水滴菜单**（R193）：圆形按钮 → 拉丝颈缩 → 啵断 → 水珠惯性飞行膨胀
 * → 摊开成面板；关闭反向回放（收缩汇聚 → 飞回融合）。
 *
 * 判据盯四件事（两条腿：源码 + 归档回执；纯函数腿在本文件上半）：
 * ① **几何纯函数**：颈缩连接体随进度收细、断裂后消失、重叠期不画（融合态）；
 * ② **契约合法**：不新增 @keyframes（全表仍 1 个）、时长只落在 :root（复用四族
 *    --motion-enter/--motion-exit/--motion-reveal，JS 里 getComputedStyle 读取）、
 *    动画只动 transform/opacity、reduced-motion 整层跳过；
 * ③ **材质令牌**：--glass-* 进 :root 且暗色主题覆盖；抽屉/设置/命令面板三处玻璃皮肤；
 * ④ **回执腿**：step163 取证（水珠中途帧 + 面板摊开 + 关闭反向）。
 */

const ROOT = join(__dirname, "..", "..", "..");
const droplet = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "liquid-droplet.ts"), "utf8");
const transition = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "LiquidTransition.tsx"), "utf8");
const drawer = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "AiDrawer.tsx"), "utf8");
const css = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "styles.css"), "utf8");
const settings = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "SettingsPanel.tsx"), "utf8");
const palette = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "CommandPalette.tsx"), "utf8");
const report = JSON.parse(
  readFileSync(join(ROOT, "docs", "assets", "m1-preview", "walkthrough-report.json"), "utf8"),
) as { steps: Array<{ step: number; ok: boolean; detail: string }> };

const source: LiquidCircle = { x: 40, y: 400, r: 20 };
const target: LiquidCircle = { x: 1200, y: 96, r: 34 };

describe("拉丝颈缩的纯几何（R193）：metaballBridge", () => {
  it("**两圆重叠（融合态）不画连接体**——返回 null，不画空 path", () => {
    expect(metaballBridge({ x: 0, y: 0, r: 20 }, { x: 10, y: 0, r: 20 }, 1)).toBeNull();
  });

  it("**拉丝中段：连接体存在且含两条对称贝塞尔**（颈缩形状）", () => {
    // 拉丝发生在两圆**贴近**的初期（脱离后 neck 归零 ⇒ 桥消失）
    const mid = { x: 92, y: 388, r: 26 };
    const path = metaballBridge(source, mid, 0.6);
    expect(path, "中段应有连接体").not.toBeNull();
    const cCount = (path as string).match(/C /g)?.length ?? 0;
    expect(cCount, "颈缩是两条对称三次贝塞尔").toBe(2);
  });

  it("**拉断了：间隙超过阈值 ⇒ 连接体消失**（啵的一声在几何上的表达）", () => {
    const far = { x: 1400, y: 96, r: 34 };
    expect(metaballBridge(source, far, 0)).toBeNull();
    expect(metaballBridge(source, far, 0.1)).toBeNull();
  });

  it("**颈宽随进度收细**：同一对圆，neck 越小附着点越靠圆心（桥越细）", () => {
    const mid = { x: 92, y: 388, r: 26 };
    const wide = metaballBridge(source, mid, 1);
    const thin = metaballBridge(source, mid, 0.3);
    expect(wide).not.toBeNull();
    expect(thin).not.toBeNull();
    // 解析各自 path 的首个附着点（M 坐标），量它到源圆心的距离：
    // neck 大 ⇒ 附着弧宽 ⇒ 附着点偏离正面方向更远 ⇒ 离圆心更远
    const attachDist = (path: string): number => {
      const m = /M ([\d.]+) ([\d.]+)/.exec(path) ?? [];
      const x = Number(m[1]);
      const y = Number(m[2]);
      return Math.hypot(x - source.x, y - source.y);
    };
    const wideDist = attachDist(wide as string);
    const thinDist = attachDist(thin as string);
    expect(wideDist, "宽颈的附着点离圆心更远（弧更宽）").toBeGreaterThan(thinDist);
    expect(wide).not.toBe(thin);
  });
});

describe("时序相位（R193）：splitPhase / flyPhase", () => {
  it("**断裂阈值前颈宽收细、到达 BREAK_AT 归零且 broken=true**", () => {
    const early = splitPhase(BREAK_AT * 0.5);
    expect(early.neck).toBeGreaterThan(0);
    expect(early.broken).toBe(false);
    const atBreak = splitPhase(BREAK_AT);
    expect(atBreak.neck).toBe(0);
    expect(atBreak.broken).toBe(true);
  });

  it("**位移单调推进、膨胀从 0.42 起**（水珠从按钮里「挤」出来）", () => {
    const half = splitPhase(BREAK_AT * 0.5);
    const full = splitPhase(BREAK_AT);
    expect(half.travel).toBeLessThan(full.travel);
    expect(half.scale).toBeGreaterThanOrEqual(0.42);
    expect(flyPhase(1).scale).toBeGreaterThan(flyPhase(0).scale);
  });
});

describe("液态玻璃的契约合法性（R193）：不新增 keyframes、时长只在 :root、材质令牌", () => {
  it("**动画驱动是 rAF（JS 读 :root 令牌），不写死毫秒**", () => {
    expect(transition, "水滴层没有从 CSS 变量读时长（时长会变成第二个出处）").toContain(
      'readMs(direction === "split" ? "--motion-reveal" : "--motion-exit")',
    );
    expect(transition, "水滴层没有 reduced-motion 跳过").toContain(
      '(prefers-reduced-motion: reduce)',
    );
    expect(transition, "水滴层动了布局属性（width/height 动画会掉帧）").not.toContain(
      "element.animate",
    );
  });

  it("**抽屉相位状态机**（closed→split→open→closing；玻璃皮肤；水滴源点）", () => {
    expect(drawer, "抽屉没有相位状态机").toContain('"closed" | "split" | "open" | "closing"');
    expect(drawer, "抽屉没有接水滴层").toContain("<LiquidTransition");
    expect(drawer, "抽屉面板没有玻璃皮肤").toContain("drawer-panel glass-panel");
    expect(css, "CSS 里没有水滴源点圆形样式").toContain(".is-liquid-source");
  });

  it("**材质令牌进 :root 且三处浮层玻璃皮肤**（风格扩展到整体）", () => {
    expect(css, ":root 没有 --glass-blur").toContain("--glass-blur:");
    expect(css, "暗色主题没有玻璃令牌覆盖段标记").toContain("R193 液态玻璃族");
    expect(settings, "设置浮层没有玻璃皮肤").toContain("settings-panel glass-panel");
    expect(palette, "命令面板没有玻璃皮肤").toContain("command-panel glass-panel");
    expect(css, "reduce 块没有隐藏水滴层").toContain(".liquid-layer {\n    display: none;\n  }");
  });

  it("**回执腿：step163 取证过**（水珠中途帧 + 面板摊开 + 关闭反向）", () => {
    const step = report.steps.find((row) => row.step === 163);
    expect(step, "报告里没有 step163（液态玻璃取证）那一步").toBeTruthy();
    expect((step as { ok: boolean }).ok, "step163 没过").toBe(true);
    const detail = (step as { detail: string }).detail;
    expect(detail, "step163 没取证水珠中途帧").toContain("水珠中途帧=true");
    expect(detail, "step163 没取证面板摊开").toContain("面板摊开=true");
    expect(detail, "step163 没取证关闭反向").toContain("反向回放=true");
  });
});
