/* SPDX-License-Identifier: Apache-2.0 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AiStreamEvent } from "../../../src/shared/ipc.js";
import { api } from "../api.js";
import { onAiStream } from "./ai-session-bus.js";
import { canReplaceSelection } from "./editor-rewrite.js";

/**
 * **AI 改写这一段**（R185）：作者在编辑器里选中一段 ⇒ 让 AI 就这段改写。
 *
 * 四条口径（都是「宁可不做，也不假装能做」）：
 * ① **只认源码形态**：富文本形态的选区是 ProseMirror 坐标，与落盘的 Markdown 之间
 *    隔了一次有损往返（`mdToHtml` → `getHTML` → `htmlToMd` 会改列表缩进、合并空行、
 *    trim 结尾）⇒ **偏移与正文无任何可逆换算** ⇒ 富文本形态下这个入口**禁用并说清原因**
 *    （不假装能做，也不给作者一个会写错位置的按钮）；
 * ② **生成侧只加上下文**：选中的原文进 prompt（`selectionText`），
 *    **不改采纳的写语义**——范围替换不是「新增一条写通道」能解决的
 *    （项目纪律：禁止「任意区间改成任意文本」的通用写通道）；
 * ③ **替换是编辑器内的事**：局部 dispatch（CodeMirror `changes`）⇒ 走**既有**自动保存
 *    路径落盘（`chapter:write` + baseHash 冲突检测），不另开写入口；
 * ④ **位置失效即拒**：生成时记下**此刻的正文快照**；采纳时正文若已被改动
 *    （作者在等待期间又编辑了）⇒ **拒绝并说「正文已改，请重新生成」**，
 *    不拿旧偏移盲替换（与 `applyFixes` 的「位置失效即拒」同一条纪律）。
 *
 * 键盘：Esc 收起（登记在 shortcuts.ts）。
 */

/** 一次「改写这一段」的待采纳项 */
interface PendingRewrite {
  streamId: string;
  /** 选区起止（Markdown 偏移，只在源码形态有效） */
  from: number;
  to: number;
  /** 生成时的正文快照（采纳时比对——不一致即拒） */
  beforeBody: string;
  /** 选中的原文（比对 + 展示） */
  selectionText: string;
  /** 生成结果 */
  text: string;
}

