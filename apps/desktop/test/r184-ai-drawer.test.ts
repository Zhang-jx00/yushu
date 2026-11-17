/* SPDX-License-Identifier: Apache-2.0 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { AiStreamEvent, AiUsageEntryPayload } from "../src/shared/ipc.js";
import {
  beginAiCollect,
  currentAiCandidates,
  handleAiEvent,
  onAiStream,
  resetAiSession,
  subscribeAiSession,
} from "../renderer/src/components/ai-session-bus.js";

/**
 * **AI 抽屉与会话总线**（R184 · UI Phase 3 第一片）。
 *
 * 判据盯三件事（两条腿：源码 + 归档回执，外加总线自己的单测）：
 * ① **总线收得对**：begin 过的多候选流在 done 时进清单、单候选不进（口径不变）、
 *    失败撤销待收集、流式事件按 streamId 路由（打字机显示不经过清单）；
 * ② **订阅只挂一份**（ProjectScreen 挂载期）⇒ 切页不丢候选——AiView 里不再有
 *    本地 candidates state 与本地 onEvent 订阅；
 * ③ **写入口只有一处**（总线）⇒ 抽屉与副驾页共用同一条 adopt/reject 通道，
 *    confirm 闸门逐字相同；抽屉里没有生成入口（生成是副驾页的事）。
 */

const ROOT = join(__dirname, "..", "..", "..");
const screen = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "views", "ProjectScreen.tsx"), "utf8");
const aiView = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "views", "AiView.tsx"), "utf8");
const drawer = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "AiDrawer.tsx"), "utf8");
const bus = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "ai-session-bus.ts"), "utf8");
const actions = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "ai-session-actions.ts"), "utf8");
const shortcutsSrc = readFileSync(join(ROOT, "apps", "desktop", "renderer", "src", "components", "shortcuts.ts"), "utf8");
const report = JSON.parse(
  readFileSync(join(ROOT, "docs", "assets", "m1-preview", "walkthrough-report.json"), "utf8"),
) as { steps: Array<{ step: number; ok: boolean; detail: string }> };

/** 构造一个 done 事件（bus 收集的触发形态） */
const doneEvent = (streamId: string, text = "候选正文"): AiStreamEvent => ({
  type: "done",
  streamId,
  text,
  chars: text.length,
  aborted: false,
  providerId: "prov",
  model: "mock",
  usageId: `usage-${streamId}`,
  hints: { referenced: [], hints: [] },
  usage: { prompt_tokens: 10, completion_tokens: 20 },
} as unknown as AiStreamEvent);

describe("AI 会话总线（R184）：done 收集与流式路由", () => {
  beforeEach(() => {
    resetAiSession();
  });

  it("**begin 过的多候选流：done 时进清单**（index/total/目标随条目落总线）", () => {
    let notified = 0;
    const off = subscribeAiSession(() => {
      notified += 1;
    });
    beginAiCollect("s-1", { index: 1, total: 2, volumeId: "v1", chapterId: "c1" });
    handleAiEvent(doneEvent("s-1"));
    off();
    const list = currentAiCandidates();
    expect(list).toHaveLength(1);
    expect(list[0]!.streamId).toBe("s-1");
    expect(list[0]!.index).toBe(1);
    expect(list[0]!.total).toBe(2);
    expect(list[0]!.volumeId).toBe("v1");
    expect(list[0]!.chapterId).toBe("c1");
    expect(list[0]!.usageId).toBe("usage-s-1");
    // 订阅通知过了（抽屉与副驾页靠它重渲染）
    expect(notified).toBeGreaterThanOrEqual(1);
  });

  it("**单候选不进清单**（没 begin 过的流，done 到来也不收——右栏「候选」计数的口径不变）", () => {
    handleAiEvent(doneEvent("s-single"));
    expect(currentAiCandidates()).toHaveLength(0);
  });

  it("**失败撤销待收集**（error 事件 ⇒ 不留空壳条目）", () => {
    beginAiCollect("s-err", { index: 1, total: 2, volumeId: "v1", chapterId: "c1" });
    handleAiEvent({ type: "error", streamId: "s-err", code: "X", message: "炸了" } as unknown as AiStreamEvent);
    handleAiEvent(doneEvent("s-err"));
    expect(currentAiCandidates()).toHaveLength(0);
  });

  it("**流式事件按 streamId 路由**（打字机显示走 handler，不进清单）", () => {
    const seen: string[] = [];
    const off = onAiStream("s-delta", (event) => {
      if (event.type === "delta") seen.push(event.text);
    });
    handleAiEvent({ type: "delta", streamId: "s-delta", text: "第一段", chars: 3 } as unknown as AiStreamEvent);
    handleAiEvent({ type: "delta", streamId: "s-other", text: "别人的", chars: 3 } as unknown as AiStreamEvent);
    off();
    expect(seen).toEqual(["第一段"]);
    expect(currentAiCandidates()).toHaveLength(0);
  });

  it("**reset 清空**（新一轮多候选生成开始时调——清单是「本次运行」的语义）", () => {
    beginAiCollect("s-1", { index: 1, total: 1, volumeId: "v1", chapterId: "c1" });
    handleAiEvent(doneEvent("s-1"));
    expect(currentAiCandidates()).toHaveLength(1);
    resetAiSession();
    expect(currentAiCandidates()).toHaveLength(0);
  });
});

