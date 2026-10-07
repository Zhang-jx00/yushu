import { useCallback, useEffect, useState } from "react";
import type {
  InjectionConfigPayload,
  MemoryInjectionPreviewResult,
  MemoryStatePayload,
  MemoryTargetPayload,
  MemorySummarizeResult,
} from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 记忆页（M3 / T3-5 五层记忆的管理界面；T3-6 注入控制）：
 * - 摘要目标（卷 / 章）：AI 生成候选（**不入库**）→ 采纳（AI 入库，rev 0）或人工修订（rev+1）；
 *   `summary_rev > 0` 后 AI 再入库被拒（E_MEMORY_REV_PROTECTED——人工修订受保护）；
 * - 事实级记忆台账：带出处徽标（出处有效 / 出处失效 / 无出处——正文改动后可检出失效）
 *   与注入配置（mode / priority / position / budget_tokens / reveal_gate）；
 * - 注入预演（T3-6）：对指定章节输出注入计划（决策 + 命中键 + 排除原因 + token 估算）；
 * - 记录体检（findings）与跨项目拒绝清单（error 红线仅展示、不进入本项目记忆）。
 */

const LAYER_LABELS: Record<string, string> = {
  volume_summary: "卷摘要",
  chapter_summary: "章摘要",
};

const POSITION_LABELS: Record<string, string> = {
  after_system: "系统后",
  near_start: "靠前",
  near_end: "靠后",
};

const PROVENANCE_LABELS: Record<string, { text: string; cls: string }> = {
  ok: { text: "出处有效", cls: "badge good" },
  broken: { text: "出处失效", cls: "badge bad" },
  none: { text: "无出处", cls: "badge" },
};

