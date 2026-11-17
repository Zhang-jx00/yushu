/* SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useState } from "react";
import type { AiStreamEvent, DraftHintPayload } from "../../../src/shared/ipc.js";

/**
 * **AI 会话总线**（R184 · UI Phase 3「AI 抽屉」第一片）。
 *
 * 为什么要有它：候选清单原先住在 AiView 的本地 state（R163 时代的设计——那时
 * AI 副驾是唯一入口），`ai:event` 的订阅也挂在 AiView 的挂载期 ⇒ **切走标签页
 * 订阅随组件销毁**：多候选生成到一半切页，主进程的流还在跑，事件却全丢、候选清零；
 * 生成完成后想去编辑器边看稿边采纳，也做不到。
 *
 * 这份模块是**纯状态容器**（不碰 API ⇒ 可直接单测；写入口在
 * `ai-session-actions.ts`——那里才 import api）：
 * 三件事的**唯一出处**：
 * ① **订阅**：`ai:event` 的订阅只挂一次（ProjectScreen 挂载期），流式事件按 streamId
 *    路由给注册者（AiView 的打字机显示），`done` 事件把**多候选**收进清单——
 *    切页不再丢（生成中途切页丢的是流式画面，done 的候选进总线）；
 * ② **候选清单**：模块级可变单例 + 订阅通知（`useAiSessionCandidates`）——
 *    AI 副驾页与 AI 抽屉消费**同一份**，计数必然对得上（R163 纪律：右栏的数
 *    全部由纯函数从同一份状态现算）；
 * ③ **采纳 / 拒绝动作**：写入口**只有这一处**（R174 教训：另造一套写入点只会漂）——
 *    `adoptCandidate` 带与副驾页逐字相同的 confirm 闸门（replace 且有正文时），
 *    `rejectCandidate` 落 `.yushu/ai-feedback.jsonl`。
 *
 * 口径：
 * - **单候选（`start`）不进总线**：它的结果显示在副驾页自己的结果面板里，
 *   右栏「候选」计数的语义是**多候选清单条数**（R163 起没变过）——零语义漂移；
 * - **只收 `done`**：流式中间态（delta）的显示仍归触发方（打字机缓冲是显示层的事）；
 * - **候选不跨会话**：采纳的必要字段 `usageId` 只存在于生成完成事件，渲染层候选
 *   不落盘 ⇒ 模块级单例只在**本次应用会话**内存活（重启即清）——明写，不冒充持久化。
 */

/** 总线里的候选条目：副驾页 CandidateEntry 的跨页版（多带 volumeId / chapterId 供采纳） */
export interface BusCandidate {
  streamId: string;
  index: number;
  total: number;
  volumeId: string;
  chapterId: string;
  text: string;
  chars: number;
  aborted: boolean;
  providerId: string;
  model: string;
  usageId: string;
  hints: DraftHintPayload;
  usageText: string;
  adopted?: "replace" | "append";
  rejected?: boolean;
}

interface StreamHandler {
  (event: AiStreamEvent): void;
}

let candidates: BusCandidate[] = [];
/** 本轮多候选生成里**等待 done** 的流（beginCollect 登记 ⇒ done 才收；失败/单候选不收） */
const pending = new Map<string, { index: number; total: number; volumeId: string; chapterId: string }>();
/** 流式处理器（按 streamId 路由；AiView 的打字机显示在这里挂） */
const streamHandlers = new Map<string, StreamHandler>();
let version = 0;
const subscribers = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const notify of subscribers) notify();
}

/** 订阅候选清单变化（React 侧请用 useAiSessionCandidates） */
export function subscribeAiSession(notify: () => void): () => void {
  subscribers.add(notify);
  return () => {
    subscribers.delete(notify);
  };
}

/** React 钩子：候选清单 + 变化自动重渲染（AI 副驾页与抽屉共用同一份真源） */
/**
 * 当前候选清单（**只读快照**；React 侧请用 `useAiSessionCandidates`——
 * 这个出口是给**非 React 环境**（单测）用的）。
 */
export function currentAiCandidates(): BusCandidate[] {
  return candidates;
}

export function useAiSessionCandidates(): BusCandidate[] {
  const [, setTick] = useState(0);
  useEffect(() => subscribeAiSession(() => setTick((tick) => tick + 1)), []);
  return candidates;
}

/** 登记一个流的流式处理器（AiView 的 runOne 用；done 后必须 off） */
export function onAiStream(streamId: string, handler: StreamHandler): () => void {
  streamHandlers.set(streamId, handler);
  return () => {
    streamHandlers.delete(streamId);
  };
}

/**
 * 登记一条**待收集**的多候选流：`done` 到来时收进清单。
 * volumeId / chapterId 随条目落总线（抽屉采纳时要用，不依赖副驾页当时的选中态）。
 */
export function beginAiCollect(
  streamId: string,
  meta: { index: number; total: number; volumeId: string; chapterId: string },
): void {
  pending.set(streamId, meta);
}

/** 清空候选清单（新一轮多候选生成开始时调——清单是"本次运行"的语义） */
export function resetAiSession(): void {
  candidates = [];
  emit();
}

/**
 * `ai:event` 的**唯一入口**（ProjectScreen 挂载期订阅一次）：
 * ① 流式事件按 streamId 路由给注册者；
 * ② done 且登记过待收集 ⇒ 收进候选清单（**这就是"切页不再丢候选"的那一刀**）；
 * ③ 失败类事件 ⇒ 撤销待收集（失败的流不留空壳条目）。
 */
export function handleAiEvent(event: AiStreamEvent): void {
  streamHandlers.get(event.streamId)?.(event);
  if (event.type === "done" && pending.has(event.streamId)) {
    const meta = pending.get(event.streamId) as {
      index: number;
      total: number;
      volumeId: string;
      chapterId: string;
    };
    pending.delete(event.streamId);
    candidates = [
      ...candidates,
      {
        streamId: event.streamId,
        index: meta.index,
        total: meta.total,
        volumeId: meta.volumeId,
        chapterId: meta.chapterId,
        text: event.text,
        chars: event.chars,
        aborted: event.aborted,
        providerId: event.providerId,
        model: event.model,
        usageId: event.usageId,
        hints: event.hints,
        usageText: event.usage
          ? `prompt ${event.usage.prompt_tokens ?? "-"} / completion ${event.usage.completion_tokens ?? "-"}`
          : "（本端点未返回 usage）",
      },
    ];
    emit();
    return;
  }
  // 失败事件：撤销待收集（失败的流不留空壳条目；aborted 走 done 且带 aborted 标记，会收）
  if (event.type === "error" && pending.has(event.streamId)) {
    pending.delete(event.streamId);
  }
}

/**
 * 只改标记不动盘（**局部采纳**专用）：按句合并采纳的正文是**合并后的文本**、
 * 不是条目原文 ⇒ 写盘留在副驾页自己的通道，这里只把处置标记广播出去
 * （右栏计数与抽屉的徽标读的是总线，不广播两边就会漂）。
 */
export function markAiCandidateAdopted(streamId: string, mode: "replace" | "append"): void {
  candidates = candidates.map((item) =>
    item.streamId === streamId ? { ...item, adopted: mode } : item,
  );
  emit();
}

/** 拒绝标记（与采纳标记同一处广播——右栏的数与抽屉的徽标读的是同一份） */
export function markRejected(streamId: string): void {
  candidates = candidates.map((item) =>
    item.streamId === streamId ? { ...item, rejected: true } : item,
  );
  emit();
}
