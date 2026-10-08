import type { ProofreadFinding } from "./types.js";

/**
 * 重复表达检测（`proofread-repetition-high`，J14 §2.5 / §3.5）。
 *
 * 做法：**汉字段**内的字级 n-gram 频次统计（长度 `minN..maxN`），超阈值即报，
 * 并把"同一批位置的较短 gram"剔除（只留信息量最大的一条），避免"心中一"与"心中一凛"同时刷屏。
 *
 * 为什么按 4–8 而不是 J14 草案的单一 n=5：单一点长的 gram 要求**上下文完全相同**才算重复，
 * 而网文里的复用恰恰是"同一短语、不同上下文"（"他心中一凛"×3 的 5-gram 各不相同），
 * 只按 n=5 会整段漏报。故这里取"短语级"多长度扫描，`minN` 缺省 4（三字以下误报率过高，不纳入）。
 *
 * 对白默认不参与（J14 的 `ignore_dialogue: true`）：喊话、口令、同一人连说的复现是自然语言，
 * 不是注水。
 */

export interface RepetitionOptions {
  /** 最短 gram 长度（缺省 4） */
  minN?: number;
  /** 最长 gram 长度（缺省 8） */
  maxN?: number;
  /** 出现次数阈值（含，缺省 3） */
  minCount?: number;
  /** 是否跳过对话段（缺省 true） */
  ignoreDialogue?: boolean;
  /** 最多报几条（缺省 10，按次数降序 + gram 码点序） */
  limit?: number;
  chapter?: string;
}

export const REPETITION_DEFAULTS = {
  minN: 4,
  maxN: 8,
  minCount: 3,
  ignoreDialogue: true,
  limit: 10,
} as const;

/** 一处重复短语及其全部出现位置（绝对下标，指向原文） */
export interface RepetitionItem {
  phrase: string;
  count: number;
  positions: number[];
}

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** 对话段下标集合（“ …” 之间，含引号本身） */
function dialogueRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let open = -1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "“") open = i;
    else if (char === "”" && open >= 0) {
      ranges.push([open, i + 1]);
      open = -1;
    }
  }
  if (open >= 0) ranges.push([open, text.length]); // 未闭合的引号：保守按对话处理
  return ranges;
}

function inRanges(index: number, ranges: Array<[number, number]>): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/** 汉字连续段（带绝对起点）——标点、空白、数字与非汉字都自然断开，跨段的 gram 不成立 */
function cjkRuns(text: string, skip: Array<[number, number]>): Array<{ start: number; chars: string }> {
  const runs: Array<{ start: number; chars: string }> = [];
  let start = -1;
  let buf = "";
  const flush = (): void => {
    if (buf !== "" && start >= 0) runs.push({ start, chars: buf });
    buf = "";
    start = -1;
  };
  for (let i = 0; i < text.length; i += 1) {
    const isCjk = CJK.test(text[i]!);
    const skipped = skip.length > 0 && inRanges(i, skip);
    if (isCjk && !skipped) {
      if (start < 0) start = i;
      buf += text[i];
    } else {
      flush();
    }
  }
  flush();
  return runs;
}

/**
 * 频次统计：返回按「次数降序 → gram 长度降序 → 码点升序」排序并剔除被覆盖短 gram 的结果。
 * 排序键全部确定，**同输入同输出**（不用 locale）。
 */
export function findRepetitions(text: string, options: RepetitionOptions = {}): RepetitionItem[] {
  const minN = Math.max(2, options.minN ?? REPETITION_DEFAULTS.minN);
  const maxN = Math.max(minN, options.maxN ?? REPETITION_DEFAULTS.maxN);
  const minCount = Math.max(2, options.minCount ?? REPETITION_DEFAULTS.minCount);
  const limit = Math.max(1, options.limit ?? REPETITION_DEFAULTS.limit);
  if (text === "") return [];

  const skip = (options.ignoreDialogue ?? REPETITION_DEFAULTS.ignoreDialogue) ? dialogueRanges(text) : [];
  const counts = new Map<string, number[]>();
  for (const run of cjkRuns(text, skip)) {
    for (let n = minN; n <= maxN; n += 1) {
      if (run.chars.length < n) break;
      for (let i = 0; i + n <= run.chars.length; i += 1) {
        const phrase = run.chars.slice(i, i + n);
        const bucket = counts.get(phrase);
        if (bucket) bucket.push(run.start + i);
        else counts.set(phrase, [run.start + i]);
      }
    }
  }

  const items: RepetitionItem[] = [];
  for (const [phrase, positions] of counts) {
    if (positions.length >= minCount) items.push({ phrase, count: positions.length, positions });
  }
  items.sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count;
    if (a.phrase.length !== b.phrase.length) return b.phrase.length - a.phrase.length;
    return a.phrase < b.phrase ? -1 : a.phrase > b.phrase ? 1 : 0;
  });

  // 只保留"没有被更长的同位置 gram 覆盖"的条目（位置集合相同或被包含都算覆盖）
  const kept: RepetitionItem[] = [];
  for (const item of items) {
    const covered = kept.some(
      (existing) =>
        existing.phrase.includes(item.phrase) &&
        existing.positions.length <= item.positions.length &&
        existing.positions.every((at) => item.positions.includes(at)),
    );
    if (covered) continue;
    kept.push(item);
    if (kept.length >= limit) break;
  }
  return kept;
}

/** 结果条目（`info`、不可自动修——改法属创作决策） */
export function checkRepetition(text: string, options: RepetitionOptions = {}): ProofreadFinding[] {
  const minCount = Math.max(2, options.minCount ?? REPETITION_DEFAULTS.minCount);
  return findRepetitions(text, options).map((item) => {
    const first = item.positions[0] ?? 0;
    return {
      rule: "proofread-repetition-high" as const,
      severity: "info" as const,
      span: {
        ...(options.chapter === undefined ? {} : { chapter: options.chapter }),
        start: first,
        end: first + item.phrase.length,
        text: item.phrase,
      },
      suggestion: `替换候选：交作者或 AI 改写（重复 ${item.count} 次，本规则不自动改）`,
      evidence: `短语「${item.phrase}」出现 ${item.count} 次（阈值 ${minCount}）——同一表达反复复用是注水与 AI 味的典型特征`,
      autofix: false,
      // 统计类判定的"置信度"就是相对超阈程度，不是模型分数：如实按 count 归一
      source: { engine: "stat:ngram", conf: Number(Math.min(1, item.count / 8).toFixed(2)) },
    };
  });
}
