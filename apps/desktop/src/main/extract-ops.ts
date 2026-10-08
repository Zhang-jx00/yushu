import { YushuError } from "@yushu/core";
import {
  buildExtractionCandidates,
  candidateToCardDraft,
  classifyCandidate,
  EXTRACT_OUTPUT_SCHEMA,
  EXTRACT_TASK_ID,
  parseExtractionOutput,
  type ExistingCardRef,
  type ExtractionCandidate,
} from "@yushu/world-engine";
import {
  costTokensOf,
  extractStructured,
  orderProvidersByRoute,
  planChannel,
  planDowngrade,
  resolveRoute,
  type ChatMessage,
} from "@yushu/llm";
import { estimateTokens } from "@yushu/memory";
import type {
  ExtractAdoptPayload,
  ExtractAdoptResult,
  ExtractPreviewPayload,
  ExtractPreviewResult,
  ExtractionCandidatePayload,
} from "../shared/ipc.js";
import { appendAiUsage, newUsageId } from "./ai-usage.js";
import { loadLlmConfigForUse, loadRoutingConfigForUse, reliabilityGate, sessionKeySnapshot } from "./ai-ops.js";
import { locateChapter, readChapterBody, readOutlineSafe, readWorldTitle } from "./doc-readers.js";
import { ProjectGateway } from "./file-gateway.js";
import { writeCardDoc } from "./project-ops.js";
import { readAllCards } from "./prompt-ops.js";

/**
 * 设定抽取主进程编排（M3 / T3-10，J06）：
 * - 抽取走 `extract` 任务路由（便宜档 + require structured_output；未满足经 T3-3 降级为
 *   「提示词约束 + JSON 后校验」——本编排即该降级挂点的落地）；
 * - 结构化输出：JSON Schema 唯一契约（EXTRACT_OUTPUT_SCHEMA）→ extractJson → 后校验 →
 *   失败回喂修复（≤2 次）→ 仍失败抛 E_EXTRACT_FAILED（绝不静默采用）；
 * - 结果一律候选化（服务端强制 `status: candidate`）：与既有设定卡三分类（new / augment / conflict）；
 * - 采纳（入库）是用户显式动作：仅 `new` 候选可入库（augment / conflict 需到档案页人工处置——
 *   AI 不得重复建卡、不得覆盖既有卡）；入库卡携带 `extensions.extract` 出处凭据（status=accepted）。
 */

/** 单章抽取素材上限（字符；J06 切片控制——超长截断，避免单次超上下文） */
const MAX_EXTRACT_CHARS = 12000;

function toCandidatePayload(candidate: ExtractionCandidate): ExtractionCandidatePayload {
  return {
    candidate_id: candidate.candidate_id,
    type: candidate.type,
    name: candidate.name,
    aliases: [...candidate.aliases],
    summary: candidate.summary,
    quote: candidate.quote,
    confidence: candidate.confidence,
    diff: {
      kind: candidate.diff.kind,
      ...(candidate.diff.matched_card_id ? { matched_card_id: candidate.diff.matched_card_id } : {}),
      reason: candidate.diff.reason,
    },
    status: candidate.status,
  };
}

async function existingCardRefs(gateway: ProjectGateway): Promise<ExistingCardRef[]> {
  const cards = await readAllCards(gateway);
  return cards.map((card) => ({
    id: card.id,
    type: card.type,
    name: card.name,
    aliases: [...card.aliases],
  }));
}

interface ExtractionRun {
  chapterId: string;
  chapterTitle: string;
  candidates: ExtractionCandidate[];
  provider_id: string;
  model: string;
  attempts: number;
  downgrade: ExtractPreviewResult["downgrade"];
}

