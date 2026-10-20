/* SPDX-License-Identifier: Apache-2.0 */
import { YushuError } from "@yushu/core";
import {
  cleanImportedText,
  decodeImportedText,
  detectSourceEncoding,
  findChapterCandidates,
  isStrictChapterTitle,
  resolveSourceLine,
  type CleanRule,
  type ImportCorrection,
} from "@yushu/text";
import {
  IMPORT_SPLIT_OUTPUT_SCHEMA,
  IMPORT_SPLIT_TASK_ID,
  parseImportSplitOutput,
} from "@yushu/world-engine";
import {
  costTokensOf,
  extractStructured,
  orderProvidersByRoute,
  planChannel,
  resolveRoute,
  type ChatMessage,
} from "@yushu/llm";
import { estimateTokens } from "@yushu/memory";
import type {
  ImportAiSplitRequestPayload,
  ImportCorrectRequestPayload,
  ImportPlanResultPayload,
} from "../shared/ipc.js";
import { appendAiUsage, newUsageId } from "./ai-usage.js";
import {
  assertAiEnabled,
  loadLlmConfigForUse,
  loadRoutingConfigForUse,
  reliabilityGate,
  sessionKeySnapshot,
  storedKeysFor,
} from "./ai-ops.js";
import { importGate, type ImportGate, type ImportPlanContext } from "./import-gate.js";
import { DEFAULT_IMPORT_CLEAN_RULES, previewImport } from "./import-ops.js";
import { ProjectGateway } from "./file-gateway.js";

/**
 * 存量导入的**第二段**：AI 二次筛选切章 + 人工校正切分（M5 / T5-7 第二段，R107）。
 *
 * 判据回源 **I09 §3.4**（两段式「规则海选 → AI 筛选」，正则匹配率低时回退 AI）与
 * **I09 §3.5**（误切检测 → 人工校正清单：合并 / 拆分 / 重排）。
 *
 * 四条口径：
 * ① **AI 只能指认候选表里的序号**（`parseImportSplitOutput` 越界即丢弃并点名）；
 * ② **AI 筛不出来就回退正则切分**，并把回退理由摆到界面上——不静默换一个算法；
 * ③ **这一段只改计划、不写盘**：真正的写盘是 `import:apply`，且它用的是**同一份**计划
 *    （计划上下文跟着票据走），所以"预演看到的章"与"入库写出的章"必然对得上；
 * ④ **AI 关闭时这条路径不发起任何请求**（A4 闸门，与其它联网入口同一道门）。
 */

/** 给模型的候选条目上限：太多会把上下文撑爆，也超出模型的耐心 */
const MAX_CANDIDATES = 200;

/** 候选后面带的上下文长度（字符）：够模型判断"这行之后是不是正文" */
const CONTEXT_CHARS = 60;

interface CandidateRow {
  index: number;
  line: number;
  text: string;
  strict: boolean;
}

/**
 * 读票据 → 解码 → 清洗 → 海选（严筛再从中挑出"确定的章标题"）。
 *
 * **必须用与预演/入库同一套清洗规则**（默认规则 + 作者的自定义规则）：
 * 清洗规则会删行 ⇒ 候选的行号会变。规则对不上，AI 认下的"第 N 行"就指到了另一行文字上，
 * 而作者在界面上看到的候选列表是按预演那份算的——两边对不上，AI 筛就是在筛空气。
 */
async function readCandidates(
  ticket: string,
  gate: ImportGate,
  rules: readonly CleanRule[] = [],
): Promise<{ text: string; rows: CandidateRow[] }> {
  const { bytes } = await gate.readTicket(ticket);
  const encoding = detectSourceEncoding(bytes);
  const decoded = decodeImportedText(bytes, encoding);
  const { text } = cleanImportedText(decoded, { rules: [...DEFAULT_IMPORT_CLEAN_RULES, ...rules] });
  const lines = text.split("\n");
  const rows = findChapterCandidates(text).map((item, index) => ({
    index,
    line: item.line,
    text: item.text,
    strict: isStrictChapterTitle(lines[item.line - 1] ?? ""),
  }));
  return { text, rows };
}

