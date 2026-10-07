import { randomUUID } from "node:crypto";
import { countWords, YushuError } from "@yushu/core";
import {
  DEFAULT_INJECTION,
  applyAiSummary,
  applyHumanSummaryEdit,
  assembleContext,
  buildFactSource,
  lintMemory,
  parseChapterSummary,
  parseFact,
  parseInjectionConfig,
  parseVolumeSummary,
  planInjection,
  serializeFact,
  serializeSummary,
  verifyFactSource,
  type AssemblyItem,
  type ContextSlotName,
  type FactRecord,
  type FactSource,
  type InjectableItem,
  type InjectionConfig,
  type InjectionPlan,
  type MemoryLintFinding,
  type MemoryRecord,
  type SummaryRecord,
} from "@yushu/memory";
import { chat, orderProvidersByRoute, resolveRoute, type ChatMessage } from "@yushu/llm";
import {
  MEMORY_DIR,
  MEMORY_CHAPTER_SUMMARIES_DIR,
  MEMORY_FACTS_DIR,
  MEMORY_VOLUME_SUMMARIES_DIR,
  OUTLINE_PATH,
  WORLD_CONFIG_PATH,
  chapterPath,
  chapterSummaryPath,
  factPath,
  parseOutline,
  parseWorldConfig,
  readChapterFile,
  volumeSummaryPath,
  type Outline,
  type OutlineChapter,
  type OutlineVolume,
} from "@yushu/world-engine";
import type {
  InjectionConfigPayload,
  MemoryAssemblePayload,
  MemoryAssemblyResult,
  MemoryDeleteFactPayload,
  MemoryFactPayload,
  MemoryInjectionPreviewPayload,
  MemoryInjectionPreviewResult,
  MemorySaveFactPayload,
  MemorySaveFactResult,
  MemorySaveSummaryPayload,
  MemorySaveSummaryResult,
  MemoryStatePayload,
  MemorySummarizePayload,
  MemorySummarizeResult,
  MemorySummaryPayload,
  MemoryTargetPayload,
} from "../shared/ipc.js";
import { appendAiUsage, newUsageId } from "./ai-usage.js";
import { loadLlmConfigForUse, loadRoutingConfigForUse, reliabilityGate, sessionKeySnapshot } from "./ai-ops.js";
import { ProjectGateway } from "./file-gateway.js";
import { buildContextPreview, readAllCards } from "./prompt-ops.js";

/**
 * 五层记忆主进程编排（M3 / T3-5）：
 * - 真源 = 项目内 Markdown（memory/volumes、memory/chapters、memory/facts），SQLite 只做索引；
 * - AI 摘要一律候选化：生成不入库，采纳（入库）是用户显式动作；`summary_rev > 0` 时 AI 不得覆盖（红线）；
 * - 事实级记忆带出处链（chapter_id + 字符区间 + 摘录 sha256）：正文改动 → 出处失效可检出；
 * - 跨项目记录（project_id 不匹配）诊断为 error 并拒绝进入本项目记忆（A5 红线）。
 */

const PROJECT_ID_FALLBACK = "";
/** 摘要素材上限（字符）：超出截断（T3-7 的 token 预算细化前的粗保护） */
const MAX_SOURCE_CHARS = 8000;

/** 各层缺省注入配置（记录未显式声明时合并；T3-6）：摘要为常驻槽位，卡片/事实默认按提及触发 */
const SUMMARY_INJECTION: Record<"volume_summary" | "chapter_summary", InjectionConfig> = {
  volume_summary: { mode: "always", priority: 80, position: "after_system", budget_tokens: 800 },
  chapter_summary: { mode: "always", priority: 70, position: "after_system", budget_tokens: 1500 },
};
const CARD_INJECTION: InjectionConfig = { mode: "trigger", priority: 50, position: "near_end", budget_tokens: 600 };

function toInjectionPayload(config: InjectionConfig): InjectionConfigPayload {
  return {
    mode: config.mode,
    priority: config.priority,
    position: config.position,
    budget_tokens: config.budget_tokens,
    ...(config.reveal_gate ? { reveal_gate: config.reveal_gate } : {}),
  };
}

