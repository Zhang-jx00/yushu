/**
 * 多候选对比与局部采纳（T3-11，J15 实践 5）：
 * - `splitSentences`：中文句级切分（。！？；…… 与换行；保留分隔符，丢弃空白句）；
 * - `diffSentences`：候选 vs 当前正文的句级差异（新增 / 移除句与字数——顺序无关的集合差，
 *   确定性排序便于快照与断言）；
 * - `mergeSelected`：局部采纳——按勾选的句子合并为采纳文本（保序）。
 * 纯逻辑（无 IO / 无 DOM）。
 */

const SENTENCE_END = /[。！？!?；;…]/;
const CLOSERS = "\"」』）)】》〉”’";

/** 句级切分：终止符收句（连续终止符与收尾引号 / 括号并入前句）；换行为句边界（保留原标点） */
export function splitSentences(text: string): string[] {
  const sentences: string[] = [];
  let current = "";
  const normalized = text.replace(/\r\n?/g, "\n");
  const push = () => {
    const trimmed = current.trim();
    if (trimmed !== "") sentences.push(trimmed);
    current = "";
  };
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index]!;
    if (char === "\n") {
      push();
      continue;
    }
    current += char;
    if (!SENTENCE_END.test(char)) continue;
    // 连续终止符（如「……」「？！」）与收尾引号 / 括号并入前句，再收束
    let next = index + 1;
    while (next < normalized.length && (SENTENCE_END.test(normalized[next]!) || CLOSERS.includes(normalized[next]!))) {
      current += normalized[next]!;
      index = next;
      next += 1;
    }
    push();
  }
  push();
  return sentences;
}

export interface SentenceDiff {
  /** 候选新增（归一后不在当前正文中的句子；去重保序） */
  added: string[];
  /** 当前正文有、候选未覆盖的句子（去重保序） */
  removed: string[];
  /** 双方共有的句子数（归一后） */
  shared: number;
  /** 新增字数（原始长度之和） */
  addedChars: number;
  /** 移除字数（原始长度之和） */
  removedChars: number;
}

function normalizeSentence(sentence: string): string {
  return sentence.replace(/\s+/g, "");
}

/** 句级差异（集合差；同句仅计数不重复列出——适应候选较短的生成场景） */
export function diffSentences(baseText: string, candidateText: string): SentenceDiff {
  const base = splitSentences(baseText);
  const candidate = splitSentences(candidateText);
  const baseSet = new Set(base.map(normalizeSentence).filter((item) => item !== ""));
  const candidateSet = new Set(candidate.map(normalizeSentence).filter((item) => item !== ""));
  const added: string[] = [];
  const seenAdded = new Set<string>();
  for (const sentence of candidate) {
    const key = normalizeSentence(sentence);
    if (key === "" || baseSet.has(key) || seenAdded.has(key)) continue;
    seenAdded.add(key);
    added.push(sentence);
  }
  const removed: string[] = [];
  const seenRemoved = new Set<string>();
  for (const sentence of base) {
    const key = normalizeSentence(sentence);
    if (key === "" || candidateSet.has(key) || seenRemoved.has(key)) continue;
    seenRemoved.add(key);
    removed.push(sentence);
  }
  let shared = 0;
  for (const key of baseSet) if (candidateSet.has(key)) shared += 1;
  return {
    added,
    removed,
    shared,
    addedChars: added.reduce((sum, sentence) => sum + sentence.length, 0),
    removedChars: removed.reduce((sum, sentence) => sum + sentence.length, 0),
  };
}

/** 局部采纳：按选择顺序合并句文本（句间以换行分隔，与正文段落习惯一致） */
export function mergeSelected(sentences: string[]): string {
  return sentences.map((sentence) => sentence.trim()).filter((sentence) => sentence !== "").join("\n");
}