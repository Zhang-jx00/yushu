import { useCallback, useEffect, useState } from "react";
import type { MemoryStatePayload, MemoryTargetPayload, MemorySummarizeResult } from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 记忆页（M3 / T3-5 五层记忆的管理界面）：
 * - 摘要目标（卷 / 章）：AI 生成候选（**不入库**）→ 采纳（AI 入库，rev 0）或人工修订（rev+1）；
 *   `summary_rev > 0` 后 AI 再入库被拒（E_MEMORY_REV_PROTECTED——人工修订受保护）；
 * - 事实级记忆台账：带出处徽标（出处有效 / 出处失效 / 无出处——正文改动后可检出失效）；
 * - 记录体检（findings）与跨项目拒绝清单（error 红线仅展示、不进入本项目记忆）。
 */

const LAYER_LABELS: Record<string, string> = {
  volume_summary: "卷摘要",
  chapter_summary: "章摘要",
};

const PROVENANCE_LABELS: Record<string, { text: string; cls: string }> = {
  ok: { text: "出处有效", cls: "badge good" },
  broken: { text: "出处失效", cls: "badge bad" },
  none: { text: "无出处", cls: "badge" },
};

function firstTargetKey(state: MemoryStatePayload): string {
  const preferred = state.targets.find((item) => item.sourceChars > 0) ?? state.targets[0];
  return preferred ? `${preferred.layer}:${preferred.id}` : "";
}