/**
 * 这次切分真正的**章边界**（原稿行号）：AI 筛过就用 AI 认下的那些，否则用严筛认下的。
 *
 * 为什么不能一律用严筛：AI 筛过之后，边界是 AI 的那几条——用严筛的边界算章号，
 * 合并/拆分会落在作者没看到的章节上。
 */
function effectiveBoundaries(rows: readonly CandidateRow[], keeps: number[] | undefined): number[] {
  if (keeps !== undefined) {
    return keeps
      .map((index) => rows[index]?.line)
      .filter((line): line is number => line !== undefined);
  }
  return rows.filter((row) => row.strict).map((row) => row.line);
}

/**
 * AI 二次筛选切章：把"疑似章节标题"的候选交给模型挑一遍。
 *
 * **回退**：契约不过 / 模型一条都没留 ⇒ 回到正则切分，并把理由写进计划上下文
 * （界面上必须能看见"这次其实是正则切的"）。
 */
export async function filterImportSplitByAi(
  gateway: ProjectGateway,
  ticket: string,
  payload: ImportAiSplitRequestPayload,
  gate: ImportGate = importGate,
): Promise<ImportPlanResultPayload> {
  // A4 闸门：AI 关闭时不得发起任何 LLM 请求
  assertAiEnabled();

  const { text, rows } = await readCandidates(ticket, gate, payload.rules ?? []);
  if (rows.length === 0) {
    throw new YushuError(
      "E_IMPORT_NO_CANDIDATES",
      "这份稿子里没有一行像章节标题（连宽匹配都没有）：让 AI 筛没有意义，请检查稿件本身或自定义清洗规则",
    );
  }
  const usable = rows.slice(0, MAX_CANDIDATES);
  const lines = text.split("\n");

  const config = await loadLlmConfigForUse(gateway);
  if (config.providers.length === 0) {
    throw new YushuError("E_LLM_ROUTE", "无可用 provider：请先在「AI 副驾」配置模型端点");
  }
  const routing = await loadRoutingConfigForUse(gateway);
  const route = resolveRoute("import_split", config.providers, routing);
  const providers = orderProvidersByRoute(config.providers, route);

  const promptRows = usable.map((row) => {
    const context = (lines[row.line] ?? "").trim().slice(0, CONTEXT_CHARS);
    return `#${String(row.index)} 第${String(row.line)}行：${row.text}${context === "" ? "" : `｜下一行：${context}`}`;
  });
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        `你是网文稿件的章节切分校对员（任务契约 ${IMPORT_SPLIT_TASK_ID}）。` +
        "下面列出的是从稿件里捞出来的**疑似章节标题**（按行号排序）。" +
        "请挑出**真正的章节标题行**：判据是这一行是作者写的章节名（第一章 / 第三章 / 夜探藏经阁 / Chapter 7 之类），" +
        "而**不是**正文里的一句话、不是被排版挤成单行的段落、不是目录残留或广告。" +
        "只报候选的序号（#0、#1…），不要漏报也不要多报；" +
        "输出格式：{\"keeps\":[{\"index\":0,\"reason\":\"...\"}]}；不要输出解释、不要输出 Markdown 围栏。",
    },
    {
      role: "user",
      content: `【疑似标题候选】\n${promptRows.join("\n")}`,
    },
  ];
  const promptEstimate = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0);

  const result = await extractStructured(providers, {
    messages,
    schema: IMPORT_SPLIT_OUTPUT_SCHEMA,
    maxRepair: 2,
    validate: (value) => {
      const parsed = parseImportSplitOutput(value, usable.length);
      return { valid: parsed.issues.length === 0, issues: parsed.issues };
    },
    sessionKeys: sessionKeySnapshot(),
    storedKeys: await storedKeysFor(gateway, providers),
    reliability: { config: routing.reliability, gate: reliabilityGate },
  });
  await appendAiUsage(gateway.root, {
    id: newUsageId(),
    type: "generate",
    task: "import_split",
    provider_id: result.provider_id,
    model: result.model,
    status: result.ok ? "ok" : "error",
    chars: result.raw.length,
    channel: planChannel(providers, "import_split").channel,
    ...(result.usage ? { tokens: costTokensOf(result.usage) } : {}),
    estimate: { prompt: promptEstimate },
  });

  const parsed = parseImportSplitOutput(result.value, usable.length);
  // 回退：契约不过，或模型一条都没留 ⇒ 仍用正则切分，但把理由摆出来
  const fallback =
    parsed.issues.length > 0
      ? `AI 输出未通过契约（${parsed.issues.slice(0, 3).join("；")}），已回退到正则切分`
      : parsed.keeps.length === 0
        ? "AI 一条都没留（它认为这批候选都不像章节标题），已回退到正则切分"
        : "";
  const context = gate.planOf(ticket);
  const next: ImportPlanContext = {
    corrections: context.corrections,
    ...(fallback === "" ? { keeps: parsed.keeps } : {}),
    ai: {
      provider_id: result.provider_id,
      model: result.model,
      rejected: parsed.rejected,
      fallback,
    },
  };
  gate.setPlan(ticket, next);

  const preview = await previewImport(ticket, { gate, gateway, rules: [...(payload.rules ?? [])] });
  return {
    preview,
    note:
      fallback === ""
        ? `AI 筛过一遍：候选 ${String(usable.length)} 条 → 保留 ${String(parsed.keeps.length)} 条` +
          (parsed.rejected.length > 0 ? `；丢弃 ${String(parsed.rejected.length)} 条（越界/重复）` : "")
        : fallback,
  };
}

