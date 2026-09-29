# K14-创作软件UIUX与设计系统

> 类别：K-软件工程与产品 ｜ 世界构建金字塔层级：工程层 · 软件工程
> 质量要求：信息来源 ≥6 条、覆盖 ≥3 种来源类型；URL 必须来自真实检索结果。

## 1. 领域定义

研究长篇创作软件的界面信息架构、写作态交互、中文排版呈现与设计系统基座。边界：本领域回答「信息如何被组织、呈现与操作」，不回答「编辑器内核如何实现」（Markdown/ProseMirror 双向编辑见 S5 与 K12）、也不回答「业务规则是什么」（时效与节拍见 I 类，流派写法见 H 类）。核心工程问题有四：① 项目/世界/章节/设定卡四类对象如何在同一界面里共存而不混乱；② 如何让「世界优先」的重结构软件在初始使用时保持轻量（呼应 docs/01 §2「少量必填 + 渐进披露」）；③ 中文排版与护眼/暗色主题如何作为默认能力而非装饰；④ 设计 token、组件库、快捷键与主题化如何一次定义、多端复用。直接对应 docs/01 §4.7（编辑器：无干扰/打字机/双栏对照）、§4.9（可视化）、§2（渐进披露），并消费 I08 的专注与统计约定。

## 2. 核心知识框架

1. **界面信息架构的三种范式**。① Scrivener 式「三栏 + 三视图」：左 Binder 树（草稿/研究/回收三特殊文件夹）、中编辑区、右 Inspector，同一实体可在 Binder / Outliner（表格式大纲）/ Corkboard（虚拟索引卡）三种视图间切换，卡片 = 文档 = 大纲条目同一对象。② Ulysses 式极简：library → group → sheet 三级，用「Material Sheet」把不进入成稿的素材排除在字数与导出之外，支持 split/merge/glue 的细粒度重排。③ World Anvil 式百科：侧栏是类型化条目树 + 互链 + 搜索优先，写作区退居次要。御书需同时容纳「线性章节流」与「网状世界条目」，属于第四种：双模态信息架构。

2. **沉浸写作与打字机滚动**。iA Writer 把「Focus Mode」拆成三档：Sentence（当前句高亮、其余变灰）、Paragraph、Typewriter（不淡化文本，只把光标垂直居中）；并明确提示「编辑阶段建议关闭，以免选区与居中冲突导致画面跳动」。妙笔提供全屏专注、极简模式、打字机模式（含当前行高亮）与编辑器切分双栏；橙瓜提供「段落聚焦」让屏幕只聚焦正在写的段落。可复用结论：专注是一组可独立开关的开关，不是一个「模式」。

3. **专注机制与节奏管理**。番茄工作法（25 分钟不可分割、被打断即作废、每 4 个长休 15~30 分钟）是标准单元模型；小黑屋式「锁定到目标字数/时长期间不可退出」是强制档。两者应作为专注中心的两种强度，并写入会话记录供 I08 统计消费。

4. **中文排版的工程基线**。W3C clreq《中文排版需求》给出标点禁则、行文方向、行内中西文混排、行距与缩进、标点挤压与悬挂等规则；GB/T 15834《标点符号用法》是标点国标；chinese-copywriting-guidelines 是社区事实标准（中西文之间加空格、全角/半角标点选择、数字与单位间距）。中文创作的默认预期不是「Word 式排版」，而是「首行缩进两字 + 标点禁则 + 中西文间距 + 段间空行」，橙瓜与妙笔的「一键排版」都以此为准。

5. **护眼主题与暗色模式**。iA Writer 明确推荐「全屏 + 暗色」的组合，并建议对「白底深字 / 深底浅字」两种方案都做实测；中文工具普遍内置夜间/护眼模式与自定义背景皮肤。工程侧要点：暗色不是反色，而是一套独立语义色（背景、正文、次级文本、边框、强调色各自取值），且需要与对比度约束联动。