function injectionSummary(injection: InjectionConfigPayload): string {
  return `注入：${injection.mode} · 优先级 ${injection.priority} · ${injection.position} · ${injection.budget_tokens} token${injection.reveal_gate ? ` · 门控 ${injection.reveal_gate}` : ""}`;
}

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

  // 事实注入配置（T3-6）
  const [factMode, setFactMode] = useState<InjectionConfigPayload["mode"]>("trigger");
  const [factPriority, setFactPriority] = useState(50);
  const [factPosition, setFactPosition] = useState<InjectionConfigPayload["position"]>("near_end");
  const [factBudget, setFactBudget] = useState(400);
  const [factGate, setFactGate] = useState("");

  // 注入预演（T3-6）
  const [previewTarget, setPreviewTarget] = useState("");
  const [preview, setPreview] = useState<MemoryInjectionPreviewResult | null>(null);

  const refresh = useCallback(async () => {
    const next = await api().memory.state();
    setState(next);
    setSelectedKey((prev) => (prev && next.targets.some((item) => `${item.layer}:${item.id}` === prev) ? prev : firstTargetKey(next)));
    const fallbackChapter = next.targets.find((item) => item.layer === "chapter_summary" && item.sourceChars > 0)?.id ?? "";
    setFactChapter((prev) => (prev && next.targets.some((item) => item.id === prev && item.layer === "chapter_summary") ? prev : fallbackChapter));
    setPreviewTarget((prev) => (prev && next.targets.some((item) => item.id === prev && item.layer === "chapter_summary") ? prev : fallbackChapter));
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
        injection: {
          mode: factMode,
          priority: factPriority,
          position: factPosition,
          budget_tokens: factBudget,
          ...(factGate ? { reveal_gate: factGate } : {}),
        },
      });
      setFactKeys("");
      setFactText("");
      await refresh();
      setNotice("事实已登记（出处链与注入配置随记录保存；正文改动后可检出失效）");
    });

  const runPreview = () =>
    guard(async () => {
      if (!previewTarget) return;
      setNotice(null);
      setPreview(await api().memory.injectionPreview({ chapterId: previewTarget }));
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
                  <div className="muted memory-fact-injection">{injectionSummary(fact.injection)}</div>
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
            <div className="master-grid">
              <label className="field">
                <span>注入模式（T3-6）</span>
                <select className="memory-fact-mode" value={factMode} onChange={(event) => setFactMode(event.target.value as InjectionConfigPayload["mode"])}>
                  <option value="trigger">trigger（命中关键词才注入）</option>
                  <option value="always">always（常驻）</option>
                  <option value="manual">manual（手动清单）</option>
                </select>
              </label>
              <label className="field">
                <span>优先级（0-100，预算耗尽高者先留）</span>
                <input className="memory-fact-priority" type="number" min={0} max={100} value={factPriority} onChange={(event) => setFactPriority(Number(event.target.value) || 0)} />
              </label>
            </div>
            <div className="master-grid">
              <label className="field">
                <span>落位</span>
                <select value={factPosition} onChange={(event) => setFactPosition(event.target.value as InjectionConfigPayload["position"])}>
                  <option value="after_system">after_system（系统后）</option>
                  <option value="near_start">near_start（靠前）</option>
                  <option value="near_end">near_end（靠后）</option>
                </select>
              </label>
              <label className="field">
                <span>单项预算（token 估算）</span>
                <input type="number" min={1} max={32768} value={factBudget} onChange={(event) => setFactBudget(Number(event.target.value) || 1)} />
              </label>
            </div>
            <label className="field">
              <span>叙事可见性门控（早于该章不注入——防剧透；留空=无门控）</span>
              <select className="memory-fact-gate" value={factGate} onChange={(event) => setFactGate(event.target.value)}>
                <option value="">（无门控）</option>
                {chapterTargets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.title}
                  </option>
                ))}
              </select>
            </label>
            <button type="button" disabled={busy || factKeys.trim() === "" || factText.trim() === ""} onClick={() => void addFact()}>
              登记事实
            </button>
          </div>
        </div>

        <div className="panel">
          <h3>
            注入预演 <span className="muted">T3-6：对指定章节的注入决策与排除原因（token 估算）</span>
          </h3>
          <div className="master-grid">
            <label className="field">
              <span>目标章节</span>
              <select className="memory-preview-target" value={previewTarget} onChange={(event) => setPreviewTarget(event.target.value)}>
                {chapterTargets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.title}（{target.sourceChars} 字）
                  </option>
                ))}
              </select>
            </label>
            <button type="button" className="primary" disabled={busy || !previewTarget} onClick={() => void runPreview()}>
              注入预演
            </button>
          </div>
          {!preview && <p className="muted">对所选章节执行五层记忆的注入决策：摘要常驻、事实与设定卡按关键词触发、门控未到不注入。</p>}
          {preview && (
            <>
              <div className="muted injection-preview">
                第 {preview.chapterOrdinal} 章「{preview.chapterTitle}」· 触发文本 {preview.mentionChars} 字 · 注入{" "}
                {preview.totals.injected} 条 / 排除 {preview.totals.excluded} 条 · 合计 {preview.totals.tokens} token（估算）
              </div>
              <ul className="injection-entries">
                {preview.entries.map((entry) => (
                  <li key={entry.id} className="injection-entry">
                    <div>
                      <span className="badge">{POSITION_LABELS[entry.position] ?? entry.position}</span>
                      <span className="badge">优先级 {entry.priority}</span>
                      <span className="badge">{entry.mode}</span>
                      <strong>{entry.title}</strong>
                      <span className="muted">
                        {entry.tokens} token{entry.truncated ? "（截断）" : ""}
                      </span>
                    </div>
                    <div className="muted">
                      {entry.reason}
                      {entry.matched_keys.length > 0 ? ` · 命中键：${entry.matched_keys.join("、")}` : ""}
                    </div>
                    <div className="muted">{entry.text.replace(/\n+/g, " ").slice(0, 140)}</div>
                  </li>
                ))}
              </ul>
              {preview.excluded.length > 0 && (
                <ul className="injection-excluded">
                  {preview.excluded.map((item) => (
                    <li key={item.id} className="muted">
                      【{item.code}】{item.title}——{item.reason}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}