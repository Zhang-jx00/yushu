import {
  buildConsistencyReport,
  checkStructureFromSources,
  parseConsistencyAllowList,
  CONSISTENCY_ALLOW_PATH,
  type ConsistencyAllowList,
  type ConsistencyEntry,
  type IndexEntityRow,
  type SuppressedEntry,
} from "@yushu/world-engine";
import { mentionedEntityIds } from "@yushu/memory";
import { STRUCTURE_RULE_IDS } from "@yushu/world-engine";
import type {
  AiAdoptAuditPayload,
  ConsistencyCheckPayload,
  ConsistencyEntryPayload,
  ConsistencyReportPayload,
  ConsistencyTimingPayload,
} from "../shared/ipc.js";
import { gatewayReader } from "./index-ops.js";
import { evaluatePackRules } from "./rule-findings.js";
import { runAiAudit, type AiAuditResult } from "./ai-audit.js";
import { projectPackIds } from "./rule-ops.js";
import type { ProjectGateway } from "./file-gateway.js";

/**
 * 一致性体检的桌面接线（M4 / T4-3 报告呈现 + T4-4 三态时机，R54）。
 *
 * 通道**只读**：结论只算不写，落点问题（派生报告该不该进真源）在本轮明确搁置——
 * docs/04 §7.4 写的 `reports/consistency-*.yaml` 与"派生物不入真源"的红线冲突，
 * 要落盘应落 `.yushu/`，而那属 T4-5 提案快照体系一起做，不在这个只读轮里先建第二条写路径。
 *
 * 三态的分工：
 * - `post-generate`（生成后即时轻校验）：只报本次涉及实体发起的结论，范围外条数如实计数；
 * - `post-save`（保存后异步全量）：写通道置脏后由面板下次读取时重算，**不在输入路径上同步算**；
 * - `manual`（全书体检）：永远重算，作者点按钮就是要看当下的真结果。
 */

let cache: ConsistencyReportPayload | null = null;
let stale = true;
/** 缓存归属的项目根目录：换了项目必须作废，否则新项目的空白会被旧结论顶替 */
let cacheRoot: string | null = null;

/** 任何写真源的通道之后调用：结论过期，但缓存保留（面板可显示"上次结果 · 已过期"而不是空白） */
export function markConsistencyStale(): void {
  stale = true;
}

export function isConsistencyStale(): boolean {
  return stale;
}

function toEntry(entry: ConsistencyEntry): ConsistencyEntryPayload {
  return {
    rule: entry.rule,
    severity: entry.severity,
    subject: entry.subject,
    ...(entry.related === undefined ? {} : { related: entry.related }),
    ...(entry.path === undefined ? {} : { path: entry.path }),
    evidence: entry.evidence,
    fix: entry.fix,
    span: entry.span === null ? null : { ...entry.span },
    ...(entry.origin === undefined ? {} : { origin: entry.origin }),
  };
}

function toSuppressed(entry: SuppressedEntry): ConsistencyEntryPayload {
  return {
    ...toEntry(entry),
    reason: entry.reason,
    ...(entry.decidedAt === undefined ? {} : { decidedAt: entry.decidedAt }),
  };
}

/**
 * 轻校验范围的来源优先级：调用方明确给出的 `entityIds` > 从刚写完的正文里算出的提及。
 * 用正文自己定范围是为了不让调用方"想报谁就报谁"——采纳了林渊那段，就该看见林渊的问题。
 */
function resolveScope(
  entities: readonly IndexEntityRow[],
  entityIds?: string[],
  scopeText?: string,
): { scoped: boolean; ids: string[] } {
  if (entityIds && entityIds.length > 0) return { scoped: true, ids: [...entityIds].sort() };
  if (scopeText !== undefined) {
    const ids = mentionedEntityIds(
      scopeText,
      entities.map((entity) => ({ id: entity.id, name: entity.name, aliases: entity.aliases })),
    );
    return { scoped: true, ids: [...new Set(ids)].sort() };
  }
  return { scoped: false, ids: [] };
}

