import { YushuError, countWords } from "@yushu/core";
import {
  LLM_API_VERSION,
  LLM_FORMAT_VERSION,
  LOCAL_PROVIDER_PRESETS,
  LlmAbortError,
  ReliabilityGate,
  chat,
  costTokensOf,
  createLocalProvider,
  defaultBudgetConfig,
  defaultLlmConfig,
  defaultRoutingConfig,
  detectLlmConfigVersion,
  extractJson,
  lintLlmConfig,
  orderProvidersByRoute,
  parseBudgetConfig,
  parseLlmConfig,
  parseRoutingConfig,
  planChannels,
  planDowngrade,
  resolveCapabilities,
  resolveRoute,
  serializeLlmConfig,
  stream,
  type BudgetConfig,
  type ChatResult,
  type LlmConfig,
  type LlmFallbackInfo,
  type LlmProviderSpec,
  type RoutingConfig,
} from "@yushu/llm";
import { estimateTokens } from "@yushu/memory";
import {
  BUDGET_CONFIG_PATH,
  LLM_CONFIG_PATH,
  OUTLINE_PATH,
  ROUTING_CONFIG_PATH,
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
  AiRoutingState,
  AiSaveConfigPayload,
  AiStreamEvent,
  AiUsageState,
  ContextPreviewPayload,
} from "../shared/ipc.js";
import { appendAiUsage, newUsageId, readAiUsage } from "./ai-usage.js";
import { postAdoptAudit } from "./consistency-ops.js";
import { ProjectGateway } from "./file-gateway.js";
import { SecretsRepository, defaultKeyRefFor, type KeyCipher } from "./secrets-ops.js";
import { analyzeDraft, assembleMessages, buildContextPreview, type DraftTask } from "./prompt-ops.js";
import { takePreDestructiveSnapshot } from "./snapshot-ops.js";
import { countEffectiveChars, recordChapterDelta } from "./stats-ops.js";

/**
 * AI 副驾主进程编排（S4/S5；T1-13 ~ T1-17；T3-1 Provider 能力矩阵）：
 * - 配置：config/llm.yaml（v2 能力矩阵；明文 key 禁落盘；会话 key 仅存内存）；
 * - 密钥：加密保存 / 清除凭据（T3-14：密文进 `.yushu/secrets.json`，真源只落 key_ref）；
 * - 生成：上下文组装 → stream（协议分发 + fallback + AbortController）→ 事件流 → 使用记录；
 * - 采纳：仅用户显式操作才写入章节正文（先读 hash 再原子写，拒绝盲覆盖）。
 */

/** v1 配置的迁移备份路径（T3-1：首次覆盖 v1 前自动备份，幂等；可回滚） */
const LLM_CONFIG_BACKUP_PATH = `${LLM_CONFIG_PATH}.bak-v1`;

/** 会话内存 API Key（provider.id → key）；进程退出即消失，不落盘（docs/03 §13） */
const sessionKeys = new Map<string, string>();

/**
 * 凭据库加密后端（T3-14）：由 `ipc.ts` 在注册阶段注入 Electron safeStorage 包装器。
 * 本模块不 import electron——否则主进程逻辑的单测会连带拉起 Electron 运行时；
 * 未注入时视为「后端不可用」：只拒绝保存密文，会话内存 Key 与环境变量照常可用。
 */
let keyCipher: KeyCipher | null = null;

export function installKeyCipher(cipher: KeyCipher): void {
  keyCipher = cipher;
}

/**
 * AI 总开关（A4「AI 可整体关闭」的**进程侧事实源**，默认关闭）。
 *
 * 为什么放在主进程而不是只看渲染层的勾选：此前「关闭 AI」只是 AiView 里一个按钮禁用，
 * 主进程的 `ai:start` / `memory:summarize` / `extract:preview` 三个**真会发 HTTP** 的入口
 * 没有任何闸门——渲染层一旦被程序化调用（或将来多一个入口忘了禁用），AI 就在用户以为关掉的情况下偷偷联网。
 * docs/01 §6 的红线是「默认关闭、逐项开启、使用可审计」，默认关闭要成立就必须落在被调用那一侧。
 */
let aiEnabled = false;

export function setAiEnabled(enabled: boolean): void {
  aiEnabled = enabled === true;
}

export function aiEnabledFlag(): boolean {
  return aiEnabled;
}

