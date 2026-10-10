import { estimateTokens } from "@yushu/memory";
import { YushuError } from "@yushu/core";
import { chapterPath, parseOutline, sampleForAudit, type AuditSample, type AuditSampleInput } from "@yushu/world-engine";
import {
  costTokensOf,
  extractStructured,
  orderProvidersByRoute,
  planChannel,
  resolveRoute,
  type ChatMessage,
} from "@yushu/llm";
import { appendAiUsage, newUsageId } from "./ai-usage.js";
import { aiEnabledFlag, loadLlmConfigForUse, loadRoutingConfigForUse, reliabilityGate, sessionKeySnapshot, storedKeysFor } from "./ai-ops.js";
import { readOutlineSafe, readWorldTitle } from "./doc-readers.js";
import type { ProjectGateway } from "./file-gateway.js";

/**
 * 全书体检的 AI 采样核验（M4 / T4-4 的"重规则 + AI 采样"，R58）。
 *
 * 三条口径决定了它值不值得信：
 * ① **AI 只能指认我们给它的片段**——返回的 `index` 越界或 `kind` 不在白名单，一律丢弃并计 `rejected`。
 *    接受模型自己报的原文位置，等于把幻觉直接写成结论，也是"第二真源"的入口。
 * ② **跑不成不阻断体检**：AI 关闭 / 没有 provider / 输出不是合法 JSON，都只回 `ran:false + reason`，
 *    结构体检照旧出结论（与采纳后轻校验同口径）。
 * ③ **烧了钱就要看得见**：一次采样记一条 usage（估算 + 实报双口径），成本面板按任务分解得到 `audit`。
 */

/** 允许 AI 指认的问题类别：白名单之外的标签一律丢弃（模型自创分类不能当真源结论） */
const AUDIT_KINDS = ["hallucination", "setting-drift", "power-jump", "name-drift"] as const;
type AuditKind = (typeof AUDIT_KINDS)[number];

const AUDIT_TASK_ID = "audit";

/** 一次体检最多采多少段（烧钱与噪音的上限，作者要的是抽查不是全量重述） */
export const DEFAULT_AUDIT_LIMIT = 8;

export interface AiAuditFinding {
  rule: string;
  severity: "error" | "warn" | "info";
  subject: string;
  evidence: string;
  fix: string;
  origin: string;
  span: { file: string; start: number; end: number; text: string } | null;
}

export interface AiAuditResult {
  ran: boolean;
  /** 未跑成的原因（跑成时为空串） */
  reason: string;
  provider: string;
  model: string;
  sampled: number;
  /** 被丢弃的 AI 条目数（越界 index / 白名单外的 kind） */
  rejected: number;
  findings: AiAuditFinding[];
}

const AUDIT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["issues"],
  properties: {
    issues: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "kind", "why"],
        properties: {
          index: { type: "integer", description: "采样清单里的序号（只能是给定的那些序号）" },
          kind: { type: "string", enum: [...AUDIT_KINDS] },
          why: { type: "string", description: "一句话说清这段哪里与设定冲突/无支撑" },
        },
      },
    },
  },
};

/** 起草过的章节（正文为真源里的正文，不含 frontmatter） */
async function draftedChapters(gateway: ProjectGateway): Promise<AuditSampleInput[]> {
  const outline = await readOutlineSafe(gateway);
  if (!outline) return [];
  const out: AuditSampleInput[] = [];
  for (const volume of outline.volumes) {
    for (const chapter of volume.chapters) {
      if (!chapter.chapter_id) continue;
      const path = chapterPath(volume.id, chapter.chapter_id);
      const snap = await gateway.readDoc(path).catch(() => null);
      if (!snap) continue;
      const split = snap.content.indexOf("\n---\n");
      const body = split < 0 ? "" : snap.content.slice(split + 5).trim();
      if (body !== "") out.push({ chapterId: chapter.chapter_id, path, body });
    }
  }
  return out;
}

function validateIssues(value: unknown, samples: readonly AuditSample[]): { valid: boolean; issues: string[] } {
  const issues: string[] = [];
  if (value === null || typeof value !== "object") return { valid: false, issues: ["返回值不是对象"] };
  const list = (value as { issues?: unknown }).issues;
  if (!Array.isArray(list)) return { valid: false, issues: ["issues 不是数组"] };
  list.forEach((item, position) => {
    if (item === null || typeof item !== "object") {
      issues.push(`issues[${position}] 不是对象`);
      return;
    }
    const record = item as Record<string, unknown>;
    // 信封校验只管"形状对不对"；index 越界与 kind 不在白名单**不在这里否决整份回答**——
    // 否则一个跑偏的条目会把同一次采样里其他有效结论一起丢掉（作者什么也看不到）
    if (typeof record["index"] !== "number" || !Number.isInteger(record["index"])) {
      issues.push(`issues[${position}].index 必须是整数`);
    }
    if (typeof record["kind"] !== "string") {
      issues.push(`issues[${position}].kind 必须是字符串`);
    }
    if (typeof record["why"] !== "string" || String(record["why"]).trim() === "") {
      issues.push(`issues[${position}].why 必须是一句非空说明`);
    }
  });
  return { valid: issues.length === 0, issues };
}

