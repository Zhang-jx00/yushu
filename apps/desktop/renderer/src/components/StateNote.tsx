/* SPDX-License-Identifier: Apache-2.0 */
import type { ReactNode } from "react";
import { YushuIcon } from "../icons";
import { StateArt } from "./StateArt";

/**
 * 空状态 / 错误态（UI 重构第四批余下，R115；插画 R118）。
 *
 * 为什么要有它：空状态若只有一行灰字，作者看到的是"这儿没东西"，而不是"这儿本来该有东西、
 * 现在还没有"。R115 已经把空状态统一成三段式，但那个图标是**图标级**的（Lucide 的 `inbox`）
 * ——它负责说"这是哪一类状态"，不负责说"这里将来会有什么"。插画负责后者（R118 补上），
 * 所以两者是**分工**，不是重复。
 *
 * 结构：插画（这里将来会有什么）+ 一行「状态图标（哪一类状态）+ 标题与说明（怎么办）」。
 *
 * 图标**只走 `YushuIcon`**（唯一来源，见 `docs/12-图标与插画来源登记.md`）：
 * 状态图标不在组件里内联 path——散落一份就等于有两套画法，而且没人说得清那一份是从哪儿来。
 */
export function StateNote(props: {
  /** empty = 还没有内容；error = 出错了 */
  kind: "empty" | "error";
  title: string;
  children?: ReactNode;
  /** 可选的行动入口（按钮 / 链接） */
  action?: ReactNode;
  /** 插画尺寸（默认 40px；窄处可传小一点） */
  artSize?: number;
}) {
  return (
    <div className={"state-note state-note-" + props.kind}>
      <StateArt kind={props.kind} size={props.artSize ?? 40} />
      <div className="state-note-line">
        <YushuIcon name={props.kind === "error" ? "circle-x" : "inbox"} size={16} />
        <div className="state-note-body">
          <h3 className="state-note-title">{props.title}</h3>
          {props.children !== undefined && <p className="state-note-text">{props.children}</p>}
          {props.action !== undefined && <div className="state-note-action">{props.action}</div>}
        </div>
      </div>
    </div>
  );
}