6. **无障碍（WCAG 2.2）**。核心可测判据：正文对比度 ≥ 4.5:1、大号文本 ≥ 3:1（1.4.3 / 1.4.6）；非文本 UI 元素 ≥ 3:1（1.4.11）；文本可缩放至 200% 且不丢内容（1.4.4）；全部功能键盘可达、无键盘陷阱（2.1.1 / 2.1.2）；字符键单键快捷键必须可关闭或重映射（2.1.4）——这对写作软件（大量单键快捷键）尤其关键；焦点可见（2.4.7）与最小目标尺寸（2.5.8）。NN/g 的「训练轮」研究进一步表明：初期只开放核心功能，用户的初始使用与后续进阶使用表现都更好。

7. **设计系统与 token**。Design Tokens 社区组（W3C CG）2025-10 发布首个稳定版规范，覆盖三大能力：theming 与多品牌（明/暗/无障碍变体无需复制文件）、现代色彩空间（Display P3 / Oklch / CSS Color 4）、别名与组件级引用，并能从一份 token 生成 iOS/Android/Web/Flutter 代码；token 结构分 primitive → semantic → component 三层。组件层选型上，shadcn/ui 的范式是「源码直接落到你的 `components/ui/`，你拥有并可改」，并提供 Field（标签+控件+说明+错误的一体化表单）、Empty（空状态）、Kbd（快捷键展示）、Sidebar（可折叠图标栏）等与创作软件高度相关的组件。

8. **快捷键体系**。以 VS Code 默认键位为参照：全局命令面板（⌘⇧P / Ctrl+Shift+P）、快速打开（⌘P）、设置、分屏（⌘\）、折叠、多光标与多选、跳转到定义/引用。写作软件的对应物是「命令面板 + 可自定义 keybindings.json + 冲突检测」；UW 侧还要处理「单键快捷键（无修饰键）必须可关闭」。

9. **空状态与渐进披露**。NN/g 定义渐进披露为「首屏只给少数最重要的选项，其余按需展开」，并指出它同时改善可学习性、效率与错误率；实现形态包括分步披露、条件披露、上下文披露与渐进启用。对创作软件的含义：新建项目首屏只问「频道 + 世界类型 + 手法 + 基调」这类必填项，境界体系卡等 schema 字段按派系包条件展开；首次进入无数据的看板必须给「下一步做什么」的空状态，而不是空白页。

## 3. 可转化为产品规则的关键实践

1. 三视图同源（Scrivener：Binder = Outliner = Corkboard）→ 章节/设定条目为单一实体，「列表视图 / 大纲表格 / 卡片看板 / 图谱」只是同一数据的不同渲染，切换不丢状态。
2. Material Sheet 排除成稿（Ulysses）→ 设定卡/大纲/研究资料打 `material: true`，不计入正文有效字数与导出产物（I08 联动）。
3. 图片来源与素材分层（Ulysses group/sheet）→ 项目树用「世界条目树 + 章节树」双根，避免 30 万字长篇把章节树压垮（虚拟化渲染，见 S5）。
4. 三档专注（iA Writer Sentence/Paragraph/Typewriter）→ 写作视图提供「当前句/当前段/打字机居中」三个独立开关 + 全屏，编辑阶段自动提示关闭居中。
5. 段落聚焦 + 沉浸隐藏侧栏（橙瓜）→ 沉浸模式下自动隐藏左右栏，仅保留正文列，可在设置中固定宽度与行高。
6. 番茄钟与小黑屋双强度（I08 / 小黑屋）→ 专注中心：轻档（计时+统计，可随时退出）与重档（锁定到目标，需显式解除），会话写入 `sessions`。
7. 一键排版（橙瓜 / 妙笔）→ 按 clreq + GB/T 15834 + chinese-copywriting-guidelines 实现中文排版规则包，导出与编辑器可共享同一规则集。
8. 标点禁则与中西文间距作为可校验规则 → 排版检查项（行首禁则标点、行尾禁则标点、中西文间空格、全半角混用）单独成规则，可开关。
9. 护眼/暗色/自定义主题（iA Writer / 橙瓜 / 妙笔）→ 主题 = token 集合；提供「护眼（低蓝光暖底）」「夜间」「高对比」三套预设，并允许自定义背景图与字体（妙笔 Pro 的「自定义 CSS」是上限参考）。
10. 对比度与字号硬约束（WCAG 2.2）→ 所有主题出厂前跑一次对比度检查，正文 ≥ 4.5:1、大字号 ≥ 3:1、非文本控件 ≥ 3:1。
11. 键盘可达 + 单键快捷键可关（WCAG 2.1.4）→ 提供「单键快捷键总开关」与完整重映射界面，导出/导入 keybindings。
12. 命令面板（VS Code 参照）→ ⌘K / Ctrl+K 命令面板覆盖全部命令，并同时作为功能发现入口。
13. 渐进披露 + 条件字段（NN/g）→ 新建项目向导分步；设定卡字段按派系包与已填内容条件展开；「高级设置」折叠。
14. 空状态三要素（shadcn Empty + NN/g）→ 每个空视图给出「说明为什么空 + 一个主行动 + 一个示例/模板入口」。
15. token 三层结构（DTCG）→ 一份 `tokens.json` 生成 CSS 变量与主题，明/暗/高对比为同一 token 的不同主题值，禁止组件内写死色值与字号。

