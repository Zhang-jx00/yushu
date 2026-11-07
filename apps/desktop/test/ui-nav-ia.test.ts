/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **导航信息架构**（R173-UI Phase 1）：11 个平级 tab 收敛为**五域分组导航 rail**
 * （创作 / 世界 / AI / 质检与发布 / 文件）+ **命令面板**（Ctrl/Cmd+K）。
 *
 * 判据盯五件事（两条腿：源码 + 归档回执）：
 * ① **五域分组在**（每组的项目与旧 TABS 逐字一致——改 label = 预演 131 步翻红）；
 * ② **11 个 `.tab` 全部在 rail 里**（总数对账——一个都不许丢）；
 * ③ **rail 折叠持久化**（读 localStorage 的 `yushu.ui.rail`——状态要跨会话）；
 * ④ **命令面板**：组件存在（动作由调用方给 ⇒ 加动作不改面板）、全局键登记进 shortcuts、
 *    回执里 Ctrl+K 打开 + 过滤 + Esc 关闭都有取证；
 * ⑤ **上下文栏**在（页名 + 命令面板入口 + 快捷键入口）。
 */

const ROOT = join(__dirname, "..", "..", "..");
const screen = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "views", "ProjectScreen.tsx"), "utf8");
const palette = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "CommandPalette.tsx"), "utf8");
const shortcutsSrc = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "shortcuts.ts"), "utf8");
const report = JSON.parse(
  readFileSync(join(ROOT, "docs", "assets", "m1-preview", "walkthrough-report.json"), "utf8"),
) as { steps: Array<{ step: number; ok: boolean; detail: string }> };

/** 五域分组：域 id → 域内的页面 key（与旧 TABS 的 key 逐字一致） */
const DOMAINS_EXPECTED: Array<{ id: string; label: string; keys: string[] }> = [
  { id: "create", label: "创作域", keys: ["editor", "outline", "library"] },
  { id: "world", label: "世界域", keys: ["workbench", "archive"] },
  { id: "ai", label: "AI 域", keys: ["ai", "memory"] },
  { id: "review", label: "质检与发布", keys: ["rules", "export", "stats"] },
  { id: "files", label: "文件域", keys: ["files"] },
];

/** 旧 TABS 的 11 个 key（一个都不许丢） */
const ALL_KEYS = DOMAINS_EXPECTED.flatMap((domain) => domain.keys);

describe("导航信息架构（R173-UI Phase 1）：五域分组 rail + 命令面板", () => {
  it("**五域分组在 ProjectScreen 里成文**（域 id / 域名 / 域内页面逐项对账）", () => {
    for (const domain of DOMAINS_EXPECTED) {
      const domainStart = screen.indexOf(`id: "${domain.id}"`);
      expect(domainStart, `导航里没有 ${domain.id} 域`).toBeGreaterThanOrEqual(0);
      const segment = screen.slice(domainStart, domainStart + 400);
      expect(segment, `${domain.label} 的域名不见了`).toContain(`label: "${domain.label}"`);
      for (const key of domain.keys) {
        expect(segment, `${domain.label} 里缺页面 ${key}`).toContain(`key: "${key}"`);
      }
    }
  });

  it("**11 个页面一个不丢**（rail 从 DOMAINS 渲染，行上带 data-nav-key 对账锚点）", () => {
    const navStart = screen.indexOf('className={"tabs"');
    expect(navStart, "rail 的导航容器（.tabs）不在了").toBeGreaterThanOrEqual(0);
    const navSegment = screen.slice(navStart, screen.indexOf('"project-main"', navStart));
    // rail 的渲染走 DOMAINS.map（不是另一份手写清单 ⇒ 两份清单会漂）
    expect(navSegment, "rail 没有从 DOMAINS 渲染").toContain("DOMAINS.map((domain) =>");
    expect(navSegment, "导航行上没有 data-nav-key 对账锚点").toContain('data-nav-key={item.key}');
    // 摊平后的 NAV_ITEMS 是唯一来源（命令面板的动作集与当前页名都从它取）
    expect(screen, "NAV_ITEMS 不从 DOMAINS 摊平 ⇒ 两份清单会漂").toContain(
      "const NAV_ITEMS = DOMAINS.flatMap((domain) => domain.items);",
    );
  });

  it("**rail 折叠持久化**（读写 localStorage 的 yushu.ui.rail——状态要跨会话）", () => {
    expect(screen, "折叠状态没有读写 localStorage").toContain('localStorage.getItem("yushu.ui.rail")');
    expect(screen, "折叠状态没有写回 localStorage").toContain('localStorage.setItem("yushu.ui.rail"');
    expect(screen, "折叠态没有挂到 rail 的类名上（.nav-collapsed）").toContain(
      'navCollapsed ? " nav-collapsed" : ""',
    );
  });

  it("**命令面板**（组件存在 + 动作由调用方给 + 全局键登记 + 回执取证）", () => {
    // 组件的两条口径：过滤是子串匹配；动作由调用方给（面板自己不认识任何页面）
    expect(palette, "面板不是按子串过滤（码点序口径）").toContain('action.label.toLowerCase().includes(keyword)');
    expect(palette, "面板自己认识具体页面了 ⇒ 加动作要改面板（开闭原则破了）").not.toContain("setTab");
    // 全局键登记（shortcuts.ts 的 probe 必须在 handler 里真实存在）
    expect(
      screen,
      "Ctrl+K 的判定不在 ProjectScreen 里（登记表认领的 probe 找不到）",
    ).toContain('if (event.key === "k") {');
    expect(shortcutsSrc, "登记表里没有 command-palette 条目").toContain('id: "command-palette"');
    // 回执腿：跑过才算
    const step = report.steps.find((row) => row.step === 154);
    expect(step, "报告里没有 step154（导航 IA 取证）那一步").toBeTruthy();
    const detail = (step as { detail: string }).detail;
    expect(detail, "step154 没取证命令面板打开").toContain("命令面板打开=");
    expect(detail, "step154 没取证过滤").toContain("过滤「记忆」后=");
    expect(detail, "step154 没取证 Esc 关闭").toContain("Esc 关闭=");
  });

  it("**上下文栏在**（页名 / 命令面板入口 / 快捷键入口）", () => {
    expect(screen, "上下文栏（.context-bar）不在了").toContain('className="context-bar"');
    expect(screen, "上下文栏没有摆当前页名").toContain('className="context-title"');
    // 当前页名从 NAV_ITEMS 取（同一份清单不出两处）
    expect(screen, "当前页名不是从 NAV_ITEMS 取的").toContain("const currentNav = NAV_ITEMS.find");
  });
});
