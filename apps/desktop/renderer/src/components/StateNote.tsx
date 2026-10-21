/* SPDX-License-Identifier: Apache-2.0 */
import type { ReactNode } from "react";
import { StateArt } from "./StateArt";

/**
 * 空状态 / 错误态（UI 重构第四批余下，R115；插画 R118；"只留一个信号"与版式 R119）。
 *
 * 为什么要有它：空状态若只有一行灰字，作者看到的是"这儿没东西"，而不是"这儿本来该有东西、
 * 现在还没有"。R115 把空状态统一成三段式，R118 补上自绘插画。
 *
 * R119 做**五批总复核**时抓到两处真问题：
 * ① 插画与状态图标**表达的是同一件事**（空 = 没东西，坏 = 坏了）——两个"容器"并排摆着，
 *    同一个状态说了两遍；
 * ② 40px 的插画**孤悬在文案上面一行**，既不与文案对齐也不成组，看着像随手放的小图。
 *
 * R119 定的分工（**每个地方只留一个信号**）：
 * - **区块级**空/错态（本组件）：**插画**承担状态表达——空白稿纸 = 还没写，
 *   划掉的稿纸 = 写坏了（自绘线稿，见 `docs/12` §1.4）；右边是标题（是什么）与说明（怎么办）。
 * - **行内提示**（全局错误条）：只有一个字高，放不下插画 ⇒ 用 Lucide 图标（14px `circle-x`）。
 *
 * 因此组件里**不再挂 16px 状态图标**（R115 那枚 `inbox`）：它与插画说的是同一句话，
 * 而"同一件事说两遍"比"少一个图标"更糟——`inbox` 没了落点，R119 一并回收。
 * 矢量图形仍**只走登记过的文件**（`StateArt` / `YushuIcon`，见 `docs/12`），这里不内联 path。
 */
export function StateNote(props: {
  /** empty = 还没有内容；error = 出错了 */
  kind: "empty" | "error";
  title: string;
  children?: ReactNode;
  /** 可选的行动入口（按钮 / 链接） */
  action?: ReactNode;
  /** 插画尺寸（默认 56px；窄处可传小一点） */
  artSize?: number;
}) {
  return (
    <div className={"state-note state-note-" + props.kind}>
      <StateArt kind={props.kind} size={props.artSize ?? 56} />
      <div className="state-note-body">
        <h3 className="state-note-title">{props.title}</h3>
        {props.children !== undefined && <p className="state-note-text">{props.children}</p>}
        {props.action !== undefined && <div className="state-note-action">{props.action}</div>}
      </div>
    </div>
  );
}
