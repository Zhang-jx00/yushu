import { useCallback, useEffect, useState } from "react";
import type {
  InjectionConfigPayload,
  MemoryAssemblyResult,
  MemoryInjectionPreviewResult,
  MemoryRagPreviewResult,
  MemoryStatePayload,
  MemoryTargetPayload,
  MemorySummarizeResult,
} from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * 记忆页（M3 / T3-5 五层记忆的管理界面；T3-6 注入控制；T3-7 上下文组装；T3-8 RAG 检索）：
 * - 摘要目标（卷 / 章）：AI 生成候选（**不入库**）→ 采纳（AI 入库，rev 0）或人工修订（rev+1）；
 *   `summary_rev > 0` 后 AI 再入库被拒（E_MEMORY_REV_PROTECTED——人工修订受保护）；
 * - 事实级记忆台账：带出处徽标（出处有效 / 出处失效 / 无出处——正文改动后可检出失效）
 *   与注入配置（mode / priority / position / budget_tokens / reveal_gate）；
 * - 注入预演（T3-6）：对指定章节输出注入计划（决策 + 命中键 + 排除原因 + token 估算）；
 * - 组装预演（T3-7）：固定槽位顺序 + 槽位 cap + 全局预算裁剪 + 去重（逐出 / 截断证据）；
 * - RAG 检索预演（T3-8）：向量路（sqlite-vec / 本地余弦兜底）与关键词路（FTS5 bm25）并行 →
 *   RRF(k=60) 融合 → 可选重排 top-6；结果带出处（chapter_id + 字符区间 + hash）；
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

  // 组装预演（T3-7）
  const [assemblyBudget, setAssemblyBudget] = useState(32000);
  const [assembly, setAssembly] = useState<MemoryAssemblyResult | null>(null);

  // RAG 检索预演（T3-8）
  const [ragQuery, setRagQuery] = useState("");
  const [ragRerank, setRagRerank] = useState(true);
  const [rag, setRag] = useState<MemoryRagPreviewResult | null>(null);

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

  const runAssembly = () =>
    guard(async () => {
      if (!previewTarget) return;
      setNotice(null);
      setAssembly(await api().memory.assemble({ chapterId: previewTarget, budget_total: assemblyBudget }));
    });

  const runRag = () =>
    guard(async () => {
      if (!previewTarget) return;
      setNotice(null);
      const query = ragQuery.trim();
      setRag(
        await api().memory.ragPreview({
          chapterId: previewTarget,
          ...(query !== "" ? { query } : {}),
          ...(ragRerank ? { rerankTopK: 6 } : {}),
        }),
      );
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

        <div className="panel">
          <h3>
            组装预演 <span className="muted">T3-7：固定槽位顺序 + 槽位 cap + 全局预算裁剪 + 去重</span>
          </h3>
          <div className="master-grid">
            <label className="field">
              <span>目标章节</span>
              <select className="memory-assemble-target" value={previewTarget} onChange={(event) => setPreviewTarget(event.target.value)}>
                {chapterTargets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.title}（{target.sourceChars} 字）
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>总预算（token 估算）</span>
              <input
                className="memory-assemble-budget"
                type="number"
                min={10}
                max={200000}
                value={assemblyBudget}
                onChange={(event) => setAssemblyBudget(Number(event.target.value) || 32000)}
              />
            </label>
            <button type="button" className="primary" disabled={busy || !previewTarget} onClick={() => void runAssembly()}>
              组装预演
            </button>
          </div>
          {!assembly && (
            <p className="muted">
              槽位顺序：system_prompt → world_core → volume_summary → chapter_summary → triggered_cards → facts → rag_chunks →
              recent_prose；预算超限按 priority_then_recent 逐出（低价值槽位先出）。
            </p>
          )}
          {assembly && (
            <>
              <div className="muted assembly-preview">
                第 {assembly.chapterOrdinal} 章「{assembly.chapterTitle}」· 合计 {assembly.totalTokens} token / 预算{" "}
                {assembly.budget_total} · 稳定前缀 {assembly.stableTokens} token · 截断 {assembly.truncatedItems} 条 · 去重{" "}
                {assembly.dedup.by_id + assembly.dedup.by_similarity} 条（id {assembly.dedup.by_id} / 相似 {assembly.dedup.by_similarity}）
              </div>
              {assembly.rag && (
                <div className="muted assembly-preview-rag">
                  RAG 槽位（T3-8）：
                  {assembly.rag.status === "ok"
                    ? `命中 ${assembly.rag.hits} 条进 rag_chunks（向量实现 ${assembly.rag.store === "sqlite-vec" ? "sqlite-vec" : "本地余弦兜底"}）· 查询「${assembly.rag.query.slice(0, 60)}${assembly.rag.query.length > 60 ? "…" : ""}」`
                    : `跳过——${assembly.rag.note ?? "未检索"}`}
                </div>
              )}
              <table className="slot-table assembly-slots">
                <thead>
                  <tr>
                    <th>槽位</th>
                    <th>模式</th>
                    <th>条目</th>
                    <th>token / cap</th>
                    <th>状态</th>
                  </tr>
                </thead>
                <tbody>
                  {assembly.slots.map((slot) => (
                    <tr key={slot.slot} className="assembly-slot-row">
                      <td>{slot.slot}</td>
                      <td className="muted">{slot.mode}</td>
                      <td>{slot.items.length}</td>
                      <td>
                        {slot.tokens} / {slot.cap_tokens}
                      </td>
                      <td>{slot.truncated ? "截断" : slot.items.length === 0 ? "—" : "ok"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {assembly.dropped.length > 0 && (
                <ul className="assembly-drop">
                  {assembly.dropped.slice(0, 12).map((item, index) => (
                    <li key={`${item.id}-${index}`} className="muted">
                      【{item.reason}】{item.id}（{item.slot}）——{item.detail}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        <div className="panel">
          <h3>
            RAG 检索预演{" "}
            <span className="muted">T3-8：向量路（sqlite-vec；扩展不可用回退本地确定性嵌入）+ 关键词路（FTS5 bm25）并行 → RRF(k=60) 融合 → 可选重排 top-6；结果带出处</span>
          </h3>
          <div className="master-grid">
            <label className="field">
              <span>目标章节</span>
              <select className="memory-rag-target" value={previewTarget} onChange={(event) => setPreviewTarget(event.target.value)}>
                {chapterTargets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.title}（{target.sourceChars} 字）
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>查询词（留空 = 自动：章纲 + 最近正文尾部）</span>
              <input
                className="memory-rag-query"
                value={ragQuery}
                placeholder="如：林渊 玄铁令"
                onChange={(event) => setRagQuery(event.target.value)}
              />
            </label>
          </div>
          <div className="ai-foot">
            <label className="checkbox">
              <input type="checkbox" checked={ragRerank} onChange={(event) => setRagRerank(event.target.checked)} />
              <span>启用重排（本地启发式 top-6；bge-reranker 为后续替换点）</span>
            </label>
            <button type="button" className="primary" disabled={busy || !previewTarget} onClick={() => void runRag()}>
              检索预演
            </button>
          </div>
          {!rag && (
            <p className="muted">
              两路并行召回（各 top-50）→ RRF 融合取 top-20 → 重排至 top-6；结果为「出处（chapter_id · 字符区间 · 块 hash）+ 段落」
              供组装与核对。检索依赖索引：请先在「项目文件」页重建索引。
            </p>
          )}
          {rag && (
            <>
              <div className="muted rag-preview">
                查询「{rag.query}」（{rag.querySource === "custom" ? "自定义" : "自动"}）· 向量路 {rag.paths.vector} 条 / 关键词路{" "}
                {rag.paths.keyword} 条 · 融合 {rag.fused.length} 条{rag.reranked.length > 0 ? ` → 重排 ${rag.reranked.length} 条` : ""} ·
                向量实现 {rag.store === "sqlite-vec" ? "sqlite-vec" : `本地余弦兜底（${rag.dim} 维）`} · 向量库存量 {rag.vectorRows}
              </div>
              <div className="muted rag-note">
                {rag.storeNote}
                {rag.repairedVectors > 0 ? `（本次惰性补齐向量 ${rag.repairedVectors} 条）` : ""}
              </div>
              <table className="slot-table rag-hits">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>出处（章节 · 区间 · hash）</th>
                    <th>段落</th>
                    <th>向量路</th>
                    <th>关键词路</th>
                    <th>融合分</th>
                    <th>重排</th>
                  </tr>
                </thead>
                <tbody>
                  {(rag.reranked.length > 0 ? rag.reranked : rag.fused).map((hit) => (
                    <tr key={hit.chunkId} className="rag-hit-row">
                      <td>{hit.rerank ? hit.rerank.rank : hit.rank}</td>
                      <td className="muted">
                        {hit.chapterId ?? hit.path} · [{hit.charStart}, {hit.charEnd}) · {hit.textHash.slice(0, 8)}
                      </td>
                      <td>{hit.text.replace(/\s+/g, " ").slice(0, 60)}</td>
                      <td className="muted">{hit.sources.vector ? `#${hit.sources.vector.rank} · ${hit.sources.vector.score.toFixed(3)}` : "—"}</td>
                      <td className="muted">{hit.sources.keyword ? `#${hit.sources.keyword.rank} · ${hit.sources.keyword.score.toFixed(2)}` : "—"}</td>
                      <td>{hit.score.toFixed(4)}</td>
                      <td className="muted">{hit.rerank ? `#${hit.rerank.rank} · ${hit.rerank.score.toFixed(3)}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {rag.reranked.length > 0 && rag.reranked[0]?.rerank && (
                <div className="muted">重排依据（首条）：{rag.reranked[0].rerank.reason}</div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}