/* SPDX-License-Identifier: Apache-2.0 */
import { YushuIcon } from "../icons";

/**
 * 空状态（UI 重构第四批余下，R115）。
 *
 * 为什么要有它：空状态此前散落各处，写法各不相同——有的只是一句灰字，
 * 作者分不出「还没写」还是「坏了」；有的干脆混在正文里。
 * 统一成三段式：**图标（说明是哪一类状态）+ 标题（一句话说清是什么）+ 说明（怎么办）**。
 *
 * 图标**只走 `YushuIcon`**（唯一来源，见 `docs/12-图标与插画来源登记.md`）：
 * 状态图标不在组件里内联 path——散落一份就等于有两套画法，
 * 而且没人说得清那一份是从哪儿来的。
 *
 * 标题渲染成 `<h3>`：空态总是出现在面板里，本项目的**区块标题**级就是 h3（docs/11 §3 的三级之一），
 * 用别的标签会把它从标题层级里踢出去。
 */
export function StateNote(props: {
  /** empty = 还没有内容；error = 出错了 */
  kind: "empty" | "error";
  title: string;
  children?: React.ReactNode;
  /** 可选的行动入口（按钮 / 链接） */
  action?: React.ReactNode;
}) {
  return (
    <div className={"state-note state-note-" + props.kind}>
      <YushuIcon name={props.kind === "error" ? "circle-x" : "inbox"} size={18} />
      <div className="state-note-body">
        <h3 className="state-note-title">{props.title}</h3>
        {props.children !== undefined && <p className="state-note-text">{props.children}</p>}
        {props.action !== undefined && <div className="state-note-action">{props.action}</div>}
      </div>
    </div>
  );
}