async function readOutlineSafe(gateway: ProjectGateway): Promise<Outline | null> {
  const snapshot = await gateway.readDoc(OUTLINE_PATH).catch(() => null);
  if (!snapshot) return null;
  try {
    return parseOutline(snapshot.content);
  } catch {
    return null;
  }
}

async function readProjectId(gateway: ProjectGateway): Promise<string> {
  const snapshot = await gateway.readDoc(WORLD_CONFIG_PATH).catch(() => null);
  if (!snapshot) return PROJECT_ID_FALLBACK;
  try {
    return parseWorldConfig(snapshot.content).id;
  } catch {
    return PROJECT_ID_FALLBACK;
  }
}

async function readWorldTitle(gateway: ProjectGateway): Promise<string> {
  const snapshot = await gateway.readDoc(WORLD_CONFIG_PATH).catch(() => null);
  if (!snapshot) return "本作品";
  try {
    return parseWorldConfig(snapshot.content).title;
  } catch {
    return "本作品";
  }
}

async function readChapterBody(gateway: ProjectGateway, path: string): Promise<string> {
  const snapshot = await gateway.readDoc(path).catch(() => null);
  if (!snapshot) return "";
  try {
    return readChapterFile(snapshot.content).body;
  } catch {
    return "";
  }
}

function locateChapter(
  outline: Outline,
  chapterEntityId: string,
): { volume: OutlineVolume; chapter: OutlineChapter; path: string } | null {
  for (const volume of outline.volumes) {
    for (const chapter of volume.chapters) {
      if (chapter.chapter_id === chapterEntityId) {
        return { volume, chapter, path: chapterPath(volume.id, chapterEntityId) };
      }
    }
  }
  return null;
}

