/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * **编辑器选区 → AI 改写这一段**（R185）。
 *
 * 判据盯五件事（两条腿：源码 + 归档回执）：
 * ① **生成侧只加上下文**：选中的原文进 prompt（`selectionText`），
 *    **不改采纳的写语义**——范围替换不是「新增一条写通道」能解决的
 *    （项目纪律：禁止「任意区间改成任意文本」的通用写通道）；
 * ② **只认源码形态**：富文本形态的选区坐标与落盘 Markdown 不可逆换算 ⇒
 *    入口**禁用并说清原因**（宁可不做，也不写错位置）；
 * ③ **替换是编辑器内的事**：局部 dispatch（CodeMirror `changes`），
 *    落盘走**既有**自动保存路径（`chapter:write` + baseHash）⇒ **没有新写通道**；
 * ④ **位置失效即拒**：生成时记下正文快照，采纳时正文若已变 ⇒ 拒绝并说清；
 * ⑤ **回执腿**：step158 取证（选中 ⇒ 生成 ⇒ 替换这一段 ⇒ 正文真的变了）。
 */

const ROOT = join(__dirname, "..", "..", "..");
const editor = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "views", "ChapterEditorView.tsx"), "utf8");
const panel = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "EditorAiRewrite.tsx"), "utf8");
const ipc = readFileSync(join(ROOT, "apps", "desktop", "src", "shared", "ipc.ts"), "utf8");
const promptOps = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "prompt-ops.ts"), "utf8");
const aiOps = readFileSync(join(ROOT, "apps", "desktop", "src", "main", "ai-ops.ts"), "utf8");
const writeWrappers = readFileSync(join(ROOT, "apps", "desktop", "test", "ipc-write-wrappers.test.ts"), "utf8");
const report = JSON.parse(
  readFileSync(join(ROOT, "docs", "assets", "m1-preview", "walkthrough-report.json"), "utf8"),
) as { steps: Array<{ step: number; ok: boolean; detail: string }> };

describe("选区 → AI（R185）：生成侧只加上下文，替换在编辑器内", () => {
  it("**selectionText 进 prompt**（ipc 载荷 → DraftTask → prompt 槽位，三处都在）", () => {
    expect(ipc, "生成载荷里没有 selectionText 字段").toContain("selectionText?: string;");
    expect(promptOps, "DraftTask 里没有 selectionText 字段").toContain("selectionText?: string;");
    expect(promptOps, "prompt 里没有「作者选中的原文」这一段").toContain("【作者选中的原文】");
    expect(aiOps, "payload → task 的映射里没有 selectionText").toContain(
      "payload.selectionText ? { selectionText: payload.selectionText } : {}",
    );
  });

  it("**采纳的写语义没变**（没有新增「任意区间替换」通道——项目纪律）", () => {
    // 通道登记表里没有新通道（aiAdopt 仍是唯一那条）
    expect(writeWrappers, "写通道登记表被动了（范围替换不该新开通道）").toContain('"aiAdopt"');
    expect(ipc, "采纳载荷被加了 range（应保持整章语义）").not.toContain("range?:");
    // 替换走编辑器内局部 dispatch（CodeMirror changes）
    expect(editor, "编辑器没有局部替换的实现").toContain("view.dispatch({ changes: { from, to, insert: text } })");
    expect(editor, "编辑器没有读选区的实现").toContain("view.state.sliceDoc(range.from, range.to)");
  });

  it("**只认源码形态**（富文本形态禁用并说清原因，不假装能做）", () => {
    expect(panel, "面板没有形态判定").toContain('mode !== "source"');
    expect(panel, "富文本形态没有说明为什么不支持").toContain("富文本形态暂不支持");
    expect(panel, "富文本形态没有说明坐标不可逆换算的理由").toContain("不是同一套");
    expect(editor, "读选区没有形态守卫").toContain('if (modeRef.current !== "source") return null;');
  });

  it("**位置失效即拒**（生成时记正文快照，采纳时不一致就拒——判定在纯函数里，可单测）", () => {
    expect(panel, "生成时没有记正文快照").toContain("beforeBody = readBody()");
    expect(panel, "采纳时没有走纯函数判定").toContain("canReplaceSelection(pending.beforeBody, readBody())");
    expect(panel, "拒绝时没有说清怎么办").toContain("正文在这期间被改过了");
    // 纯函数那一层：判据文件在（单测钉住三条：一致可替换 / 变了就拒 / 只动那一段）
    expect(
      readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "editor-rewrite.ts"), "utf8"),
      "选区替换的纯判定模块不在",
    ).toContain("export function canReplaceSelection");
  });

  it("**回执腿：step158 取证过**（选中 ⇒ 生成 ⇒ 替换这一段 ⇒ 正文真的变了）", () => {
    const step = report.steps.find((row) => row.step === 158);
    expect(step, "报告里没有 step158（选区改写取证）那一步").toBeTruthy();
    expect((step as { ok: boolean }).ok, "step158 没过").toBe(true);
    const detail = (step as { detail: string }).detail;
    expect(detail, "step158 没取证选区字数").toContain("选区=");
    expect(detail, "step158 没取证生成出建议").toContain("建议=");
    // 正文变化的量法：CM6 虚拟渲染 ⇒ 量**正文字数**，且差值 == 选区 − 建议（逐字对账）
    expect(detail, "step158 没取证正文变了").toContain("变了=true");
    expect(detail, "step158 的字数差没逐字对账").toContain("差值");
    expect(detail, "step158 的差值对不上").toContain("= true");
  });
});