export function EditorAiRewrite({
  mode,
  target,
  /** 取当前源码形态的选区（null = 没有选区 / 不在源码形态） */
  readSelection,
  /** 用新文本替换选区（编辑器内局部 dispatch；返回 false = 失败） */
  replaceSelection,
  /** 当前正文（采纳时比对快照用） */
  readBody,
}: {
  mode: "source" | "rich";
  target: { volumeId: string; chapterId: string } | null;
  readSelection: () => { from: number; to: number; text: string } | null;
  replaceSelection: (from: number, to: number, text: string) => boolean;
  readBody: () => string;
}) {
  const [intent, setIntent] = useState("更紧凑一点，保留原意与语感");
  const [selection, setSelection] = useState<{ from: number; to: number; text: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [pending, setPending] = useState<PendingRewrite | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pendingRef = useRef<PendingRewrite | null>(null);
  const offRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  useEffect(
    () => () => {
      offRef.current?.();
      offRef.current = null;
    },
    [],
  );

  const refreshSelection = useCallback(() => {
    setSelection(mode === "source" ? readSelection() : null);
  }, [mode, readSelection]);

  // 选区变化时刷新（CodeMirror 的 selectionSet 已在别处监听，这里轮询式取一次即可）
  useEffect(() => {
    refreshSelection();
    const timer = window.setInterval(refreshSelection, 700);
    return () => window.clearInterval(timer);
  }, [refreshSelection]);

  const start = async () => {
    if (target === null) {
      setError("没有选中的章节：先在左边挑一章");
      return;
    }
    const sel = mode === "source" ? readSelection() : null;
    if (sel === null || sel.text.trim() === "") {
      setError("没有选中文本：在源码形态里选中一段再试（富文本形态暂不支持）");
      return;
    }
    setError(null);
    setNotice(null);
    setPending(null);
    setRunning(true);
    const streamId = `rw-${Math.random().toString(36).slice(2, 10)}`;
    const beforeBody = readBody();
    // 流式事件经总线路由（订阅仍只有项目页一处——编辑器只是注册者）
    offRef.current?.();
    offRef.current = onAiStream(streamId, (event: AiStreamEvent) => {
      if (event.type === "done") {
        setRunning(false);
        setPending({
          streamId,
          from: sel.from,
          to: sel.to,
          beforeBody,
          selectionText: sel.text,
          text: event.text,
        });
      } else if (event.type === "error") {
        setRunning(false);
        setError(`[${event.code}] ${event.message}`);
      }
    });
    try {
      await api().ai.start({
        streamId,
        volumeId: target.volumeId,
        chapterId: target.chapterId,
        task: "draft-first",
        instruction: intent.trim(),
        selectionText: sel.text,
        targetWords: Math.max(60, sel.text.length),
      });
    } catch (err) {
      setRunning(false);
      offRef.current?.();
      offRef.current = null;
      setError((err as Error).message);
    }
  };

  const adopt = () => {
    if (pending === null) return;
    // ④ 位置失效即拒：正文在这期间被改过 ⇒ 旧偏移不可信 ⇒ 拒绝并说清
    if (!canReplaceSelection(pending.beforeBody, readBody())) {
      setError("正文在这期间被改过了，选区位置可能已失效——请重新选中再生成一次");
      setPending(null);
      return;
    }
    const ok = replaceSelection(pending.from, pending.to, pending.text);
    if (!ok) {
      setError("替换失败：选区位置已不可用，请重新选中再生成一次");
      setPending(null);
      return;
    }
    setNotice("已替换这一段（保存走既有自动保存路径）");
    setPending(null);
  };

  if (mode !== "source") {
    return (
      <section className="panel chapter-ai-rewrite">
        <div className="panel-title">AI 改写这一段</div>
        <p className="muted">
          富文本形态暂不支持：选区坐标与落盘的 Markdown 不是同一套（往返会改列表缩进与空行），
          偏移算不准就会写错位置。切回源码形态即可用。
        </p>
      </section>
    );
  }

  return (
    <section
      className="panel chapter-ai-rewrite"
      data-editor-ai-rewrite="1"
      onKeyDown={(event) => {
        // Esc 收起建议（登记见 shortcuts.ts）——不采纳，直接收起
        if (event.key === "Escape") {
          event.preventDefault();
          setPending(null);
          setError(null);
        }
      }}
    >
      <div className="panel-title">AI 改写这一段</div>
      <div className="muted" data-body-chars={readBody().length}>
        本章正文 {readBody().length} 字
      </div>
      {selection === null || selection.text.trim() === "" ? (
        <p className="muted">在左边选中一段文字，这里就会出现「让 AI 改这段」。</p>
      ) : (
        <>
          <div className="muted" data-selected-chars={selection.text.length}>
            已选 {selection.text.length} 字
          </div>
          <label className="chapter-ai-intent">
            想怎么改
            <input value={intent} onChange={(event) => setIntent(event.target.value)} />
          </label>
          <button type="button" className="link" disabled={running} onClick={() => void start()}>
            {running ? "生成中…" : "让 AI 改这段"}
          </button>
        </>
      )}
      {notice !== null && <div className="chapter-ai-notice">{notice}</div>}
      {error !== null && <div className="error-text">{error}</div>}
      {pending !== null && (
        <div className="chapter-ai-suggestion" data-ai-suggestion={pending.streamId}>
          <div className="muted">AI 的改写（{pending.text.length} 字）</div>
          <pre className="chapter-ai-suggestion-text">{pending.text}</pre>
          <div className="chapter-ai-suggestion-actions">
            <button type="button" className="link" onClick={adopt}>
              替换这一段
            </button>
            <button type="button" className="link" onClick={() => setPending(null)}>
              不用了
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
