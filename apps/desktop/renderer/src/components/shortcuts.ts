/* SPDX-License-Identifier: Apache-2.0 */

/**
 * 快捷键登记表（R157）。
 *
 * 这份表**不是一份写给人看的文案**，而是"代码里到底绑了哪些键"的**逐处登记**：
 * 每一行都记着**绑定在哪个文件的哪一处**（`file` + `probe`），判据拿 `probe` 回到源码里
 * 把那一处的按键判断抠出来对账 ⇒ **面板上的条目数与真实绑定数对不上时，当场红**。
 *
 * 口径（`docs/11` §7.37）：
 * ① **全局** = 绑在窗口上（任何时候都能按）；**局部** = 焦点在某个东西上时才生效
 *    （画布、输入框、某个按钮……）—— 两者都在面板上，但**分开摆**（混在一起作者会以为
 *    "那个键什么时候都能按"）。
 * ② 一个键在**不同地方**做不同的事 ⇒ **分成两条**（同一个键在地图画布上是"平移"，
 *    在标注节点上是"挪标注"；写在一起作者只会记住一半）。
 * ③ `keys` 按**代码里逐处判断**列出（同一处里同一个键判了两次就写两次）⇒
 *    判据对的是**逐处**，不是"这个键有没有出现过"。
 * ④ `probe` 是那一处的**原样片段**（唯一）⇒ 判据靠它定位，不靠"文件里出现过这个键"。
 *
 * 为什么要有这张表：入口多了以后，作者**记不住**哪个键在哪儿能按 ⇒ 与其让人猜，
 * 不如把真源摆出来——但摆出来的必须是**真的**（这份表因此有判据钉着）。
 */

/** 全局（绑在窗口上，任何时候都能按） / 局部（焦点在某个东西上时才生效） */
export type ShortcutScope = "global" | "contextual";

export interface ShortcutEntry {
  /** 条目 id（判据拿它认领） */
  id: string;
  scope: ShortcutScope;
  /**
   * 这一处绑的键。
   *
   * 按代码里**逐处判断**列出（同一个键在**同一处**判了两次就写两次 —— 判据对的是逐处，
   * 不是"这个键有没有出现过"）；面板上显示时再去重（见 `keysLabel`）。
   */
  keys: string[];
  /** 什么时候能按（作者得知道"我现在能不能按它"） */
  when: string;
  /** 按了会怎样 */
  action: string;
  /** 绑定在哪个文件（相对仓库根） */
  file: string;
  /** 该文件里能认出"这一处绑定"的**原样片段**（判据拿它定位；必须唯一） */
  probe: string;
}

/** 地图画布（WorldMapPanel） */
const MAP = "apps/desktop/renderer/src/components/WorldMapPanel.tsx";

