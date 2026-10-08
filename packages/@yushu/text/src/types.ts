/**
 * 中文文本处理的公共类型（T3-13 / J14）。
 *
 * 口径约定（与仓库既有实现保持一致，避免长出第二套）：
 * - **span 下标是 UTF-16 字符串下标**（`String.prototype.slice` 语义），与导出敏感词命中
 *   （`@yushu/export/sensitive.ts` 的 `index`）同口径；编辑器侧据此定位即 `doc.string.slice(start, end)`。
 * - **severity 三级取 J14 的 `error | warn | info`**（不是 `warning`）：
 *   确定性错误 / 修改建议 / 存疑提示（`severity_map: {deterministic: error, suggested: warn, uncertain: info}`）。
 * - **`autofix` 只是"可否自动修"的标记，不代表已修**：任何写入正文的修复都必须经用户确认，
 *   未确认即写入由 `proofread-autofix-unconfirmed`（error）拦下——这是 J14 的安全底线。
 */

/** J14 三级严重度 */
export type ProofreadSeverity = "error" | "warn" | "info";

/** T3-13 初版落地的规则 id（`proofread-address-drift` 需联动 E07 声线卡，留 M4/T4） */
export type ProofreadRuleId =
  | "proofread-typo"
  | "proofread-conversion-ambiguous"
  | "proofread-punctuation-gb"
  | "proofread-repetition-high"
  | "proofread-demiscue"
  | "proofread-long-sentence"
  | "proofread-autofix-unconfirmed";

/** 命中位置与原文片段 */
export interface ProofreadSpan {
  /** 章节 id（可选：无头校验或单章检查时省略） */
  chapter?: string;
  /** UTF-16 下标，含头不含尾 */
  start: number;
  /** UTF-16 下标，含头不含尾 */
  end: number;
  /** 命中的原文（`text.slice(start, end)`，用于面板逐字显示） */
  text: string;
}

/**
 * 单条检测结果——J14「结果可解释」：每条都带 evidence 说明"为什么命中"，
 * 不给理由的黑箱结果一律不产出。
 */
export interface ProofreadFinding {
  rule: ProofreadRuleId;
  severity: ProofreadSeverity;
  span: ProofreadSpan;
  /** 建议替换文本（可缺省：如长句只提示不给改法） */
  suggestion?: string;
  /** 为什么命中（命中的词表 / 规则名 / 统计依据） */
  evidence: string;
  /** 该条能否自动修复（真正的写入仍需确认） */
  autofix: boolean;
  /** 判定来源与置信度（内置词表=1，启发式给低值，绝不伪装成模型分数） */
  source: { engine: string; conf?: number };
}

/** 规则元数据（面板与 M4/T4-2 分类的展示来源，不在 UI 里硬编码第二份说明） */
export interface ProofreadRuleMeta {
  id: ProofreadRuleId;
  /** 默认严重度（J14 的分级；调用方可按规则包覆盖） */
  severity: ProofreadSeverity;
  /** 中文短名 */
  label: string;
  /** 判定依据（引用规范或词表来源） */
  basis: string;
}

/** 规则清单（顺序固定，供面板分组显示） */
export const PROOFREAD_RULES: readonly ProofreadRuleMeta[] = [
  {
    id: "proofread-typo",
    severity: "warn",
    label: "错别字 / 别字",
    basis: "内置常见同音形近别字词表（J14 §3.1 规则层先行）",
  },
  {
    id: "proofread-punctuation-gb",
    severity: "warn",
    label: "标点规范",
    basis: "GB/T 15834-2011《标点符号用法》与中文排版指北",
  },
  {
    id: "proofread-conversion-ambiguous",
    severity: "info",
    label: "繁简转换歧义",
    basis: "OpenCC「严格区分一简对多繁与一简对多异」（J14 §2.2）",
  },
  {
    id: "proofread-repetition-high",
    severity: "info",
    label: "重复表达",
    basis: "字级 n-gram 频次（n=5、≥3 次，J14 §5 配置草案）",
  },
  {
    id: "proofread-demiscue",
    severity: "info",
    label: "的地得疑似",
    basis: "定/状/补语位置规则 + 固定写法白名单豁免（J14 §2.7、§3.6）",
  },
  {
    id: "proofread-long-sentence",
    severity: "info",
    label: "超长句",
    basis: "单句 > 80 字且无标点切分（J14 §5 规则建议）",
  },
  {
    id: "proofread-autofix-unconfirmed",
    severity: "error",
    label: "未确认即自动修复",
    basis: "J14 安全底线：检测可自动、修复需确认",
  },
];

/** 严重度排序权重（error → warn → info；同权重再按位置，保证同输入同输出） */
export function severityRank(severity: ProofreadSeverity): number {
  if (severity === "error") return 0;
  if (severity === "warn") return 1;
  return 2;
}

/** 按「严重度 → 起始下标 → 规则名」稳定排序（不依赖 locale，同输入同输出） */
export function sortFindings(findings: ProofreadFinding[]): ProofreadFinding[] {
  return [...findings].sort((a, b) => {
    const rank = severityRank(a.severity) - severityRank(b.severity);
    if (rank !== 0) return rank;
    if (a.span.start !== b.span.start) return a.span.start - b.span.start;
    if (a.rule !== b.rule) return a.rule < b.rule ? -1 : 1;
    return a.span.end - b.span.end;
  });
}

/** 按严重度计数（面板徽标与导出前自查摘要用） */
export function countBySeverity(findings: ProofreadFinding[]): Record<ProofreadSeverity, number> {
  const counts: Record<ProofreadSeverity, number> = { error: 0, warn: 0, info: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}
