import type { ProofreadFinding } from "./types.js";

/**
 * 错别字 / 别字检测（`proofread-typo`，J14 §2.1 / §3.1）。
 *
 * **规则层先行、模型层补位**：本模块只实现内置别字词表（同音 / 形近），命中即给正确写法作候选，
 * 严重度 `warn`、`autofix: true`（可自动替换，但**写入正文仍需用户确认**）。
 * pycorrector / MacBERT 一类模型层是后续替换点，`source.engine` 已按 J14 的条目结构留位。
 *
 * 词表取舍（宁可漏报不误报）：只收「**错法本身不构成任何合法词**」的条目。
 * 以下几类常见错法**故意不收**，因为它们会撞进合法写法里，误报代价高于漏报：
 * - 「必竟」（毕竟）——「想必竟然」里就含这个子串；
 * - 「既使」（即使）——半文言里「既，使众人信服」会连读成它；
 * - 「作崇」（作祟）——「工作崇拜」必撞；
 * - 「题高」（提高）——「本题高频」必撞；
 * - 「重迭」（重叠）——第一批异形词整理表里的**异形词**而非错字，属排版风格而非对错。
 * 「其它 / 账-帐」这类同样属异形词与地区写法，也不在本表内。
 */

/** 内置别字词表：错法 → 正确写法 */
const TYPO_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ["迫不急待", "迫不及待"],
  ["走头无路", "走投无路"],
  ["变本加利", "变本加厉"],
  ["穿流不息", "川流不息"],
  ["默守成规", "墨守成规"],
  ["甘败下风", "甘拜下风"],
  ["一愁莫展", "一筹莫展"],
  ["再接再励", "再接再厉"],
  ["相形见拙", "相形见绌"],
  ["言简意该", "言简意赅"],
  ["病入膏荒", "病入膏肓"],
  ["沧海一栗", "沧海一粟"],
  ["一如继往", "一如既往"],
  ["按步就班", "按部就班"],
  ["全神惯注", "全神贯注"],
  ["一股作气", "一鼓作气"],
  ["半途而费", "半途而废"],
  ["直接了当", "直截了当"],
  ["名信片", "明信片"],
  ["换然一新", "焕然一新"],
  ["布署", "部署"],
  ["凑和", "凑合"],
  ["脉膊", "脉搏"],
  ["偏辟", "偏僻"],
  ["装钉", "装订"],
  ["幅射", "辐射"],
  ["会唔", "会晤"],
  ["即然", "既然"],
  ["破斧沉舟", "破釜沉舟"],
  ["义气用事", "意气用事"],
  ["因地治宜", "因地制宜"],
  ["坐阵", "坐镇"],
  ["专横拔扈", "专横跋扈"],
  ["自爆自弃", "自暴自弃"],
  ["综横", "纵横"],
  ["神祗", "神祇"],
  ["融恰", "融洽"],
  ["人才汇萃", "人才荟萃"],
  ["情甘情愿", "心甘情愿"],
];

/**
 * 词表的只读视图（面板与单测都要能读到条目本体，而不是只有函数）。
 * 构建序即"最长优先"序，与 `checkTypos` 的匹配序一致。
 */
export const TYPO_TABLE: ReadonlyMap<string, string> = new Map(
  [...TYPO_ENTRIES].sort((a, b) => {
    if (a[0].length !== b[0].length) return b[0].length - a[0].length;
    return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
  }),
);

/**
 * 逐字扫描 + 最长优先匹配：同一位置只报一条，命中后从该词之后继续（不重叠、不重复报）。
 * 结果天然按位置升序，无需排序（同输入同输出）。
 */
export function checkTypos(text: string, options: { chapter?: string } = {}): ProofreadFinding[] {
  if (text === "") return [];
  const findings: ProofreadFinding[] = [];
  let i = 0;
  while (i < text.length) {
    let matched = false;
    for (const [from, to] of TYPO_TABLE) {
      if (!text.startsWith(from, i)) continue;
      findings.push({
        rule: "proofread-typo",
        severity: "warn",
        span: {
          ...(options.chapter === undefined ? {} : { chapter: options.chapter }),
          start: i,
          end: i + from.length,
          text: from,
        },
        suggestion: to,
        evidence: `常见别字「${from}」应为「${to}」（内置词表命中；同音 / 形近误写）`,
        autofix: true,
        source: { engine: "lexicon:typo", conf: 1 },
      });
      i += from.length;
      matched = true;
      break;
    }
    if (!matched) i += 1;
  }
  return findings;
}
