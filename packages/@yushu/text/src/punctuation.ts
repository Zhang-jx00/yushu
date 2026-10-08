import type { ProofreadFinding } from "./types.js";

/**
 * 中文标点核查与规范化（`proofread-punctuation-gb`，J14 §2.3 / §3.3）。
 *
 * 依据：GB/T 15834-2011《标点符号用法》（点号 / 标号用法、省略号为六连点）与
 * 中文文案排版指北（全半角统一）。
 *
 * **误报抑制策略（本模块的关键取舍）**：真源是 Markdown，正文里合法存在标题 `#`、列表 `-`、
 * 加粗 `**`、行内代码、URL、小数与千分位。本模块**不解析 Markdown 语法**，而是把
 * 「**相邻字符是否为汉字**」当作中文语境的判据——半角标点只有在紧邻汉字时才算误用，
 * 于是 `3.5` / `https://a.com/x.md` / `**警惕**:` / `- 列表项` 天然不报，
 * 代价是"汉字后紧跟半个右括号再接英文"这类边缘场景会漏报（宁可漏报不误报）。
 */

/** 中日韩统一表意文字（含扩展 A 与兼容表意文字）——判"中文语境"用 */
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** 需要规范成全角的点号（半角 → 全角） */
const HALF_TO_FULL: Record<string, string> = {
  ",": "，",
  ";": "；",
  ":": "：",
  "!": "！",
  "?": "？",
  ".": "。",
};

/** 同类连排需要合并的点号集合（省略号与破折号另走专项规则） */
const COLLAPSIBLE = new Set(["，", "、", "；", "：", "！", "?", "？", ",", ";", ":", "!", "."]);

/** 混用组合（逗号紧跟句号）→ 保留句末点号 */
const MIXED_PAIRS: ReadonlyArray<readonly [string, string, string]> = [
  ["，", "。", "。"],
  [",", "。", "。"],
  ["，", ".", "。"],
];

function isCjk(char: string | undefined): boolean {
  return char !== undefined && CJK.test(char);
}

/** 全角化：半角点号转全角，其余原样返回 */
function toFullWidth(char: string): string {
  return HALF_TO_FULL[char] ?? char;
}

/** 一次扫描产出的可修复问题（span 与修复候选同源，避免两套口径漂移） */
interface PunctIssue {
  start: number;
  end: number;
  from: string;
  /** 修复候选；undefined 表示只能提示、无法机械修复（如引号不配对） */
  to?: string;
  evidence: string;
}

/** 该位置是否处于中文语境（任一侧是汉字即算） */
function nearCjk(text: string, start: number, end: number): boolean {
  return isCjk(text[start - 1]) || isCjk(text[end]);
}

function scanIssues(text: string): PunctIssue[] {
  const issues: PunctIssue[] = [];
  let i = 0;
  // 已占用到的下标：规则按 ①→⑤ 顺序取先命中者，避免同一位置重复报
  let occupiedUntil = 0;
  const available = (start: number): boolean => start >= occupiedUntil;
  const claim = (end: number): void => {
    occupiedUntil = end;
  };

  while (i < text.length) {
    const char = text[i]!;

    // ① 省略号误写：ASCII 三点 或 三个及以上句号 → 六连点 ……
    if (char === "." || char === "。") {
      let j = i;
      while (j < text.length && text[j] === char) j += 1;
      if (j - i >= 3 && nearCjk(text, i, j) && available(i)) {
        issues.push({
          start: i,
          end: j,
          from: text.slice(i, j),
          to: "……",
          evidence: `省略号误写为「${text.slice(i, j)}」（GB/T 15834：省略号形式为「……」六连点）`,
        });
        claim(j);
        i = j;
        continue;
      }
    }

    // ② 破折号误写：两个及以上半角连字符夹在中文里 → ——
    if (char === "-" && text[i + 1] === "-" && nearCjk(text, i, i + 2) && available(i)) {
      let j = i;
      while (j < text.length && text[j] === "-") j += 1;
      issues.push({
        start: i,
        end: j,
        from: text.slice(i, j),
        to: "——",
        evidence: `破折号误写为「${text.slice(i, j)}」（GB/T 15834：破折号形式为「——」）`,
      });
      claim(j);
      i = j;
      continue;
    }

    // ③ 混用组合「，。」→ 保留句末点号
    const next = text[i + 1];
    const mixed = MIXED_PAIRS.find(([first, second]) => char === first && next === second);
    if (mixed && available(i)) {
      issues.push({
        start: i,
        end: i + 2,
        from: `${mixed[0]}${mixed[1]}`,
        to: mixed[2],
        evidence: `句末点号混用「${mixed[0]}${mixed[1]}」（同一停顿只保留一个点号）`,
      });
      claim(i + 2);
      i += 2;
      continue;
    }

    // ④ 同类点号连排（！！！ / ，，）→ 只留一个（非中文语境的 `!!` 整段跳过，不报）
    if (COLLAPSIBLE.has(char)) {
      let j = i;
      while (j < text.length && text[j] === char) j += 1;
      if (j - i >= 2) {
        if (nearCjk(text, i, j) && available(i)) {
          issues.push({
            start: i,
            end: j,
            from: text.slice(i, j),
            to: toFullWidth(char),
            evidence: `同一标点多写 ${j - i} 次「${text.slice(i, j)}」（点号不叠用）`,
          });
          claim(j);
        }
        i = j;
        continue;
      }
    }

    // ⑤ 半角点号紧跟汉字、且后面还是汉字或已到句末 → 判为中文语境误用并转全角
    if (HALF_TO_FULL[char] !== undefined && isCjk(text[i - 1])) {
      const after = text[i + 1];
      if (after === undefined || isCjk(after)) {
        if (available(i)) {
          issues.push({
            start: i,
            end: i + 1,
            from: char,
            to: toFullWidth(char),
            evidence: `中文语句里使用半角标点「${char}」（应作全角「${toFullWidth(char)}」）`,
          });
          claim(i + 1);
        }
      }
    }

    i += 1;
  }
  return issues;
}