## 4. 信息来源

1. [官方文档] Scrivener·用 Corkboard 组织项目（Literature & Latte 官方博客） — https://www.literatureandlatte.com/blog/organize-your-scrivener-project-with-the-corkboard — Binder/Outliner/Corkboard 三视图同源，卡片与文档为同一对象。
2. [官方文档] Ulysses·Sheets & Groups — https://help.ulysses.app/en_US/the-library/567894-sheets-groups — library/group/sheet 三级组织、Material Sheets 不计入字数与导出、split/merge/glue。
3. [官方文档] World Anvil·世界构建模板 — https://www.worldanvil.com/features/worldbuilding-templates — 百科式条目树 + 25+ 模板 + 互链 + 「3 个字符即全局搜索」。
4. [官方文档] iA Writer·Focus Mode — https://ia.net/writer/support/editor/focus-mode — Sentence/Paragraph/Typewriter 三档与「编辑阶段建议关闭居中」的实操警告。
5. [官方文档] 妙笔 WonderPen 功能页 — https://www.tominlab.com/wonderpen — 树状目录、白板、大纲视图 + 自定义元数据、打字机模式、编辑器切分、多种主题、一键排版、自定义 CSS。
6. [官方文档] 橙瓜码字官网 — https://www.chenggua.com/about-us/index/index.html — 段落聚焦、沉浸式隐藏侧栏、自动排版（首行缩进两字）、护眼模式与自定义皮肤。
7. [规范标准] W3C《中文排版需求》（clreq） — https://www.w3.org/TR/clreq/ — 标点禁则、行文方向、行内中西文混排、行距与缩进等中文排版基线。
8. [规范标准] W3C《Web 内容无障碍指南 2.2》（WCAG 2.2） — https://www.w3.org/TR/WCAG22/ — 对比度 4.5:1 / 3:1、文本缩放 200%、键盘可达、字符键快捷键可关闭、目标尺寸。
9. [规范标准] Design Tokens Format Module 2025.10（W3C Design Tokens CG 稳定版） — https://www.designtokens.org/tr/drafts/format/ — token 名称/值/类型/别名/分组/组合类型与主题化基础。
10. [官方文档] shadcn/ui·2025-10 新组件（Empty / Kbd / Field / Sidebar） — https://ui.shadcn.com/docs/changelog/2025-10-new-components — 源码即组件的范式与空状态、快捷键、表单字段、可折叠侧栏组件。
11. [技术文章] NN/g《Progressive Disclosure》 — https://www.nngroup.com/articles/progressive-disclosure/ — 首屏只给核心选项、高级选项按需展开，同时改善可学习性/效率/错误率。
12. [官方文档] Visual Studio Code·Default Keyboard Shortcuts — https://code.visualstudio.com/docs/reference/default-keybindings — 命令面板、快速打开、分屏等默认键位体系作为快捷键设计参照。
13. [开源项目] sparanoid/chinese-copywriting-guidelines — https://github.com/sparanoid/chinese-copywriting-guidelines — 中西文空格、全半角标点、数字与单位间距的社区事实标准。
14. [评测] NowNovel《The Best Worldbuilding Tools for Authors in 2026》 — https://nownovel.com/best-worldbuilding-tools/ — 对 World Anvil / LegendKeeper 等界面与信息架构的横向评价。
15. [技术文章] Lollypop Design《The Power of Progressive Disclosure in SaaS UX》 — https://dev.to/lollypopdesign/the-power-of-progressive-disclosure-in-saas-ux-design-1ma4 — 分步/条件/上下文披露与渐进启用四类实现形态。

