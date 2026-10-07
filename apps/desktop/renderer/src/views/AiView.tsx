import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AiConfigState,
  AiDraftTarget,
  AiModelPayload,
  AiStreamEvent,
  AiUsageEntryPayload,
  ContextPreviewPayload,
  DraftHintPayload,
} from "../../../src/shared/ipc";
import { api } from "../api";

/**
 * AI 副驾（S4/S5；T1-15 ~ T1-17）：
 * - AI 调用默认关闭（本地功能不受影响）；开启后展示 provider / key 就绪态；
 * - 上下文预览器：槽位 / 来源 / 字符数 / 稳定前缀断点（真实发给模型的内容可审计）；
 * - 流式生成 + 停止（AbortController）；结果以候选呈现，整段采纳（替换/追加）才写正文；
 * - AI 使用记录（生成 / 采纳）来自 .yushu/ai-usage.jsonl。
 */

interface GenerateResult {
  text: string;
  chars: number;
  aborted: boolean;
  providerId: string;
  model: string;
  usageId: string;
  hints: DraftHintPayload;
  usageText: string;
}

/** T3-1：模型层级与能力矩阵的展示标签（能力矩阵为「保守默认合并后」结果，UI 直接呈现） */
const TIER_LABELS: Record<string, string> = { small: "小模型", flagship: "旗舰", reasoning: "推理" };

const CAPABILITY_LABELS: { key: keyof AiModelPayload["capabilities"]; label: string }[] = [
  { key: "stream", label: "流式" },
  { key: "usage", label: "usage" },
  { key: "structured_output", label: "结构化" },
  { key: "tools", label: "tools" },
  { key: "reasoning", label: "推理" },
  { key: "vision", label: "视觉" },
  { key: "cache", label: "缓存" },
  { key: "batch", label: "批量" },
];

function capabilityLabels(capabilities: AiModelPayload["capabilities"]): string[] {
  return CAPABILITY_LABELS.filter((item) => Boolean(capabilities[item.key])).map((item) => item.label);
}