/** LLM 入口的统一前置断言：未开启即拒（不发任何请求），错误信息给可操作指引 */
export function assertAiEnabled(): void {
  if (!aiEnabled) {
    throw new YushuError(
      "E_AI_DISABLED",
      "AI 调用当前已关闭（默认关闭，逐项开启）：请在「AI 副驾」勾选「启用 AI 调用」后再试；关闭状态下本地功能全部可用",
    );
  }
}

/** 加密后端是否可用（T3-14）：未注入后端或 safeStorage 未就绪都算不可用——UI 据此禁用「加密保存」，绝不降级存明文 */
export function keyBackendAvailable(): boolean {
  return keyCipher !== null && keyCipher.available;
}

/** 当前项目的凭据库仓储（未注入后端时抛 E_SECRETS_BACKEND，不静默降级） */
export function secretsOf(gateway: ProjectGateway): SecretsRepository {
  if (!keyCipher) {
    throw new YushuError(
      "E_SECRETS_BACKEND",
      "凭据加密后端未就绪（Electron safeStorage 未注入）：本次会话 Key 与环境变量仍可用，加密保存暂不可用",
    );
  }
  return new SecretsRepository(gateway.root, keyCipher);
}

/** 解密供本次调用使用的凭据表（provider 未声明 key_ref 时天然为空表）；供 memory/extract 复用 */
export async function storedKeysFor(
  gateway: ProjectGateway,
  providers: LlmProviderSpec[],
): Promise<Record<string, string>> {
  if (!keyCipher || !providers.some((provider) => Boolean(provider.key_ref))) return {};
  return new SecretsRepository(gateway.root, keyCipher).storedKeysFor(providers);
}

/** 已登记的 key_ref 集合（凭据库不存在 / 损坏时按「无已存凭据」处理，不阻断配置页读取） */
async function storedKeyRefs(gateway: ProjectGateway): Promise<Set<string>> {
  if (!keyCipher) return new Set();
  try {
    return new Set((await new SecretsRepository(gateway.root, keyCipher).list()).map((item) => item.key_ref));
  } catch {
    return new Set();
  }
}

/** 可靠性闸门（T3-2）：冷却与并发状态跨调用共享（配置每次从 config/routing.yaml 读取）；
 *  记忆摘要（T3-5）等其他任务共用同一闸门，避免每个任务各持一份冷却/并发状态。 */
export const reliabilityGate = new ReliabilityGate();

export function setSessionKey(providerId: string, apiKey: string): void {
  if (!providerId.trim()) throw new YushuError("E_INVALID_INPUT", "providerId 不能为空");
  if (apiKey.trim() === "") sessionKeys.delete(providerId);
  else sessionKeys.set(providerId, apiKey.trim());
}

/** 会话内存 Key 快照（供 llm 调用选项；不落盘，不回传渲染层） */
export function sessionKeySnapshot(): Record<string, string> {
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
      // T3-12：定价必须随载荷透出——保存路径是 providers 全量替换，漏传等于抹掉手写价格
      ...(model.pricing ? { pricing: { ...model.pricing } } : {}),
    })),
    ...(provider.api_key_env ? { api_key_env: provider.api_key_env } : {}),
    ...(provider.key_ref ? { key_ref: provider.key_ref } : {}),
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

/** 读取 config/routing.yaml 并校验；不存在时返回内置默认（docs/03 §9） */
export async function loadRoutingConfigForUse(gateway: ProjectGateway): Promise<RoutingConfig> {
  const snapshot = await gateway.readDoc(ROUTING_CONFIG_PATH).catch(() => null);
  if (!snapshot) return defaultRoutingConfig();
  return parseRoutingConfig(snapshot.content);
}

/**
 * 读取 config/budget.yaml（**可选文件**：不存在 = 不设月度上限，走内置默认）。
 *
 * 解析失败**不静默回落到默认值**——那会让作者以为护栏正按他写的上限盯着，实际盯的是另一套数。
 * 错误原文带回给面板外显，并由调用方额外记一条 error 级体检发现（budget-config-invalid）。
 */