/** 引号配对（只查成对的中文弯引号；数量不符按缺失一侧点名，无法机械补全故不给修复） */
function quoteIssues(text: string): PunctIssue[] {
  const found: PunctIssue[] = [];
  const pairs: ReadonlyArray<readonly [string, string, string, string]> = [
    ["“", "”", "左引号“", "右引号”"],
    ["‘", "’", "左单引号‘", "右单引号’"],
  ];
  for (const [open, close, openName, closeName] of pairs) {
    let opens = 0;
    let closes = 0;
    let lastOpen = -1;
    let lastClose = -1;
    for (let i = 0; i < text.length; i += 1) {
      if (text[i] === open) {
        opens += 1;
        lastOpen = i;
      } else if (text[i] === close) {
        closes += 1;
        lastClose = i;
      }
    }
    if (opens > closes && lastOpen >= 0) {
      found.push({
        start: lastOpen,
        end: lastOpen + 1,
        from: open,
        evidence: `${openName} ${opens} 个 / ${closeName} ${closes} 个：右引号”缺失（引号未配对，无法机械补全位置）`,
      });
    } else if (closes > opens && lastClose >= 0) {
      found.push({
        start: lastClose,
        end: lastClose + 1,
        from: close,
        evidence: `${openName} ${opens} 个 / ${closeName} ${closes} 个：左引号“缺失（引号未配对，无法机械补全位置）`,
      });
    }
  }
  return found;
}

/**
 * 标点核查：返回按位置升序的检测结果（`warn`）。
 * `chapter` 只作为 span 的标注透传，不参与判定。
 */
export function checkPunctuation(
  text: string,
  options: { chapter?: string } = {},
): ProofreadFinding[] {
  if (text === "") return [];
  const issues = [...scanIssues(text), ...quoteIssues(text)].sort((a, b) => a.start - b.start);
  return issues.map((issue) => {
    const finding: ProofreadFinding = {
      rule: "proofread-punctuation-gb",
      severity: "warn",
      span: {
        ...(options.chapter === undefined ? {} : { chapter: options.chapter }),
        start: issue.start,
        end: issue.end,
        text: issue.from,
      },
      evidence: issue.evidence,
      autofix: issue.to !== undefined,
      source: { engine: "rule:punctuation-gb", conf: 1 },
    };
    if (issue.to !== undefined) finding.suggestion = issue.to;
    return finding;
  });
}

/** 一处标点修复（下标指向**原文**，供面板"改前/改后"对照） */
export interface PunctuationChange {
  start: number;
  from: string;
  to: string;
}

/**
 * 生成规范化后的文本与逐处改动（J14 §3.3「一键排版（可预览）」）。
 *
 * **本函数不写回任何文件**——排版只改格式不改字义，但仍须经用户确认后才写正文；
 * 跳过无修复候选的条目（如引号不配对）。改动按原文下标升序且互不重叠。
 */
export function normalizePunctuation(text: string): { text: string; changes: PunctuationChange[] } {
  const changes: PunctuationChange[] = [];
  for (const issue of scanIssues(text)) {
    if (issue.to === undefined) continue;
    changes.push({ start: issue.start, from: issue.from, to: issue.to });
  }
  if (changes.length === 0) return { text, changes: [] };
  let out = "";
  let cursor = 0;
  for (const change of changes) {
    out += text.slice(cursor, change.start);
    out += change.to;
    cursor = change.start + change.from.length;
  }
  out += text.slice(cursor);
  return { text: out, changes };
}
