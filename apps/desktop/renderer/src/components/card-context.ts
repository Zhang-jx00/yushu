/* SPDX-License-Identifier: Apache-2.0 */

/**
 * 编辑器页右栏「选中段的出处 · 这条卡的原文 · 相关实体」的**纯函数**（R165）。
 *
 * 为什么是纯函数：这一栏要摆的是**卡的内容**（原文 + 它牵扯到谁），
 * 而卡可能有几百字 ⇒ 截断规则必须**在同一个地方**（界面自己截 ⇒ 预演对不上账）。
 *
 * 三条口径：
 * ① **出处不许丢**：路径、名字、类型都在（作者要能回到那张卡）；
 * ② **原文截断了就说截断了**（不许把截断后的片段当全文摆出去）；
 * ③ **相关实体逐条列**（这张卡的 refs：它与谁有关系）。
 *
 * 纯函数：只读入参，不碰 fs、不碰 React、不读墙钟 ⇒ 可单测。
 */

/** 原文最多列这么多字（多的说清截了多少） */
export const CARD_CONTEXT_MAX_CHARS = 400;

/** 一条关系（这张卡指向谁） */
export interface CardContextRef {
  relation: string;
  target: string;
}

/** 右栏那一块要摆的东西 */
export interface CardContextSummary {
  /** 出处：卡的文件路径 */
  path: string;
  /** 卡名 */
  name: string;
  /** 卡类型 */
  type: string;
  /** 原文（可能已截断） */
  body: string;
  /** 原文**被截断了**（界面上要说明） */
  truncated: boolean;
  /** 原文的总字数（截断前） */
  totalChars: number;
  /** 相关实体（这张卡的 refs） */
  refs: CardContextRef[];
}

export function summarizeCardContext(input: {
  /** 出处：卡的文件路径 */
  path: string;
  /** 卡本身（名字 / 类型 / 正文 / 关系） */
  card: { name: string; type: string; body: string; refs?: CardContextRef[] };
}): CardContextSummary {
  const body = input.card.body;
  const truncated = body.length > CARD_CONTEXT_MAX_CHARS;
  return {
    path: input.path,
    name: input.card.name,
    type: input.card.type,
    body: truncated ? body.slice(0, CARD_CONTEXT_MAX_CHARS) : body,
    truncated,
    totalChars: body.length,
    refs: input.card.refs ?? [],
  };
}