export async function loadBudgetConfigForUse(
  gateway: ProjectGateway,
): Promise<{ config: BudgetConfig; exists: boolean; error: string | null }> {
  const snapshot = await gateway.readDoc(BUDGET_CONFIG_PATH).catch(() => null);
  if (!snapshot) return { config: defaultBudgetConfig(), exists: false, error: null };
  try {
    return { config: parseBudgetConfig(snapshot.content), exists: true, error: null };
  } catch (err) {
    return {
      config: defaultBudgetConfig(),
      exists: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const RETRY_POLICY_LABELS = ["RateLimitError", "InternalServerError", "NetworkError"] as const;

/** 路由载荷（任务路由 + 可靠性；UI 展示与 e2e 探针用） */
async function readAiRouting(gateway: ProjectGateway): Promise<AiRoutingState> {
  const snapshot = await gateway.readDoc(ROUTING_CONFIG_PATH).catch(() => null);
  const routing = snapshot ? parseRoutingConfig(snapshot.content) : defaultRoutingConfig();
  return {
    path: ROUTING_CONFIG_PATH,
    exists: snapshot !== null,
    routes: Object.entries(routing.routes).map(([task, route]) => ({
      task,
      prefer: [...(route.prefer ?? [])],
      require: [...(route.require ?? [])],
    })),
    fallback: Object.fromEntries(Object.entries(routing.fallback).map(([task, chain]) => [task, [...chain]])),
    reliability: {
      num_retries: routing.reliability.num_retries,
      retry_policy: RETRY_POLICY_LABELS.map((kind) => ({
        kind,
        ...routing.reliability.retry_policy[kind],
      })),
      cooldown: { ...routing.reliability.cooldown },
      concurrency: {
        global: routing.reliability.concurrency.global,
        per_provider: { ...routing.reliability.concurrency.per_provider },
      },
    },
  };
}

/** 配置状态（含每个 provider 的 key 就绪态；不返回 key 本身） */
export async function readAiConfig(gateway: ProjectGateway): Promise<AiConfigState> {
  const snapshot = await gateway.readDoc(LLM_CONFIG_PATH).catch(() => null);
  // v1 文本由 parseLlmConfig 自动迁移（内存态；写回由保存路径显式完成并先行备份）
  const config = snapshot ? parseLlmConfig(snapshot.content) : defaultLlmConfig();
  const keys = sessionKeySnapshot();
  // T3-14：已加密保存的凭据清单（只取 key_ref，绝不把明文回传渲染层；后端未就绪时为空）
  const storedRefs = await storedKeyRefs(gateway);

  const keyStates = config.providers.map((provider) => {
    const hasSessionKey = Boolean(keys[provider.id]);
    const hasEnvKey = Boolean(provider.api_key_env && process.env[provider.api_key_env]);
    const hasStoredKey = Boolean(provider.key_ref && storedRefs.has(provider.key_ref));
    return {
      provider_id: provider.id,
      ...(provider.api_key_env ? { api_key_env: provider.api_key_env } : {}),
      ...(provider.key_ref ? { key_ref: provider.key_ref } : {}),
      has_session_key: hasSessionKey,
      has_env_key: hasEnvKey,
      has_stored_key: hasStoredKey,
      // 既不需要鉴权（本地端点）也算就绪
      ready:
        hasSessionKey ||
        hasEnvKey ||
        hasStoredKey ||
        (!provider.api_key_env && !provider.key_ref),
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
    routing: await readAiRouting(gateway),
    // T3-4：能力差异标注（非阻断）与本地模型预设（供 UI 一键添加）
    warnings: lintLlmConfig(config).map((warning) => ({
      provider_id: warning.provider_id,
      ...(warning.model ? { model: warning.model } : {}),
      message: warning.message,
    })),
    localPresets: LOCAL_PROVIDER_PRESETS.map((preset) => ({
      id: preset.id,
      label: preset.label,
      note: preset.note,
      provider: toProviderPayload(createLocalProvider(preset.id)),
    })),
    keyStates,
    // T3-14：加密后端可用性随配置一并下发（渲染层据此禁用「加密保存」并如实提示，不猜）
    keyBackendAvailable: keyBackendAvailable(),
    aiEnabled: aiEnabledFlag(),
    canGenerate: keyStates.some((state) => state.ready),
    // T3-11（J08/J09）：批量任务半价通道规划（batch_eligible：outline / summarize / extract）
    channels: planChannels(config.providers).map((plan) => ({
      task: plan.task,
      channel: plan.channel,
      eligible: plan.eligible,
      note: plan.note,
    })),
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

/**
 * providers 单点改写并回写真源：saveAiConfig 是「providers 全量替换」，
 * 所以必须先拿 readAiConfig 的当前列表（含定价 / 能力矩阵）再改目标那一条，并带上读时 hash 做并发检测。
 */
async function patchProvider(
  gateway: ProjectGateway,
  state: AiConfigState,
  providerId: string,
  patch: (provider: AiProviderPayload) => AiProviderPayload,
): Promise<AiConfigState> {
  return saveAiConfig(gateway, {
    providers: state.config.providers.map((provider) =>
      provider.id === providerId ? patch(provider) : provider,
    ),
    ...(state.hash ? { baseHash: state.hash } : {}),
  });
}

/** provider 必须已在真源里（key_ref 只有写在已存在的 provider 上才有意义） */
function requireProvider(state: AiConfigState, providerId: string): void {
  if (!state.config.providers.some((provider) => provider.id === providerId)) {
    throw new YushuError(
      "E_INVALID_INPUT",
      `config/llm.yaml 里没有 provider「${providerId}」：请先点「保存 Provider 配置」，再为其加密保存 Key`,
    );
  }
}

/**
 * 加密保存 provider 的 API Key（T3-14 桌面端接线），两步缺一不可：
 * ① 密文入凭据库 `.yushu/secrets.json`（派生物；后端不可用时 put 抛 E_SECRETS_BACKEND，绝不降级写明文）；
 * ② 真源 `config/llm.yaml` 只补 `key_ref` 引用——走 readAiConfig → saveAiConfig，不绕开校验与并发检测自己写文件。
 * `api_key_env` 保留用户已填值：两种凭据来源可共存，取值顺序（会话 > 凭据库 > 环境变量）已决定优先级。
 * 空串按**拒绝**处理而不是「清除」：清除是独立动作（clearProviderKey），输入框误触不该把已有凭据删掉。
 */
export async function saveProviderKey(
  gateway: ProjectGateway,
  providerId: string,
  apiKey: string,
): Promise<AiConfigState> {
  const id = providerId.trim();
  if (id === "") throw new YushuError("E_INVALID_INPUT", "providerId 不能为空");
  const plain = apiKey.trim();
  if (plain === "") {
    throw new YushuError("E_INVALID_INPUT", "API Key 为空：加密保存需要非空密钥；如需移除请点「清除凭据」");
  }
  const current = await readAiConfig(gateway);
  requireProvider(current, id);
  const keyRef = defaultKeyRefFor(id);
  await secretsOf(gateway).put(keyRef, plain, id);
  // 会话内存 Key 的优先级高于凭据库：旧会话 Key 留着会盖住刚存的密文（用户以为新 Key 已生效），故显式失效
  setSessionKey(id, "");
  return patchProvider(gateway, current, id, (provider) => ({ ...provider, key_ref: keyRef }));
}

/**
 * 清除 provider 凭据（T3-14）：删凭据库条目 + 去掉真源的 `key_ref`（会话内存 Key 不动，它本就不落盘）。
 * 先删密文再改真源：反序一旦删除失败就留下「yaml 指向已不存在条目」的悬空引用——面板显示「未配置」而磁盘仍有密文，最难查。
 */
export async function clearProviderKey(
  gateway: ProjectGateway,
  providerId: string,
): Promise<AiConfigState> {
  const id = providerId.trim();
  if (id === "") throw new YushuError("E_INVALID_INPUT", "providerId 不能为空");
  // remove 幂等（条目本就不存在返回 false），此时仍要继续清掉真源的 key_ref
  await secretsOf(gateway).remove(defaultKeyRefFor(id));
  const current = await readAiConfig(gateway);
  if (!current.config.providers.some((provider) => provider.id === id)) return current;
  return patchProvider(gateway, current, id, (provider) => {
    const next = { ...provider };
    delete next.key_ref;
    return next;
  });
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
  // A4 闸门（第二道）：`ai:start` 是 fire-and-forget，处理器侧已先拦一次；
  // 这里再断言一次，防"将来新增调用方绕过处理器"把闸门变成一次性护栏。
  assertAiEnabled();
  const { streamId, payload, sink, signal } = args;
  const usageId = newUsageId();
  let preview: ContextPreviewPayload | null = null;
  /** 发送前的 prompt token 估算（T3-12，与 usage 实报对账）；上下文组装失败时保持缺省 */
  let promptEstimate: number | undefined;

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
    // T3-11（J15）：多候选生成——注入「独立生成、不得互相参照」标记（保证候选多样性而非同质复制）
    if (payload.candidateTotal && payload.candidateTotal > 1 && payload.candidateIndex) {
      const marker = `【多候选生成 #${payload.candidateIndex}/${payload.candidateTotal}：独立生成本候选，不得参照其它候选或与其保持一致】`;
      task.instruction = task.instruction ? `${task.instruction}\n${marker}` : marker;
    }
    const messages = assembleMessages(preview, task);
    const config = await loadLlmConfigForUse(gateway);
    // T3-2：任务路由（draft-first / continue 均归 drafting：prefer 旗舰 + require stream）
    // + 可靠性（重试 / 冷却 / 并发）。
    const routing = await loadRoutingConfigForUse(gateway);
    const route = resolveRoute("drafting", config.providers, routing);
    const providers = orderProvidersByRoute(config.providers, route);

    // T3-3：能力矩阵驱动的自动降级——require 未满足不报错（提示词约束 / 一次性返回 / JSON 后校验）
    const plan = planDowngrade(route.unmet);
    for (const action of plan.actions) {
      sink({ streamId, type: "downgrade", message: action.message });
    }
    if (plan.prompt_suffix) {
      messages.push({ role: "user", content: plan.prompt_suffix });
    }
    // T3-12：发送前估算（含降级追加的约束段——按实际发出的消息体算）
    promptEstimate = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);

    let accumulated = "";
    const onDelta = (delta: { text: string }) => {
      accumulated += delta.text;
      sink({ streamId, type: "delta", text: delta.text, chars: countWords(accumulated) });
    };

    const callOptions = {
      sessionKeys: sessionKeySnapshot(),
      storedKeys: await storedKeysFor(gateway, providers),
      reliability: { config: routing.reliability, gate: reliabilityGate },
      onFallback: (info: LlmFallbackInfo) =>
        sink({ streamId, type: "fallback", providerId: info.provider_id, reason: info.reason }),
    };
    const oneShot = plan.actions.some((action) => action.strategy === "one_shot");
    let result: ChatResult;
    if (oneShot) {
      // 降级：一次性返回（模型未声明 stream）；以单个 delta 形式送达，UI 保持同一渲染路径
      result = await chat(providers, { messages, signal }, callOptions);
      accumulated = result.text;
      if (result.text !== "") {
        sink({ streamId, type: "delta", text: result.text, chars: countWords(result.text) });
      }
    } else {
      result = await stream(providers, { messages, signal }, { onDelta }, callOptions);
    }
    // T3-3：JSON 后校验（仅结构化降级路径；失败仅提示，不阻断）
    if (plan.post_validate_json) {
      const parsed = extractJson(result.text);
      if (!parsed.ok) {
        sink({
          streamId,
          type: "downgrade",
          message: `JSON 后校验未通过（${parsed.error}）：请检查回复或改用支持结构化输出的模型`,
        });
      }
    }

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
      // T3-12（J09）：usage 实报落盘（缺 usage 时不写 tokens——面板计入「无 token 记录」）
      ...(result.usage ? { tokens: costTokensOf(result.usage) } : {}),
      ...(promptEstimate !== undefined ? { estimate: { prompt: promptEstimate } } : {}),
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
        // 中止时拿不到 usage（协议层未返回尾块）：completion 用已生成部分的估算值，面板标注为估算口径
        ...(promptEstimate !== undefined
          ? { estimate: { prompt: promptEstimate, completion: estimateTokens(partial) } }
          : {}),
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
      ...(promptEstimate !== undefined ? { estimate: { prompt: promptEstimate } } : {}),
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

  // 采纳后即时轻校验（M4 / T4-4 的 post-generate 落点）：范围由**刚采纳进去的正文**自己算，
  // 谁被写进这一段就只报谁的结构性结论。放在这里而不是渲染层，是因为三条采纳路径（整段替换 /
  // 整段追加 / 按句局部采纳）都走这个函数，接一处就不会漏两处。
  const audit = await postAdoptAudit(gateway, payload.text);

  return { chapterPath: path, hash: written.hash, wordCount: updated.word_count, chars, audit };
}

/** AI 使用记录（最近 N 条，倒序） */
export async function readAiUsageState(gateway: ProjectGateway, limit = 30): Promise<AiUsageState> {
  return { path: ".yushu/ai-usage.jsonl", entries: await readAiUsage(gateway.root, limit) };
}