export const SHORTCUTS: ShortcutEntry[] = [
  {
    id: "focus-mode-escape",
    scope: "global",
    keys: ["Escape"],
    when: "专注模式里（顶栏与标签栏都藏起来的那一段）",
    action: "退出专注模式，回到平时的界面",
    file: "apps/desktop/renderer/src/views/ProjectScreen.tsx",
    probe: "const onKeyDown = (event: KeyboardEvent) => {",
  },
  {
    id: "map-canvas-view",
    scope: "contextual",
    keys: ["+", "=", "-", "_", "0", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"],
    when: "地图画布获得焦点、且没有在框定 / 放置 / 画形状 / 挖洞",
    action: "＋ / ＝ 放大，－ / ＿ 缩小，0 回到整块，方向键平移画面",
    file: MAP,
    probe: "const onViewKeyDown = useCallback(",
  },
  {
    id: "map-frame",
    scope: "contextual",
    keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "+", "=", "-", "_", "Enter"],
    when: "正在框定底图的那一块（框定模式下）",
    action: "方向键移动框，＋ / － 改框的大小，回车把这一块定下来",
    file: MAP,
    probe: "const onFrameKeyDown = useCallback(",
  },
  {
    id: "map-place-cursor",
    scope: "contextual",
    keys: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Enter"],
    when: "正在放标注（十字光标已经在动）",
    action: "方向键挪光标，回车在光标处落点",
    file: MAP,
    probe: "const onPlaceKeyDown = useCallback(",
  },
  {
    id: "map-marker",
    scope: "contextual",
    keys: ["Enter", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"],
    when: "焦点在某个标注上（点一下或用 Tab 走到它）",
    action: "回车 / 空格选中它，方向键挪它（按住 Shift 步子更大）",
    file: MAP,
    probe: 'onPointerDown={(event) => onItemPointerDown(event, "marker", marker.id)}',
  },
  {
    id: "map-anchor",
    scope: "contextual",
    keys: ["Enter", " ", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"],
    when: "焦点在某个事件锚点上",
    action: "回车 / 空格选中它，方向键挪它（按住 Shift 步子更大）",
    file: MAP,
    probe: 'onPointerDown={(event) => onItemPointerDown(event, "anchor", anchor.id)}',
  },
  {
    id: "map-hole",
    scope: "contextual",
    keys: ["Enter", "Backspace"],
    when: "正在挖洞（已经选好了要挖的那个区域）",
    action: "回车加一个顶点，退格删掉最后一个顶点",
    file: MAP,
    probe: "// 挖洞：回车加一个顶点、退格删掉最后一个（键盘也能挖）",
  },
  {
    id: "map-shape",
    scope: "contextual",
    keys: ["Enter", "Backspace"],
    when: "正在画形状（画行程线、画区域那一圈）",
    action: "回车加一个顶点，退格删掉最后一个顶点",
    file: MAP,
    probe: "// 画形状：回车加一个顶点、退格删掉最后一个（键盘也能画）",
  },
  {
    id: "editor-mention-menu",
    scope: "contextual",
    keys: ["ArrowDown", "ArrowUp", "ArrowDown", "Enter", "Escape"],
    when: "编辑器里刚敲了 @ 、候选菜单正开着",
    action: "↑ ↓ 换候选，回车插进去，Esc 关掉菜单",
    file: "apps/desktop/renderer/src/views/ChapterEditorView.tsx",
    probe: "const mentionKeyHandler = useCallback(",
  },
  {
    id: "graph-node",
    scope: "contextual",
    keys: ["Enter", " "],
    when: "焦点在关系图谱的某个节点上",
    action: "回车 / 空格把视角收到那个节点上",
    file: "apps/desktop/renderer/src/components/RelationGraphPanel.tsx",
    probe: "aria-label={`聚焦节点 ${node.name}`}",
  },
  {
    id: "import-rule",
    scope: "contextual",
    keys: ["Enter"],
    when: "存量导入页那条「新规则」输入框里",
    action: "回车把这条规则加进规则海选",
    file: "apps/desktop/renderer/src/components/ImportPanel.tsx",
    probe: "value={draft}",
  },
  {
    id: "genesis-kickoff",
    scope: "contextual",
    keys: ["Enter"],
    when: "起源工作台那句「一句话开局」的输入框里",
    action: "回车把这句话填进下面的表单（**只填进表单，不自动保存**）",
    file: "apps/desktop/renderer/src/views/GenesisView.tsx",
    probe: 'placeholder="如：混沌中第一缕灵光开天，天柱断裂化为九城"',
  },
  {
    id: "search-submit",
    scope: "contextual",
    keys: ["Enter"],
    when: "项目文件页那个检索框里",
    action: "回车开始检索",
    file: "apps/desktop/renderer/src/views/ProjectView.tsx",
    probe: 'placeholder="检索正文 / 设定…"',
  },
];

/** 全局快捷键有几条（判据拿它对"窗口级 keydown 监听器"的数量） */
export const GLOBAL_SHORTCUT_COUNT = SHORTCUTS.filter((entry) => entry.scope === "global").length;

/** 键名 → 人话（作者看到的是"回车"，不是 "Enter"） */
const KEY_LABEL: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Enter: "回车",
  Escape: "Esc",
  Backspace: "退格",
  " ": "空格",
  "+": "＋",
  "=": "＝",
  "-": "－",
  "_": "＿",
};

/** 一个键的人话 */
export function keyLabel(key: string): string {
  return KEY_LABEL[key] ?? key;
}

/** 一组键的人话（**去重**后按原顺序拼起来：同一个键判了两次，界面只摆一次） */
export function keysLabel(keys: string[]): string {
  const seen: string[] = [];
  for (const key of keys) {
    if (seen.indexOf(key) < 0) seen.push(key);
  }
  return seen.map(keyLabel).join(" / ");
}