export function MemoryView() {
  const [state, setState] = useState<MemoryStatePayload | null>(null);
  const [selectedKey, setSelectedKey] = useState("");
  const [candidate, setCandidate] = useState("");
  const [lastRun, setLastRun] = useState<MemorySummarizeResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 事实登记表单
  const [factKeys, setFactKeys] = useState("");
  const [factText, setFactText] = useState("");
  const [factChapter, setFactChapter] = useState("");
  const [factStart, setFactStart] = useState(0);
  const [factEnd, setFactEnd] = useState(0);
  const [factWithSource, setFactWithSource] = useState(true);

  const refresh = useCallback(async () => {
    const next = await api().memory.state();
    setState(next);
    setSelectedKey((prev) => (prev && next.targets.some((item) => `${item.layer}:${item.id}` === prev) ? prev : firstTargetKey(next)));
    setFactChapter((prev) => (prev && next.targets.some((item) => item.id === prev && item.layer === "chapter_summary") ? prev : (next.targets.find((item) => item.layer === "chapter_summary" && item.sourceChars > 0)?.id ?? "")));
    return next;
  }, []);

  useEffect(() => {
    void refresh().catch((err) => setError((err as Error).message));
  }, [refresh]);

  const selected: MemoryTargetPayload | null =
    state?.targets.find((item) => `${item.layer}:${item.id}` === selectedKey) ?? null;
  const currentSummary =
    state && selected
      ? state.summaries.find((item) => item.layer === selected.layer && item.id === selected.id) ?? null
      : null;
  const chapterTargets = (state?.targets ?? []).filter((item) => item.layer === "chapter_summary");

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const generate = () =>
    guard(async () => {
      if (!selected) return;
      setNotice(null);
      const result = await api().memory.summarize({
        layer: selected.layer,
        id: selected.id,
        ...(selected.volume_id ? { volumeId: selected.volume_id } : {}),
      });
      setCandidate(result.text);
      setLastRun(result);
      setNotice(`候选已生成（${result.provider_id} / ${result.model}，${result.chars} 字）——尚未入库，需显式采纳`);
    });

  const save = (origin: "ai" | "human") =>
    guard(async () => {
      if (!selected || candidate.trim() === "") return;
      const saved = await api().memory.saveSummary({
        layer: selected.layer,
        id: selected.id,
        ...(selected.volume_id ? { volume_id: selected.volume_id } : {}),
        text: candidate,
        origin,
        ...(currentSummary ? { baseHash: currentSummary.hash } : {}),
      });
      await refresh();
      setNotice(
        `${origin === "ai" ? "AI 候选已入库" : "人工修订已保存"} → ${saved.path}（rev ${saved.summary_rev}；${origin === "human" ? "此后 AI 不得覆盖" : "rev 0 仍可被 AI 更新"}）`,
      );
    });

  const addFact = () =>
    guard(async () => {
      const keys = factKeys
        .split(/[,，、\s]+/)
        .map((item) => item.trim())
        .filter(Boolean);
      await api().memory.saveFact({
        keys,
        text: factText,
        ...(factWithSource && factChapter
          ? { provenance: { chapter_id: factChapter, start: factStart, end: factEnd } }
          : {}),
      });
      setFactKeys("");
      setFactText("");
      await refresh();
      setNotice("事实已登记（出处链随记录保存；正文改动后可检出失效）");
    });

  const removeFact = (id: string, baseHash: string) =>
    guard(async () => {
      await api().memory.deleteFact({ id, baseHash });
      await refresh();
      setNotice(`事实已删除：${id}`);
    });

  return (
    <div className="memory">
      <aside>
        <section className="panel">
          <h3>
            摘要目标 <span className="muted">卷 / 章（有正文素材）</span>
          </h3>
          <div className="muted">
            真源 memory/（{state?.summaries.length ?? 0} 条摘要已入库）· 当前项目 {state?.project_id ?? "-"}
          </div>
          <ul className="memory-targets">
            {(state?.targets ?? []).map((target) => {
              const key = `${target.layer}:${target.id}`;
              return (
                <li
                  key={key}
                  className={key === selectedKey ? "on" : ""}
                  onClick={() => {
                    setSelectedKey(key);
                    setCandidate("");
                    setLastRun(null);
                    setNotice(null);
                    setError(null);
                  }}
                >
                  <div>
                    <span className="badge">{LAYER_LABELS[target.layer] ?? target.layer}</span>
                    <strong>{target.title}</strong>
                    {target.volume_title && target.layer === "chapter_summary" && (
                      <span className="muted">（{target.volume_title}）</span>
                    )}
                  </div>
                  <div className="muted">
                    素材 {target.sourceChars} 字 ·{" "}
                    {target.hasSummary ? `已入库 rev ${target.summaryRev}` : "未建摘要"}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="panel">
          <h3>记录体检</h3>
          {(state?.findings ?? []).length === 0 && <p className="muted">无发现：命名空间与出处均通过。</p>}
          <ul className="issues">
            {(state?.findings ?? []).map((finding, index) => (
              <li key={`${finding.code}-${finding.record_id}-${index}`} className={finding.severity === "error" ? "error-text" : "warn"}>
                【{finding.severity}】{finding.message}
              </li>
            ))}
          </ul>
          {(state?.rejected ?? []).length > 0 && (
            <>
              <div className="muted">跨项目拒绝清单（不进入本项目记忆）：</div>
              <ul className="issues">
                {(state?.rejected ?? []).map((item) => (
                  <li key={item.path} className="error-text">
                    {item.record_id}（来自 {item.project_id}）——{item.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </aside>

      <section>
        <div className="panel">
          <div className="panel-title">
            <h3>
              摘要 <span className="muted">AI 候选不入库；采纳 / 人工修订才写 memory/</span>
            </h3>
            <button type="button" className="link" onClick={() => void refresh()}>
              刷新
            </button>
          </div>
          {!selected && <p className="muted">选择左侧目标开始。</p>}
          {selected && (
            <>
              <div className="muted">
                目标：{LAYER_LABELS[selected.layer]} · {selected.title} · 素材 {selected.sourceChars} 字
              </div>
              <div className="memory-summary-rev muted">
                {currentSummary
                  ? `已入库 · rev ${currentSummary.summary_rev} · 更新 ${currentSummary.updated_at.replace("T", " ").slice(0, 19)}${currentSummary.summary_rev > 0 ? "（人工已修订：AI 不得覆盖）" : "（AI 可更新）"}`
                  : "未入库：生成候选后经「采纳候选（AI 入库）」写入"}
              </div>
              <div className="ai-foot">
                <button type="button" className="primary" disabled={busy || selected.sourceChars === 0} onClick={() => void generate()}>
                  生成候选
                </button>
                {lastRun && <span className="muted">最近候选：{lastRun.provider_id} / {lastRun.model} · {lastRun.chars} 字</span>}
              </div>
              <textarea
                className="memory-candidate"
                rows={8}
                value={candidate}
                placeholder="AI 候选将出现在这里；也可直接手写摘要后保存人工修订"
                onChange={(event) => setCandidate(event.target.value)}
              />
              <div className="ai-foot">
                <button
                  type="button"
                  className="primary"
                  disabled={busy || candidate.trim() === ""}
                  onClick={() => void save("ai")}
                >
                  采纳候选（AI 入库）
                </button>
                <button type="button" disabled={busy || candidate.trim() === ""} onClick={() => void save("human")}>
                  保存人工修订
                </button>
                <span className="muted">人工修订后 rev+1：AI 不得再覆盖（红线保护）</span>
              </div>
            </>
          )}
          {notice && <div className="muted">{notice}</div>}
          {error && <div className="error-text">{error}</div>}
        </div>

        <div className="panel">
          <h3>
            事实级记忆台账 <span className="muted">带出处（chapter_id + 字符区间 + 摘录 hash）</span>
          </h3>
          {(state?.facts ?? []).length === 0 && <p className="muted">尚无事实记录：登记后可用于注入与一致性校验。</p>}
          <ul className="memory-facts">
            {(state?.facts ?? []).map((fact) => {
              const badge = PROVENANCE_LABELS[fact.provenance] ?? { text: "无出处", cls: "badge" };
              return (
                <li key={fact.id} className="memory-fact">
                  <div>
                    <strong>{fact.id}</strong>
                    <span className={badge.cls}>{badge.text}</span>
                    {fact.keys.map((key) => (
                      <span className="badge" key={key}>
                        {key}
                      </span>
                    ))}
                    <span className="spacer" />
                    <button type="button" className="link" disabled={busy} onClick={() => void removeFact(fact.id, fact.hash)}>
                      删除
                    </button>
                  </div>
                  <div className="muted">{fact.text.replace(/\n+/g, " ").slice(0, 160)}</div>
                  <div className="muted">
                    {fact.source
                      ? `出处：${fact.source.chapter_id} [${fact.source.start}, ${fact.source.end})${fact.provenance_note ? `——${fact.provenance_note}` : ""}`
                      : "手工登记（无出处）"}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="config-form">
            <div className="master-grid">
              <label className="field">
                <span>触发关键词（逗号分隔）</span>
                <input className="memory-fact-keys" value={factKeys} placeholder="如：林渊, 小渊" onChange={(event) => setFactKeys(event.target.value)} />
              </label>
              <label className="field">
                <span>出处章节</span>
                <select value={factChapter} onChange={(event) => setFactChapter(event.target.value)}>
                  {chapterTargets.map((target) => (
                    <option key={target.id} value={target.id}>
                      {target.title}（{target.sourceChars} 字）
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field">
              <span>事实正文</span>
              <textarea className="memory-fact-text" rows={2} value={factText} placeholder="一句话事实（如：林渊在第一章末获得玄铁令）" onChange={(event) => setFactText(event.target.value)} />
            </label>
            <div className="master-grid">
              <label className="field">
                <span>摘录区间 start</span>
                <input className="memory-fact-start" type="number" min={0} value={factStart} onChange={(event) => setFactStart(Number(event.target.value) || 0)} />
              </label>
              <label className="field">
                <span>摘录区间 end（不含）</span>
                <input className="memory-fact-end" type="number" min={0} value={factEnd} onChange={(event) => setFactEnd(Number(event.target.value) || 0)} />
              </label>
            </div>
            <label className="checkbox">
              <input type="checkbox" checked={factWithSource} onChange={(event) => setFactWithSource(event.target.checked)} />
              <span>登记出处（区间按正文字符下标；服务端读取正文计算摘录 hash）</span>
            </label>
            <button type="button" disabled={busy || factKeys.trim() === "" || factText.trim() === ""} onClick={() => void addFact()}>
              登记事实
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}