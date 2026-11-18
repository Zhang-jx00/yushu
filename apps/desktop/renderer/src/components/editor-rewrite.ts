/* SPDX-License-Identifier: Apache-2.0 */

/**
 * **选区替换的两条纯判定**（R185）：把「能不能替换」与「替换成什么样」从组件里
 * 抽出来 ⇒ 可直接单测（预演层造不出「生成期间正文被改过」的场景——
 * CM6 的文本输入走原生 input 事件，脚本派发 keydown 插不进字）。
 *
 * 口径：
 * ① **位置失效即拒**：采纳时正文若与生成时的快照不同 ⇒ 旧偏移不可信 ⇒ 拒
 *    （与 `applyFixes` 的「位置失效即拒」同一条纪律）；
 * ② **替换只动那一段**：其余正文**逐字不动**（不做任何"顺手规范化"——
 *    规范化会把作者的排版改掉，那不是作者要的）。
 */

/** 正文与生成时的快照是否仍一致（一致 ⇒ 选区偏移仍可信） */
export function canReplaceSelection(beforeBody: string, currentBody: string): boolean {
  return beforeBody === currentBody;
}

/** 用新文本替换 `body` 的 [from, to) 区间；区间越界或倒挂 ⇒ 原样返回（不猜、不截断） */
export function sliceReplacement(body: string, from: number, to: number, text: string): string {
  if (from < 0 || to > body.length || from >= to) return body;
  return body.slice(0, from) + text + body.slice(to);
}