async function runExtraction(gateway: ProjectGateway, chapterId: string): Promise<ExtractionRun> {
  const outline = await readOutlineSafe(gateway);
  if (!outline) throw new YushuError("E_OUTLINE", "项目尚无大纲：请先完成三级大纲");
  const located = locateChapter(outline, chapterId);
  if (!located) throw new YushuError("E_INVALID_INPUT", `找不到章节：${chapterId}（可能尚未创建草稿章节）`);
  const body = await readChapterBody(gateway, located.path);
  if (body.trim() === "") {
    throw new YushuError("E_INVALID_INPUT", "章节正文为空：请先写出正文再抽取设定候选");
  }
  const worldTitle = await readWorldTitle(gateway);
  const config = await loadLlmConfigForUse(gateway);
  if (config.providers.length === 0) {
    throw new YushuError("E_LLM_ROUTE", "无可用 provider：请先在「AI 副驾」配置模型端点");
  }
  const routing = await loadRoutingConfigForUse(gateway);
  const route = resolveRoute("extract", config.providers, routing);
  // T3-3 降级挂点：structured_output 未满足 → 提示词约束 + JSON 后校验（extractStructured 原生路径）
  const downgrade = planDowngrade(route.unmet);
  const providers = orderProvidersByRoute(config.providers, route);

  const material = body.length > MAX_EXTRACT_CHARS ? `${body.slice(0, MAX_EXTRACT_CHARS)}\n……（超长已截断）` : body;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `你是《${worldTitle}》的设定抽取助手（任务契约 ${EXTRACT_TASK_ID}）。` +
        "从给定章节正文中抽取实体候选（人物 / 地点 / 势力 / 物品 / 功法技能 / 事件 / 规则设定）。" +
        "要求：只抽取正文中有据可查的实体，每条必须给出原文引文 quote（无出处的结论不要输出）；" +
        "排除通名与代词（他 / 她 / 众人 / 公司 等）；不确定的字段留空或不输出；" +
        "confidence 为 0-1 的把握度；不要输出解释、不要输出 Markdown 围栏。",
    },
    {
      role: "user",
      content: `【章节】${located.chapter.title}（${located.volume.title}）\n【正文】\n${material}`,
    },
  ];

  // T3-12：发送前估算（仅首轮请求的消息体——修复轮会追加上下文，实报以累加 usage 为准）
  const promptEstimate = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);

  const result = await extractStructured(providers, {
    messages,
    schema: EXTRACT_OUTPUT_SCHEMA,
    maxRepair: 2,
    validate: (value) => {
      const parsed = parseExtractionOutput(value);
      return { valid: parsed.issues.length === 0, issues: parsed.issues };
    },
    sessionKeys: sessionKeySnapshot(),
    reliability: { config: routing.reliability, gate: reliabilityGate },
  });
  await appendAiUsage(gateway.root, {
    id: newUsageId(),
    type: "generate",
    task: "extract",
    provider_id: result.provider_id,
    model: result.model,
    status: result.ok ? "ok" : "error",
    chars: result.raw.length,
    chapter_id: chapterId,
    // T3-11（J08/J09）：批量任务通道归属（batch = 半价通道；未声明 batch 时按标准通道计价）
    channel: planChannel(providers, "extract").channel,
    // T3-12（J09）：抽取的 usage 为全部轮次累加（修复轮同样计费）
    ...(result.usage ? { tokens: costTokensOf(result.usage) } : {}),
    estimate: { prompt: promptEstimate },
  });
  if (!result.ok) {
    throw new YushuError(
      "E_EXTRACT_FAILED",
      `抽取未通过校验（${result.attempts} 次尝试后仍失败；原始输出已记录于 .yushu/ai-usage.jsonl）：${result.issues.join("；")}`,
    );
  }

  const parsed = parseExtractionOutput(result.value);
  const candidates = buildExtractionCandidates(parsed.candidates, await existingCardRefs(gateway));
  return {
    chapterId,
    chapterTitle: located.chapter.title,
    candidates,
    provider_id: result.provider_id,
    model: result.model,
    attempts: result.attempts,
    downgrade: downgrade.actions.map((action) => ({
      capability: action.capability,
      strategy: action.strategy,
      message: action.message,
    })),
  };
}

/** 抽取预演（只读）：候选一律 status=candidate——生成不入库，采纳是用户显式动作 */
export async function previewSettingExtraction(
  gateway: ProjectGateway,
  payload: ExtractPreviewPayload,
): Promise<ExtractPreviewResult> {
  const run = await runExtraction(gateway, payload.chapterId);
  const counts = { new: 0, augment: 0, conflict: 0 };
  for (const candidate of run.candidates) counts[candidate.diff.kind] += 1;
  return {
    chapterId: run.chapterId,
    chapterTitle: run.chapterTitle,
    candidates: run.candidates.map(toCandidatePayload),
    stats: { total: run.candidates.length, ...counts },
    provider_id: run.provider_id,
    model: run.model,
    attempts: run.attempts,
    downgrade: run.downgrade,
  };
}

/** 采纳候选（入库）：仅 new 允许（服务端复核分类——augment / conflict 明确拒绝，AI 不得覆盖） */
export async function adoptSettingCandidate(
  gateway: ProjectGateway,
  payload: ExtractAdoptPayload,
): Promise<ExtractAdoptResult> {
  const candidate = payload.candidate;
  if (!candidate || candidate.name.trim() === "" || candidate.type.trim() === "") {
    throw new YushuError("E_INVALID_INPUT", "候选缺少名称或类型，无法入库");
  }
  const existing = await existingCardRefs(gateway);
  const diff = classifyCandidate(
    {
      type: candidate.type,
      name: candidate.name,
      aliases: candidate.aliases ?? [],
      summary: candidate.summary ?? "",
      quote: candidate.quote ?? "",
      confidence: candidate.confidence ?? 0,
    },
    existing,
  );
  if (diff.kind !== "new") {
    throw new YushuError(
      "E_EXTRACT_CONFLICT",
      `候选「${candidate.name}」${
        diff.kind === "augment" ? "已存在同名/别名设定卡" : "与既有设定卡冲突"
      }（${diff.matched_card_id ?? "?"}）：AI 结果不得重复建卡或覆盖——请到「世界观档案」人工处置`,
    );
  }
  const full: ExtractionCandidate = {
    candidate_id: candidate.candidate_id || "cand-manual",
    type: candidate.type,
    name: candidate.name,
    aliases: candidate.aliases ?? [],
    summary: candidate.summary ?? "",
    quote: candidate.quote ?? "",
    confidence: candidate.confidence ?? 0,
    diff,
    status: "candidate",
  };
  const draft = candidateToCardDraft(full, { chapterId: payload.chapterId });
  const { sourceChapters = [], ...rest } = draft.card;
  const written = await writeCardDoc(gateway, {
    card: { ...rest, source_chapters: sourceChapters },
    body: draft.body,
  });
  return { path: written.path, hash: written.hash, warnings: written.warnings };
}