describe("AI 抽屉（R184）：同一份真源 + 写入口只有一处 + 生成不在抽屉", () => {
  it("**订阅只挂一份**（ProjectScreen 挂载期订阅；AiView 不再有本地订阅与本地候选 state）", () => {
    expect(screen, "ProjectScreen 没有挂总线的唯一订阅").toContain("api().ai.onEvent(handleAiEvent)");
    expect(aiView, "AiView 还留着本地 onEvent 订阅（切页丢候选的 bug 没修干净）").not.toContain("ai.onEvent");
    expect(aiView, "AiView 还留着本地 candidates useState").not.toContain("useState<CandidateEntry[]>");
    expect(aiView, "AiView 没有改成读总线（hook 名）").toContain("useAiSessionCandidates()");
  });

  it("**Ctrl+J 独立监听器 + rail-foot 入口**（全局条目与窗口级 keydown 监听器一一对账）", () => {
    expect(screen, "Ctrl+J 的判定不在 ProjectScreen 里").toContain('if (event.key === "j") {');
    expect(screen, "rail-foot 没有 AI 抽屉入口").toContain('aria-label="打开 AI 抽屉（Ctrl+J）"');
    expect(screen, "抽屉组件没挂在 ProjectScreen 根级").toContain("<AiDrawer");
    expect(shortcutsSrc, "登记表里没有 ai-drawer 条目").toContain('id: "ai-drawer"');
    expect(shortcutsSrc, "登记表里没有 ai-drawer-escape 条目").toContain('id: "ai-drawer-escape"');
  });

  it("**写入口只有一处**（confirm 闸门逐字相同；抽屉没有生成入口）", () => {
    // confirm 文案在 bus（副驾页与抽屉共用同一条 adopt 通道 ⇒ 同一句红线）
    expect(actions, "confirm 闸门不在写动作模块上（两处入口会漂）").toContain(
      "替换将覆盖该章节现有正文（覆盖前会自动创建「破坏前」快照，可整体回退），确定继续？",
    );
    expect(aiView, "AiView 自己还留着 adopt 的 confirm 文案（写入口没收敛）").not.toContain(
      "替换将覆盖该章节现有正文",
    );
    expect(drawer, "抽屉没读总线候选").toContain("useAiSessionCandidates()");
    expect(drawer, "抽屉没走同一个纯函数报数").toContain("summarizeAiSession");
    expect(drawer, "抽屉里出现了生成入口（生成是副驾页的事，塞进来就是工作台复制两份）").not.toContain(
      "ai.start",
    );
    expect(drawer, "抽屉没给「去副驾生成」的入口").toContain("去副驾生成");
  });

  it("**回执腿：step157 取证过**（编辑器页开抽屉 + 候选数与副驾页对上 + Esc 关闭）", () => {
    const step = report.steps.find((row) => row.step === 157);
    expect(step, "报告里没有 step157（AI 抽屉取证）那一步").toBeTruthy();
    expect((step as { ok: boolean }).ok, "step157 没过").toBe(true);
    const detail = (step as { detail: string }).detail;
    expect(detail, "step157 没取证跨页四数对账").toContain("四数对上=true");
    expect(detail, "step157 没取证 Esc 关闭").toContain("Esc 关闭=true");
  });
});
