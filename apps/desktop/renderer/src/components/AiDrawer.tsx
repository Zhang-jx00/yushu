/* SPDX-License-Identifier: Apache-2.0 */
import { useEffect, useRef, useState } from "react";
import type { AiDraftTarget, AiUsageEntryPayload } from "../../../src/shared/ipc.js";
import { REJECT_REASON_PRESETS } from "../../../src/shared/ipc.js";
import { api } from "../api.js";
import { useAiSessionCandidates } from "./ai-session-bus.js";
import { adoptAiCandidate, rejectAiCandidate } from "./ai-session-actions.js";
import { summarizeAiSession } from "./ai-session.js";

/**
 * **AI 抽屉**（R184 · UI Phase 3 第一片）：任何页面都能唤起的右侧滑入面板——
 * 作者在编辑器写稿时不必切走，就能看到这次会话跑出来的多候选并采纳 / 拒绝。
 *
 * 口径：
 * ① **数据不另取**：候选清单读 `ai-session-bus`（与 AI 副驾页**同一份**真源）；
 *    会话产物计数走 `summarizeAiSession` 同一个纯函数 ⇒ 抽屉与副驾右栏必然对得上；
 * ② **生成不在抽屉**：生成目标 / 上下文预览 / 打字机是副驾页的工作台
 *    （抽屉里塞一套等于把工作台复制两份）⇒ 抽屉只给「去副驾生成」的入口；
 * ③ **写入口与副驾页是同一个**（`adoptAiCandidate` / `rejectAiCandidate`）——
 *    confirm 闸门逐字相同（replace 且该章有正文才弹）；另造一套写入点只会漂（R174 教训）；
 * ④ Esc 关闭（登记表 `ai-drawer-escape`）+ 点遮罩关（与命令面板 / 设置浮层同一套交互）。
 * 样式全令牌；`z-index: 30` 与现有浮层同一档（契约 §4：只有浮层允许 overlay 级阴影）。
 */