## 5. 对御书设计的启示

**数据结构建议：设计 token 草案（primitive → semantic → component）**

```yaml
# design/tokens.json（DTCG 2025.10 格式，节选；一份文件生成多端变量）
color:
  primitive:                        # 不与界面语义绑定，仅作调色板
    ink-900: { $type: color, $value: "oklch(0.22 0.02 260)" }
    ink-100: { $type: color, $value: "oklch(0.96 0.01 260)" }
    warm-50: { $type: color, $value: "oklch(0.97 0.02 85)" }   # 护眼暖底
    accent-600: { $type: color, $value: "oklch(0.55 0.16 250)" }
  semantic:                         # 界面语义层，主题只改这一层
    bg-app: { $type: color, $value: "{color.primitive.warm-50}" }
    text-body: { $type: color, $value: "{color.primitive.ink-900}" }
    text-muted: { $type: color, $value: "oklch(0.55 0.01 260)" }
    border-subtle: { $type: color, $value: "oklch(0.88 0.01 260)" }
typing:
  font-family:
    body-cjk: { $type: fontFamily, $value: ["Source Han Serif SC", "serif"] }
    ui: { $type: fontFamily, $value: ["Inter", "system-ui", "sans-serif"] }
  size: { body: { $type: dimension, $value: "18px" }, ui: { $type: dimension, $value: "14px" } }
  line-height: { body: { $type: number, $value: 1.9 }, ui: { $type: number, $value: 1.5 } }
  measure: { reading: { $type: dimension, $value: "38em" } }     # 单行字数上限
spacing: { xs: { $type: dimension, $value: "4px" }, sm: { $type: dimension, $value: "8px" }, md: { $type: dimension, $value: "16px" } }
component:
  card-padding: { $type: dimension, $value: "{spacing.md}" }
  sidebar-width: { $type: dimension, $value: "16rem" }
themes:                              # 主题 = semantic 层的不同取值集
  light: {}
  dark:
    color: { semantic: { bg-app: { $value: "oklch(0.20 0.02 260)" }, text-body: { $value: "oklch(0.92 0.01 260)" } } }
  eyecare:
    color: { semantic: { bg-app: { $value: "{color.primitive.warm-50}" } } }
  high-contrast:
    color: { semantic: { bg-app: { $value: "#ffffff" }, text-body: { $value: "#000000" }, border-subtle: { $value: "#000000" } } }
```

**结构化清单：编辑器信息架构与视图模式**

```yaml
layout:
  zones: [left_sidebar, main_editor, right_inspector]
  left_sidebar: { roots: [world_tree, chapter_tree], collapsible: true, rail_icons: true }
  right_inspector: { tabs: [setting_card, outline, stats, history], dockable: true }
views:                      # 同一实体的不同渲染，切换保状态
  chapter: [continuous, card_board, outliner_table, timeline]
  world_entry: [detail_card, relation_graph, map_pin, timeline]
writing_view:               # 可独立开关，组合生效
  focus_scope: [off, sentence, paragraph, typewriter]
  fullscreen: false
  split_pane: { enabled: false, mode: side_by_side }   # 左设定右正文
  line_highlight: false
  paragraph_dim: false
focus_center:
  pomodoro: { duration: 25, short_break: 5, long_break: 20, units_before_long: 4 }
  lockdown: { enabled: false, target: { type: word_count, value: 2000 } }   # 小黑屋式，默认关
```