/**
 * 人工校正切分（合并 / 拆分 / 重排）。
 *
 * **只改计划，不写盘**：写盘是 `import:apply` 的事，而且它用的是同一份计划。
 * 拆分点用**候选序号**表达（作者看得见那行文字），由这一层解析成行号与章序号。
 */
export async function correctImportSplit(
  gateway: ProjectGateway,
  ticket: string,
  payload: ImportCorrectRequestPayload,
  gate: ImportGate = importGate,
): Promise<ImportPlanResultPayload> {
  const { text, rows } = await readCandidates(ticket, gate, payload.rules ?? []);

  const context = gate.planOf(ticket);
  const correction = payload.correction;
  let applied: ImportCorrection;
  let note: string;
  if (correction.kind === "merge") {
    applied = { kind: "merge", at: correction.at };
    note = `已合并第 ${String(correction.at + 1)} 章与第 ${String(correction.at + 2)} 章`;
  } else if (correction.kind === "move") {
    applied = { kind: "move", from: correction.from, to: correction.to };
    note = `已把第 ${String(correction.from + 1)} 章挪到第 ${String(correction.to + 1)} 位`;
  } else {
    const candidate = rows[correction.candidateIndex];
    if (candidate === undefined) {
      throw new YushuError(
        "E_IMPORT_CORRECTION",
        `候选序号越界：${String(correction.candidateIndex)}（本次只有 ${String(rows.length)} 条候选）`,
      );
    }
    // 拆分的落点由这一层解析：候选行落在哪一章，就在那一章的哪个位置切。
    // **原稿行号要先换算成章内行号**——章正文入库前 trim 过，直接拿原稿行号切会切错句子。
    const resolved = resolveSourceLine(
      text,
      effectiveBoundaries(rows, context.keeps),
      candidate.line,
    );
    if (resolved === null) {
      throw new YushuError(
        "E_IMPORT_CORRECTION",
        `第 ${String(candidate.line)} 行（「${candidate.text}」）切不开：它不是某章正文里的切点` +
          "（章标题本身、楔子里的行、或章首章尾都切不了）",
      );
    }
    applied = { kind: "split", at: resolved.chapterIndex, line: resolved.bodyLine, title: candidate.text };
    note = `已在第 ${String(candidate.line)} 行（「${candidate.text}」）处切开`;
  }

  gate.setPlan(ticket, { ...context, corrections: [...context.corrections, applied] });
  const preview = await previewImport(ticket, { gate, gateway, rules: [...(payload.rules ?? [])] });
  return { preview, note };
}
