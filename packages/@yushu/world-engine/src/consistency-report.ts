import { YushuError } from "@yushu/core";
import { isMap, isScalar, isSeq, parse as parseYaml, parseDocument, stringify as stringifyYaml } from "yaml";
import {
  STRUCTURE_RULE_IDS,
  type StructureFinding,
  type StructureRuleId,
  type StructureSeverity,
} from "./consistency.js";
import type { IndexEntityRow } from "./index-input.js";

/**
 * 一致性报告与豁免（M4 / T4-3，docs/03 §11.2 与 docs/04 §7.5 A4 / A6）。
 *
 * 三条口径贯穿整个文件：
 * - **每条结论都要能跳回原文**：`span` 用 UTF-16 下标（与 `@yushu/text` 同口径），
 *   偏移取自 YAML AST 的 `range`，不是我们自己数字符；
 * - **豁免必须记理由**（A6）：空 `reason`、缺 `subject` 的"整条规则一刀切"一律拒绝加载；
 * - **豁免要看得见**：被豁免的条目不静默消失，而是进 `suppressed` 连同理由一起交给面板。
 */

export const CONSISTENCY_ALLOW_API_VERSION = "yushu.consistency-allow/v1";

export interface ConsistencyAllowEntry {
  rule: StructureRuleId;
  /** 发起方实体 id；不允许省略——省略就等于把整条规则关掉 */
  subject: string;
  related?: string;
  /** 必填：为什么这不是问题（docs/04 §7.5 A6） */
  reason: string;
  /** 决策时间（ISO 字符串）。审计用，不参与确定性比较 */
  decidedAt?: string;
}

export interface ConsistencyAllowList {
  apiVersion: string;
  entries: ConsistencyAllowEntry[];
}

export class ConsistencyAllowError extends YushuError {
  constructor(message: string, options?: ErrorOptions) {
    super("E_CONSISTENCY_ALLOW", message, options);
  }
}

const ALLOW_KEYS = ["apiVersion", "entries"] as const;
const ENTRY_KEYS = ["rule", "subject", "related", "reason", "decided_at"] as const;

