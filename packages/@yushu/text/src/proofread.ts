import { checkConversion } from "./conversion.js";
import { checkPunctuation } from "./punctuation.js";
import { checkRepetition, type RepetitionOptions } from "./repetition.js";
import { checkSubordinateDe, checkLongSentences } from "./sentence.js";
import { checkTypos } from "./typo.js";
import {
  countBySeverity,
  sortFindings,
  type ProofreadFinding,
  type ProofreadRuleId,
  type ProofreadSeverity,
  type ProofreadSpan,
} from "./types.js";

/**
 * 校对汇总与安全闸门（T3-13 / J14 §2.6「分级呈现与修复边界」、§3.8「一键修复边界」）。
 *
 * **本模块的铁律**：`applyFixes` 在 `confirmed:false` 时必须**一字不改**，
 * 并回一条 `proofread-autofix-unconfirmed`（error）。这条比任何检测规则都重要——
 * 检测错了只是提示噪音，改稿错了是毁作者的稿。
 */

/** 参与"检测"的规则（autofix 闸门是修复侧的拦截，不属于检测项） */
const DETECT_RULES: readonly ProofreadRuleId[] = [
  "proofread-typo",
  "proofread-punctuation-gb",
  "proofread-conversion-ambiguous",
  "proofread-repetition-high",
  "proofread-demiscue",
  "proofread-long-sentence",
];

export interface ProofreadOptions {
  chapter?: string;
  /** 规则开关：显式 false 才关（缺省全开） */
  rules?: Partial<Record<ProofreadRuleId, boolean>>;
  /** 长句阈值（缺省 `LONG_SENTENCE_LIMIT`） */
  longSentenceLimit?: number;
  repetition?: Omit<RepetitionOptions, "chapter">;
}

export interface ProofreadResult {
  /** 已按「严重度 → 位置 → 规则」排序 */
  findings: ProofreadFinding[];
  counts: Record<ProofreadSeverity, number>;
  /** 被检文本长度（UTF-16 下标口径，与 span 同源） */
  chars: number;
  checkedRules: ProofreadRuleId[];
  /** 被关掉的规则如实登记——面板不能把"没跑"显示成"没问题" */
  skippedRules: ProofreadRuleId[];
}

/** 汇总一遍全文（T4-4 的"生成后即时轻校验"与"保存后异步全量"都从这里走） */
export function proofreadText(text: string, options: ProofreadOptions = {}): ProofreadResult {
  const checkedRules: ProofreadRuleId[] = [];
  const skippedRules: ProofreadRuleId[] = [];
  const enabled = (rule: ProofreadRuleId): boolean => {
    if (options.rules?.[rule] === false) {
      skippedRules.push(rule);
      return false;
    }
    checkedRules.push(rule);
    return true;
  };
  const chapter = options.chapter;

  const findings: ProofreadFinding[] = [];
  if (enabled("proofread-typo")) findings.push(...checkTypos(text, { chapter }));
  if (enabled("proofread-punctuation-gb")) findings.push(...checkPunctuation(text, { chapter }));
  if (enabled("proofread-conversion-ambiguous")) findings.push(...checkConversion(text, { chapter }));
  if (enabled("proofread-repetition-high")) findings.push(...checkRepetition(text, { ...options.repetition, chapter }));
  if (enabled("proofread-demiscue")) findings.push(...checkSubordinateDe(text, { chapter }));
  if (enabled("proofread-long-sentence")) {
    findings.push(...checkLongSentences(text, { chapter, limit: options.longSentenceLimit }));
  }

  const sorted = sortFindings(findings);
  return {
    findings: sorted,
    counts: countBySeverity(sorted),
    chars: text.length,
    checkedRules,
    skippedRules,
  };
}

/** 一处已落地的修复（下标指向**原文**） */
export interface AppliedFix {
  start: number;
  from: string;
  to: string;
}

/** 被拒的修复与原因（逐条可解释，供面板原样列出） */
export interface RejectedFix {
  reason: string;
  span: ProofreadSpan;
}