/** 记忆状态：摘要 / 事实台账（含出处校验）/ 目标列表 / lint 发现 / 跨项目拒绝清单 */
export async function loadMemoryState(gateway: ProjectGateway): Promise<MemoryStatePayload> {
  const projectId = await readProjectId(gateway);
  const tree = await gateway.listTree();
  const isSummaryPath = (path: string) =>
    path.endsWith(".md") &&
    (path.startsWith(`${MEMORY_VOLUME_SUMMARIES_DIR}/`) || path.startsWith(`${MEMORY_CHAPTER_SUMMARIES_DIR}/`));
  const summaryPaths = tree.filter((entry) => entry.type === "file" && isSummaryPath(entry.path)).map((entry) => entry.path);
  const factPaths = tree
    .filter((entry) => entry.type === "file" && entry.path.startsWith(`${MEMORY_FACTS_DIR}/`) && entry.path.endsWith(".md"))
    .map((entry) => entry.path);

  const findings: MemoryLintFinding[] = [];
  const rejected: MemoryStatePayload["rejected"] = [];
  const records: MemoryRecord[] = [];
  const summaries: MemorySummaryPayload[] = [];
  const factsWithoutProvenance: MemoryFactPayload[] = [];

  for (const path of summaryPaths) {
    try {
      const snapshot = await gateway.readDoc(path);
      const record = path.startsWith(`${MEMORY_VOLUME_SUMMARIES_DIR}/`)
        ? parseVolumeSummary(snapshot.content)
        : parseChapterSummary(snapshot.content);
      records.push(record);
      if (record.project_id !== projectId) {
        rejected.push({
          path,
          record_id: record.id,
          project_id: record.project_id,
          reason: "记录命名空间与当前项目不符（跨项目泄漏：不进入本项目记忆）",
        });
        continue;
      }
      summaries.push({
        layer: record.layer,
        id: record.id,
        ...(record.volume_id ? { volume_id: record.volume_id } : {}),
        summary_rev: record.summary_rev,
        updated_at: record.updated_at,
        text: record.text,
        path,
        hash: snapshot.hash,
      });
    } catch (err) {
      findings.push({
        severity: "error",
        code: "memory-malformed",
        record_id: path,
        message: `摘要记录解析失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  for (const path of factPaths) {
    try {
      const snapshot = await gateway.readDoc(path);
      const record = parseFact(snapshot.content);
      records.push(record);
      if (record.project_id !== projectId) {
        rejected.push({
          path,
          record_id: record.id,
          project_id: record.project_id,
          reason: "记录命名空间与当前项目不符（跨项目泄漏：不进入本项目记忆）",
        });
        continue;
      }
      let provenance: MemoryFactPayload["provenance"] = "none";
      let provenanceNote: string | undefined;
      if (record.source) {
        const outline = await readOutlineSafe(gateway);
        const located = outline ? locateChapter(outline, record.source.chapter_id) : null;
        if (!located) {
          provenance = "broken";
          provenanceNote = `找不到出处章节：${record.source.chapter_id}（章节可能已被删除）`;
        } else {
          const body = await readChapterBody(gateway, located.path);
          const check = verifyFactSource(record.source, body);
          provenance = check.ok ? "ok" : "broken";
          if (!check.ok) provenanceNote = check.reason;
        }
      }
      const payload: MemoryFactPayload = {
        id: record.id,
        keys: [...record.keys],
        text: record.text,
        updated_at: record.updated_at,
        path,
        hash: snapshot.hash,
        ...(record.source ? { source: { ...record.source } } : {}),
        provenance,
        ...(provenanceNote ? { provenance_note: provenanceNote } : {}),
        injection: toInjectionPayload(record.injection ?? DEFAULT_INJECTION),
      };
      factsWithoutProvenance.push(payload);
    } catch (err) {
      findings.push({
        severity: "error",
        code: "memory-malformed",
        record_id: path,
        message: `事实记录解析失败：${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // lint：跨项目泄漏 = error（红线）；无出处事实 = warn（对全部记录做体检，含已拒绝记录——诊断不隐藏）
  findings.push(...lintMemory(records, projectId));

  // 目标列表（有正文素材的卷 / 章）
  const outline = await readOutlineSafe(gateway);
  const targets: MemoryTargetPayload[] = [];
  if (outline) {
    for (const volume of outline.volumes) {
      let volumeChars = 0;
      const chapterEntries: { chapter: OutlineChapter; body: string }[] = [];
      for (const chapter of volume.chapters) {
        if (!chapter.chapter_id) continue;
        const body = await readChapterBody(gateway, chapterPath(volume.id, chapter.chapter_id));
        volumeChars += body.length;
        chapterEntries.push({ chapter, body });
      }
      const volumeSummary = summaries.find((item) => item.layer === "volume_summary" && item.id === volume.id);
      targets.push({
        layer: "volume_summary",
        id: volume.id,
        title: volume.title,
        sourceChars: volumeChars,
        hasSummary: volumeSummary !== undefined,
        summaryRev: volumeSummary?.summary_rev ?? 0,
      });
      for (const { chapter, body } of chapterEntries) {
        const chapterId = chapter.chapter_id!;
        const chapterSummary = summaries.find((item) => item.layer === "chapter_summary" && item.id === chapterId);
        targets.push({
          layer: "chapter_summary",
          id: chapterId,
          title: chapter.title,
          volume_id: volume.id,
          volume_title: volume.title,
          sourceChars: body.length,
          hasSummary: chapterSummary !== undefined,
          summaryRev: chapterSummary?.summary_rev ?? 0,
        });
      }
    }
  }

  return {
    dir: MEMORY_DIR,
    project_id: projectId,
    summaries,
    targets,
    facts: factsWithoutProvenance,
    findings,
    rejected,
  };
}

function truncateSource(text: string): string {
  if (text.length <= MAX_SOURCE_CHARS) return text;
  return `${text.slice(0, MAX_SOURCE_CHARS)}\n……（素材超长已截断）`;
}

/** AI 摘要候选（T3-5）：生成不入库——采纳是用户显式动作（候选化原则） */
export async function summarizeMemory(
  gateway: ProjectGateway,
  payload: MemorySummarizePayload,
): Promise<MemorySummarizeResult> {
  const outline = await readOutlineSafe(gateway);
  if (!outline) throw new YushuError("E_OUTLINE", "项目尚无大纲：请先完成三级大纲");

  let sourceLabel = "";
  let source = "";
  let chapterId: string | undefined;
  if (payload.layer === "chapter_summary") {
    const located = locateChapter(outline, payload.id);
    if (!located) throw new YushuError("E_INVALID_INPUT", `找不到章节：${payload.id}`);
    source = await readChapterBody(gateway, located.path);
    sourceLabel = `章「${located.chapter.title}」（${located.volume.title}）`;
    chapterId = payload.id;
  } else {
    const volume = outline.volumes.find((item) => item.id === payload.id);
    if (!volume) throw new YushuError("E_INVALID_INPUT", `找不到卷纲：${payload.id}`);
    const parts: string[] = [];
    for (const chapter of volume.chapters) {
      if (!chapter.chapter_id) continue;
      const body = await readChapterBody(gateway, chapterPath(volume.id, chapter.chapter_id));
      if (body.trim() !== "") parts.push(`【${chapter.title}】\n${body}`);
    }
    source = parts.join("\n\n");
    sourceLabel = `卷「${volume.title}」（${volume.act}）`;
  }
  if (source.trim() === "") {
    throw new YushuError("E_INVALID_INPUT", "素材正文为空：请先写出章节正文再生成摘要");
  }

  const worldTitle = await readWorldTitle(gateway);
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `你是《${worldTitle}》的长期记忆管理助手：把给定正文压缩为可复用的记忆摘要，供后续章节续写时参考。` +
        "要求：只输出摘要本身（纯文本 3-6 条要点，每条一行，不要标题、不要评价文笔）；" +
        "保留关键事件、人物状态变化、新出现的设定/道具/伏笔与结尾悬念；不得引入正文中不存在的设定。",
    },
    {
      role: "user",
      content: `【对象】${sourceLabel}\n【正文】\n${truncateSource(source)}\n【任务】输出该${payload.layer === "chapter_summary" ? "章" : "卷"}的中文摘要（3-6 条要点）。`,
    },
  ];

  const config = await loadLlmConfigForUse(gateway);
  if (config.providers.length === 0) {
    throw new YushuError("E_LLM_ROUTE", "无可用 provider：请先在「AI 副驾」配置模型端点");
  }
  const routing = await loadRoutingConfigForUse(gateway);
  // T3-5：摘要走 summarize 任务路由（默认 prefer small——压缩类任务不必烧旗舰）
  const route = resolveRoute("summarize", config.providers, routing);
  const providers = orderProvidersByRoute(config.providers, route);
  const result = await chat(providers, { messages }, {
    sessionKeys: sessionKeySnapshot(),
    reliability: { config: routing.reliability, gate: reliabilityGate },
  });
  const text = result.text.trim();
  if (text === "") {
    throw new YushuError("E_LLM_EMPTY", "模型返回为空：请重试或更换 provider");
  }
  const chars = countWords(text);
  await appendAiUsage(gateway.root, {
    id: newUsageId(),
    type: "generate",
    task: "summarize",
    provider_id: result.provider_id,
    model: result.model,
    status: "ok",
    chars,
    ...(chapterId ? { chapter_id: chapterId } : {}),
  });
  return {
    layer: payload.layer,
    id: payload.id,
    text,
    chars,
    provider_id: result.provider_id,
    model: result.model,
  };
}

/** 摘要入库：ai = 候选入库（rev > 0 → E_MEMORY_REV_PROTECTED）；human = 人工编辑（rev+1） */
export async function saveMemorySummary(
  gateway: ProjectGateway,
  payload: MemorySaveSummaryPayload,
): Promise<MemorySaveSummaryResult> {
  const text = payload.text.trim();
  if (text === "") throw new YushuError("E_INVALID_INPUT", "摘要正文为空，无法入库");
  const projectId = await readProjectId(gateway);
  const path = payload.layer === "volume_summary" ? volumeSummaryPath(payload.id) : chapterSummaryPath(payload.id);
  const snapshot = await gateway.readDoc(path).catch(() => null);
  let existing: SummaryRecord | null = null;
  if (snapshot) {
    existing =
      payload.layer === "volume_summary" ? parseVolumeSummary(snapshot.content) : parseChapterSummary(snapshot.content);
    if (!payload.baseHash) {
      throw new YushuError("E_INVALID_INPUT", `更新既有摘要必须携带 baseHash（${path}）`);
    }
  }
  const now = new Date().toISOString();
  const input = {
    id: payload.id,
    project_id: projectId,
    ...(payload.volume_id ? { volume_id: payload.volume_id } : {}),
    text,
  };
  const record =
    payload.origin === "ai"
      ? applyAiSummary(payload.layer, existing, input, now)
      : applyHumanSummaryEdit(existing, input, now, payload.layer);
  const written = await gateway.writeDoc(path, serializeSummary(record), existing ? payload.baseHash : undefined);
  return { path, hash: written.hash, summary_rev: record.summary_rev, updated_at: record.updated_at };
}

/** 事实登记（带出处可选）：出处经正文计算摘录 hash——出处链必须可验证 */
export async function saveMemoryFact(
  gateway: ProjectGateway,
  payload: MemorySaveFactPayload,
): Promise<MemorySaveFactResult> {
  const keys = (payload.keys ?? []).map((key) => key.trim()).filter((key) => key !== "");
  if (keys.length === 0) throw new YushuError("E_INVALID_INPUT", "事实关键词（keys）不能为空");
  const text = payload.text.replace(/\r\n/g, "\n").trim();
  if (text === "") throw new YushuError("E_INVALID_INPUT", "事实正文为空，无法入库");
  const projectId = await readProjectId(gateway);
  const id = payload.id?.trim() ? payload.id.trim() : `fact-${randomUUID().slice(0, 8)}`;
  const path = factPath(id);
  const snapshot = await gateway.readDoc(path).catch(() => null);
  if (snapshot && !payload.baseHash) {
    throw new YushuError("E_INVALID_INPUT", `更新既有事实必须携带 baseHash（${path}）`);
  }

  let source: FactSource | undefined;
  if (payload.provenance) {
    const outline = await readOutlineSafe(gateway);
    const located = outline ? locateChapter(outline, payload.provenance.chapter_id) : null;
    if (!located) {
      throw new YushuError("E_INVALID_INPUT", `出处章节不存在：${payload.provenance.chapter_id}（请先在三级大纲创建草稿章节）`);
    }
    const body = await readChapterBody(gateway, located.path);
    try {
      source = buildFactSource(payload.provenance.chapter_id, body, payload.provenance.start, payload.provenance.end);
    } catch (err) {
      throw new YushuError("E_INVALID_INPUT", err instanceof Error ? err.message : String(err));
    }
  }

  // T3-6：注入配置（显式传入即校验落盘；省略时保留既有配置，新建用默认——落盘只写显式配置）
  let injection: InjectionConfig | undefined;
  const existingRecord = snapshot ? parseFact(snapshot.content) : null;
  if (payload.injection) {
    injection = parseInjectionConfig(payload.injection, id);
  } else if (existingRecord?.injection) {
    injection = existingRecord.injection;
  }

  const record: FactRecord = {
    layer: "fact",
    id,
    project_id: projectId,
    keys,
    text: `${text}\n`,
    ...(source ? { source } : {}),
    ...(injection ? { injection } : {}),
    updated_at: new Date().toISOString(),
  };
  const written = await gateway.writeDoc(path, serializeFact(record), snapshot ? payload.baseHash : undefined);
  return { path, hash: written.hash, id, provenance: source ? "ok" : "none" };
}

/** 删除事实（携带 baseHash 并发检测，防误删外部修改版） */
export async function deleteMemoryFact(
  gateway: ProjectGateway,
  payload: MemoryDeleteFactPayload,
): Promise<boolean> {
  const path = factPath(payload.id);
  const snapshot = await gateway.readDoc(path).catch(() => null);
  if (!snapshot) throw new YushuError("E_MEMORY_NOT_FOUND", `事实不存在：${payload.id}`);
  await gateway.deleteDoc(path, payload.baseHash);
  return true;
}

interface CollectedChapter {
  chapterId: string;
  chapterTitle: string;
  chapterOrdinal: number;
  chapterPath: string;
  mentionText: string;
  items: InjectableItem[];
  ordinalOf: (chapterId: string) => number | null;
  /** 条目新近度（priority_then_recent 用；缺省 0） */
  recencyOf: Map<string, number>;
  /** 稳定前缀文本（system_prompt + world_constraints；人设与任务约束必须常驻） */
  systemText: string;
  /** 最近正文（recent_prose 槽位） */
  recentProse: string;
}

/**
 * 收集指定章节的五层记忆可注入条目（T3-6/T3-7 共用）：
 * 摘要（常驻槽位）/ 事实（keys 触发，记录级注入配置）/ 设定卡（名称·别名触发，
 * 卡片 frontmatter `injection` 可覆盖）；同时给出系统提示与最近正文（来自既有上下文组装）。
 */
async function collectChapterContext(gateway: ProjectGateway, chapterId: string): Promise<CollectedChapter> {
  const outline = await readOutlineSafe(gateway);
  if (!outline) throw new YushuError("E_OUTLINE", "项目尚无大纲：请先完成三级大纲");

  // 全局章序（卷序 → 章序，1-based；未建草稿的章纲同样计数——门控按叙事顺序判定）
  const ordered: { volume: OutlineVolume; chapter: OutlineChapter; path: string; ordinal: number }[] = [];
  const volumeTitles = new Map<string, string>();
  let ordinal = 0;
  for (const volume of outline.volumes) {
    volumeTitles.set(volume.id, volume.title);
    for (const chapter of volume.chapters) {
      ordinal += 1;
      if (!chapter.chapter_id) continue;
      ordered.push({ volume, chapter, path: chapterPath(volume.id, chapter.chapter_id), ordinal });
    }
  }
  const locate = ordered.find((item) => item.chapter.chapter_id === chapterId);
  if (!locate) throw new YushuError("E_INVALID_INPUT", `找不到章节：${chapterId}（可能尚未创建草稿章节）`);
  const ordinalOf = (id: string) => ordered.find((item) => item.chapter.chapter_id === id)?.ordinal ?? null;
  const mentionText = await readChapterBody(gateway, locate.path);
  const chapterTitleById = new Map(ordered.map((item) => [item.chapter.chapter_id!, item.chapter.title]));
  const chapterOrdinalById = new Map(ordered.map((item) => [item.chapter.chapter_id!, item.ordinal]));

  const state = await loadMemoryState(gateway);
  const items: InjectableItem[] = [];
  const recencyOf = new Map<string, number>();
  for (const summary of state.summaries) {
    const title =
      summary.layer === "volume_summary"
        ? `卷摘要：${volumeTitles.get(summary.id) ?? summary.id}`
        : `章摘要：${chapterTitleById.get(summary.id) ?? summary.id}`;
    items.push({ id: summary.id, layer: summary.layer, title, text: summary.text, keys: [], config: SUMMARY_INJECTION[summary.layer] });
    recencyOf.set(
      summary.id,
      summary.layer === "chapter_summary" ? (chapterOrdinalById.get(summary.id) ?? 0) : Date.parse(summary.updated_at) || 0,
    );
  }
  for (const fact of state.facts) {
    items.push({ id: fact.id, layer: "fact", title: `事实：${fact.id}`, text: fact.text, keys: fact.keys, config: fact.injection });
    recencyOf.set(fact.id, Date.parse(fact.updated_at) || 0);
  }
  const cards = await readAllCards(gateway);
  for (const card of cards) {
    let cardInjection = CARD_INJECTION;
    if (card.injection !== undefined) {
      try {
        cardInjection = parseInjectionConfig(card.injection, card.id);
      } catch {
        // 卡上注入配置非法：保守用默认（卡片仍可在档案页修复；不影响注入链路可用）
      }
    }
    const alias = card.aliases.length > 0 ? `（别名：${card.aliases.join("、")}）` : "";
    items.push({
      id: card.id,
      layer: "world_core",
      title: `设定卡：${card.name}`,
      text: `【${card.type}｜${card.layer}】${card.name}${alias}\n${card.body.slice(0, 800)}`,
      keys: [card.name, ...card.aliases],
      config: cardInjection,
    });
  }

  // 系统提示与最近正文（复用既有上下文组装的槽位文本——稳定前缀置头）
  const preview = await buildContextPreview(gateway, { volumeId: locate.volume.id, chapterId: locate.chapter.id });
  const slotText = (name: string) => preview.slots.find((slot) => slot.slot === name)?.text ?? "";
  const systemText = [slotText("system_prompt"), slotText("world_constraints")].filter((text) => text.trim() !== "").join("\n\n");

  return {
    chapterId,
    chapterTitle: locate.chapter.title,
    chapterOrdinal: locate.ordinal,
    chapterPath: locate.path,
    mentionText,
    items,
    ordinalOf,
    recencyOf,
    systemText,
    recentProse: slotText("recent_prose"),
  };
}

function planFor(collected: CollectedChapter, manualIds?: string[]): InjectionPlan {
  return planInjection(collected.items, {
    chapterOrdinal: collected.chapterOrdinal,
    ordinalOf: collected.ordinalOf,
    mentionText: collected.mentionText,
    ...(manualIds ? { manualIds } : {}),
  });
}

/**
 * 注入预演（T3-6）：对指定章节输出注入计划（决策 + 排除原因 + token 估算）。
 * T3-7 的组装（assembleForChapter）在此决策之上做槽位落位、去重与预算裁剪。
 */
export async function previewInjection(
  gateway: ProjectGateway,
  payload: MemoryInjectionPreviewPayload,
): Promise<MemoryInjectionPreviewResult> {
  const collected = await collectChapterContext(gateway, payload.chapterId);
  const plan = planFor(collected, payload.manualIds);
  return {
    chapterId: collected.chapterId,
    chapterTitle: collected.chapterTitle,
    chapterOrdinal: collected.chapterOrdinal,
    chapterPath: collected.chapterPath,
    mentionChars: collected.mentionText.length,
    entries: plan.entries,
    excluded: plan.excluded,
    totals: { injected: plan.entries.length, excluded: plan.excluded.length, tokens: plan.totalTokens },
  };
}

/** 注入条目 → 组装槽位（T3-7）：常驻卡片进 world_core（稳定前缀），触发卡片进 triggered_cards；fact → facts */
function slotOf(entry: { layer: InjectableItem["layer"]; mode: InjectionConfig["mode"] }): ContextSlotName {
  if (entry.layer === "world_core") return entry.mode === "always" ? "world_core" : "triggered_cards";
  if (entry.layer === "fact") return "facts";
  return entry.layer;
}

/**
 * 上下文组装（T3-7；docs/03 §10.2）：固定槽位顺序 + 槽位 cap + 全局预算裁剪 +
 * 去重（by_id / by_similarity）+ priority_then_recent 逐出；输出完整决策证据（供 T3-9 预览器与快照）。
 */
export async function assembleForChapter(
  gateway: ProjectGateway,
  payload: MemoryAssemblePayload,
): Promise<MemoryAssemblyResult> {
  const collected = await collectChapterContext(gateway, payload.chapterId);
  const plan = planFor(collected, payload.manualIds);

  const assemblyItems: AssemblyItem[] = [];
  if (collected.systemText.trim() !== "") {
    assemblyItems.push({
      id: "system_prompt",
      slot: "system_prompt",
      title: "系统提示（人设 + 世界约束）",
      text: collected.systemText,
      stable: true,
      priority: 100,
      source: "内置人设 + 派系包约束",
    });
  }
  if (collected.recentProse.trim() !== "") {
    assemblyItems.push({
      id: "recent_prose",
      slot: "recent_prose",
      title: "最近正文",
      text: collected.recentProse,
      priority: 90,
      recency: collected.chapterOrdinal,
      source: collected.chapterPath,
    });
  }
  for (const entry of plan.entries) {
    assemblyItems.push({
      id: entry.id,
      slot: slotOf(entry),
      title: entry.title,
      text: entry.text,
      stable: entry.layer === "world_core" && entry.mode === "always",
      priority: entry.priority,
      recency: collected.recencyOf.get(entry.id) ?? 0,
      source: entry.reason,
    });
  }

  const result = assembleContext(assemblyItems, { budget_total: payload.budget_total ?? 32000 });
  return {
    chapterId: collected.chapterId,
    chapterTitle: collected.chapterTitle,
    chapterOrdinal: collected.chapterOrdinal,
    chapterPath: collected.chapterPath,
    ...result,
  };
}