export function AiDrawer({
  open,
  onClose,
  onGoToAi,
}: {
  open: boolean;
  onClose: () => void;
  /** 跳去 AI 副驾页发起生成（抽屉只管处置，不管生成） */
  onGoToAi: () => void;
}) {
  const candidates = useAiSessionCandidates();
  const [usage, setUsage] = useState<AiUsageEntryPayload[]>([]);
  const [drafts, setDrafts] = useState<AiDraftTarget[]>([]);
  const [rejectDraft, setRejectDraft] = useState<{ streamId: string; reason: string; note: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const firstBtnRef = useRef<HTMLButtonElement | null>(null);

  // 打开时取一次跨页可读的持久数据（使用记录 / 草稿章清单——都来自主进程，不依赖副驾页）
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api()
      .ai.usage()
      .then((state) => {
        if (alive) setUsage(state.entries);
      })
      .catch(() => undefined);
    void api()
      .ai.drafts()
      .then((rows) => {
        if (alive) setDrafts(rows);
      })
      .catch(() => undefined);
    requestAnimationFrame(() => firstBtnRef.current?.focus());
    return () => {
      alive = false;
    };
  }, [open]);

  if (!open) return null;

  // 与副驾右栏同一个纯函数、同一份候选 ⇒ 两侧的数必然逐字一致
  const session = summarizeAiSession({
    candidates: candidates.map((item) => ({
      streamId: item.streamId,
      index: item.index,
      chars: item.chars,
      adopted: item.adopted,
      rejected: item.rejected,
    })),
    usage,
  });
  const hasBodyOf = (volumeId: string, chapterId: string): boolean =>
    drafts.some((item) => item.volumeId === volumeId && item.chapterId === chapterId && item.hasBody);

  const adopt = async (entry: (typeof candidates)[number], mode: "replace" | "append") => {
    try {
      setError(null);
      const adopted = await adoptAiCandidate(entry, mode, { hasBody: hasBodyOf(entry.volumeId, entry.chapterId) });
      if (adopted === null) return; // confirm 闸门被作者取消
      setNotice(`候选 ${entry.index}/${entry.total} 已${mode === "replace" ? "替换" : "追加"}采纳 → ${adopted.chapterPath}（${adopted.wordCount} 字）`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const reject = async (entry: (typeof candidates)[number], reason: string, note: string) => {
    try {
      setError(null);
      await rejectAiCandidate(entry, reason, note);
      setRejectDraft(null);
      setNotice(`已记录拒绝原因「${reason}」——沉淀为提示词改进数据（本机 .yushu/ai-feedback.jsonl）`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="drawer-overlay" onMouseDown={onClose} role="presentation">
      <div
        className="drawer-panel"
        role="dialog"
        aria-modal="true"
        aria-label="AI 抽屉"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="drawer-title">
          AI 抽屉
          {/* R184 对账锚点：四个数与副驾页右栏的 data-ai-session-* 同源同形 ⇒ 预演能跨页逐字对 */}
          <span
            className="muted drawer-summary"
            data-drawer-candidates={session.candidates}
            data-drawer-adopted={session.adopted}
            data-drawer-rejected={session.rejected}
            data-drawer-pending={session.pending}
          >
            候选 {session.candidates} · 已采纳 {session.adopted} · 已拒绝 {session.rejected} · 还没处置 {session.pending}
          </span>
        </div>
        <p className="muted drawer-note">
          生成在「AI 副驾」页发起（多候选），这里只做处置——
          <button type="button" className="link" onClick={onGoToAi}>
            去副驾生成
          </button>
        </p>
        {notice !== null && <p className="drawer-notice">{notice}</p>}
        {error !== null && <p className="error-text">{error}</p>}
        {candidates.length === 0 && (
          <p className="muted">
            这次会话还没有多候选——在 AI 副驾页用「N 个候选」跑一次，跑完不用切页，在这里直接采纳。
          </p>
        )}
        <ul className="drawer-list">
          {candidates.map((entry) => (
            <li key={entry.streamId} className="drawer-candidate" data-drawer-candidate={entry.streamId}>
              <div className="drawer-candidate-head">
                <span>
                  候选 {entry.index}/{entry.total} · {entry.chars} 字 · {entry.providerId}/{entry.model}
                </span>
                {entry.adopted !== undefined && <span className="chip">已{entry.adopted === "replace" ? "替换" : "追加"}采纳</span>}
                {entry.rejected === true && <span className="chip">已拒绝</span>}
              </div>
              <div className="drawer-candidate-text">{entry.text.slice(0, 400)}</div>
              <div className="drawer-candidate-actions">
                <button
                  ref={candidates.findIndex((item) => item.streamId === entry.streamId) === 0 ? firstBtnRef : undefined}
                  type="button"
                  className="link"
                  disabled={entry.adopted !== undefined || entry.rejected === true}
                  onClick={() => void adopt(entry, "replace")}
                >
                  替换采纳
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={entry.adopted !== undefined || entry.rejected === true}
                  onClick={() => void adopt(entry, "append")}
                >
                  追加采纳
                </button>
                <button
                  type="button"
                  className="link"
                  disabled={entry.rejected === true}
                  onClick={() =>
                    setRejectDraft({ streamId: entry.streamId, reason: REJECT_REASON_PRESETS[0], note: "" })
                  }
                >
                  拒绝…
                </button>
              </div>
              {rejectDraft?.streamId === entry.streamId && (
                <div className="drawer-reject">
                  <label className="drawer-reject-row">
                    原因
                    <select
                      value={rejectDraft.reason}
                      onChange={(event) =>
                        setRejectDraft({ ...rejectDraft, reason: event.target.value })
                      }
                    >
                      {REJECT_REASON_PRESETS.map((reason) => (
                        <option key={reason} value={reason}>
                          {reason}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="drawer-reject-row">
                    备注
                    <input
                      value={rejectDraft.note}
                      onChange={(event) => setRejectDraft({ ...rejectDraft, note: event.target.value })}
                    />
                  </label>
                  <button
                    type="button"
                    className="link"
                    onClick={() => void reject(entry, rejectDraft.reason, rejectDraft.note)}
                  >
                    记录拒绝原因
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