export interface ApplyFixesResult {
  /** 未确认时**原样返回**输入文本 */
  text: string;
  applied: AppliedFix[];
  rejected: RejectedFix[];
  /** 未确认请求转成的 error 结果（`proofread-autofix-unconfirmed`） */
  blocked: ProofreadFinding[];
}

export interface ApplyFixesOptions {
  /** 用户是否已确认本次改动（**false 时一律不改**） */
  confirmed: boolean;
  /** 与传入 findings **同序**的作者显式候选（如繁简歧义选定「髮」而非「發」） */
  replacements?: Array<string | undefined>;
}

/**
 * 把检测结果的修复候选落到文本上（不写文件，只返回新文本）。
 *
 * 四道闸门，逐条可解释：
 * ① **未确认即 error**——`confirmed:false` 时整批拒绝，文本一字不动；
 * ② **位置失效即拒**——`span.text` 与原文该处不符（正文已被改动），绝不按旧下标盲替换；
 * ③ **不允许自动修的规则**（繁简歧义、重复表达、的地得、长句）只能由作者显式给出候选文本；
 * ④ **重叠只应用先到的**一条，避免两次替换互相踩踏。
 */
export function applyFixes(
  text: string,
  findings: readonly ProofreadFinding[],
  options: ApplyFixesOptions,
): ApplyFixesResult {
  const indexed = findings.map((finding, index) => ({ finding, index }));
  indexed.sort((a, b) => a.finding.span.start - b.finding.span.start || a.finding.span.end - b.finding.span.end);

  if (options.confirmed !== true) {
    return {
      text,
      applied: [],
      rejected: indexed.map(({ finding }) => ({
        reason: "未经用户确认，修复一律不落稿（J14 安全底线：检测可自动、修复需确认）",
        span: finding.span,
      })),
      blocked: indexed.map(({ finding }) => ({
        rule: "proofread-autofix-unconfirmed" as const,
        severity: "error" as const,
        span: finding.span,
        evidence: `未确认即提交修复：规则「${finding.rule}」候选「${finding.suggestion ?? "(无候选)"}」已拦截，正文未改动`,
        autofix: false,
        source: { engine: "gate:autofix-confirmation", conf: 1 },
      })),
    };
  }

  const applied: AppliedFix[] = [];
  const rejected: RejectedFix[] = [];
  let out = "";
  let cursor = 0;

  for (const { finding, index } of indexed) {
    const { start, end, text: hitText } = finding.span;
    const actual = text.slice(start, end);
    if (actual !== hitText) {
      rejected.push({
        reason: `位置失效：原文此处是「${actual}」而非「${hitText}」（正文已变动），不盲替换`,
        span: finding.span,
      });
      continue;
    }
    if (start < cursor) {
      rejected.push({ reason: "与已应用的修复重叠", span: finding.span });
      continue;
    }
    const requested = options.replacements?.[index];
    // 显式候选只在该条目**登记过候选列表**时才生效——否则"采纳"就退化成能改正文任意区间的通用写通道
    const explicit = requested !== undefined && finding.candidates?.includes(requested) ? requested : undefined;
    if (requested !== undefined && explicit === undefined) {
      rejected.push({
        reason: `候选文本不在该条目登记的候选内（只接受「${finding.candidates?.join(" / ") ?? "无候选"}」），本条不改`,
        span: finding.span,
      });
      continue;
    }
    if (explicit === undefined && !finding.autofix) {
      rejected.push({
        reason: `该规则不允许自动修（需显式选定候选）：${finding.rule}`,
        span: finding.span,
      });
      continue;
    }
    const to = explicit ?? finding.suggestion;
    if (to === undefined) {
      rejected.push({ reason: "无修复候选，只能人工处理", span: finding.span });
      continue;
    }
    out += text.slice(cursor, start) + to;
    applied.push({ start, from: hitText, to });
    cursor = end;
  }
  out += text.slice(cursor);

  return { text: out, applied, rejected, blocked: [] };
}