export function AiView() {
  const [enabled, setEnabled] = useState(false);
  const [config, setConfig] = useState<AiConfigState | null>(null);
  const [drafts, setDrafts] = useState<AiDraftTarget[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");
  const [task, setTask] = useState<"draft-first" | "continue">("draft-first");
  const [targetWords, setTargetWords] = useState(2000);
  const [instruction, setInstruction] = useState("");
  const [preview, setPreview] = useState<ContextPreviewPayload | null>(null);
  const [streamText, setStreamText] = useState("");
  const [streamChars, setStreamChars] = useState(0);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<GenerateResult | null>(null);
  const [fallbackNote, setFallbackNote] = useState<string | null>(null);
  const [usageList, setUsageList] = useState<AiUsageEntryPayload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const streamIdRef = useRef<string | null>(null);

  // 配置表单（主 Provider）
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKeyEnv, setApiKeyEnv] = useState("");
  const [sessionKey, setSessionKey] = useState("");
  const [keyProvider, setKeyProvider] = useState("");

  const selected = drafts.find((draft) => `${draft.volumeId}:${draft.chapterId}` === selectedKey) ?? null;

  const refreshConfig = useCallback(async () => {
    const state = await api().ai.config();
    setConfig(state);
    const primary = state.config.providers[0];
    if (primary) {
      setBaseUrl(primary.base_url);
      setModel(primary.models[0]?.name ?? "");
      setApiKeyEnv(primary.api_key_env ?? "");
    }
    setKeyProvider((prev) => prev || primary?.id || "");
    return state;
  }, []);

  const refreshDrafts = useCallback(async () => {
    const list = await api().ai.drafts();
    setDrafts(list);
    setSelectedKey((prev) =>
      prev && list.some((draft) => `${draft.volumeId}:${draft.chapterId}` === prev)
        ? prev
        : list[0]
          ? `${list[0].volumeId}:${list[0].chapterId}`
          : "",
    );
    return list;
  }, []);

  const refreshUsage = useCallback(async () => {
    setUsageList((await api().ai.usage()).entries);
  }, []);

  const refreshPreview = useCallback(
    async (target?: { volumeId: string; chapterId: string } | null) => {
      try {
        setError(null);
        setPreview(await api().ai.context(target ?? undefined));
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [],
  );

  useEffect(() => {
    void (async () => {
      try {
        await refreshConfig();
        await refreshDrafts();
        await refreshUsage();
        await refreshPreview(null);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [refreshConfig, refreshDrafts, refreshUsage, refreshPreview]);

  // 流式事件订阅（ai:event 单向推送）
  useEffect(() => {
    const off = api().ai.onEvent((event: AiStreamEvent) => {
      if (event.streamId !== streamIdRef.current) return;
      if (event.type === "delta") {
        setStreamText((prev) => prev + event.text);
        setStreamChars(event.chars);
      } else if (event.type === "fallback") {
        setFallbackNote(`provider「${event.providerId}」不可用，已降级：${event.reason}`);
      } else if (event.type === "done") {
        setRunning(false);
        setStreamText(event.text);
        setStreamChars(event.chars);
        setResult({
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
        });
        void refreshUsage();
      } else {
        setRunning(false);
        setError(`[${event.code}] ${event.message}`);
      }
    });
    return off;
  }, [refreshUsage]);

  const selectTarget = async (key: string) => {
    setSelectedKey(key);
    const draft = drafts.find((item) => `${item.volumeId}:${item.chapterId}` === key);
    if (draft) await refreshPreview({ volumeId: draft.volumeId, chapterId: draft.chapterId });
  };

  const start = async () => {
    if (!selected) return;
    setRunning(true);
    setStreamText("");
    setStreamChars(0);
    setResult(null);
    setError(null);
    setNotice(null);
    setFallbackNote(null);
    // 先确定 streamId，再订阅事件（避免首个增量与 invoke 返回值的竞态）
    const streamId = `ai-${crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 8) : Math.random().toString(36).slice(2, 10)}`;
    streamIdRef.current = streamId;
    try {
      await api().ai.start({
        streamId,
        volumeId: selected.volumeId,
        chapterId: selected.chapterId,
        task,
        targetWords,
        ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
      });
      setNotice(`生成已开始（streamId ${streamId}）——候选不会写入正文`);
    } catch (err) {
      setRunning(false);
      setError((err as Error).message);
    }
  };

  const stop = async () => {
    if (!streamIdRef.current) return;
    await api().ai.abort(streamIdRef.current);
    setNotice("已请求停止：已生成部分将保留为候选");
  };

  const adopt = async (mode: "replace" | "append") => {
    if (!result || !selected) return;
    if (
      mode === "replace" &&
      selected.hasBody &&
      !confirm("替换将覆盖该章节现有正文（覆盖前会自动创建「破坏前」快照，可整体回退），确定继续？")
    ) {
      return;
    }
    try {
      setError(null);
      const adopted = await api().ai.adopt({
        usageId: result.usageId,
        volumeId: selected.volumeId,
        chapterId: selected.chapterId,
        text: result.text,
        mode,
      });
      setNotice(
        `已${mode === "replace" ? "替换" : "追加"}采纳 → ${adopted.chapterPath}（${adopted.wordCount} 字，baseHash 并发检测通过）`,
      );
      await refreshDrafts();
      await refreshUsage();
      await refreshPreview({ volumeId: selected.volumeId, chapterId: selected.chapterId });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveConfig = async () => {
    if (!config) return;
    try {
      setError(null);
      const providers = config.config.providers.map((provider, index) =>
        index === 0
          ? {
              ...provider,
              base_url: baseUrl.trim(),
              models: provider.models.map((item, modelIndex) =>
                modelIndex === 0 ? { ...item, name: model.trim() } : item,
              ),
              ...(apiKeyEnv.trim() ? { api_key_env: apiKeyEnv.trim() } : { api_key_env: undefined }),
            }
          : provider,
      );
      const saved = await api().ai.saveConfig({
        providers,
        ...(config.hash ? { baseHash: config.hash } : {}),
      });
      setConfig(saved);
      setNotice(`配置已保存 → ${saved.path}（明文 Key 禁止落盘，请用环境变量或会话 Key）`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveSessionKey = async () => {
    try {
      setError(null);
      await api().ai.setKey(keyProvider, sessionKey);
      setSessionKey("");
      await refreshConfig();
      setNotice(`会话 Key 已写入内存（provider：${keyProvider}）；关闭应用即失效，不落盘`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="ai">
      <aside>
        <section className="panel">
          <h3>
            AI 副驾开关 <span className="muted">默认关闭</span>
          </h3>
          <label className="checkbox">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            <span>启用 AI 调用（关闭时本地功能不受影响；生成属于唯一联网步骤）</span>
          </label>
        </section>

        <section className="panel">
          <h3>
            Provider <span className="muted">{config?.exists ? "config/llm.yaml" : "内置默认（未落盘）"}</span>
          </h3>
          {(config?.config.providers ?? []).map((provider) => {
            const keyState = config?.keyStates.find((state) => state.provider_id === provider.id);
            return (
              <div className="provider" key={provider.id}>
                <div className="pack-title">
                  <strong>{provider.id}</strong>
                  <span className="badge">{provider.kind === "local" ? "本地" : "云端"}</span>
                  <span className="badge">{provider.protocol}</span>
                  <span className={keyState?.ready ? "badge good" : "badge bad"}>
                    {keyState?.ready ? "可用" : "缺少 Key"}
                  </span>
                </div>
                {provider.models.map((item) => (
                  <div className="muted" key={item.name}>
                    {item.name} · {TIER_LABELS[item.tier] ?? item.tier} ·{" "}
                    {capabilityLabels(item.capabilities).join(" / ") || "—"}
                    {item.limits?.context ? ` · 上下文 ${item.limits.context}` : ""}
                  </div>
                ))}
                <div className="muted">{provider.base_url}</div>
                {provider.api_key_env && (
                  <div className="muted">
                    Key 来源：环境变量 {provider.api_key_env}
                    {keyState?.has_session_key ? " / 会话 Key 已设置" : ""}
                  </div>
                )}
              </div>
            );
          })}
          <div className="config-form">
            <label className="field">
              <span>主 Provider base_url</span>
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
            </label>
            <label className="field">
              <span>主 Provider model</span>
              <input value={model} onChange={(event) => setModel(event.target.value)} />
            </label>
            <label className="field">
              <span>API Key 环境变量名（留空=无鉴权，如本地端点）</span>
              <input value={apiKeyEnv} onChange={(event) => setApiKeyEnv(event.target.value)} placeholder="YUSHU_LLM_API_KEY" />
            </label>
            <button type="button" onClick={saveConfig}>
              保存 Provider 配置
            </button>
          </div>
          <div className="config-form">
            <div className="master-grid">
              <label className="field">
                <span>会话 Key 所属 provider</span>
                <select value={keyProvider} onChange={(event) => setKeyProvider(event.target.value)}>
                  {(config?.config.providers ?? []).map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.id}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field grow">
                <span>会话 Key（仅存内存，不落盘）</span>
                <input
                  type="password"
                  value={sessionKey}
                  onChange={(event) => setSessionKey(event.target.value)}
                  placeholder="sk-..."
                />
              </label>
            </div>
            <button type="button" disabled={sessionKey.trim() === ""} onClick={saveSessionKey}>
              设置会话 Key
            </button>
          </div>
        </section>

        <section className="panel">
          <h3>
            生成目标 <span className="muted">{drafts.length} 个草稿章节</span>
          </h3>
          {drafts.length === 0 && (
            <p className="muted">
              尚无草稿章节：请先在「三级大纲」为章纲点击「创建草稿章节」，采纳才有可写入的正文文件。
            </p>
          )}
          <ul className="draft-list">
            {drafts.map((draft) => {
              const key = `${draft.volumeId}:${draft.chapterId}`;
              return (
                <li key={key} className={key === selectedKey ? "on" : ""} onClick={() => void selectTarget(key)}>
                  <div>
                    <strong>{draft.title}</strong>
                    <span className="muted">{draft.volumeTitle}</span>
                  </div>
                  <div className="muted">
                    {draft.chapterPath} · {draft.wordCount} 字{draft.hasBody ? "" : "（空正文）"}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="master-grid">
            <label className="field">
              <span>任务类型</span>
              <select value={task} onChange={(event) => setTask(event.target.value as "draft-first" | "continue")}>
                <option value="draft-first">按细纲写出初稿</option>
                <option value="continue">续写已有正文</option>
              </select>
            </label>
            <label className="field">
              <span>目标字数</span>
              <input
                type="number"
                min={300}
                max={6000}
                step={100}
                value={targetWords}
                onChange={(event) => setTargetWords(Number(event.target.value) || 2000)}
              />
            </label>
          </div>
          <label className="field">
            <span>附加要求（可选）</span>
            <textarea
              rows={2}
              value={instruction}
              placeholder="如：开篇 200 字内进入冲突，不要复述设定"
              onChange={(event) => setInstruction(event.target.value)}
            />
          </label>
        </section>
      </aside>

      <section>
        <div className="panel">
          <div className="panel-title">
            <h3>
              上下文预览器 <span className="muted">T1-13/14：真实发给模型的槽位</span>
            </h3>
            <button
              type="button"
              className="link"
              onClick={() => void refreshPreview(selected ? { volumeId: selected.volumeId, chapterId: selected.chapterId } : null)}
            >
              刷新预览
            </button>
          </div>
          {preview && (
            <>
              <div className="muted">
                稳定前缀 {preview.stableChars} 字符（断点：{preview.cacheBreakpointAfter} 之后）· 总计{" "}
                {preview.totalChars} 字符 · 设定卡 {preview.cardIndex.length} 张
                {preview.target ? ` · 目标：${preview.target.chapterPath || "（该章纲尚未创建草稿章节）"}` : ""}
              </div>
              <table className="slot-table">
                <thead>
                  <tr>
                    <th>槽位</th>
                    <th>稳定</th>
                    <th>来源</th>
                    <th>字符</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.slots.map((slot) => (
                    <tr key={slot.slot}>
                      <td>{slot.slot}</td>
                      <td>{slot.stable ? "✓ 前缀" : "易变"}</td>
                      <td className="muted">{slot.source}</td>
                      <td>
                        {slot.chars}
                        {slot.truncated ? "（截断）" : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <details className="extensions">
                <summary className="muted">展开槽位全文（可审计）</summary>
                {preview.slots.map((slot) => (
                  <div key={slot.slot}>
                    <strong>{slot.slot}</strong>
                    <pre>{slot.text || "（空）"}</pre>
                  </div>
                ))}
              </details>
            </>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">
            <h3>
              候选正文 <span className="muted">生成结果不写正文，采纳后才落盘</span>
            </h3>
            <span>
              {running ? (
                <button type="button" onClick={stop}>
                  停止生成
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  disabled={!enabled || !selected || !config?.canGenerate}
                  title={!enabled ? "请先开启 AI 调用" : !config?.canGenerate ? "缺少可用的 provider Key" : ""}
                  onClick={start}
                >
                  开始生成
                </button>
              )}
            </span>
          </div>
          {!enabled && <p className="muted">AI 默认关闭：开启后可流式生成；离线时其余功能不受影响。</p>}
          {fallbackNote && <div className="warn">{fallbackNote}</div>}
          <div className="candidate">
            {streamText || (running ? "（等待首个增量…）" : "（尚无候选内容）")}
          </div>
          {running && <div className="muted">已生成 {streamChars} 字…</div>}
          {result && (
            <>
              <div className="muted">
                {result.aborted ? "已停止（保留已生成部分）" : "生成完成"} · {result.providerId || "-"} /{" "}
                {result.model || "-"} · {result.chars} 字 · {result.usageText}
              </div>
              {result.hints.hints.length > 0 && (
                <ul className="issues">
                  {result.hints.hints.map((hint) => (
                    <li key={hint} className="warn">
                      轻提示：{hint}
                    </li>
                  ))}
                </ul>
              )}
              {result.hints.referenced.length > 0 && (
                <div className="muted">命中设定：{result.hints.referenced.join("、")}</div>
              )}
              <div className="ai-foot">
                <button type="button" className="primary" disabled={!selected} onClick={() => void adopt("replace")}>
                  整段采纳（替换正文）
                </button>
                <button type="button" disabled={!selected} onClick={() => void adopt("append")}>
                  追加到正文
                </button>
                <span className="muted">采纳会写入章节文件并记录 usage_id</span>
              </div>
            </>
          )}
          {notice && <div className="muted">{notice}</div>}
          {error && <div className="error-text">{error}</div>}
        </div>

        <div className="panel">
          <h3>
            AI 使用记录 <span className="muted">.yushu/ai-usage.jsonl（证据链，T1-17）</span>
          </h3>
          {usageList.length === 0 && <p className="muted">尚无记录：每次生成与采纳会各留一条事件。</p>}
          <ul className="usage-list">
            {usageList.map((entry) => (
              <li key={`${entry.id}-${entry.time}`}>
                <span className={entry.status === "error" ? "error-text" : entry.status === "aborted" ? "warn" : ""}>
                  {entry.type === "generate" ? "生成" : "采纳"}
                </span>
                <span className="muted">
                  {entry.time.replace("T", " ").slice(0, 19)} · {entry.model ?? "-"} · {entry.status ?? "ok"} ·{" "}
                  {entry.chars ?? 0} 字
                  {entry.usage_id ? ` · 关联 ${entry.usage_id}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </div>
  );
}