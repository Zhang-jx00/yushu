import { YushuError, countWords } from "@yushu/core";
import {
  LLM_API_VERSION,
  LLM_FORMAT_VERSION,
  LlmAbortError,
  defaultLlmConfig,
  detectLlmConfigVersion,
  parseLlmConfig,
  resolveCapabilities,
  serializeLlmConfig,
  stream,
  type LlmConfig,
  type LlmProviderSpec,
} from "@yushu/llm";
import {
  LLM_CONFIG_PATH,
  OUTLINE_PATH,
  chapterPath,
  parseOutline,
  readChapterFile,
  serializeChapterFile,
} from "@yushu/world-engine";
import type {
  AiAdoptPayload,
  AiAdoptResult,
  AiConfigState,
  AiDraftTarget,
  AiGeneratePayload,
  AiProviderPayload,
  AiSaveConfigPayload,
  AiStreamEvent,
  AiUsageState,
  ContextPreviewPayload,
} from "../shared/ipc.js";
import { appendAiUsage, newUsageId, readAiUsage } from "./ai-usage.js";
import { ProjectGateway } from "./file-gateway.js";
import { analyzeDraft, assembleMessages, buildContextPreview, type DraftTask } from "./prompt-ops.js";
import { takePreDestructiveSnapshot } from "./snapshot-ops.js";
import { countEffectiveChars, recordChapterDelta } from "./stats-ops.js";

/**
 * AI 副驾主进程编排（S4/S5；T1-13 ~ T1-17；T3-1 Provider 能力矩阵）：
 * - 配置：config/llm.yaml（v2 能力矩阵；明文 key 禁落盘；会话 key 仅存内存）；
 * - 生成：上下文组装 → stream（协议分发 + fallback + AbortController）→ 事件流 → 使用记录；
 * - 采纳：仅用户显式操作才写入章节正文（先读 hash 再原子写，拒绝盲覆盖）。
 */

/** v1 配置的迁移备份路径（T3-1：首次覆盖 v1 前自动备份，幂等；可回滚） */
const LLM_CONFIG_BACKUP_PATH = `${LLM_CONFIG_PATH}.bak-v1`;

/** 会话内存 API Key（provider.id → key）；进程退出即消失，不落盘（docs/03 §13） */
const sessionKeys = new Map<string, string>();

export function setSessionKey(providerId: string, apiKey: string): void {
  if (!providerId.trim()) throw new YushuError("E_INVALID_INPUT", "providerId 不能为空");
  if (apiKey.trim() === "") sessionKeys.delete(providerId);
  else sessionKeys.set(providerId, apiKey.trim());
}

function sessionKeySnapshot(): Record<string, string> {
  return Object.fromEntries(sessionKeys);
}

/** provider → 载荷（能力矩阵合并保守默认后下发，UI 直接展示） */
function toProviderPayload(provider: LlmProviderSpec): AiProviderPayload {
  return {
    id: provider.id,
    kind: provider.kind,
    protocol: provider.protocol,
    base_url: provider.base_url,
    models: provider.models.map((model) => ({
      name: model.name,
      tier: model.tier,
      capabilities: { ...resolveCapabilities(model) },
      ...(model.limits ? { limits: { ...model.limits } } : {}),
    })),
    ...(provider.api_key_env ? { api_key_env: provider.api_key_env } : {}),
    ...(provider.temperature !== undefined ? { temperature: provider.temperature } : {}),
    ...(provider.max_tokens !== undefined ? { max_tokens: provider.max_tokens } : {}),
  };
}

/** 读取 config/llm.yaml 并校验；不存在时返回默认配置（云端主干 + 本地兜底） */
export async function loadLlmConfigForUse(gateway: ProjectGateway): Promise<LlmConfig> {
  const snapshot = await gateway.readDoc(LLM_CONFIG_PATH).catch(() => null);
  if (!snapshot) return defaultLlmConfig();
  return parseLlmConfig(snapshot.content);
}

/** 配置状态（含每个 provider 的 key 就绪态；不返回 key 本身） */
export async function readAiConfig(gateway: ProjectGateway): Promise<AiConfigState> {
  const snapshot = await gateway.readDoc(LLM_CONFIG_PATH).catch(() => null);
  // v1 文本由 parseLlmConfig 自动迁移（内存态；写回由保存路径显式完成并先行备份）
  const config = snapshot ? parseLlmConfig(snapshot.content) : defaultLlmConfig();
  const keys = sessionKeySnapshot();

  const keyStates = config.providers.map((provider) => {
    const hasSessionKey = Boolean(keys[provider.id]);
    const hasEnvKey = Boolean(provider.api_key_env && process.env[provider.api_key_env]);
    return {
      provider_id: provider.id,
      ...(provider.api_key_env ? { api_key_env: provider.api_key_env } : {}),
      has_session_key: hasSessionKey,
      has_env_key: hasEnvKey,
      ready: !provider.api_key_env || hasSessionKey || hasEnvKey,
    };
  });

  return {
    path: LLM_CONFIG_PATH,
    exists: snapshot !== null,
    ...(snapshot ? { hash: snapshot.hash } : {}),
    config: {
      apiVersion: config.apiVersion,
      format_version: config.format_version,
      providers: config.providers.map((provider) => toProviderPayload(provider)),
    },
    keyStates,
    canGenerate: keyStates.some((state) => state.ready),
  };
}