async function computeReport(
  gateway: ProjectGateway,
  timing: ConsistencyTimingPayload,
  payload: ConsistencyCheckPayload,
): Promise<ConsistencyReportPayload> {
  const structure = await checkStructureFromSources(gatewayReader(gateway));
  const scope = resolveScope(structure.entities, payload.entityIds, payload.scopeText);
  // AI 采样只在全书体检这一档跑，且必须作者显式要求（一次采样 = 一次真金白银的调用）
  const wantAi = payload.aiAudit === true && timing === "manual";
  const aiAudit = wantAi
    ? await runAiAudit(gateway, {})
    : {
        ran: false,
        reason:
          timing === "post-generate"
            ? "轻校验路径不跑采样（采纳时作者要的是即时的结构结论，采样另计）"
            : payload.aiAudit === true
              ? "只有「全书体检」会跑采样（当前时机不执行）"
              : "未请求（点「AI 采样核验」才会跑）",
        provider: "",
        model: "",
        sampled: 0,
        rejected: 0,
        findings: [],
      };
  const aiFindings = wantAi && aiAudit.ran
    ? aiAudit.findings.map((finding) => ({
        rule: finding.rule,
        severity: finding.severity,
        subject: finding.subject,
        evidence: finding.evidence,
        fix: finding.fix,
        origin: finding.origin,
        ...(finding.span ? { span: finding.span } : {}),
      }))
    : [];
  // 派系包规则拿项目数据求值（战力类）：轻校验有范围时只读范围内那些卡
  const packRun = await evaluatePackRules(gateway, {
    packIds: await projectPackIds(gateway),
    entities: structure.entities,
    ...(timing === "post-generate" && scope.scoped ? { entityIds: scope.ids } : {}),
  });
  const packFindings = packRun.findings.map((finding) => ({
    rule: finding.rule,
    severity: finding.severity,
    subject: finding.subject,
    ...(finding.related === undefined ? {} : { related: finding.related }),
    evidence: finding.evidence,
    fix: finding.fix,
    origin: finding.origin,
  }));
  // 豁免清单只认**本次真的参与求值的那些 id**（内置三条 + 包里的规则 id）：
  // 仍然不许豁免一条不存在的规则，但包规则接入后不能再被这句挡在门外
  const knownRuleIds = [
    ...STRUCTURE_RULE_IDS,
    ...packRun.evaluated,
    ...packRun.notEvaluated.map((item) => item.id),
    // AI 采样的结论也要能被豁免（四个类别固定，不随模型输出漂移）
    "ai-sampled-hallucination",
    "ai-sampled-setting-drift",
    "ai-sampled-power-jump",
    "ai-sampled-name-drift",
  ];

  let allow: ConsistencyAllowList | null = null;
  let allowExists = false;
  let allowError: string | null = null;
  const allowSnap = await gateway.readDoc(CONSISTENCY_ALLOW_PATH).catch(() => null);
  if (allowSnap) {
    allowExists = true;
    try {
      allow = parseConsistencyAllowList(allowSnap.content, knownRuleIds);
    } catch (err) {
      // 读不了就**不应用任何豁免**：静默放行等于把坏清单变成"全部正常"
      allowError = err instanceof Error ? err.message : String(err);
    }
  }

  // 只为"确实要跳过去"的文件读原文，别为一张空项目读遍全库
  const cardTexts: Record<string, string> = {};
  const filePathById = new Map(structure.entities.map((entity) => [entity.id, entity.filePath]));
  const needed = new Set<string>();
  for (const finding of [...structure.findings, ...packFindings, ...aiFindings]) {
    const file = filePathById.get(finding.subject);
    if (file && cardTexts[file] === undefined) needed.add(file);
  }
  for (const file of needed) {
    const snap = await gateway.readDoc(file).catch(() => null);
    if (snap) cardTexts[file] = snap.content;
  }

  const report = buildConsistencyReport({
    findings: [...structure.findings, ...packFindings, ...aiFindings],
    entities: structure.entities,
    cardTexts,
    allow,
  });

  let entries = report.entries;
  let filteredOut = 0;
  // 轻校验只在**给了范围**时过滤；范围空着不过滤——没范围就报全部比"悄悄清零"诚实
  if (timing === "post-generate" && scope.scoped) {
    const kept = entries.filter((entry) => new Set(scope.ids).has(entry.subject));
    filteredOut = entries.length - kept.length;
    entries = kept;
  }

  return {
    timing,
    ranAgain: true,
    allowPath: CONSISTENCY_ALLOW_PATH,
    allowExists,
    allowError,
    worldNote: structure.worldNote,
    entities: structure.sources.entities,
    refs: structure.sources.refs,
    scopeIds: timing === "post-generate" ? scope.ids : [],
    entries: entries.map(toEntry),
    suppressed: report.suppressed.map(toSuppressed),
    unusedAllow: report.unusedAllow,
    outOfScope: structure.outOfScope.map((item) => ({ ...item })),
    skipped: { ...structure.skipped },
    pack: { evaluated: packRun.evaluated, notEvaluated: packRun.notEvaluated, errors: packRun.errors },
    aiAudit: {
      ran: aiAudit.ran,
      reason: aiAudit.reason,
      provider: aiAudit.provider,
      model: aiAudit.model,
      sampled: aiAudit.sampled,
      rejected: aiAudit.rejected,
    },
    counted: {
      findings: structure.findings.length,
      entries: entries.length,
      suppressed: report.suppressed.length,
      filteredOut,
    },
  };
}

/** 跑一次一致性体检（按三态时机决定是否复用缓存与是否按范围过滤） */
export async function runConsistencyCheck(
  gateway: ProjectGateway,
  payload: ConsistencyCheckPayload = {},
): Promise<ConsistencyReportPayload> {
  const timing: ConsistencyTimingPayload = payload.timing ?? "manual";
  if (cacheRoot !== gateway.root) {
    cacheRoot = gateway.root;
    cache = null;
    stale = true;
  }
  if (timing === "post-save" && !stale && cache !== null) {
    return { ...cache, timing, ranAgain: false };
  }
  const fresh = await computeReport(gateway, timing, payload);
  if (timing !== "post-generate") {
    cache = fresh;
    stale = false;
  }
  return fresh;
}

/**
 * 采纳后即时轻校验（M4 / T4-4 的 post-generate 调用点，R56）。
 *
 * **绝不抛错**：调用时正文已经落盘了，这里抛出去会让副驾把整次操作报成"采纳失败"，
 * 而作者的真实选择是再采纳一次（重复写入）。拿不到结论就如实说"没跑成 + 为什么"。
 */
export async function postAdoptAudit(gateway: ProjectGateway, text: string): Promise<AiAdoptAuditPayload> {
  try {
    const report = await runConsistencyCheck(gateway, { timing: "post-generate", scopeText: text });
    return {
      ran: true,
      error: "",
      scopeIds: report.scopeIds,
      entries: report.entries,
      filteredOut: report.counted.filteredOut,
    };
  } catch (err) {
    return {
      ran: false,
      error: err instanceof Error ? err.message : String(err),
      scopeIds: [],
      entries: [],
      filteredOut: 0,
    };
  }
}
