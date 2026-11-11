/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **UI Phase 2：设置中心归位 + 发布归位质检域**（R183）。
 *
 * 判据盯四件事（两条腿：源码 + 归档回执）：
 * ① **顶栏偏好 select 退场**——主题 / 密度归位到设置浮层后，App 顶栏不再有
 *    `.density-picker` / `.theme-picker`（归位没做干净 = 两份入口并存 = 漂移起点）；
 * ② **设置浮层是真的**：组件在、App 引了它、上下文栏有入口 prop、浮层里摆的是
 *    主题与密度两个 select（状态与持久化仍在 App——浮层只是新视图，不是第二份状态）；
 * ③ **发布归位**：PublishPanel 不再在稿件总览（LibraryView 零引用），
 *    落在「发布与导出」页（ExportView 引用 + 域内 label 改名）——
 *    「质检与发布」域名实符相符；
 * ④ **回执腿**：step156 取证（顶栏 select 退场 + 浮层打开 + 换密度当场生效 + Esc 关闭）。
 */

const ROOT = join(__dirname, "..", "..", "..");
const app = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "App.tsx"), "utf8");
const screen = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "views", "ProjectScreen.tsx"), "utf8");
const settings = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "SettingsPanel.tsx"), "utf8");
const library = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "views", "LibraryView.tsx"), "utf8");
const exportView = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "views", "ExportView.tsx"), "utf8");
const icons = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "icons.tsx"), "utf8");
const iconRegistry = readFileSync(join(ROOT, "docs", "12-图标与插画来源登记.md"), "utf8");
const report = JSON.parse(
  readFileSync(join(ROOT, "docs", "assets", "m1-preview", "walkthrough-report.json"), "utf8"),
) as { steps: Array<{ step: number; ok: boolean; detail: string }> };

describe("设置中心归位（R183）：偏好收到浮层，顶栏退场", () => {
  it("**顶栏的两个偏好 select 退场了**（density-picker / theme-picker 在 App 里零命中）", () => {
    expect(app, "顶栏还留着 density-picker——归位没做干净（两份入口并存 = 漂移起点）").not.toContain(
      "density-picker",
    );
    expect(app, "顶栏还留着 theme-picker").not.toContain("theme-picker");
    // 偏好的状态与持久化仍在 App（R117/R121 的键一个没动）——浮层只是新视图
    expect(app, "密度偏好的状态与持久化不在 App 了（归位不该连状态一起搬）").toContain("loadDensityPref");
    expect(app, "主题偏好的状态与持久化不在 App 了").toContain("loadThemePref");
  });

  it("**设置浮层是真的**（组件在 + App 引了 + 上下文栏有入口 + 浮层摆主题与密度）", () => {
    expect(app, "App 没有引设置浮层组件").toContain('components/SettingsPanel"');
    expect(app, "App 没有渲染 SettingsPanel").toContain("<SettingsPanel");
    expect(screen, "ProjectScreen 没有设置入口的举手 prop").toContain("onOpenSettings");
    // 浮层里的两个 select 用 aria-label 认（预演也按这个找）
    expect(settings, "浮层里没有主题选择").toContain('aria-label="主题"');
    expect(settings, "浮层里没有密度选择").toContain('aria-label="界面密度"');
    // Esc 关闭登记进 shortcuts（登记表扫描器另有通用判据，这里钉"这条登记存在"）
    const shortcutsSrc = readFileSync(
      join(ROOT, "apps", "desktop", "renderer", "src", "components", "shortcuts.ts"),
      "utf8",
    );
    expect(shortcutsSrc, "登记表里没有 settings-escape 条目").toContain('id: "settings-escape"');
  });

  it("**设置图标的来源登记在**（icons.tsx 有 settings + docs/12 有一行）", () => {
    expect(icons, "icons.tsx 里没有 settings 图标").toContain('"settings"');
    expect(iconRegistry, "docs/12 没登记 settings 图标").toContain("| 17 | `settings` |");
  });
});

describe("发布归位质检域（R183）：「质检与发布」名实相符", () => {
  it("**PublishPanel 不再在稿件总览**（LibraryView 零引用——总览专注卷章）", () => {
    expect(library, "稿件总览还在引 PublishPanel（归位没搬走）").not.toContain("PublishPanel");
    expect(library, "稿件总览还留着发布折叠区").not.toContain("library-publish");
  });

  it("**发布面板落在「发布与导出」页**（ExportView 引用 + 域内 label 改名）", () => {
    expect(exportView, "发布与导出页没有引 PublishPanel").toContain('components/PublishPanel"');
    expect(exportView, "发布与导出页没有渲染 PublishPanel").toContain("<PublishPanel />");
    expect(screen, "域内的页面还叫「导出与自查」（没改名）").toContain('label: "发布与导出"');
    expect(screen, "域内还留着旧页名").not.toContain("导出与自查");
  });

  it("**回执腿：step156 取证过**（顶栏 select 退场 + 浮层 + 换密度当场生效 + Esc 关闭）", () => {
    const step = report.steps.find((row) => row.step === 156);
    expect(step, "报告里没有 step156（设置浮层取证）那一步").toBeTruthy();
    expect((step as { ok: boolean }).ok, "step156 没过").toBe(true);
    const detail = (step as { detail: string }).detail;
    expect(detail, "step156 没取证顶栏 select 退场").toContain("顶栏偏好 select 退场=true");
    expect(detail, "step156 没取证浮层打开").toContain("浮层打开=true");
    expect(detail, "step156 没取证换密度当场生效").toContain("当场生效=true");
    expect(detail, "step156 没取证 Esc 关闭").toContain("Esc 关闭=true");
  });
});