/** 保存 config/llm.yaml（providers 全量替换；写入前经 parseLlmConfig 校验） */
export async function saveAiConfig(
  gateway: ProjectGateway,
  payload: AiSaveConfigPayload,
): Promise<AiConfigState> {
  // T3-1：覆盖 v1 配置前自动备份（幂等——备份已存在则跳过；备份失败不阻断保存但留下日志线索）
  const current = await gateway.readDoc(LLM_CONFIG_PATH).catch(() => null);
  if (current && detectLlmConfigVersion(current.content) < LLM_FORMAT_VERSION) {
    await gateway.writeDoc(LLM_CONFIG_BACKUP_PATH, current.content).catch((err) => {
      const code = (err as { code?: string }).code;
      if (code !== "E_DOC_CONFLICT") {
        console.warn(`[ai] v1 配置备份写入失败（${LLM_CONFIG_BACKUP_PATH}）：${String(err)}`);
      }
    });
  }
  const candidate = {
    apiVersion: LLM_API_VERSION,
    format_version: LLM_FORMAT_VERSION,
    providers: payload.providers as unknown as LlmProviderSpec[],
  };
  const validated = parseLlmConfig(serializeLlmConfig(candidate));
  await gateway.writeDoc(LLM_CONFIG_PATH, serializeLlmConfig(validated), payload.baseHash);
  return readAiConfig(gateway);
}

/** 可生成目标：已创建草稿章节（chapter_id 已回填且文件存在）的章纲列表 */
export async function listDraftTargets(gateway: ProjectGateway): Promise<AiDraftTarget[]> {
  const snapshot = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  if (!snapshot) return [];
  const outline = parseOutline(snapshot.content);
  const targets: AiDraftTarget[] = [];

  for (const volume of outline.volumes) {
    for (const chapter of volume.chapters) {
      if (!chapter.chapter_id) continue;
      const path = chapterPath(volume.id, chapter.chapter_id);
      const file = await gateway.readDoc(path).catch(() => null);
      if (!file) continue;
      const { chapter: entity, body } = readChapterFile(file.content);
      targets.push({
        volumeId: volume.id,
        volumeTitle: volume.title,
        volumeAct: volume.act,
        chapterId: chapter.id,
        title: chapter.title,
        idx: chapter.idx,
        chapterPath: path,
        hasBody: body.trim() !== "",
        wordCount: entity.word_count > 0 ? entity.word_count : countWords(body),
      });
    }
  }
  return targets;
}

/** 上下文预览（槽位 / 来源 / 字符数 / 截断标记） */
export async function readAiContext(
  gateway: ProjectGateway,
  target?: { volumeId: string; chapterId: string },
): Promise<ContextPreviewPayload> {
  return buildContextPreview(gateway, target);
}

export interface RunGenerateArgs {
  streamId: string;
  payload: AiGeneratePayload;
  sink: (event: AiStreamEvent) => void;
  signal: AbortSignal;
}

/**
 * 生成任务（T1-16）：流式 + fallback + 中止保留部分文本；无论成败都写 AI 使用记录（T1-17）。
 * 生成结果只经事件流返回，绝不直接写正文（采纳是用户的显式动作）。
 */
export async function runAiGenerate(gateway: ProjectGateway, args: RunGenerateArgs): Promise<void> {
  const { streamId, payload, sink, signal } = args;
  const usageId = newUsageId();
  let preview: ContextPreviewPayload | null = null;

  try {
    preview = await buildContextPreview(gateway, {
      volumeId: payload.volumeId,
      chapterId: payload.chapterId,
    });
    if (!preview.target) {
      throw new YushuError("E_NO_TARGET", "未找到章纲目标：请先在三级大纲中选择并创建草稿章节");
    }
    const task: DraftTask = {
      kind: payload.task,
      ...(payload.instruction ? { instruction: payload.instruction } : {}),
      ...(payload.targetWords ? { targetWords: payload.targetWords } : {}),
    };
    const messages = assembleMessages(preview, task);
    const config = await loadLlmConfigForUse(gateway);

    let accumulated = "";
    const onDelta = (delta: { text: string }) => {
      accumulated += delta.text;
      sink({ streamId, type: "delta", text: delta.text, chars: countWords(accumulated) });
    };

    const result = await stream(
      config.providers,
      { messages, signal },
      { onDelta },
      {
        sessionKeys: sessionKeySnapshot(),
        onFallback: (info) =>
          sink({ streamId, type: "fallback", providerId: info.provider_id, reason: info.reason }),
      },
    );

    const chars = countWords(result.text);
    const hints = analyzeDraft(result.text, preview.cardIndex, preview.layers);
    await appendAiUsage(gateway.root, {
      id: usageId,
      type: "generate",
      task: payload.task,
      provider_id: result.provider_id,
      model: result.model,
      status: "ok",
      chars,
      chapter_id: payload.chapterId,
    });
    sink({
      streamId,
      type: "done",
      text: result.text,
      chars,
      aborted: false,
      providerId: result.provider_id,
      model: result.model,
      usageId,
      hints,
      ...(result.usage ? { usage: result.usage } : {}),
    });
  } catch (err) {
    if (err instanceof LlmAbortError) {
      // 中止：保留已生成部分作为候选（用户可继续采纳）
      const partial = err.partial;
      const chars = countWords(partial);
      const hints = preview
        ? analyzeDraft(partial, preview.cardIndex, preview.layers)
        : { referenced: [], hints: [] };
      await appendAiUsage(gateway.root, {
        id: usageId,
        type: "generate",
        task: payload.task,
        status: "aborted",
        chars,
        chapter_id: payload.chapterId,
      });
      sink({
        streamId,
        type: "done",
        text: partial,
        chars,
        aborted: true,
        providerId: "",
        model: "",
        usageId,
        hints,
      });
      return;
    }
    const error = err as { code?: string; message?: string };
    await appendAiUsage(gateway.root, {
      id: usageId,
      type: "generate",
      task: payload.task,
      status: "error",
      chapter_id: payload.chapterId,
    });
    sink({
      streamId,
      type: "error",
      code: error.code ?? "E_UNKNOWN",
      message: error.message ?? String(err),
    });
  }
}

