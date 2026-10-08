import type { ProofreadFinding } from "./types.js";

/**
 * 句级轻提示（`proofread-long-sentence` / `proofread-demiscue`，J14 §2.5–§2.6 / §3.6）。
 *
 * 两条都定 **info**：J14 明确"的地得、成语误用存在语境弹性……必须分级"，
 * 所以这里只做"疑似"提示，不判错、不给自动修（`autofix: false`）。
 */

/** 长句阈值（J14 §5 规则建议：单句 > 80 字且无标点切分） */
export const LONG_SENTENCE_LIMIT = 80;

/** 句末点号与换行——与渲染层句级 diff（`candidate-diff.ts`）保持同一套切分口径 */
const SENTENCE_END = /[。！？!?；;…\n]/;

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;

/** Markdown 结构行（标题 / 列表 / 引用 / 代码围栏）不参与长句判定——它们是排版骨架，不是正文节奏 */
const STRUCTURAL_LINE = /^\s*(#{1,6}\s|[-*+]\s|>\s?|```|~~~|---|\|)/;

/** 方式副词（长者先匹配，保证同输入同输出） */
const MANNER_ADVERBS: readonly string[] = [
  "得意", "不屑", "沉沉", "微微", "渐渐", "愣愣", "呆呆", "幽幽", "淡然", "悍然", "豁然",
  "凛然", "断然", "贸然", "欣然", "默然", "怅然", "陡然", "骤然", "猛然", "径直", "飞快",
  "急切", "焦急", "勉强", "主动", "不停", "反复", "接连", "尴尬", "慢慢", "缓缓", "轻轻",
  "狠狠", "快速", "迅速", "认真", "仔细", "高兴", "激动",
].sort((a, b) => (b.length - a.length) || (a < b ? -1 : a > b ? 1 : 0));

/** 方式词之后紧跟这些单字动词，才判"状语位置"——否则是定语（「快速的反应」是合法写法） */
const ACTION_VERB = new Set([
  "走", "说", "道", "答", "笑", "看", "想", "点", "摇", "冲", "扑", "退", "迎", "转",
  "抓", "握", "举", "抬", "低", "皱", "叹", "吻", "抱", "拉", "推", "敲", "打", "骂",
  "夸", "问", "应", "跑", "跳", "蹲", "伏", "闪", "盯", "瞅", "吼", "喊", "叫", "哼",
]);

/** 一个句段（含句末点号） */
export interface SentencePart {
  start: number;
  end: number;
  /** 句段原文（含句末点号） */
  text: string;
  /** 句内汉字数（阈值按它算，标点不计） */
  chars: number;
}

/**
 * 切句：句末点号与换行断开，段尾**含**标点（下标可直接用于正文定位与替换）。
 * 无汉字的段（纯标点 / 纯空白）丢弃，避免空句刷结果。
 */
export function splitSentences(text: string): SentencePart[] {
  const parts: SentencePart[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (!SENTENCE_END.test(text[i]!)) continue;
    const raw = text.slice(start, i + 1);
    const chars = [...raw].filter((c) => CJK.test(c)).length;
    if (chars > 0) parts.push({ start, end: i + 1, text: raw, chars });
    start = i + 1;
  }
  if (start < text.length) {
    // 末段无句末点号（作者还没写完 / 段尾省略）同样参与判定
    const raw = text.slice(start);
    const chars = [...raw].filter((c) => CJK.test(c)).length;
    if (chars > 0) parts.push({ start, end: text.length, text: raw, chars });
  }
  return parts;
}

/** 该句段起点所在行是否是 Markdown 结构行 */
function isStructural(text: string, start: number): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  let lineEnd = text.indexOf("\n", start);
  if (lineEnd < 0) lineEnd = text.length;
  return STRUCTURAL_LINE.test(text.slice(lineStart, lineEnd));
}

/** 超长句提示（info，不给改法——怎么断句是作者的事） */
export function checkLongSentences(
  text: string,
  options: { chapter?: string; limit?: number } = {},
): ProofreadFinding[] {
  const limit = Math.max(1, options.limit ?? LONG_SENTENCE_LIMIT);
  return splitSentences(text)
    .filter((part) => part.chars > limit && !isStructural(text, part.start))
    .map((part) => ({
      rule: "proofread-long-sentence" as const,
      severity: "info" as const,
      span: {
        ...(options.chapter === undefined ? {} : { chapter: options.chapter }),
        start: part.start,
        end: part.end,
        text: part.text,
      },
      evidence: `单句 ${part.chars} 字无标点切分（阈值 ${limit} 字）：节奏偏长，建议拆分或加逗号（存疑提示，不断言为错）`,
      autofix: false,
      source: { engine: "rule:sentence-length", conf: Number(Math.min(1, part.chars / (limit * 2)).toFixed(2)) },
    }));
}

/**
 * 状语位置的「的」疑似应为「地」（`proofread-demiscue`，J14 §2.5）。
 *
 * 判定收窄成 `方式副词 + 的 + 单字动词`（如"慢慢的走过去"，正确写法是"慢慢地走过去"）——
 * 这样「快速的反应」「认真的态度」这类**定语**写法不会被误报（J14 §3.6 要求豁免固定写法，
 * 本实现用"前接方式词、后接动词"把定语场景整体挡在门外，比维护一张短语白名单更稳）。
 * 「的 / 得」补语方向（"高兴的一跳三尺高"）不在初版范围：误报率高，留 T4（见 docs 遗留）。
 */
export function checkSubordinateDe(
  text: string,
  options: { chapter?: string } = {},
): ProofreadFinding[] {
  const findings: ProofreadFinding[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== "的") continue;
    const adverb = MANNER_ADVERBS.find((word) => text.startsWith(word, i - word.length));
    if (adverb === undefined) continue;
    const verb = text[i + 1];
    if (verb === undefined || !ACTION_VERB.has(verb)) continue;
    findings.push({
      rule: "proofread-demiscue" as const,
      severity: "info" as const,
      span: {
        ...(options.chapter === undefined ? {} : { chapter: options.chapter }),
        start: i,
        end: i + 1,
        text: "的",
      },
      suggestion: "地",
      evidence: `方式词「${adverb}」与动词「${verb}」之间的「的」疑似状语标记，应作「地」（存疑提示：定语写法与口语节奏可豁免，不自动替换）`,
      autofix: false,
      source: { engine: "rule:de-adverbial", conf: 0.6 },
    });
  }
  return findings;
}