export async function runAiAudit(
  gateway: ProjectGateway,
  options: { limit?: number } = {},
): Promise<AiAuditResult> {
  const empty: AiAuditResult = { ran: false, reason: "", provider: "", model: "", sampled: 0, rejected: 0, findings: [] };
  if (!aiEnabledFlag()) {
    return { ...empty, reason: "AI 调用当前已关闭（全书体检的采样核验需要开启 AI；结构类结论不受影响）" };
  }
  let chapters: AuditSampleInput[] = [];
  try {
    chapters = await draftedChapters(gateway);
  } catch (err) {
    return { ...empty, reason: `读取章节正文失败：${err instanceof Error ? err.message : String(err)}` };
  }
  const samples = sampleForAudit(chapters, options.limit ?? DEFAULT_AUDIT_LIMIT);
  if (samples.length === 0) {
    return { ...empty, reason: "没有可采样的正文段落（章节为空或段落过短）" };
  }
  let config;
  try {
    config = await loadLlmConfigForUse(gateway);
  } catch (err) {
    return { ...empty, sampled: samples.length, reason: `模型配置读不了：${err instanceof Error ? err.message : String(err)}` };
  }
  if (config.providers.length === 0) {
    return { ...empty, sampled: samples.length, reason: "无可用 provider：请先在「AI 副驾」配置模型端点" };
  }
  const routing = await loadRoutingConfigForUse(gateway);
  const route = resolveRoute(AUDIT_TASK_ID, config.providers, routing);
  const providers = orderProvidersByRoute(config.providers, route);

  const listing = samples
    .map((sample, index) => `【${index}】章节 ${sample.chapterId}：${sample.quote}`)
    .join("\n");
  const worldTitle = await readWorldTitle(gateway);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `你是《${worldTitle}》的一致性抽查助手（任务契约 yushu.audit/consistency-sampling）。` +
        "下面给出从本书正文中**确定性采样**出的若干片段（带序号）。" +
        "只判断这些片段本身是否存在：无出处的断言（hallucination）、与设定冲突（setting-drift）、" +
        "战力/境界跳变（power-jump）、称呼不一致（name-drift）。" +
        "要求：每条结论必须引用给定序号（index），不得自己编位置、自己引原文；" +
        "没有问题的片段不要输出；kind 只能取上面四个值；why 用一句话说清依据缺失在哪。" +
        "只输出 JSON，不要 Markdown 围栏，不要解释。",
    },
    { role: "user", content: listing },
  ];
  const promptEstimate = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);

  const result = await extractStructured<{ issues?: Array<{ index: number; kind: AuditKind; why: string }> }>(
    providers,
    {
      messages,
      schema: AUDIT_OUTPUT_SCHEMA,
      maxRepair: 2,
      validate: (value) => validateIssues(value, samples),
      sessionKeys: sessionKeySnapshot(),
      storedKeys: await storedKeysFor(gateway, providers),
      reliability: { config: routing.reliability, gate: reliabilityGate },
    },
  );
  await appendAiUsage(gateway.root, {
    id: newUsageId(),
    type: "generate",
    task: AUDIT_TASK_ID,
    provider_id: result.provider_id,
    model: result.model,
    status: result.ok ? "ok" : "error",
    chars: result.raw.length,
    channel: planChannel(providers, AUDIT_TASK_ID).channel,
    ...(result.usage ? { tokens: costTokensOf(result.usage) } : {}),
    estimate: { prompt: promptEstimate },
  }).catch(() => undefined);

  if (!result.ok || !result.value) {
    return {
      ...empty,
      sampled: samples.length,
      provider: result.provider_id,
      model: result.model,
      reason: `模型输出未通过校验（${result.issues.join("；").slice(0, 160) || "无可用回答"}）`,
    };
  }

  const findings: AiAuditFinding[] = [];
  let rejected = 0;
  for (const issue of result.value.issues ?? []) {
    // 越界 / 白名单外：丢弃并计数（结论不接受模型自报的位置，也不接受它自创的分类）
    const index = issue?.index;
    const sample = typeof index === "number" && index >= 0 && index < samples.length ? samples[index] : undefined;
    if (!sample || !AUDIT_KINDS.includes(issue?.kind)) {
      rejected += 1;
      continue;
    }
    findings.push({
      rule: `ai-sampled-${issue.kind}`,
      severity: "warn",
      subject: sample.chapterId,
      evidence: `${issue.why}（采样片段：「${sample.quote}」）`,
      fix: "确认属实就改写该段或补设定出处；确属有意可在 config/consistency.yaml 记理由豁免（AI 结论一律需人工确认）",
      origin: `AI 采样（${result.provider_id}/${result.model}）`,
      span: { file: sample.path, start: sample.start, end: sample.end, text: sample.quote },
    });
  }
  findings.sort((a, b) => {
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    if (a.subject !== b.subject) return a.subject < b.subject ? -1 : 1;
    return (a.span?.start ?? 0) - (b.span?.start ?? 0);
  });
  return {
    ran: true,
    reason: "",
    provider: result.provider_id,
    model: result.model,
    sampled: samples.length,
    rejected,
    findings,
  };
}

/** 供报告合并前的一致性检查：outline 缺失等结构性问题在这里提前给出原因而不是抛 */
export async function assertOutlineReadable(gateway: ProjectGateway): Promise<string | null> {
  try {
    const snap = await gateway.readDoc("outline/outline.yaml").catch(() => null);
    if (!snap) return "项目尚无大纲（全书体检的采样需要至少一章正文）";
    parseOutline(snap.content);
    return null;
  } catch (err) {
    return err instanceof YushuError ? err.message : String(err);
  }
}