function joinBody(existing: string, incoming: string): string {
  const before = existing.trimEnd();
  const after = incoming.trim();
  return [before, after].filter(Boolean).join("\n\n");
}

/**
 * 采纳候选（T1-16）：把候选文本写入章节正文。
 * - 必须先有草稿章节（细纲→草稿在三级大纲完成）；
 * - replace 覆盖 / append 追加；写入带 baseHash 并发检测，拒绝盲覆盖；
 * - 采纳行为写入 AI 使用记录（usage_id 关联生成记录）。
 */
export async function adoptDraft(
  gateway: ProjectGateway,
  payload: AiAdoptPayload,
): Promise<AiAdoptResult> {
  if (payload.text.trim() === "") {
    throw new YushuError("E_INVALID_INPUT", "候选正文为空，无法采纳");
  }
  const outlineSnap = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  if (!outlineSnap) throw new YushuError("E_OUTLINE", "项目尚无大纲");
  const outline = parseOutline(outlineSnap.content);
  const volume = outline.volumes.find((item) => item.id === payload.volumeId);
  if (!volume) throw new YushuError("E_OUTLINE", `找不到卷纲：${payload.volumeId}`);
  const chapterOutline = volume.chapters.find((item) => item.id === payload.chapterId);
  if (!chapterOutline) throw new YushuError("E_OUTLINE", `找不到章纲：${payload.chapterId}`);
  if (!chapterOutline.chapter_id) {
    throw new YushuError(
      "E_NO_CHAPTER_DRAFT",
      "该章纲尚未创建草稿章节：请先在「三级大纲」中点击「创建草稿章节」",
    );
  }

  const path = chapterPath(volume.id, chapterOutline.chapter_id);
  const snapshot = await gateway.readDoc(path).catch(() => null);
  if (!snapshot) {
    throw new YushuError("E_NO_CHAPTER_DRAFT", `章节草稿不存在：${path}（请在三级大纲中重新创建）`);
  }

  const { chapter, body } = readChapterFile(snapshot.content);
  const nextBody = payload.mode === "replace" ? payload.text.trim() : joinBody(body, payload.text);
  // T2-8 切片 B：整段替换属破坏性操作（清空 / 覆盖既有正文）——写入前强制 pre_destructive 快照；
  // append 保留原文，不触发。快照失败按 K10 阻断（E_SNAPSHOT_REQUIRED，绝不无备份替换）。
  if (payload.mode === "replace") {
    await takePreDestructiveSnapshot(gateway);
  }
  const updated = { ...chapter, word_count: countWords(nextBody) };
  const written = await gateway.writeDoc(path, serializeChapterFile(updated, nextBody), snapshot.hash);
  // T2-9 码字统计：AI 采纳计入章节净增字数（切片 B：同时记有效字数净增；失败不阻断采纳）
  const oldWords = chapter.word_count > 0 ? chapter.word_count : countWords(body);
  await recordChapterDelta(gateway, {
    path,
    oldWords,
    newWords: updated.word_count,
    oldEffective: countEffectiveChars(body),
    newEffective: countEffectiveChars(nextBody),
  }).catch(() => undefined);

  const chars = countWords(payload.text);
  await appendAiUsage(gateway.root, {
    id: newUsageId(),
    type: "adopt",
    usage_id: payload.usageId,
    chapter_id: chapterOutline.chapter_id,
    chars,
  });

  return { chapterPath: path, hash: written.hash, wordCount: updated.word_count, chars };
}

/** AI 使用记录（最近 N 条，倒序） */
export async function readAiUsageState(gateway: ProjectGateway, limit = 30): Promise<AiUsageState> {
  return { path: ".yushu/ai-usage.jsonl", entries: await readAiUsage(gateway.root, limit) };
}