import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AiCostPanelPayload,
  AiConfigState,
  AiDraftTarget,
  AiModelPayload,
  AiProviderKeyState,
  AiProviderPayload,
  AiRoutingState,
  AiStreamEvent,
  AiUsageEntryPayload,
  ContextPreviewPayload,
  CostCacheAuditPayload,
  CostRowPayload,
  DraftHintPayload,
} from "../../../src/shared/ipc";
import { api } from "../api";
import { TypewriterBuffer, type TypewriterMode } from "../typewriter-buffer";
import { diffSentences, mergeSelected, splitSentences } from "../candidate-diff";
import { REJECT_REASON_PRESETS, type AiFeedbackState } from "../../../src/shared/ipc";

/**
 * AI 副驾（S4/S5；T1-15 ~ T1-17；M3/T3-11 写作 UX）：
 * - AI 调用默认关闭（本地功能不受影响）；开启后展示 provider / key 就绪态；
 * - **Provider 密钥（T3-14，K12）**：三态展示（已加密保存 / 仅本次会话 / 环境变量 / 无需鉴权 / 未配置）+
 *   加密保存与清除凭据；加密后端不可用时禁用保存（宁可禁用也不降级存明文）；
 * - 上下文预览器：槽位 / 来源 / 字符数 / 稳定前缀断点（真实发给模型的内容可审计）；
 * - 流式生成 + 停止（AbortController）；**chunk 缓冲 + rAF 打字机**（匀速 / 瞬时两档）渲染候选；
 * - **多候选对比（J15）**：N 个候选独立生成（「不得互相参照」标记）→ 句级 diff 对照草稿 →
 *   整段 / 追加 / **按句局部采纳**；拒绝 → 预置原因标签记录（.yushu/ai-feedback.jsonl，统计展示）；
 * - 批量任务半价通道规划展示（T3-11，J08/J09：outline / summarize / extract）；
 * - **Token 与成本面板（T3-12，J09）**：usage 实报 + 本地估算双口径聚合（按任务 / 按模型分解、预估 vs 实付偏差、
 *   定价表状态、稳定前缀缓存编排核对）；金额与偏差文本全部由主进程下发，渲染层不再自造格式化口径；
 * - 结果以候选呈现，显式采纳才写正文；AI 使用记录来自 .yushu/ai-usage.jsonl。
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
  streamId: string;
}

/** 多候选条目（T3-11）：生成结果 + 候选序号 + 采纳 / 拒绝处置状态 */
interface CandidateEntry extends GenerateResult {
  index: number;
  total: number;
  adopted?: "replace" | "append";
  rejected?: boolean;
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

const CAPABILITY_LABEL_MAP: Record<string, string> = Object.fromEntries(
  CAPABILITY_LABELS.map((item) => [item.key, item.label]),
);

/** T3-2：任务路由摘要（以 drafting 为例；可靠性三项：重试 / 冷却 / 并发） */
function routingSummary(routing: AiRoutingState): string {
  const drafting = routing.routes.find((route) => route.task === "drafting");
  const prefer = (drafting?.prefer ?? []).map((tier) => TIER_LABELS[tier] ?? tier).join(" / ") || "默认";
  const require = (drafting?.require ?? []).map((key) => CAPABILITY_LABEL_MAP[key] ?? key).join(" / ");
  const rateLimit = routing.reliability.retry_policy.find((rule) => rule.kind === "RateLimitError");
  return `路由（${routing.exists ? routing.path : "内置默认"}）：drafting → ${prefer}${require ? `（require：${require}）` : ""} · 重试 ${rateLimit?.max_retries ?? routing.reliability.num_retries} · 冷却 ${routing.reliability.cooldown.cooldown_s}s · 并发 ${routing.reliability.concurrency.global}`;
}

/** 成本面板回执行（预演脚本按包含匹配断言）：金额与偏差一律用主进程下发的展示文本 */
function costReceiptLine(totals: CostRowPayload): string {
  return `成本面板：合计 ${totals.costText}｜输入 ${totals.promptTokens} tok｜偏差 ${totals.deviationText}`;
}

/**
 * 密钥三态措辞（T3-14）：按取值优先级取一条显示——
 * 凭据库密文 > 会话内存 > 环境变量；三者皆无且该 provider 本就无需鉴权则显示「无需鉴权」。
 * 判定依据全部来自 keyStates（主进程下发），渲染层不猜。
 */
function keyStateText(state: AiProviderKeyState | undefined): string {
  if (!state) return "未配置";
  if (state.has_stored_key) return "已加密保存";
  if (state.has_session_key) return "仅本次会话";
  if (state.has_env_key) return `环境变量 ${state.api_key_env ?? ""}`.trim();
  if (!state.api_key_env && !state.key_ref) return "无需鉴权";
  return "未配置";
}

/** 后端不可用时的说明（宁可禁用也不降级存明文）：文案含 safeStorage 与「不会写明文」 */
const KEY_BACKEND_UNAVAILABLE_NOTE =
  "加密后端不可用：本机 safeStorage 未就绪，无法加密保存，也不会写明文到磁盘。请改用「会话 Key」或 api_key_env 环境变量";

/** 成本分解表（按任务 / 按模型同构，共用一份列定义——避免两处口径漂移） */
function CostBreakdownTable({ rows, keyLabel }: { rows: CostRowPayload[]; keyLabel: string }) {
  if (rows.length === 0) return <p className="muted">暂无可分解的模型调用记录。</p>;
  return (
    <table className="slot-table">
      <thead>
        <tr>
          <th>{keyLabel}</th>
          <th>条数</th>
          <th>输入</th>
          <th>输出</th>
          <th>命中缓存</th>
          <th>写缓存</th>
          <th>金额</th>
          <th>预估 vs 实付</th>
          <th>未配置价格</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <td>{row.key}</td>
            <td>{row.entries}</td>
            <td>{row.promptTokens}</td>
            <td>{row.completionTokens}</td>
            <td>{row.cachedTokens}</td>
            <td>{row.cacheWriteTokens}</td>
            <td>{row.costText}</td>
            <td>{row.deviationText}</td>
            <td className={row.unpricedEntries > 0 ? "warn" : "muted"}>
              {row.unpricedEntries > 0 ? `${row.unpricedEntries} 条` : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** 稳定前缀编排核对区（只读）：断点、错位槽位、缓存声明与节省投影全部来自 cache 载荷 */
function CostCacheAudit({ cache }: { cache: CostCacheAuditPayload }) {
  return (
    <div className="ai-cost-cache">
      <div className="muted">
        核对对象 {cache.target}
        {cache.chapter_id ? ` · 章节 ${cache.chapter_id}` : ""} · 断点置于「{cache.breakpointAfter}」之后（下标{" "}
        {cache.breakpointIndex}
        {cache.breakpointIndex === -1 ? "：断点槽位不在组装清单中" : ""}）
      </div>
      <div className={cache.ordered ? "muted" : "warn"}>
        编排：
        {cache.ordered
          ? "✓ 稳定在前、易变在后"
          : `✗ 已击穿——错位槽位：${cache.misplaced.join("、") || "（未给出明细）"}`}
      </div>
      <div className="muted">
        稳定前缀 {cache.stableTokens} tok · 易变 {cache.unstableTokens} tok · 缓存能力
        {cache.cacheDeclared ? `已声明（模式 ${cache.cacheMode ?? "未标注"}）` : "未声明（不会命中折扣）"} · 节省{" "}
        {cache.savingText}
      </div>
      {cache.belowMinTokens && (
        <div className="warn">稳定前缀未达 provider 的缓存门槛：按当前编排不会命中</div>
      )}
      {cache.warnings.length > 0 && (
        <ul className="issues">
          {cache.warnings.map((warning, index) => (
            <li key={`${warning}-${index}`} className="warn">
              标注：{warning}
            </li>
          ))}
        </ul>
      )}
      <table className="slot-table">
        <thead>
          <tr>
            <th>槽位</th>
            <th>稳定</th>
            <th>token（估算）</th>
          </tr>
        </thead>
        <tbody>
          {cache.slots.map((slot) => (
            <tr key={slot.slot}>
              <td>{slot.slot}</td>
              <td>{slot.stable ? "✓ 前缀" : "易变"}</td>
              <td>{slot.tokens}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AiView() {
  const [config, setConfig] = useState<AiConfigState | null>(null);

  /**
   * AI 开关（A4）：状态取自主进程的 `config.aiEnabled`，**不在渲染层自持一份**——
   * 否则 UI 显示"已开启"而主进程仍是关闭（或反之），按钮禁用态就成了唯一闸门。
   */
  const enabled = config?.aiEnabled === true;
  const toggleAi = async (next: boolean): Promise<void> => {
    try {
      setError(null);
      setConfig(await api().ai.setEnabled(next));
    } catch (err) {
      setError((err as Error).message);
    }
  };
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
  const [downgradeNotes, setDowngradeNotes] = useState<string[]>([]);
  const [usageList, setUsageList] = useState<AiUsageEntryPayload[]>([]);
  const [costPanel, setCostPanel] = useState<AiCostPanelPayload | null>(null);
  const [costReceipt, setCostReceipt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const streamIdRef = useRef<string | null>(null);

  // 写作 UX（T3-11）：打字机缓冲 / 多候选 / 句级 diff 与局部采纳 / 拒绝原因
  const [typewriterMode, setTypewriterMode] = useState<TypewriterMode>("smooth");
  const [candidateCount, setCandidateCount] = useState(2);
  const [candidates, setCandidates] = useState<CandidateEntry[]>([]);
  const [expandedDiff, setExpandedDiff] = useState<string | null>(null);
  const [selectedSentences, setSelectedSentences] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<AiFeedbackState | null>(null);
  const [rejectDraft, setRejectDraft] = useState<{ streamId: string; reason: string; note: string } | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const runHandlersRef = useRef(new Map<string, (event: AiStreamEvent) => void>());
  const bufferRef = useRef<TypewriterBuffer | null>(null);
  const frameRef = useRef<number | null>(null);
  const modeRef = useRef<TypewriterMode>("smooth");

  // 配置编辑（T3-4：provider 列表草稿——逐行编辑 / 添加本地预设 / 删除）
  const [providersDraft, setProvidersDraft] = useState<AiProviderPayload[] | null>(null);
  const [presetId, setPresetId] = useState("ollama");
  const [sessionKey, setSessionKey] = useState("");
  const [keyProvider, setKeyProvider] = useState("");
  /** 待加密保存的 Key 草稿（provider.id → 输入值；只在内存，成功即清空，绝不回传主进程以外处） */
  const [keyDraft, setKeyDraft] = useState<Record<string, string>>({});

  const selected = drafts.find((draft) => `${draft.volumeId}:${draft.chapterId}` === selectedKey) ?? null;
  const providers = providersDraft ?? config?.config.providers ?? [];

  const updateProvider = (index: number, patch: Partial<AiProviderPayload>) => {
    setProvidersDraft((prev) =>
      (prev ?? config?.config.providers ?? []).map((provider, i) =>
        i === index ? { ...provider, ...patch } : provider,
      ),
    );
  };

  const updateProviderModel = (index: number, name: string) => {
    setProvidersDraft((prev) =>
      (prev ?? config?.config.providers ?? []).map((provider, i) =>
        i === index
          ? { ...provider, models: provider.models.map((m, mi) => (mi === 0 ? { ...m, name } : m)) }
          : provider,
      ),
    );
  };

  const removeProvider = (index: number) => {
    setProvidersDraft((prev) => (prev ?? config?.config.providers ?? []).filter((_, i) => i !== index));
  };

  const addLocalPreset = () => {
    const preset = config?.localPresets.find((item) => item.id === presetId);
    if (!preset) return;
    const existing = providersDraft ?? config?.config.providers ?? [];
    const ids = new Set(existing.map((provider) => provider.id));
    let id = preset.provider.id;
    let suffix = 2;
    while (ids.has(id)) id = `${preset.provider.id}-${suffix++}`;
    setProvidersDraft([...existing, { ...preset.provider, id }]);
  };

  const refreshConfig = useCallback(async () => {
    const state = await api().ai.config();
    setConfig(state);
    setProvidersDraft(state.config.providers);
    const primary = state.config.providers[0];
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

  /** 成本面板取数（T3-12）：带章纲目标时主进程顺带核对缓存编排，未选择则只聚合（cache 为 null） */
  const refreshCost = useCallback(
    async (target?: { volumeId: string; chapterId: string } | null) => {
      try {
        setError(null);
        const panel = await api().ai.cost(target ?? {});
        setCostPanel(panel);
        setCostReceipt(costReceiptLine(panel.totals));
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [],
  );

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
        const list = await refreshDrafts();
        await refreshUsage();
        await refreshPreview(null);
        const first = list[0];
        await refreshCost(first ? { volumeId: first.volumeId, chapterId: first.chapterId } : null);
        setFeedback(await api().ai.feedback());
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [refreshConfig, refreshDrafts, refreshUsage, refreshPreview, refreshCost]);

  // 流式事件分发（ai:event 单向推送；T3-11：按 streamId 路由到各自 runOne 处理器——支持多候选串行）
  useEffect(() => {
    const off = api().ai.onEvent((event: AiStreamEvent) => {
      runHandlersRef.current.get(event.streamId)?.(event);
    });
    return off;
  }, []);

  // 打字机模式同步（切换后立即作用于当前缓冲）
  useEffect(() => {
    modeRef.current = typewriterMode;
    bufferRef.current?.setMode(typewriterMode);
  }, [typewriterMode]);

  const selectTarget = async (key: string) => {
    setSelectedKey(key);
    const draft = drafts.find((item) => `${item.volumeId}:${item.chapterId}` === key);
    if (draft) {
      await refreshPreview({ volumeId: draft.volumeId, chapterId: draft.chapterId });
      await refreshCost({ volumeId: draft.volumeId, chapterId: draft.chapterId });
    }
  };

  /** 拉取当前草稿正文（多候选句级 diff 的对照基线） */
  const ensureDraftBody = useCallback(async () => {
    if (!selected) {
      setDraftBody("");
      return "";
    }
    try {
      const snapshot = await api().chapter.read(selected.chapterPath);
      setDraftBody(snapshot.body);
      return snapshot.body;
    } catch {
      setDraftBody("");
      return "";
    }
  }, [selected]);

  /** 打字机帧循环：rAF 每帧 flush 一次缓冲（未 flush 内容不触发 React 提交——J08 反模式的正面实现） */
  const startFrameLoop = () => {
    if (frameRef.current !== null) return;
    const tick = () => {
      const buffer = bufferRef.current;
      if (buffer) {
        const piece = buffer.flushFrame();
        if (piece !== "") setStreamText((prev) => prev + piece);
      }
      frameRef.current = bufferRef.current ? requestAnimationFrame(tick) : null;
    };
    frameRef.current = requestAnimationFrame(tick);
  };

  const stopFrameLoop = () => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
  };

  /** 单次流式生成（多候选串行复用同一实现）：返回完整结果；事件按 streamId 分发 */
  const runOne = (index: number, total: number): Promise<GenerateResult> =>
    new Promise<GenerateResult>((resolve, reject) => {
      if (!selected) {
        reject(new Error("未选择生成目标"));
        return;
      }
      const streamId = `ai-${typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID().replace(/-/g, "").slice(0, 8) : Math.random().toString(36).slice(2, 10)}`;
      streamIdRef.current = streamId;
      bufferRef.current = new TypewriterBuffer({ mode: modeRef.current });
      setStreamText("");
      setStreamChars(0);
      startFrameLoop();
      const finish = () => {
        runHandlersRef.current.delete(streamId);
        stopFrameLoop();
        bufferRef.current = null;
      };
      runHandlersRef.current.set(streamId, (event) => {
        if (event.type === "delta") {
          bufferRef.current?.push(event.text);
          setStreamChars(event.chars);
          return;
        }
        if (event.type === "fallback") {
          setFallbackNote(`provider「${event.providerId}」不可用，已降级：${event.reason}`);
          return;
        }
        if (event.type === "downgrade") {
          setDowngradeNotes((prev) => (prev.includes(event.message) ? prev : [...prev, event.message]));
          return;
        }
        if (event.type === "done") {
          bufferRef.current?.flushAll();
          finish();
          setStreamText(event.text);
          setStreamChars(event.chars);
          resolve({
            streamId,
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
          return;
        }
        finish();
        reject(new Error(`[${event.code}] ${event.message}`));
      });
      void api()
        .ai.start({
          streamId,
          volumeId: selected.volumeId,
          chapterId: selected.chapterId,
          task,
          targetWords,
          ...(instruction.trim() ? { instruction: instruction.trim() } : {}),
          ...(total > 1 ? { candidateIndex: index, candidateTotal: total } : {}),
        })
        .catch((err: Error) => {
          finish();
          reject(err);
        });
    });

  const resetRunState = () => {
    setResult(null);
    setError(null);
    setNotice(null);
    setFallbackNote(null);
    setDowngradeNotes([]);
  };

  const start = async () => {
    if (!selected) return;
    setRunning(true);
    resetRunState();
    setCandidates([]);
    setExpandedDiff(null);
    try {
      const outcome = await runOne(1, 1);
      setResult(outcome);
      void refreshUsage();
      void refreshCost(selected ? { volumeId: selected.volumeId, chapterId: selected.chapterId } : null);
      await ensureDraftBody();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  /** 多候选生成（T3-11，J15）：串行 N 个候选（各自独立标记）；停止会终止整个串行队列 */
  const startMulti = async () => {
    if (!selected) return;
    setRunning(true);
    resetRunState();
    setCandidates([]);
    setExpandedDiff(null);
    setSelectedSentences({});
    const produced: CandidateEntry[] = [];
    try {
      await ensureDraftBody();
      for (let index = 1; index <= candidateCount; index += 1) {
        setNotice(`多候选生成中：第 ${index}/${candidateCount} 个…`);
        const outcome = await runOne(index, candidateCount);
        produced.push({ ...outcome, index, total: candidateCount });
        setCandidates([...produced]);
        if (outcome.aborted) break;
      }
      setNotice(`多候选生成完成：${produced.length} 个候选（句级差异已对照草稿；采纳 / 拒绝均需显式操作）`);
      void refreshUsage();
      void refreshCost(selected ? { volumeId: selected.volumeId, chapterId: selected.chapterId } : null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
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
      await ensureDraftBody();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 多候选：整段 / 追加采纳（显式动作才写正文——与单候选同一红线） */
  const adoptCandidate = async (entry: CandidateEntry, mode: "replace" | "append") => {
    if (!selected) return;
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
        usageId: entry.usageId,
        volumeId: selected.volumeId,
        chapterId: selected.chapterId,
        text: entry.text,
        mode,
      });
      setNotice(
        `候选 ${entry.index}/${entry.total} 已${mode === "replace" ? "替换" : "追加"}采纳 → ${adopted.chapterPath}（${adopted.wordCount} 字）`,
      );
      setCandidates((prev) =>
        prev.map((item) => (item.streamId === entry.streamId ? { ...item, adopted: mode } : item)),
      );
      await refreshDrafts();
      await refreshUsage();
      await ensureDraftBody();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const toggleSentence = (key: string, checked: boolean) => {
    setSelectedSentences((prev) => ({ ...prev, [key]: checked }));
  };

  /** 局部采纳（J15）：按句勾选合并（缺省全选）→ 追加落盘 */
  const adoptSelectedSentences = async (entry: CandidateEntry) => {
    if (!selected) return;
    const sentences = splitSentences(entry.text);
    const checked = sentences.filter((_, index) => selectedSentences[`${entry.streamId}:${index}`] ?? true);
    const text = mergeSelected(checked);
    if (text.trim() === "") {
      setError("未勾选任何句子：至少选择一句后再采纳");
      return;
    }
    try {
      setError(null);
      const adopted = await api().ai.adopt({
        usageId: entry.usageId,
        volumeId: selected.volumeId,
        chapterId: selected.chapterId,
        text,
        mode: "append",
      });
      setNotice(`局部采纳：已追加 ${checked.length}/${sentences.length} 句 → ${adopted.chapterPath}（${adopted.wordCount} 字）`);
      setCandidates((prev) =>
        prev.map((item) => (item.streamId === entry.streamId ? { ...item, adopted: "append" } : item)),
      );
      await refreshDrafts();
      await refreshUsage();
      await ensureDraftBody();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 拒绝原因记录（J15）：预置标签 + 备注 → .yushu/ai-feedback.jsonl（统计展示；不写正文） */
  const rejectCandidate = async (entry: CandidateEntry, reason: string, note: string) => {
    try {
      setError(null);
      const state = await api().ai.reject({
        usageId: entry.usageId,
        task: "drafting",
        reason,
        excerpt: entry.text.slice(0, 200),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      setFeedback(state);
      setCandidates((prev) =>
        prev.map((item) => (item.streamId === entry.streamId ? { ...item, rejected: true } : item)),
      );
      setRejectDraft(null);
      setNotice(`已记录拒绝原因「${reason}」——沉淀为提示词改进数据（本机 .yushu/ai-feedback.jsonl）`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const saveConfig = async () => {
    if (!config) return;
    try {
      setError(null);
      const saved = await api().ai.saveConfig({
        providers: providers,
        ...(config.hash ? { baseHash: config.hash } : {}),
      });
      setConfig(saved);
      setProvidersDraft(saved.config.providers);
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

  /** 加密保存 provider Key（T3-14）：密文进凭据库，真源只多一个 key_ref；返回值不含密钥本体 */
  const saveStoredKey = async (providerId: string) => {
    const value = (keyDraft[providerId] ?? "").trim();
    if (value === "") {
      setError("API Key 为空：加密保存需要非空密钥；如需移除请点「清除凭据」");
      return;
    }
    try {
      setError(null);
      const state = await api().ai.saveKey(providerId, value);
      setConfig(state);
      setProvidersDraft(state.config.providers);
      setKeyDraft((prev) => ({ ...prev, [providerId]: "" }));
      setNotice(
        `密钥已加密保存（safeStorage 密文 → .yushu/secrets.json，不入 Git/索引/快照）；config/llm.yaml 只记录 key_ref「${providerId}」，真源不含密钥字面值`,
      );
    } catch (err) {
      setError((err as Error).message);
    }
  };

  /** 清除凭据（T3-14）：删密文条目并去掉真源 key_ref（会话内存 Key 不动） */
  const clearStoredKey = async (providerId: string) => {
    try {
      setError(null);
      const state = await api().ai.clearKey(providerId);
      setConfig(state);
      setProvidersDraft(state.config.providers);
      setNotice(`已清除凭据：provider「${providerId}」的密文条目与 config/llm.yaml 的 key_ref 均已移除`);
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
            <input
              type="checkbox"
              className="ai-enable-toggle"
              checked={enabled}
              onChange={(event) => void toggleAi(event.target.checked)}
            />
            <span>启用 AI 调用（关闭时本地功能不受影响；生成属于唯一联网步骤）</span>
          </label>
        </section>

        <section className="panel">
          <h3>
            Provider <span className="muted">{config?.exists ? "config/llm.yaml" : "内置默认（未落盘）"}</span>
          </h3>
          {(config?.config.providers ?? []).length > 0 && <div className="muted">Provider {providers.length} 个（顺序即 fallback 优先级）</div>}
          {providers.map((provider, index) => {
            const keyState = config?.keyStates.find((state) => state.provider_id === provider.id);
            return (
              <div className="provider" key={`${provider.id}-${index}`}>
                <div className="pack-title">
                  <strong>{provider.id}</strong>
                  <span className="badge">{provider.kind === "local" ? "本地" : "云端"}</span>
                  <span className="badge">{provider.protocol}</span>
                  <span className={keyState?.ready ? "badge good" : "badge bad"}>
                    {keyState?.ready ? "可用" : "缺少 Key"}
                  </span>
                  <span className={keyState?.has_stored_key ? "badge good" : "badge"}>
                    密钥：{keyStateText(keyState)}
                  </span>
                  {providers.length > 1 && (
                    <button type="button" className="link" onClick={() => removeProvider(index)}>
                      删除
                    </button>
                  )}
                </div>
                {provider.models.map((item) => (
                  <div className="muted" key={item.name}>
                    {item.name} · {TIER_LABELS[item.tier] ?? item.tier} ·{" "}
                    {capabilityLabels(item.capabilities).join(" / ") || "—"}
                    {item.limits?.context ? ` · 上下文 ${item.limits.context}` : ""}
                  </div>
                ))}
                {provider.kind === "local" && (
                  <div className="muted privacy-note">本地隐私模式：请求不出本机（能力差异见下方标注）</div>
                )}
                <div className="config-form">
                  <label className="field">
                    <span>base_url</span>
                    <input
                      value={provider.base_url}
                      onChange={(event) => updateProvider(index, { base_url: event.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>模型名</span>
                    <input
                      value={provider.models[0]?.name ?? ""}
                      onChange={(event) => updateProviderModel(index, event.target.value)}
                    />
                  </label>
                  <label className="field">
                    <span>API Key 环境变量名（留空=无鉴权，如本地端点）</span>
                    <input
                      value={provider.api_key_env ?? ""}
                      placeholder="YUSHU_LLM_API_KEY"
                      onChange={(event) =>
                        updateProvider(index, {
                          ...(event.target.value.trim() ? { api_key_env: event.target.value } : { api_key_env: undefined }),
                        })
                      }
                    />
                  </label>
                </div>
                {/* T3-14：密钥加密保存（密文进凭据库，真源只落 key_ref）；后端不可用时禁用而非降级存明文 */}
                <div className="config-form">
                  <div className="master-grid">
                    <label className="field grow">
                      <span>API Key（加密保存：本机 safeStorage 密文，真源只记 key_ref）</span>
                      <input
                        type="password"
                        autoComplete="new-password"
                        className="ai-key-input"
                        value={keyDraft[provider.id] ?? ""}
                        placeholder="sk-..."
                        disabled={config ? !config.keyBackendAvailable : true}
                        onChange={(event) =>
                          setKeyDraft((prev) => ({ ...prev, [provider.id]: event.target.value }))
                        }
                      />
                    </label>
                    <button
                      type="button"
                      className="primary ai-key-save"
                      disabled={
                        config ? !config.keyBackendAvailable || (keyDraft[provider.id] ?? "").trim() === "" : true
                      }
                      title={config?.keyBackendAvailable ? "" : "加密后端不可用：不会写明文，故禁用"}
                      onClick={() => void saveStoredKey(provider.id)}
                    >
                      加密保存
                    </button>
                    {keyState?.has_stored_key && (
                      <button
                        type="button"
                        className="link ai-key-clear"
                        onClick={() => void clearStoredKey(provider.id)}
                      >
                        清除凭据
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
          {config && !config.keyBackendAvailable && (
            <div className="warn ai-key-backend-note">{KEY_BACKEND_UNAVAILABLE_NOTE}</div>
          )}
          <div className="config-form">
            <div className="master-grid">
              <label className="field">
                <span>添加本地模型（OpenAI 兼容端点）</span>
                <select value={presetId} onChange={(event) => setPresetId(event.target.value)}>
                  {(config?.localPresets ?? []).map((preset) => (
                    <option key={preset.id} value={preset.id}>
                      {preset.label}
                    </option>
                  ))}
                </select>
              </label>
              <button type="button" onClick={addLocalPreset}>
                添加
              </button>
            </div>
            <button type="button" className="primary" onClick={saveConfig}>
              保存 Provider 配置
            </button>
          </div>
          {(config?.warnings ?? []).length > 0 && (
            <ul className="issues warnings">
              {(config?.warnings ?? []).map((warning, index) => (
                <li key={`${warning.provider_id}-${index}`} className="warn">
                  标注：{warning.provider_id}
                  {warning.model ? ` / ${warning.model}` : ""}——{warning.message}
                </li>
              ))}
            </ul>
          )}
          {config?.routing && <div className="muted routing-line">{routingSummary(config.routing)}</div>}
          {config?.channels && config.channels.length > 0 && (
            <div className="muted ai-channels">
              半价通道（T3-11）：{config.channels.map((plan) => `${plan.task} → ${plan.channel === "batch" ? "batch（半价）" : "sync"}`).join(" · ")}
              （batch_eligible：大纲候选 / 摘要回填 / 实体抽取；未声明 batch 能力时按标准通道计价）
            </div>
          )}
          <div className="config-form">
            <div className="master-grid">
              <label className="field">
                <span>会话 Key 所属 provider</span>
                <select value={keyProvider} onChange={(event) => setKeyProvider(event.target.value)}>
                  {providers.map((provider) => (
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
            <span className="ai-run-controls">
              <select
                className="ai-typewriter-mode"
                value={typewriterMode}
                onChange={(event) => setTypewriterMode(event.target.value as TypewriterMode)}
              >
                <option value="smooth">打字机：匀速</option>
                <option value="instant">打字机：瞬时</option>
              </select>
              <select
                className="ai-candidate-count"
                value={candidateCount}
                disabled={running}
                onChange={(event) => setCandidateCount(Number(event.target.value) || 2)}
              >
                <option value={2}>候选数 2</option>
                <option value={3}>候选数 3</option>
                <option value={1}>候选数 1</option>
              </select>
              {running ? (
                <button type="button" onClick={stop}>
                  停止生成
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="primary"
                    disabled={!enabled || !selected || !config?.canGenerate}
                    title={!enabled ? "请先开启 AI 调用" : !config?.canGenerate ? "缺少可用的 provider Key" : ""}
                    onClick={() => void start()}
                  >
                    开始生成
                  </button>
                  <button
                    type="button"
                    className="ai-multi-start"
                    disabled={!enabled || !selected || !config?.canGenerate || candidateCount < 2}
                    title="多候选：各自独立生成（不得互相参照）——句级 diff 对照草稿"
                    onClick={() => void startMulti()}
                  >
                    {`生成 ${candidateCount} 个候选`}
                  </button>
                </>
              )}
            </span>
          </div>
          {!enabled && <p className="muted">AI 默认关闭：开启后可流式生成；离线时其余功能不受影响。</p>}
          {fallbackNote && <div className="warn">{fallbackNote}</div>}
          {downgradeNotes.map((note) => (
            <div className="warn" key={note}>
              降级提示：{note}
            </div>
          ))}
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

        {candidates.length > 0 && (
          <div className="panel">
            <h3>
              多候选对比{" "}
              <span className="muted">T3-11（J15）：句级差异 / 局部采纳 / 拒绝原因；采纳与拒绝均不自动写正文（显式操作）</span>
            </h3>
            <div className="muted">
              候选 {candidates.length} 个 · 对照草稿正文 {draftBody.length} 字（句级 diff；「按句采纳」缺省全选）
            </div>
            {feedback && feedback.total > 0 && (
              <div className="muted ai-feedback">
                拒绝原因统计（本机）：{feedback.counts.map((item) => `${item.reason}×${item.count}`).join("、")}（共 {feedback.total} 条，沉淀提示词改进）
              </div>
            )}
            <ul className="ai-candidates">
              {candidates.map((entry) => {
                const diff = diffSentences(draftBody, entry.text);
                const sentences = splitSentences(entry.text);
                const expanded = expandedDiff === entry.streamId;
                return (
                  <li key={entry.streamId} className="ai-candidate-card">
                    <div>
                      <span className="badge">
                        候选 {entry.index}/{entry.total}
                      </span>
                      <strong>{entry.chars} 字</strong>
                      <span className="muted">
                        {entry.providerId || "-"} / {entry.model || "-"}
                        {entry.aborted ? " · 已停止（保留部分）" : ""}
                      </span>
                      {entry.adopted && <span className="badge good">已{entry.adopted === "replace" ? "替换" : "追加"}采纳</span>}
                      {entry.rejected && <span className="badge bad">已拒绝</span>}
                      <span className="spacer" />
                      <button type="button" disabled={!selected || entry.rejected} onClick={() => void adoptCandidate(entry, "replace")}>
                        整段采纳（替换）
                      </button>
                      <button type="button" disabled={!selected || entry.rejected} onClick={() => void adoptCandidate(entry, "append")}>
                        追加到正文
                      </button>
                      <button
                        type="button"
                        className="link ai-sentence-toggle"
                        disabled={entry.rejected}
                        onClick={() => setExpandedDiff(expanded ? null : entry.streamId)}
                      >
                        按句采纳（{sentences.length} 句）
                      </button>
                      <button
                        type="button"
                        className="link"
                        disabled={entry.rejected}
                        onClick={() => setRejectDraft({ streamId: entry.streamId, reason: REJECT_REASON_PRESETS[0], note: "" })}
                      >
                        拒绝…
                      </button>
                    </div>
                    <div className="muted">
                      句级差异：新增 {diff.added.length} 句（+{diff.addedChars} 字） / 移除 {diff.removed.length} 句（-
                      {diff.removedChars} 字） / 相同 {diff.shared} 句
                    </div>
                    <div className="candidate">
                      {entry.text.slice(0, 400)}
                      {entry.text.length > 400 ? "…" : ""}
                    </div>
                    {expanded && (
                      <div className="sentences">
                        {sentences.map((sentence, index) => {
                          const key = `${entry.streamId}:${index}`;
                          return (
                            <label className="checkbox" key={key}>
                              <input
                                type="checkbox"
                                checked={selectedSentences[key] ?? true}
                                onChange={(event) => toggleSentence(key, event.target.checked)}
                              />
                              <span>{sentence}</span>
                            </label>
                          );
                        })}
                        <button
                          type="button"
                          className="primary ai-sentence-adopt"
                          disabled={!selected}
                          onClick={() => void adoptSelectedSentences(entry)}
                        >
                          采纳所选句（追加）
                        </button>
                      </div>
                    )}
                    {rejectDraft?.streamId === entry.streamId && (
                      <div className="reject-form">
                        <label className="field">
                          <span>拒绝原因</span>
                          <select
                            className="ai-reject-reason"
                            value={rejectDraft.reason}
                            onChange={(event) => setRejectDraft({ ...rejectDraft, reason: event.target.value })}
                          >
                            {REJECT_REASON_PRESETS.map((reason) => (
                              <option key={reason} value={reason}>
                                {reason}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="field grow">
                          <span>备注（可选）</span>
                          <input
                            value={rejectDraft.note}
                            onChange={(event) => setRejectDraft({ ...rejectDraft, note: event.target.value })}
                          />
                        </label>
                        <button
                          type="button"
                          className="ai-reject-confirm"
                          onClick={() => void rejectCandidate(entry, rejectDraft.reason, rejectDraft.note)}
                        >
                          记录拒绝
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

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

        <div className="panel">
          <div className="panel-title">
            <h3>
              Token 与成本{" "}
              <span className="muted">T3-12（J09）：usage 实报 + 本地估算双口径的只读聚合（不联网，AI 关闭时同样可看历史）</span>
            </h3>
            <button
              type="button"
              className="link ai-cost-refresh"
              onClick={() =>
                void refreshCost(selected ? { volumeId: selected.volumeId, chapterId: selected.chapterId } : null)
              }
            >
              刷新成本面板
            </button>
          </div>
          {!costPanel && <p className="muted">尚未取数：读取 .yushu/ai-usage.jsonl 与 config/llm.yaml 的定价表后展示。</p>}
          {costPanel && (
            <>
              <div className="muted">
                {costPanel.path} · 读到 {costPanel.entries} 条记录 · 参与聚合的模型调用 {costPanel.totals.entries} 次 · 币种{" "}
                {costPanel.currencies.join("、") || "（无：暂无已计价条目）"}
              </div>
              <div className="muted ai-cost-totals">
                合计：token 输入 {costPanel.totals.promptTokens} / 输出 {costPanel.totals.completionTokens} / 命中缓存{" "}
                {costPanel.totals.cachedTokens} / 写缓存 {costPanel.totals.cacheWriteTokens}｜金额{" "}
                {costPanel.totals.costText}｜预估 vs 实付 {costPanel.totals.deviationText}｜缓存节省{" "}
                {costPanel.totals.cacheSavedText}
              </div>
              {costPanel.entriesWithoutTokens > 0 && (
                <div className="warn ai-cost-usage-missing">
                  {costPanel.entriesWithoutTokens} 条记录无 usage 实报（J09 cost-usage-missing：这些条目不进 token
                  合计，金额与偏差不可对账）
                </div>
              )}
              {costReceipt && <div className="muted ai-cost-receipt">{costReceipt}</div>}

              <div className="muted">按任务分解</div>
              <CostBreakdownTable rows={costPanel.byTask} keyLabel="任务" />
              <div className="muted">按模型分解</div>
              <CostBreakdownTable rows={costPanel.byModel} keyLabel="模型" />
              <div className="muted">按章节分解（未标注章节的记录归入「（未标注章节）」一行，不静默丢弃）</div>
              <CostBreakdownTable rows={costPanel.byChapter} keyLabel="章节" />

              <div className="muted">定价表状态（config/llm.yaml 的 models[].pricing，单价按每 1M tokens）</div>
              {costPanel.pricing.length === 0 ? (
                <p className="muted">provider 配置里没有模型条目：无定价可展示（金额一律标「未配置价格」）。</p>
              ) : (
                <table className="slot-table">
                  <thead>
                    <tr>
                      <th>provider · 模型</th>
                      <th>价格</th>
                    </tr>
                  </thead>
                  <tbody>
                    {costPanel.pricing.map((row) => (
                      <tr key={`${row.provider_id}-${row.model}`}>
                        <td>
                          {row.provider_id} · {row.model}
                        </td>
                        <td className={row.configured ? "" : "warn"}>
                          {row.configured
                            ? `已配置｜币种 ${row.currency ?? "未声明（按 CNY 计）"}｜输入 ${row.input}｜输出 ${row.output}${
                                row.cache_read === undefined ? "" : `｜命中缓存 ${row.cache_read}`
                              }`
                            : "未配置价格"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              <div className="muted">缓存编排核对（稳定前缀是否真的置头）</div>
              {costPanel.cache ? (
                <CostCacheAudit cache={costPanel.cache} />
              ) : (
                <p className="muted">
                  {selected
                    ? "该章纲没有可核对的组装结果（尚未创建草稿章节）：不核对缓存编排，避免无中生有"
                    : "未选择章纲：只做聚合，不核对缓存编排（选择生成目标后再点「刷新成本面板」即一并核对）"}
                </p>
              )}

              <div className="muted">口径说明</div>
              <ul className="issues ai-cost-notes">
                {costPanel.notes.map((note, index) => (
                  <li key={`${note}-${index}`} className="muted">
                    {note}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </section>
    </div>
  );
}