**校验规则建议（规则 id）**

- `ui-contrast-aa`：任一主题下正文文本对比度 < 4.5:1，或大号文本/非文本控件 < 3:1 → error（WCAG 1.4.3 / 1.4.6 / 1.4.11）。
- `ui-token-hardcoded`：组件样式出现未引用 token 的硬编码色值或字号 → error（禁止绕过设计系统）。
- `ui-single-key-shortcut`：存在无修饰键的字符快捷键但未提供总开关 → error（WCAG 2.1.4）。
- `ui-focus-visible`：交互元素缺少可见焦点样式 → error（WCAG 2.4.7）。
- `ui-cjk-punct-line-start`：排版检查发现行首出现禁则标点（。，、）」等）→ warn，附一键修复。
- `ui-cjk-latin-space`：中文与西文/数字相邻处缺空格或混用全半角 → info（对齐 chinese-copywriting-guidelines）。
- `ui-measure-too-wide`：正文行宽 > 45 个汉字 → info（可读性，建议 30~40 字/行）。
- `ui-empty-state-missing`：任一列表/看板在零数据时未定义空状态 → warn（须含说明 + 主行动 + 示例入口）。
- `ui-wizard-required-count`：新建项目向导首屏必填字段 > 6 → warn（渐进披露，对齐 docs/01 §2）。
- `ui-zoom-200`：界面在 200% 缩放下出现内容遮挡或功能丢失 → error（WCAG 1.4.4）。

**功能建议**

- 双模态信息架构：左侧同时提供「世界条目树」与「章节树」双根，可用标签页或并排切换；条目树支持图谱/地图/时间线三种联动视图。
- 专注中心：把 `focus_scope`、`fullscreen`、`paragraph_dim`、番茄钟与可选的锁定档做成一个面板，会话写入 `sessions` 并对接 I08 的码字统计。
- 一键排版：提供可预览的排版规则包（缩进/禁则/中西文间距/段间空行），规则可在「编辑器实时」与「导出时」两处独立启用。
- 主题工坊：内置 light/dark/eyecare/high-contrast 四套 token 主题，用户可导出/导入自定义主题（含背景图与正文字体），所有主题过对比度门禁。
- 命令面板 + 快捷键编辑：⌘K 面板覆盖全部命令，提供 keybindings 编辑器、冲突检测与「单键快捷键总开关」。
- 空状态组件：统一使用 Empty 组件的三要素模板，新建项目向导首屏只问四维派系并给「不确定？用推荐组合」入口。

**AI 提示词建议**

- 「排版体检」：输入一段中文正文，按 clreq + GB/T 15834 输出标点禁则与中西文间距问题清单（含位置与建议替换），不修改文学表达。
- 「空状态文案」：输入某视图名称与用户当前所处阶段，输出该空状态的「一句说明 + 主行动按钮文案 + 示例入口文案」。

## 6. 领域内子主题备忘（可选）

- 触控与移动端布局（v1 不做移动端，但需为跨端存储预留，见 docs/01 §5）。
- 打印与纸张视图（Scrivener 的 Page View 与 Vellum 的 Proof 模式）对「所见即所得排版」的启发。
- 字体渲染与中文可变字体（思源宋体/黑体）、标点挤压与悬挂缩进的技术实现成本。
- 国际化与多语言界面下的行文方向（clreq 与西文 RTL 的共存）。
- 编辑器无障碍的进阶项：朗读/听写与屏幕阅读器对结构化文档（ProseMirror 文档树）的适配。