/** 解析 `config/consistency.yaml`（与 llm / routing / budget 同一套严格约定） */
export function parseConsistencyAllowList(text: string): ConsistencyAllowList {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new ConsistencyAllowError(
      `config/consistency.yaml 无法解析：${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConsistencyAllowError("config/consistency.yaml 顶层应为映射");
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(ALLOW_KEYS as readonly string[]).includes(key)) {
      throw new ConsistencyAllowError(`config/consistency.yaml 含未知键「${key}」（拒绝静默忽略）`);
    }
  }
  if (record["apiVersion"] !== CONSISTENCY_ALLOW_API_VERSION) {
    throw new ConsistencyAllowError(
      `config/consistency.yaml 的 apiVersion 应为 ${CONSISTENCY_ALLOW_API_VERSION}，实际 ${String(record["apiVersion"])}`,
    );
  }
  const list = record["entries"];
  if (list === undefined) throw new ConsistencyAllowError("config/consistency.yaml 缺少 entries（没有豁免就写空数组）");
  if (!Array.isArray(list)) throw new ConsistencyAllowError("config/consistency.yaml 的 entries 应为数组");
  const entries = list.map((item, index) => parseAllowEntry(item, `entries[${index}]`));
  const seen = new Set<string>();
  for (const entry of entries) {
    const key = allowKey(entry.rule, entry.subject, entry.related);
    if (seen.has(key)) throw new ConsistencyAllowError(`豁免条目重复：${key}`);
    seen.add(key);
  }
  return { apiVersion: CONSISTENCY_ALLOW_API_VERSION, entries };
}

function parseAllowEntry(value: unknown, where: string): ConsistencyAllowEntry {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ConsistencyAllowError(`${where} 应为映射`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
      throw new ConsistencyAllowError(`${where} 含未知键「${key}」（过期时间一类的语义本轮不支持）`);
    }
  }
  const rule = record["rule"];
  if (typeof rule !== "string" || !(STRUCTURE_RULE_IDS as readonly string[]).includes(rule)) {
    throw new ConsistencyAllowError(
      `${where}.rule 应为已实现的规则 id 之一（${STRUCTURE_RULE_IDS.join(" | ")}），实际 ${String(rule)}`,
    );
  }
  const subject = record["subject"];
  if (typeof subject !== "string" || subject.trim() === "") {
    throw new ConsistencyAllowError(`${where}.subject 必填且非空——省略等于把整条规则关掉，那不是豁免`);
  }
  const reason = record["reason"];
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new ConsistencyAllowError(`${where}.reason 必填且非空（docs/04 §7.5 A6：误报白名单必须记录理由）`);
  }
  const related = record["related"];
  if (related !== undefined && (typeof related !== "string" || related.trim() === "")) {
    throw new ConsistencyAllowError(`${where}.related 若给出则应为非空字符串`);
  }
  const decidedAt = record["decided_at"];
  if (decidedAt !== undefined && typeof decidedAt !== "string") {
    throw new ConsistencyAllowError(`${where}.decided_at 应为 ISO 字符串`);
  }
  return {
    rule: rule as StructureRuleId,
    subject,
    ...(related === undefined ? {} : { related: related as string }),
    reason: reason.trim(),
    ...(decidedAt === undefined ? {} : { decidedAt: decidedAt as string }),
  };
}

/** 确定性序列化（键顺序固定，同输入同字节，可 diff 可进快照） */
export function serializeConsistencyAllowList(allow: ConsistencyAllowList): string {
  const body = {
    apiVersion: allow.apiVersion,
    entries: allow.entries.map((entry) => ({
      rule: entry.rule,
      subject: entry.subject,
      ...(entry.related === undefined ? {} : { related: entry.related }),
      reason: entry.reason,
      ...(entry.decidedAt === undefined ? {} : { decided_at: entry.decidedAt }),
    })),
  };
  return stringifyYaml(body, { lineWidth: 0 });
}

/** 豁免匹配键：只用稳定身份（规则 + 主体 + 目标），**不用行号**——文件一改行号就飘 */
function allowKey(rule: string, subject: string, related?: string): string {
  return related === undefined ? `${rule}|${subject}` : `${rule}|${subject}|${related}`;
}

/* ---------------- 原文区间（A4：每条发现可跳到原文） ---------------- */

/** 卡文件 frontmatter 里一条引用的原文区间（UTF-16 下标，与 @yushu/text 同口径） */
export interface CardRefSpan {
  relation: string;
  target: string;
  start: number;
  end: number;
}

/**
 * 定位设定卡里 `refs` 各条目的原文区间。
 *
 * 偏移取自 YAML AST 的 `range`，**不是我们自己数字符**——手数在中文与全角标点处最容易错位，
 * 而面板高亮用的就是这些下标。解析不出对象时返回空数组（宁可没有区间，也不给假区间）。
 */
export function locateCardRefSpans(text: string): CardRefSpan[] {
  if (text.trim() === "") return [];
  let doc: ReturnType<typeof parseDocument>;
  try {
    doc = parseDocument(text);
  } catch {
    return [];
  }
  // 「多个文档」对设定卡是常态（frontmatter 之后的 `---` 与正文会被当成第二篇），
  // 直接按 errors 非空就退回"无区间"，等于每张贴了正文的卡都拿不到跳转位置。
  if (doc.errors.some((error) => !error.message.includes("multiple documents"))) return [];
  const root = doc.contents;
  if (!isMap(root)) return [];
  const refs = root.get("refs");
  if (!isSeq(refs)) return [];
  const spans: CardRefSpan[] = [];
  for (const item of refs.items) {
    if (!isMap(item)) continue;
    // 第二参数 true：拿**节点**而不是解好的 JS 值——只有节点上带 range（值本身没有位置信息）
    const relation = item.get("relation", true);
    const target = item.get("target", true);
    if (!isScalar(relation) || !isScalar(target)) continue;
    const range = item.range;
    if (!range) continue;
    spans.push({
      relation: String(relation.value ?? ""),
      target: String(target.value ?? ""),
      start: range[0],
      end: range[1],
    });
  }
  return spans;
}

/* ---------------- 报告条目 ---------------- */

export interface ConsistencySpan {
  file: string;
  start: number;
  end: number;
  /** 该区间内的原文（尾部空白已去掉，便于面板直接展示） */
  text: string;
}

export interface ConsistencyEntry {
  rule: StructureRuleId;
  severity: StructureSeverity;
  subject: string;
  related?: string;
  path?: string[];
  evidence: string;
  /** 找不到原文时为 null——**不给 0-0 的假区间** */
  span: ConsistencySpan | null;
  /** 可执行的修法（含"要留白就走豁免并写理由"的出口） */
  fix: string;
}

export interface SuppressedEntry extends ConsistencyEntry {
  /** 豁免理由（A6 要求可审计） */
  reason: string;
  decidedAt?: string;
}

export interface ConsistencyReportInput {
  findings: readonly StructureFinding[];
  entities: readonly IndexEntityRow[];
  /** 卡文件路径 → 全文（由调用方读，本模块不做 IO） */
  cardTexts: Readonly<Record<string, string>>;
  allow?: ConsistencyAllowList | null;
}

export interface ConsistencyReportResult {
  entries: ConsistencyEntry[];
  suppressed: SuppressedEntry[];
  /** 一条都没匹配上的豁免键——不报出来的话清单只会越攒越长，没人知道哪条已失效 */
  unusedAllow: string[];
  counted: { findings: number; entries: number; suppressed: number };
}

function fixText(finding: StructureFinding): string {
  switch (finding.rule) {
    case "ref-dangling":
      return "把该引用的 target 改成存在的实体 id，或删掉这条引用；确认要留白就在 config/consistency.yaml 记理由豁免（必须写 reason）。";
    case "ref-cycle":
      return "断掉环上的任意一条引用（保留「下游 → 上游」的方向）；确属有意的双线结构，可在 config/consistency.yaml 记理由豁免。";
    case "layer-order-violation": {
      const from = finding.fromLayer ?? "上游";
      const to = finding.toLayer ?? "下游";
      return `把这条依赖改由 ${to} 侧的卡发起（${from} 是上游，不应依赖 ${to} 的产物）；确属双向设定可在 config/consistency.yaml 记理由豁免。`;
    }
    default:
      return "见 evidence。";
  }
}

/** 汇总成报告：补区间、给修法、按豁免清单分流，并对用不上的豁免给出提示 */
export function buildConsistencyReport(input: ConsistencyReportInput): ConsistencyReportResult {
  const filePathById = new Map<string, string>();
  for (const entity of input.entities) filePathById.set(entity.id, entity.filePath);
  const spansByFile = new Map<string, CardRefSpan[]>();
  const spansFor = (file: string | undefined): CardRefSpan[] => {
    if (!file) return [];
    const cached = spansByFile.get(file);
    if (cached) return cached;
    const text = input.cardTexts[file];
    const computed = text === undefined ? [] : locateCardRefSpans(text);
    spansByFile.set(file, computed);
    return computed;
  };

  const allowEntries = input.allow?.entries ?? [];
  const usedAllow = new Set<string>();
  const entries: ConsistencyEntry[] = [];
  const suppressed: SuppressedEntry[] = [];

  for (const finding of input.findings) {
    const file = filePathById.get(finding.subject);
    const span = spanFor(finding, file, spansFor(file), input.cardTexts);
    const entry: ConsistencyEntry = {
      rule: finding.rule,
      severity: finding.severity,
      subject: finding.subject,
      ...(finding.related === undefined ? {} : { related: finding.related }),
      ...(finding.path === undefined ? {} : { path: finding.path }),
      evidence: finding.evidence,
      span,
      fix: fixText(finding),
    };
    const hit = allowEntries.find((item) => matchesAllow(item, finding));
    if (hit) {
      usedAllow.add(allowKey(hit.rule, hit.subject, hit.related));
      suppressed.push({
        ...entry,
        reason: hit.reason,
        ...(hit.decidedAt === undefined ? {} : { decidedAt: hit.decidedAt }),
      });
      continue;
    }
    entries.push(entry);
  }

  const unusedAllow = allowEntries
    .map((item) => allowKey(item.rule, item.subject, item.related))
    .filter((key) => !usedAllow.has(key))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    entries,
    suppressed,
    unusedAllow,
    counted: { findings: input.findings.length, entries: entries.length, suppressed: suppressed.length },
  };
}

function spanFor(
  finding: StructureFinding,
  file: string | undefined,
  spans: CardRefSpan[],
  cardTexts: Readonly<Record<string, string>>,
): ConsistencySpan | null {
  if (!file || finding.related === undefined) return null;
  const match = spans.find((item) => item.target === finding.related);
  if (!match) return null;
  const text = cardTexts[file];
  if (text === undefined) return null;
  return { file, start: match.start, end: match.end, text: text.slice(match.start, match.end).trimEnd() };
}

/** 豁免匹配：给了 related 就三段全等；没给就是「规则 + 主体」级豁免（该主体的多处发现一并豁免） */
function matchesAllow(entry: ConsistencyAllowEntry, finding: StructureFinding): boolean {
  if (entry.rule !== finding.rule || entry.subject !== finding.subject) return false;
  return entry.related === undefined || entry.related === finding.related;
}
