# 御书 · 交接文档（给 QoderCN）

> 交接时间：2026-10-07 ｜ 交接时远端 main：`2d3115a4`（R30–R39 十轮全部已推送）
> **R40 续跑更新（2026-10-07，QoderCN）**：T3-12 已完成，远端 main 随后同步；本文 §1 快照与 §4 未完成清单已按 R40 实况更正（上一版误记 tag 未推、远端停在 `2d3115a4`，实际 `git ls-remote` 显示 main 已含交接文档提交、`v0.2.0` tag 已在远端）。
> 本文写给接手的 AI 编码助手（QoderCN）：读完这一份 + `docs/04-开发计划.md`（唯一任务清单）+ `docs/06-M1验收与自查清单.md` §八（逐轮记录），即可无缝续跑。
> 阅读顺序建议：本文 §1 状态快照 → §7 每轮工作流（照做）→ §4 未完成清单（领任务）→ 其余按需查阅。

---

## 1. 项目一句话与当前状态快照

**御书**：本地优先的开源网文创作工具（Electron + React + TypeScript monorepo）。核心理念：Markdown/YAML 为唯一真源、SQLite 仅作索引、AI 结果一律候选化（采纳是用户显式动作）、离线能力完整（AI 可整体关闭）。

当前进度：**M1（世界基座）、M2（编辑器与索引，v0.2.0）已完成验收；M3（AI Provider 与上下文记忆）的 14 个功能任务中 13 个已完成并勾选（T3-1～T3-13，R30–R49），T3-14 保持未勾选**——**这条是第 55 轮十轮总复核改的**：此前本节一直写"14 项全部已勾"，而 `docs/04` §6.3 实际只勾了 T3-12（`git log -S'[x] T3-1'` 零命中，从来没勾过，各轮只在注记里写"已完成"）。复核逐条对照证据后补齐 T3-1～T3-11、T3-13 共 12 条；**T3-14 不补勾**，因为任务文本里的"导入或导出项目时自动剔除密钥"没有调用点可接（项目打包属 M5），已就位的三条是 `detectPlaintextSecrets` 检测 / `secrets-ops` 加密保存与后端不可用拒存 / 保存路径明文阻断（**原文写作的 `stripSecrets` 是个不存在的名字**，R101 回源统一；剥离的真名是 `redactPlaintextSecrets`）。M3 剩余验收：§6.5 的 **A3（成本偏差需真实 provider）** 一条——A1 / A2 / A4 / A5 / A6 已达成并有机器证据（A2 于 R46，A4 于 R47，A5/A6 于 R41）。收口动作：A1–A6 全绿 → `v0.4.0` 打 tag（docs/04 §6.7）；**A3 必须等真实端点，不要在 mock 上声称达成**。**R50 起进 M4**（docs/04 §7），**M4 进度：已勾 10/12（未勾：T4-2、T4-11）**——这条计数是机器可读标记，`governance-docs.test.ts` 拿它跟 `docs/04` §7.3 的勾选实况对账，不一致就红（**第 86 轮十轮总复核改的**：此前这句一直停在 R58 的口径"T4-1 / T4-3 / T4-4 已勾选"，落后了 28 轮，而开头这句是接手者唯一会先读的话，它少报进度的后果是"重复劳动"而不是"误判已完成"）。已勾的 10 条：T4-1 规则 DSL（R50/R51）、T4-3 报告格式（R53/R54）、T4-4 校验三态（R54/R56/R58）、T4-5 影响传播与写回（R61/R62）、T4-6 伏笔台账（R66/R75）、T4-7 时间线（R68）、T4-8 编年史（R71/R76）、T4-9 关系图谱（R69）、T4-10 爽点与期待感（R72/R73）、T4-12 平台规则包机制（R85）。**未勾的两条各有明确缺口**：T4-2 八类语义规则已落 结构三条（R52）+ 战力一类（R57/R97）+ 伏笔回收链与节拍（R74/R75）+ **视角可判定的那五条（R102：`pov.yaml` 策略声明 / 未标视角 / 悬空视角 / 白名单外 / 切换预算，含 `pov` 的界面写入点）**，仍缺 信息可见性、黄金三章里可量化的部分、结局承诺清算、幻觉，以及视角 L1「同场景多角色内心直写」（那条要靠 AI 采样，不靠关键词猜，见 docs/04 T4-2 第 102 轮注记）；T4-11 的**阈值已于 R84 做成可配置**（不再是"写死 0"），但"校准"要标注语料，且产品只有"豁免率"这一个代理信号——**M4 验收 A3（召回率与误报率）需要真实 provider 与真实语料，不在 mock 上声称达成**。理由见 §3.2 各行与 docs/04 注记。**R86 是 R76–R85 的十轮总复核（只动文档与锁）；R87 起进 M5**（docs/04 §8，共 9 条功能任务，**目前 0 勾**）——第一段做的是 T5-4 的"能力判定"那一半：`@yushu/export/formats.ts` + `export-tooling.ts` 把"这台机器能不能产出 txt/epub/docx/pdf"变成**现场探测**的事实并显示在导出页（本机实测 pandoc 2.10 认 pdf 但七个 PDF 引擎零安装 ⇒ PDF 判「暂不可」）。**产出本身还没做**：Markdown 源装配、`runExport` 的 format 参数、EPUBCheck 门禁接线、平台章节格式适配（K11）都在后面，且 PDF 与 EPUB 质检各卡一条外部条件（作者本机装引擎 / 备 EPUBCheck jar）。

| 项目 | 状态 |
|---|---|
| 工作目录 | `d:\Zcode对话\workspace\novel` |
| 远端 | `https://github.com/Zhang-jx00/yushu.git`（公开仓库；凭据可用，推送没出过权限问题）。**2026-10-15 那一小时 `github.com:443` 反复连不上**：R90 的 3 条卡了约 30 分钟后重试成功（`07b94af..08272e2`）；R91 的提交连试 4 次超时/重置后同样重试成功；R101 收口时 3 条提交仍卡在本地（`Failed to connect to github.com:443` / `Recv failure: Connection was reset`），当时 `git push ... | tail` 还报过 `PUSH=0` 而真实 `PUSH_EXIT=128`——**别信管道尾部的退出码**。**当前状态（2026-10-16 R102 收口时）：已恢复并全部推上去**——`git push origin main` 两次退出码 0（`0ce116a..12d6664` 含 R101 卡住的 4 条 + R102 前两条；`12d6664..6737947` 是落档条），`git ls-remote origin main` 逐字等于本地 HEAD `6737947`。教训一句：网络类失败要在账上写清"当时"的状态，恢复了就立刻更正，别让过期状态留在交接文档里 |
| 单测 | **1446/1446 全绿**（136 个测试文件）——`pnpm test`（R102 新增视角引擎 16 + 桌面侧 17 + 规则 id 覆盖锁 3 + 四处对账 1 + 写通道分类 2；R101 为 1407/133） |
| 类型检查 | **11 个包/应用零错误**——`pnpm typecheck`（注意：内含 `pnpm -r run build`，即构建全部产物）。**R88 起这份"零错误"覆盖 `src` 与 `test` 两面**：每个有测试的包多一份 `tsconfig.test.json`（`noEmit`）并接进该包脚本；此前 11 份配置的 `include` 都只有 `src`，约 120 个测试文件从来没被类型检查（锁：`typecheck-coverage.test.ts` 23 例） |
| e2e | 全链路通过（离线 mock LLM，无需外网/Key）——`pnpm --filter @yushu/desktop e2e`；R43 起含「密钥安全」探针、R45 起含「中文自查」探针（`diskUnchanged:true` 即「两个只读通道不写盘」的实测） |
| UI 预演 | **63/63 全绿**（最近一次新目录 **v216**（R102），抖动=0、证据缺失=0；**62→63 是 R102 的 step63（视角看板：未声明那句原话必须在屏幕上、改策略让保存按钮从禁用变可点、绑一章视角就少一条结论、点「全书体检」后视角结论出现在总表里）**。本轮为看界面共跑 4 次（v213–v216），**每次 63/63 且 step63 数字逐字一致**——三次改动都是纯呈现层（策略框宽度、结论表次序、回执位置），判据没被顺手放宽。**上一版这一行还写着"62/62（v212）"**，那是 R101 的实况、本轮已过期。**本轮起预演多一种夹具 `export-dir`：对话框只换成临时目录，跑完由 `check()` 数盘上文件并把结果折进步骤通过判定——**回执漂亮不再等于通过**；**步数 56→57 是 R87 的 step57（能力矩阵），57→58 是 R90 的 step58（格式选择 + 真出 EPUB），58→59 是 R94 的 step59（平台章节格式），59→60 是 R95 的 step60（冷启动待补：点一条待补必须把选中项挪走），60→61 是 R98 的 step61（设定集：面板条目数与落盘产物同一份结论，脱敏点名的名字必须不出现在文件里）**。**这一行先前被写漏了两轮**：R96 实跑过 v200、R97 实跑过 v201，行首却还停在「最近一次 v199（R95）」——回源更正，别把过期快照当现状。v188 是一次**有价值的抖动**：step7 重试后通过（`flaky:[7]`），归因不是噪声而是 R87 让首帧预览变慢后「我已核对…」复选框会被 `setReviewed(false)` 静默冲掉——改成"摘要未回前不许勾"之后 v189、v190（都属 R87 收口）与 v191（R89）均 `attempts=1`、`flaky:[]`；**v186 是一次未复现的静默中止**：退出码 1、日志停在 `step34 OK`、既无"执行中断"行也无 `DONE` 行，紧接着的 v187 一次过——按"连续两轮同样红才追根因"的口径本轮未追，日志留在 `D:\Temp\r85-walk3.log` 与 `D:\Temp\yushu-walkthrough-v186` 备查；v183/v180/v179/v178/v177 均为 56/56、v174 为 55/55、v167 为 54/54、v153 为 51/51，`flakySteps:[]`、`screenshotFailures:[]`；R63 的 v142 为 47/47）——见 §6.3。**step21 的抖动根因分两层，R58 消掉第一层、R78 消掉第二层**：① `press()` 缓存了失效的 `.tiptap` 节点（改为每次按键重新查询）；② 断言写死"↓ 一次后高亮必须在第 2 项"，而**真鼠标停在候选菜单上时 `onMouseEnter` 会先把 active 挪走**——组件的 `(active+1)%n` 是对的，错的是把鼠标位置当契约。现断言"↓ 让高亮移动一格 + 回车插入的正是那一格"，并把实际起止项与插入的卡名打进证据行。**教训：连续两轮同样红就不是抖动**，先取证据再改测试。剩余遗留只有 step17：快照内容寻址导致"重复点一次不产生新行"，**状态变更型步骤重试救不回来**，根因仍未定（docs/06 §七）。**另记一条证据口径**：`screenshotFailures:[]` 只说明图取到了，不说明图拍对了——R58 复看时发现规则页的 step41/43/44 截图只拍到页首，已给这几步补 `scrollIntoView` 再重跑（v135）；R78 的 step55 同理，最后一步是"取消"会让面板回到空态，于是截图前把 UTF-8 报告再放回来（空态截图证明不了报告显示过任何一份报告）。**两条"取证要取在被断言那段"的新例子**：step47（R63）在展开动画**中途 60ms 采样**高度（0 → 35/52 → 236 = 内容高），断言的是"存在中间态且终值等于内容高"而不是某个中间常量；step49（R66）在页面里**现场按真实章序造数据**再验看板（逾期外显、红鲱鱼+放弃带理由不被报缺陷、paid 无回收章报矛盾、面板内没有写回按钮）；step48（R64）读**真实 computed style**（`line-break` / `text-autospace` / `text-spacing-trim` / `font-variant-numeric` / 版心 px）与 `CSS.supports()` 三个布尔——把"这台机器的运行时支不支持"变成问出来的事实，不是查表猜的。**R71 再添两条同类账，都属"证据看着有、其实不成立"**：① step33 `waitFor('.assembly-preview')` 等的节点在上一步跑完后**已经在 DOM 里**（step31 末尾故意用小预算再跑一次），于是它立刻返回、读到旧回执，而按钮还在合法禁用态——此前绿是撞运气（IPC 快过 150ms 睡眠）；凡"点按钮 → 等结果节点"先问"这节点是不是已经在"，判据要带上**本步特有的内容**（本步的预算数字、按钮转绿）。② M4 验收 A5 的 e2e 探针比的是 `edges:0 / timelineRows:0` 的两个空视图 ⇒ 空对空当然"逐字不变"，已补夹具与 `edges > 0`、`timelineRows >= 3` 两条非空性断言并分别变异打红。**还有一条截图纪律**：新步骤若只量不改画面，`captureStep` 的滞后帧守卫会标"证据存疑"（v160/v161 的 step53 就是这样），要么把目标区域滚进视口、要么别指望那张图算证据。**夹具别靠调用次序给数据**（R78 step55）：桩按"第 1/2/3 次点击"返回不同文件时，失败重试的第二次 attempt 会继承上一次的进度，把抖动与真回归搅在一起；改成由渲染层全局变量指名要哪一份。 |
| 对外文档 | R81 起四份社区健康文件**齐备**：`README` / `CONTRIBUTING` / `SECURITY`（含支持版本范围与确认 7 天、高危修复 30 天时限）/ `CODE_OF_CONDUCT`（四级处置阶梯，自写执行版本而非复制 Covenant 全文）/ `GOVERNANCE`（四级梯队 + 独立 moderation + 「核心离线能力永久免费」边界承诺，第一句就写明当前是单人维护）/ `CODEOWNERS`（按领域拆）/ `NOTICE` / `ROADMAP` / `CHANGELOG`，`.github/` 三份 issue 模板（含 `pack_submission`）与 PR 模板都带行为准则勾选项。docs/04 §11.6「健康文件齐备」门槛**已勾**（锁：`governance-docs.test.ts` 21 例，含一条「账本已动过的里程碑不许写未开始」的反漂移断言）。R82 起 **295 个既有源文件逐文件 SPDX 头已落**（扫描范围实测 297 个文件，`/* SPDX-License-Identifier: Apache-2.0 */`，shebang 入口落第二行），§11.6「LICENSE + NOTICE + SPDX」门槛**已勾**（锁：`spdx-headers.test.ts` 4 例，含扫描范围下限与 shebang 例外名单）。**仍缺任何 CI 配置**，§11.6 据此保持其余未勾 |
| 性能实测 | 10/10 达标（最近一次 **R83** 报告 `docs/assets/perf/perf-report-local-dev-20261014-r83-perf-gate.json`：热盘 cold 1445ms / 首屏脚本执行 136ms / FCP 200ms / 空闲 442MB）。**R83 起 `--perf-probe` 的退出码就是门禁**：绝对预算未达标 ⇒ 1（此前恒 0，❌ 打出来调用方仍看到"跑通了"）；相对基线回退只报告不翻红（同机两遍 `cold` 实测 3160 vs 1434ms，个位数毫秒的 ±20% 是噪声）。**"包体 1.5 MB 要不要按标签页拆"已裁决为不拆**，依据与占比见 docs/04 T2-10 第 83 轮注记 |
| 版本 | `v0.2.0` tag **已在远端**（本文上一版记为"远端未推"，已过期更正） |

---

## 2. 仓库结构与命令速查

```
novel/
├─ packages/@yushu/
│  ├─ core        核心类型（EntityBase/LayerKey）、ID、frontmatter 序列化、countWords
│  ├─ schema      JSON Schema 注册表（ajv）：world / 设定卡 / 三级大纲 / 章节
│  ├─ world-engine 布局常量（world/outline/chapters/memory 路径）、设定卡、三级大纲、
│  │              collectIndexInput / diffIndexSources（索引数据源）、expert: extract.ts（T3-10 抽取契约）
│  ├─ genre-engine 派系包：loadPack / lintPack / fuse（融合预演）
│  ├─ export      TXT 导出 + 敏感词自查 + 干净剪贴板
│  ├─ search      SQLite 索引（node:sqlite）：FTS5 external content + chunk_vectors + RAG
│  │              （vector.ts：VectorStore/嵌入；rag.ts：bm25 + RRF + 重排）
│  ├─ llm         Provider 能力矩阵 v2 + 协议适配（openai_chat/anthropic/gemini）+
│  │              路由/可靠性（routing.ts/reliability.ts）+ 降级（downgrade.ts）+
│  │              结构化输出（structured.ts）+ 半价通道（batch.ts）+ chat/stream
│  ├─ memory      五层记忆：records/provenance/mentions/injection/assemble/snapshot
└─ text        中文处理（T3-13，J14）：punctuation（GB/T 15834）/ typo（内置别字表）/
               conversion（繁简，歧义不硬猜）/ repetition（n-gram）/ sentence（长句·的地得）/
               proofread（汇总 + 修复安全闸门 applyFixes）
├─ apps/desktop/  Electron 桌面端
│  ├─ src/main/   主进程：ipc.ts（通道注册）、file-gateway.ts（路径防护+原子写）、
│  │              ai-ops.ts（生成/配置/路由）、ai-feedback.ts、memory-ops.ts、extract-ops.ts、
│  │              index-ops.ts、prompt-ops.ts、doc-readers.ts（共享只读读取器）、
│  │              stats-ops / snapshot-ops / recovery-* / git-ops / session-ops / project-ops …
│  │              main.ts（入口 + e2e 全链路探针脚本）、walkthrough.ts（UI 预演 + mock LLM）
│  ├─ preload/preload.cjs   白名单 IPC 桥（新通道必须同步这里！）
│  ├─ renderer/src/         api.ts（类型化 API，新通道必须同步！）、views/*（页面）、
│  │              typewriter-buffer.ts / candidate-diff.ts（T3-11 纯逻辑）
│  └─ test/                 桌面端单测（含 renderer 纯逻辑模块的单测）
├─ apps/cli/      无头命令：node apps/cli/dist/cli.js rebuild|status|search <项目目录>
├─ docs/
│  ├─ 00-交接文档（M1 时给 Trae 的；本文是新的 M3 交接）
│  ├─ 01-需求总纲 / 02-竞品分析 / 03-开发规划方案（技术选型权威） / 04-开发计划（任务清单权威）
│  ├─ 05-流派总表 / 06-验收与自查清单（§八 逐轮记录 + §五 可复现命令） / 07-真人试跑材料包
│  ├─ research/   A–K 调研文档（禁止删改；J03/J04/J06/J08/J15 是 M3 的设计依据）
│  └─ assets/     m1-preview/（预演截图 + walkthrough-report.json）、perf/（性能报告）
├─ perf-budget.yaml   性能预算（唯一事实源；实测段随轮次追加）
└─ CHANGELOG.md       M3 增量逐条记录（每轮新增一条）
```

命令速查（全部在仓库根执行）：

```bash
pnpm install                         # 若 lockfile 需变更：先 --lockfile-only（本环境 frozen-lockfile）
pnpm test                            # 全量单测（提交前必须全绿）
pnpm typecheck                       # 全仓构建 + 类型检查（含 renderer；提交前必须全绿）
pnpm --filter @yushu/desktop e2e     # 端到端（mock LLM，离线）
pnpm --filter @yushu/desktop exec electron . "--ui-walkthrough=D:\Temp\yushu-walkthrough-vNN"  # UI 预演（必须全新空目录，编号递增）
pnpm --filter @yushu/desktop perf-test            # 性能实测（synth-1m；只在触及索引/启动/输入路径时跑）
pnpm --filter @yushu/desktop kill-test            # 强杀恢复实测（只在触及保存/恢复路径时跑）
```

---

## 3. 已完成内容总览

### 3.1 阶段总览

- **M1 世界基座**：monorepo 骨架、派系包（load/lint/fuse）、新建项目向导（四维多选）、起源工作台 9 步问卷、三级大纲（总纲→卷纲→章纲）、设定卡 Markdown+frontmatter 真源、AI 最小接入（chat/stream + AbortController）、TXT 导出 + 敏感词自查、`@yushu/search` 首版（FTS5 + CJK unigram 方案）、命名生成器、UI 预演框架。验收 A0（三画像自动化试跑）通过。
- **M2 编辑器与索引（v0.2.0）**：双形态编辑器（CodeMirror 6 / TipTap）、`@` 提及（两形态 + 候选菜单）、保存管线（800ms 防抖自动保存 / 失焦与切页 flush / 关闭前 flush / 三方自动合并 / 冲突旁路文件）、崩溃恢复（编辑日志 + 恢复面板 + 真强杀实测）、本地快照（内容寻址 + 环形保留 20 + 整体回滚 + pre_destructive）、码字统计（净增/有效字数/速度曲线/写作日历/会话与真实速度）、Git 版本管理（isomorphic-git：init/commit/rollback，惰性加载）、索引（分片重建 + 进度流 + 增量 + 自愈 + racy 防护 + utilityProcess 解析下沉）、性能预算（perf-budget.yaml + synth-1m + 回归对比工具）、稿件总览（虚拟滚动）、大章节流。M2 验收 A1–A5 机器验证全绿。
- **M3 AI Provider 与上下文记忆（R30–R39，本次交接的主体）**：

### 3.2 逐轮明细（M3 与 M4 起步；每轮 = 引擎 → 桌面端 → docs+证据）

| 轮 | 任务 | 交付要点（一句话版；细节见 docs/04 注记 + docs/06 §八） |
|---|---|---|
| R30 | T3-1 Provider 抽象与能力矩阵 | `config/llm.yaml` v2（kind/protocol/models[].tier·capabilities·limits）；v1→v2 幂等迁移 + 保存前自动备份 `.bak-v1`；Anthropic Messages / Gemini generateContent 协议适配器；`lintLlmConfig` 体检 |
| R31 | T3-2 任务路由与可靠性 | `config/routing.yaml`（routes/fallback/reliability）；`resolveRoute`/`orderProvidersByRoute`；错误分类重试（退避+抖动）、冷却熔断、FIFO 并发闸门；chat/stream 接入 `reliability`；e2e 实测 429→重试 |
| R32 | T3-3 + T3-4 自动降级 + 本地模型 | `planDowngrade`（structured_output→提示词约束+JSON 后校验；stream→一次性返回；tools→无路径）；`extractJson`；`LOCAL_PROVIDER_PRESETS`（Ollama/LM Studio/llama.cpp/vLLM）+ 可管理 Provider 列表 + 本地隐私提示 |
| R33 | T3-5 五层记忆 | `@yushu/memory`：摘要/事实记录（Markdown+frontmatter，`memory/` 真源）；`summary_rev>0` AI 不得覆盖（E_MEMORY_REV_PROTECTED 红线）；事实出处链（chapter_id+区间+sha256，ok/broken/none）；`lintMemory`（跨项目泄漏=error 红线）；提及追踪；「记忆」页 |
| R34 | T3-6 注入控制 | `injection.ts`：mode/priority/position/budget_tokens/reveal_gate；`planInjection`（决策+排除清单+命中键）；`estimateTokens/truncateToTokens`；事实/卡片注入配置持久化；注入预演面板 |
| R35 | T3-7 上下文组装 | `assemble.ts`：8 固定槽位顺序 + 缺省 caps；priority_then_recent；by_id/by_similarity 去重；槽位 cap 截断→丢弃；全局逐出序 + system_prompt 只截断；完整决策证据；组装预演面板 |
| R36 | T3-8 RAG 混合检索 | `vector.ts`（VectorStore 抽象：sqlite-vec 探测 + 本地确定性嵌入 256 维 + 余弦兜底）；`rag.ts`（bm25 关键词路 + RRF k=60 加权 + 本地启发式重排 top-6 + 出处）；索引 schema v2（chunk_vectors 与正文块同事务、旧库惰性补齐）；`ragSearchIndex`；组装接入 rag_chunks 槽位；RAG 检索预演面板 |
| R37 | T3-9 上下文预览器 | 组装条目补 matched_keys；`snapshot.ts`（`yushu.context-snapshot/v1` + fingerprint=sha256(决策内容，除 generated_at)——同输入两次一致）；`memory:contextSnapshot`（写 `.yushu/context-log/`）；预览器五列表 + 导出按钮；**docs/04 §6.5 A1 标记达成** |
| R38 | T3-10 结构化输出与设定抽取 | `structured.ts`（schema 契约注入 + extractJson + 后校验 + 错误回喂修复 ≤2 + 如实失败）；`world-engine/extract.ts`（`EXTRACT_OUTPUT_SCHEMA`（quote 必填）、三分类 new/augment/conflict、candidate_id/status 服务端强制、卡草案+出处凭据）；`extract` 路由（T3-3 挂点落地）；记忆页「设定抽取」面板（仅 new 可采纳；服务端复核拒 augment/conflict） |
| R39 | T3-11 写作 UX | `typewriter-buffer.ts`（token 缓冲 + rAF 每帧 flush；匀速/瞬时两档）；`candidate-diff.ts`（中文句级切分/diff/局部采纳合并）；AI 副驾多候选生成（2-3 串行 + 独立标记）+ 候选卡片（句级差异/替换/追加/按句勾选局部采纳）+ 拒绝原因记录（`.yushu/ai-feedback.jsonl` + 统计）；`batch.ts` 半价通道规划（batch_eligible + planChannel）+ 通道展示 + usage 记 channel |
| R40 | T3-12 Token 与成本 | `cost.ts`（每 1M tokens 单价、实报+估算双口径、未配置价格返回 null、按任务/模型/合计聚合、多币种不强行合计、偏差中位数、`accumulateUsage` 跨轮累加）；`cache.ts`（`checkCacheOrchestration`：稳定前缀置头 / 断点下标 / 击穿点名 / 门槛 / 节省投影仅在已声明读价时给出）；三协议 usage 缓存字段归一（子集扣出 vs 互斥直映）；`structured.ts` 逐轮累加 usage；`llm.yaml` 模型 `pricing` + **修复 saveConfig 全量替换抹掉手写价格的隐患**；ai-usage 记 `tokens`+`estimate`；`cost-ops.ts` + `ai:cost`；AI 副驾成本面板；偏差 >50% 告警。单测 483/483、预演 36/36（v84）。**另修掉一处 M2 遗留**：富文本 `@` 菜单重开时继承上次高亮（会预选第 3 项、回车插错卡）→ 抽 `nextMentionActive` 只在同一次 `@` 会话内继承 |

| R41 | 验收复核（无功能改动） | A5（跨项目泄漏探针原文）与 A6（小预算逐出证据）补机器证据后在 docs/04 §6.5 勾选；`.gitignore` 增 `.qoder-credits/`（工具产物**不删只忽略**） |
| R42 | T3-14 安全（引擎 + 主进程侧） | `@yushu/llm/secrets.ts`（`detectPlaintextSecrets` 落地 K12 `key-plaintext-detected`、`maskSecret` 去标识化、`SecretsStore` 信封按键名排序）；**修掉旧的静默行为**（`parseLlmConfig` 过去对未知 `api_key` 字段"读已知丢其余"＝明文静静留在盘上）→ 含明文一律 `E_LLM_CONFIG` 拒绝且信息不含密钥本体；取值顺序 **会话 > 凭据库 > 环境变量**；主进程 `secrets-ops.ts`（`.yushu/secrets.json`、tmp+rename、**后端不可用即拒存不降级**、**损坏不覆写**）；`secrets-ops`/`ai-ops` 不 import electron（后端经 `installKeyCipher` 注入）以便无 Electron 单测。单测 +20（503/503，61 文件） |
| R43 | T3-14 安全（桌面端 UI + 取证收口） | IPC 四处同步 `ai:saveKey` / `ai:clearKey`（`apiKey` 单向入参，返回值只含 `key_ref` 与三态布尔）；`ai-ops` 的 `saveProviderKey`（密文入库 → 真源只补 `key_ref`，走 `readAiConfig→patchProvider→saveAiConfig` 保住定价往返与 baseHash；保存前失效旧会话 Key；空串拒存）与 `clearProviderKey`（先删密文再改真源，避免悬空 `key_ref`）；AI 副驾三态徽标 + `type=password`/`autocomplete=new-password` + 后端不可用即**禁用**保存；e2e「密钥安全」探针 + 预演 step37（**37/37**，v92）。**补两处自查缺口**：第 42 轮没测 `ai-ops` 接线（新增 `ai-key-ops.test.ts` 9 例）、step37 原先只断"有回执"漏了"显示没跟上"（补两处翻态断言）；六次定向变异做红/绿配对（颠倒保存次序 → 3 红）。**另修两个工装缺陷**：预演截图写入遇 Windows 短暂占用即崩且窗口常开（→ 重试 3 轮 + `screenshotFailures` 计入退出码 + 入口 `.catch` 即 `app.exit(1)`）、`gitInit` 不写 `.gitignore` 导致遍历仍 stat `.yushu/` 里易失的 SQLite 侧车（`ENOENT ... lstat '.yushu/index.db-shm'` 打断过一次 e2e）→ 现幂等补齐项目根 `.gitignore`，**"凭据与派生物不入 Git" 由「御书自己过滤」升级为「仓库本身就不收」**（`git check-ignore` 外部对照）。单测 517/517（62 文件） |

| R44 | T3-13 中文处理（引擎侧） | 新建 `@yushu/text`（离线 / 零外部词典 / 确定性）：`proofread-punctuation-gb`（GB/T 15834，语境判据用「相邻是否汉字」而非解析 Markdown）、`proofread-typo`（39 条「错法本身不是合法词」的别字，故意排除 5 类会撞合法写法的错法并在源码注明）、`proofread-conversion-ambiguous`（**歧义字原样保留、只登记候选**，绝不写猜出来的繁体）、`proofread-repetition-high`（4..8 多长度 gram + 对白跳过；单一 n=5 会整段漏报）、`proofread-long-sentence` / `proofread-demiscue`（info 级轻提示，状语判据收窄为「副词+的+动词」以免误伤定语）；**修复闸门 `applyFixes`：未确认即 error 且文本一字不动、span 失效即拒、autofix=false 须显式选候选、重叠只留先到**。单测 +74 → 591/591（68 文件），typecheck 11 包全绿，四次定向变异红/绿配对（去掉 confirmed→2 红、去掉语境判据→3 红、让繁简猜候选→1 红、去掉动词要求→1 红）。桌面端接入归 R45 |

| R45 | T3-13 中文处理（桌面端 + 取证收口） | IPC 四处同步 `text:proofread` / `text:fixBody`（**都是只读**，用 `wrap` 不用 `wrapWrite`）；`text-ops.ts` 读章节正文跑 `proofreadText`；编辑器新增「中文自查」面板（未勾选确认时所有采纳按钮禁用 / 采纳全部可自动修 + 逐条采纳 / 繁简歧义须从候选下拉选定 / evidence 与 skippedRules 原样展示）。**不开第二条写通道**：`fixBody` 只回「改后正文 + 改前正文」，渲染层比对内容仍一致才替换文档，落盘继续由 `chapter:write`（baseHash + 编辑日志 + 字数增量 + 索引刷新）负责；采纳请求只带 `{start, rule}`，改法由主进程重新检测的条目决定，`replacement` 必须属于该条目候选（引擎为此加 `candidates` 字段）。**修掉三处缺陷**：采纳回执被紧随的重扫冲掉（拆两行）、预演 `waitFor` 未 await 异步谓词（Promise 恒真 → 读盘类断言会假绿）、step38 候选回执读到上一轮旧文本（改为等回执变化并断言「已采纳 1 处」）。**另根治 e2e 竞态**：`.gitignore` 之后仍偶发 `ENOENT ... lstat .yushu/index.db-shm` → 新增 `isTransientScanError` + `withTransientRetry`（只认 ENOENT+lstat/stat/readdir，业务错误码立即上抛，耗尽给 `E_GIT_SCAN`）。单测 +15 → 607/607（69 文件）、预演 **38/38**（v103）、e2e 中文自查探针 `blocked:3 / applied:3 / diskUnchanged:true / spansOk:true / candidateGuard:rejected…`；变异「直接落盘 + 无视 confirmed」→ 3 红 |

| R46 | A2 任务路由取证（无产品改动） | e2e 新建**两个独立 mock 端点**（旗舰全程 503 / 小模型正常）+ 专用 routing.yaml（`drafting.prefer=[flagship]`、`fallback.drafting=[flagship-bad, small-good]`、`InternalServerError.max_retries=2`、`cooldown.allowed_fails=1`）。实测 `{badHits:3, badFailures:3, goodHits:3, goodFailures:0}`、原因「HTTP 503」→「冷却中（剩余 60s）」、`recordsDelta:3 / promptTokensDelta:30 (=12+12+6) / summarizeOk:true`，A2 四口径逐条对上并勾选。**两次期望落空把机制校正**：一次动作只向闸门记 1 次失败（`allowed_fails:2` 不触发冷却）；cloud provider 无 Key 会**在发请求前跳过**（必须补会话 Key 才是真正的失败回落）。命名任务不经 LLM，故以摘要任务作「走小模型」等价证据；真实端点配额/限流不在口径内 | 

| R47 | A4 取证 + AI 总开关进程化 | 发现「关闭 AI」原先只是渲染层按钮禁用，三个联网入口（ai:start / memory:summarize / extract:preview）无闸门 → 新增主进程开关（默认 false、`E_AI_DISABLED`、三入口前置断言、fire-and-forget 处双拦）+ `ai:setEnabled` 四处同步 + `AiConfigState.aiEnabled` 供 UI 派生。取证：`ai-gate.test.ts` 7 例（含「关闭态不产生使用记录」「非 true 值不当开启」）、e2e A4 探针 `{blockedAll:true, localFailed:[], localCount:11}` 且端点计数仍为 3/3（零请求）、预演 step39（39/39，v105）；变异「assertAiEnabled 永不误抛」→ 4 红。`ai.test.ts` 两用例被拦是测试未跟上契约，改为显式开启而非放宽闸门。口径：trial 外网审计仅覆盖 renderer 会话，不冒充全进程零外网 | 

| R48 | 成本章节维度贯通 + 预算护栏与成本体检引擎 | 补第 40 轮自己写下的 J09 遗留：① `CostEntry` 加 `chapter_id`/`time`、`summarizeCosts.byChapter`（**未标注章节归入「（未标注章节）」一行，不静默丢条目**）→ `AiCostPanelPayload.byChapter` → 面板复用 `CostBreakdownTable`；写侧核实 `chapter_id` 自 R40 起就在 `.yushu/ai-usage.jsonl` 里，本轮补的是**读侧贯通**（别把"读到"写成"写到"）。② 新增 `llm/budget.ts`：`config/budget.yaml` 严格解析（`apiVersion` 必填 + **未知键一律拒绝**——拼错的键被静默忽略会让护栏以为"未配置"）、确定性序列化、缺省不设月度上限。③ `lintCost` 四条规则：`cost-usage-missing`（warn，**adopt 不发请求整类排除**）、`budget-context-overflow`（error，`inputTokens > context − max_output`）、`budget-monthly-cap`（warn/error，缺省 0.8）、`cost-per-chapter-anomaly`（warn，> 均值 3×；**样本 < 3 章整条沉默**——两章时高的那章必然超倍数，属误报源）；未定价与跨币种不参与异常判定；`chapterCostsOf` 引擎与面板共用。**只报不改**（降级/拦截属策略变更，需用户在场）；错误用 `YushuError` + `E_LLM_BUDGET`（不引 `LlmError`，shared 侧循环导入）。自查抓到面板章节表**漏表头 + 缩进错位**、`spec.capabilities` 可选需可选链。单测 +13 → **627/627（71 文件）**，typecheck 11 包全 Done，e2e ✅，预演 **39/39**（改动前 v106；补表头后按 §6.3 重跑 **v107** 仍 39/39、证据缺失=0）。**遗留**：预算与体检并入面板 notes 的接线未做（`spentThisMonth` 按 `time` 归月、`assembly` 取组装实测）；`per_call_confirm_over` 只有字段与解析、**尚无拦截点** |

| R49 | 预算护栏与成本体检接入面板（T3-12 收口） | 补第 48 轮留下的断头路（引擎有规则、面板看不到结果）：主进程按 `CostEntry.time` 归自然月算 `spentThisMonth`（**实报优先、缺实报用本地估算补**，两口径 `bySource` 分列）、章节金额复用 `chapterCostsOf`、组装实测 token **与编排核对共用同一次 context preview**（两处各读一次盘会取到不同正文，同一面板自相矛盾）。`config/budget.yaml` 落地为**可选文件**（world-engine 加 `BUDGET_CONFIG_PATH`），**解析失败不静默回落成"没配置"**：错误原文外显 + 追加 error 级 `budget-config-invalid` 排在最前。**缺输入的规则整条列入 `skipped` 并逐条点名**（未配上限 / 未选章纲 / 模型未声明 `limits.context` / 可折算章节 <3 / 无 provider 声明 usage）——延续 R45 `skippedRules` 那条线：**不把"没跑"显示成"没问题"**。面板新增「预算护栏与成本体检」区（本月已用含"N 条未定价不计金额"、生效上限与阈值、findings 着色、skipped 说明）。**自己埋的坑自己抓到**：`resolvePricing` 原把 `fallbackEntries` 计数塞在查价闭包里，三处聚合共用后同一条记录被计 2 次（单测当场红）→ 查价改无副作用、计数单独走一遍，token 判据抽成 `hasUsageTokens` 两侧共用。单测 +12 → **639/639（71 文件）**，typecheck 11 包全 Done，e2e ✅（探针新增 `budgetInvalidCode:"budget-config-invalid" / capSeverity:"error" / capSpent:"¥0.0003" / capMonthKey:"2026-10" / noTargetSkipsOverflow:true`，坏 yaml 读完复原不污染后续探针），预演 step36 扩断言 **39/39**（v108；删「未跑：」前缀 → v109 step36 FAIL 退出码 1；复原 → v110 终版）。变异 7 次全能红（引擎 3 + 接线 3 + 预演断言 1）。**未勾 A3 的唯一原因仍是偏差数值需真实 provider，与分解维度无关**（四维已齐，已更正 docs/04 §6.5）。`per_call_confirm_over` **仍无拦截点** |

| R50 | M4/T4-1 规则 DSL 求值沙箱（引擎侧） | 新建 `@yushu/genre-engine/src/rule-dsl.ts`（放这包是因 docs/04 §7.4 指定它承载「规则 DSL 求值沙箱」），形状原样承接 docs/03 §8.2 + G06 草案（`id/severity/scope/when/message/priority`，severity 仍 `error\|warn\|info`）。**四道闸门**：操作符白名单（未知操作符抛 `E_RULE_OPERATOR` **不静默当假**；`reduce/map/filter/merge/some/every/cat/regex/fetch/fs/env/now/date` 逐个点名拒绝理由）、禁循环（无迭代原语，唯一遍历是 `in` 且候选长度计入预算）、**深度 16 在加载期就拒**（求值期再设同闸兜住手造规则）、**求值预算用节点计数不用墙钟**（`Date.now()` 超时破坏确定性——本轮最重要口径）。取数：`var` 点分路径纯读、拒 `__proto__/constructor/prototype` 与函数（永不调用），`readPath` 导出供 T4-2 复用；比较：只接受有限数字（**不比中文字典序**）、等值严格、除零报错；结论：`evidence` 只登记真正读到的 var（短路分支不进），`{a.chapter}` 取不到留「（缺 路径）」不整条失败。**自抓两处实现错**：`*` 与 `+` 共用 reduce 初值 0 致乘法恒 0；`in` 候选侧把字面量清单当表达式拒绝（最常见写法被自家沙箱拦在门外）→ 改「数组=字面量、对象=求值」。单测 +34 → **673/673（72 文件）**，typecheck 11 包全 Done；**6 次变异全能红**（白名单→3 红、双节点预算→1 红、加载期深度→1 红、求值期深度→1 红、原型链→1 红、隐式转换→1 红）。**随后被真实包数据打脸一次（重要教训）**：`packs/xuanhuan-xitong/rules/` 里本来就有两份规则件、`loadPack` 也早已解析它们，而我的解析器只认自己测试里假想的裸 `rules:` 形状——真件是 `apiVersion + id + title + source + rules:` **信封**，且六条里有两条 `when` 一个对象塞两个键。改：双形状解析、**裸列表必须有版本**、信封 `title/source` 逐条盖到 `origin` **不静默丢弃**（读了字段不带出去＝抹掉可追溯性，与 R40「saveConfig 抹 pricing」同类）、包内两条规则改写 `and + ==`；新增 `pack-rules.test.ts`（5 例，直接读真件）长期钉住 → **678/678（73 文件）**，变异增至 **8 次**（+静默丢 origin→1 红、+信封未知键放行→1 红）。**纯引擎轮：未碰桌面端，故不跑 e2e / 预演，也不声称跑过**。版本合并与 priority 排序**未实现**（等多包真规则再说，不凭空发明）。 |

| R51 | 规则 DSL 桌面端接入（T4-1 收口） | 补第 50 轮缺的**内容层**：`genre-engine/rules.ts` 的 `loadPackRuleSets` 真读包内 `rules/*.yaml` 交给 `parseRuleDocument`，每件带 `{file,packId,rules,error,expressionIssues}`。与 `loadPackTaboos` 的"失败静默跳过"**刻意相反**——悄悄消失的规则让作者看到"没发现问题"，真相却是"这条没跑"，**沉默的校验器比没有校验器更坏**。`rule-dsl.ts` 补静态侧 `collectExpressionIssues`（不求值就指出"一个对象两个键，请用 and/or""未知操作符 regex：禁正则"）；`lintPack` 新增 `rule-unparsable` / `rule-expression` / `rule-duplicate-id`（同包撞 id 拒绝按加载顺序取后者）。IPC 两个**只读**通道 `rule:catalog` / `rule:dryRun`（`wrap` 不用 `wrapWrite`；试算只吃夹具、不读正文不写盘）+ 第 11 个标签页「规则」（目录汇总 / 逐件表格 / 沙箱试算 / 依据表），空目录明写「不等于这些包没有规则」，试算**命中·未命中·被沙箱拒绝**三态分开并给原始 `E_RULE_*`。**第二次被真实数据纠正**：包内规则件是 `apiVersion+id+title+source+rules` **信封**，R50 只认假想的裸 `rules:` → 补齐并把 `title/source` 逐条盖到 `origin`（读了字段不带出去＝抹掉可追溯性，同 R40 saveConfig 抹 pricing）。单测 +24 → **702/702（75 文件）**，typecheck 11 包全 Done，e2e ✅（`total:6 / hit:true / evidenceCount:4 / missMatched:false / rejectCode:"[E_RULE_UNORDERABLE]…" / diskUnchanged:true`），预演新增 **step40** → **40/40**（终版 v114 45.1s）。**step40 两次真实红跑**：v111（我的选择器 `.rules-table tbody td.error` 写宽了，严重度单元格也带 error 类）＝预演抓到**我自己的断言**而非产品缺陷；v113（故意把命中行类名换成未命中行）证明回执断言能红。`scene` → 步骤 10-40。**未实现**：同 id 版本合并、`priority` 参与排序、规则编辑 UI（派系包是外部制品） |

| R52 | M4/T4-2 结构完整性三条规则（引擎侧） | 新建 `world-engine/consistency.ts`：`checkStructure({entities,refs})` 纯数据结构 + `checkStructureFromSources(reader)` 文件直算，**不 import search、不读 SQLite**（索引可删，删库后结论必须一字不变＝§7.5 A5 口径）。`ref-dangling`（error，**只按 id 精确匹配**，孤儿引用也算结构破坏）、`ref-cycle`（error，码点排序 + 路径旋转到环内最小 id；**深度上限 64 并计 `cycleDepthCapped`，不假装没环**；同一强连通分量只报先发现的环，不枚举全部初等环）、`layer-order-violation`（error，上游层引用下游层；层未知不判定、同层不算）。**两处权威文件互相矛盾，做显式裁决并写进注释**：严重度 docs/03:381=error vs K05:122=warn → 取 docs/03；倒置方向取 K05 的具体例子（地理引用人物）。「没跑」与「没问题」分开：`ch-`/`co-`/`vol-` 目标逐条登记 `outOfScope`；`enabledLayers` 落实"未启用层不参与校验"；world.yaml 不合式按全启用并写 `worldNote`（测试里 `expect(worldNote).toBeNull()` 防止解析静默失败造成假绿）。**变异 6 次，其中一次杀掉自己的死代码**：`seen` 环去重集合关掉后 27 例全绿 → 无测试能杀它 → 按"没有失败测试就没有代码"删除（其余五次分别 1/1/1/4/2 红）。TDD 三轮红绿，+27 例 → **729/729（76 文件）**，typecheck 11 包全 Done；**纯引擎轮未跑 e2e / 预演，也不声称跑过**。**T4-2 保持未勾选**：八类语义规则需事实/声线卡比对；`chapter.outline_ref` 与 `source_chapters` 的存在性校验（章节↔大纲双向对账）也未做 |

| R53 | M4/T4-3 一致性报告格式 + 必须记理由的豁免清单（引擎侧） | `consistency-report.ts`：`locateCardRefSpans` 用 YAML AST 的 `range` 给出卡内 refs 的 **UTF-16 区间**（与 T3-13 同口径，同一个面板不能有两套下标）；报告条目 `{rule,severity,subject,related?,path?,evidence,span,fix}` **与校对 finding 同形**；找不到原文 `span:null` 不造 0-0 假区间；`fix` 给可执行方向 + 统一豁免出口（倒置类要点名两端层名 → 给 `StructureFinding` 补 `fromLayer/toLayer`，由测试倒逼而非预留）。豁免 `config/consistency.yaml` 落实 A6：**无 reason 拒载、subject 必填（省略＝整条规则关掉）、rule 必须是已实现 id、未知键拒绝（不支持 until/通配，免得给"会自己失效"的假安全感）**；匹配键用 规则+主体+目标不用行号；被豁免条目进 `suppressed` 带理由与决策时间；**用不上的豁免进 `unusedAllow`**。**两个坑由测试逼出**：`item.get("relation")` 对标量返回解好值的 JS 数据（要 `get(key,true)` 才有节点与 range）；带正文的卡必报「multiple documents」，按 errors 非空一律退回无区间＝每张正常卡都失去跳转。**TDD 两轮红绿 + 18 例 → 747/747（77 文件）**，typecheck 11 包全 Done；变异 4 次能红（忽略 related→1、区间塌一点→4、不要求 reason→1、不报 unusedAllow→2），**1 次未杀到**（`!range` 兜底不可达）如实记录不声称测过。纯引擎轮未跑 e2e / 预演。**报告落点仍未决**：docs/04 §7.4 写 `reports/consistency-*.yaml` 与"派生物不入真源"冲突 → 建议落 `.yushu/consistency/`，R54 一并裁决 |

| R54 | M4/T4-4 一致性体检三态 + 规则页面板 | `consistency-ops.ts` + 只读通道 `consistency:check`（四处同步）。三态语义各不同：`manual` 永远重算；`post-save` 由 **`wrapWrite` 置脏**（与索引刷新同一漏斗，一处覆盖所有真源写入）、下次读取才重算，命中缓存显示「复用缓存」；`post-generate` 按 `entityIds` 过滤且范围外计数进 `filteredOut`。缓存记项目根，换项目即作废。面板（第 11 页「规则」）新增体检段：汇总（结论/豁免/未纳入范围/深度封顶）· 结论表（级别·依据·建议修法·**原文跳转**）· 豁免带理由与决策时间（A6 审计）· `unusedAllow` 提示已失效；清单读不了 → `allowError` 外显且**本次不应用任何豁免**。**预演逼出两个真问题、改产品不改断言**：① 切标签页重挂载 RulesView → 体检结果丢失 → 挂载时自动取缓存；② 探针与预演项目里没有任何悬空引用、结论恒 0，"每条发现可跳原文"是空跑 → e2e 临时给既有卡加坏引用再按原 payload 复原（并断言复原后归零），step41 真的造卡真的点跳转。**桌面单测 +8 → 755/755（78 文件）**，typecheck 11 包全 Done，e2e ✅（`spans:1 / entries:1 / spanSlicesOk / restoredOk / entriesAfterRestore:0 / diskUnchanged`），预演 **step41 → 41/41**（v118 45.8s，scene 已同步 10-41）；变异 5 次各杀 1 红。**T4-4 未勾选**：`post-generate` 未接在 AI 采纳后的调用点、"重规则 + AI 采样"未实现、报告不落盘（`reports/` 与派生物红线冲突，留 T4-5 裁决） |

| R55 | 批次收口：e2e 具名断言 + 预演有界重试 + T4-11 回归集 + **R46–R55 十轮总复核** | **① e2e 断言具名化**（307 项大布尔链 → `Array<[表达式原文, 值]>`，脚本逐字搬移并校验括号引号均衡；红探针点名两条、退出 1；纯重构证据 = 改前后两次 e2e 归一化时序字段后结果 JSON 逐字一致）。**② 预演有界重试**：`walkthrough-attempts.ts` 纯函数 + 5 例单测，失败步骤最多重试 1 次，重试后通过记 `flakySteps`（退出码仍 0 但必须留痕）、两次均败照旧失败；两条真实探针量出边界——只读型 step40 可被重试救回（`flakySteps:[40]`），**状态变更型 step17 救不回**（快照内容寻址，重点不产生新行）→ 结论：**抖动根因仍未定，重试只是止血**。**③ T4-11 回归集**：干净语料零发现且误报率 0（并断言真的扫到引用数）+ 三条单点故障各只点亮自己 + 覆盖锁 + 两次求值逐字一致；派系包补六条反例（与正例只差一个值）。**T4-11 未勾选**（阈值仍是写死的 0）。**④ 十轮总复核改正四处文档不符**：M3 从来没勾过勾选框（docs/08 却写"14 项已全勾"）→ 按证据补 12 条；T3-14 不补勾并写明"导出剥离待 M5"；T3-13 标题 OpenCC 与实现的内置子集表口径修正；T3-12 行尾残留碎片删除；另补勾 T4-3 与 M4 验收 A2 / A4 / A6（行内挂达成证据）。**验证**：`pnpm test` 773/773（81 文件）、typecheck 11 包/应用全 Done、e2e E2E=0、预演全新目录 **v123 41/41**（47.1s，抖动=0、证据缺失=0）；变异 7 次全能红并 `diff -q` 确认恢复 |
| R56 | M4/T4-4 采纳后即时轻校验接线 + 一致性报告落盘裁决 | **接线选在 `adoptDraft` 返回处**（整段替换 / 追加 / 按句局部采纳三条路径共用一个函数，接一处不漏两处，绕过 UI 直接 invoke 也带回执）。范围由**刚采纳进去的正文**自己算：`resolveScope` 优先用 `entityIds`，否则交给 `mentionedEntityIds`（名称与别名都算提及）——不让调用方声称"我只关心谁"。三条 fail-safe 各钉一条测试：**没给范围不过滤**（清零比全报更像"没问题"）、**范围为空如实为空**（不把全书结论倒进回执，`filteredOut` 照给）、**跑不成不阻断采纳**（正文已落盘，抛错只会诱导重复采纳 → `ran:false`+原因）。副驾在采纳回执下方新增「采纳后即时轻校验」段（沿用 `.consistency-table` 口径），未跑成给红色错误行而不是整段消失。**报告落盘本轮裁决：不落盘**——结论 100% 派生自真源，写进 `reports/` 就是第二真源；该留档的是作者的豁免判断（`config/consistency.yaml` 带 reason 与决策时间，即 A6 审计入口）；docs/04 §7.4 产物行同步改写，不再挂给 T4-5。**具名断言当场见效**：首跑 e2e 报 `result.consistency.diskUnchanged`——探针自己在只读窗口里做了一次真实采纳（写正文）；放在 R54 的单条大布尔链里只能两份 JSON 逐项 diff，这次名字直接打出来，修的是探针取快照的时机，产品没动、断言没放宽。**耗时如实记**：轻校验同步跑完整结构扫描，实测 `auditMs:157`（小项目），已登记 docs/06 §七，卡数上千后的两条退路本轮不做。**验证**：单测 +2（`postAdoptAudit` 等）→ 783/783（81 文件），typecheck 11 包/应用全 Done，e2e ✅（`auditRan:true / auditScopeIds=被污染卡 id / auditHitRule:"ref-dangling" / auditFilteredOut:0 / diskUnchanged:true / restoredOk:true`），预演新增 **step42** → 42/42（v124 47.0s，抖动=0）；变异 6 次全能红（scopeText 不传→6、别名→1、过滤反了→7、catch rethrow→1、回执不带 audit→2、无范围也清零→1）。**T4-4 仍不勾选**：只剩"全书体检（重规则 + AI 采样）"，而语义规则本身属 T4-2 还没落地 |
| R57 | M4/T4-2 第一条语义规则＝派系包规则拿项目数据求值 | **分工裁决**：战力崩没崩的判定只有一套，在包里的 `power-no-regress`；御书不另写等价判定（两套判定各报各的，作者学会的是忽略红色）。御书做的是**数据装配**：设定卡 `extensions.power_log` → `parsePowerLog` 校验并按章号排序 → `pairPowerLog` 拼相邻对 → `evaluateRule`。装配层三条"不猜"各有测试：章号认不出（"序章"）报错不猜顺序、同章号重复报错不静默丢一条、字段类型不对逐条点名。**结论并入同一份报告**（不长第二套结构）：`ConsistencyEntry.rule` 放开为字符串 + 新增 `origin`（谁说的），span 沿用"按 related 找原文"，refs 找不到再找台账那一行，仍找不到给 null。**A6 跟着放开**：`parseConsistencyAllowList(text, knownIds)` = 内置三条 + 本次参与求值的包规则 id（不放开会卡在"结论报得出来、豁免写不进去"）。**没数据绑定的规则逐条点名 `notEvaluated`**（六条里本轮只跑 1 条）+ 台账读不出进 `pack.errors`，面板三行都外显。**预演脚本抓出的系统性坑（不是产品坑）**：step43 首跑红，先用一次性脚本对真实预演目录跑产品路径确认 `entries` 里确有该结论（脚本跑完即删），才定位到**等待条件命中了上一轮就在的汇总行**——修法是等"本轮新结论出现"，并把造卡改成幂等（有界重试时 `E_DOC_CONFLICT` 不该判死）。**验证**：单测 +26 → 807/807（83 文件），typecheck 11 包/应用全 Done，e2e ✅（`packRuleFound:True / packSpanOk:True / packEvaluated:"power-no-regress" / packSkipped:5 / packErrorNames 点名坏台账`），预演新增 **step43** → **43/43**（v127，抖动=0）；变异 7 次全能红（猜章号→3、重复不报→1、台账 span 失效→2、不收 knownIds→1、不并入报告→2、不点名未参与→2、绑定表放宽→9）。**T4-2 仍不勾选**：八类语义规则只做了战力一类；M4 验收 A3（召回/误报阈值）没有真实数据可定，不声称达成 |
| R58 | M4/T4-4 收口：全书体检的重规则 + AI 采样核验 | **确定性采样是前提**：`audit-sample.ts` 的 `sampleForAudit` 按空行切段、丢弃过短段（<12 字符）、**逐章轮转**、**无随机种子**（同输入同输出，"这轮采了哪几段"可复算可交代），每段带 UTF-16 起止下标与引文。**AI 只能指认我们给它的片段**：提示词要求每条结论引用给定 `index`，桌面侧 `ai-audit.ts` 对越界 `index` 与白名单外 `kind`（四类：hallucination / setting-drift / power-jump / name-drift）**逐条丢弃并计 `rejected`**、不整份否决（一个跑偏条目不该带走同批有效结论）——接受模型自己报的位置就是幻觉进真源的入口。**门控**：只有 `manual` + 显式 `aiAudit:true` 才真跑（一次采样=一次真花钱），AI 关闭 / 无 provider / 非法 JSON 一律 `ran:false + reason` 且**结构结论照旧出**。**三段结论并同一张表**（`structure + pack + ai` 进同一个 `buildConsistencyReport`），面板只对 `world/cards/` 给"打开设定卡"那一跳，章节片段写「正文片段（在编辑器里定位）」；四个 `ai-sampled-*` 进豁免白名单。每次采样记一条 usage（`task:"audit"`，估算 + 实报双口径）。**自我纠错一条值得留档**：首版"AI 没挤掉结构结论"写成 `counted.findings === counted.findings`，**永真**；跑"只留 AI findings"的变异时它没红（基线一起归零），改成比较条目里的非 AI 条数 + 绝对下限 `>=1` 后同一变异立刻点名。**预演脚本加了开跑前解析期自检**（`stepBodySyntaxError` 只编译不执行）：本轮 step44 连撞 5 个脚本级 bug，前三个（少 `)`、`/.../\.`、`\s+` 归一化吃掉空格）是纯语法错却要 70 秒才暴露；后两个（`match` 缺捕获组读出 `-1`、`/\bref-dangling/` 在 `"errorref-dangling"` 处无词字符边界所以结构行读成 0）是语义错，自检挡不住，靠把原始值写进 note 定位。**顺带消掉 step21 抖动根因**（`press()` 用了失效的 `.tiptap` 节点，改为每次按键重新查询）。**验证**：单测 +21 → **828/828（85 文件）**，typecheck 11 包/应用全 Done，e2e ✅（`aiRan:true / aiReason:"" / aiSampled:2 / aiRejected:0 / aiRule:"ai-sampled-hallucination" / aiSpanTop:"chapters" / aiNonAiEntries:1 === aiPrevEntries:1`），预演新增 **step44** → **44/44**（**v133 / v134 / v135 三次均一次过、抖动=0**；step44 表内 4 行=结构 2 + 包规则 1 + AI 1。第三次是复看证据图发现规则页那几步只拍到页首，补 `scrollIntoView` 重跑——**截图要能作证那句断言，`screenshotFailures:[]` 不等于拍对了**）；变异 3 次全能红（门控→6、span 置 null→1、合并改替换→9），每次跑完即还原并复验。**T4-4 勾选；M4 的 A3 仍不勾**：阈值要有真实 provider 与真实语料，mock 数字不算达成 |
| R59 | 外部审计 4 条发现的复验与处置（2 修 / 2 定论） | **口径**：4 条都是 2026-10-09 外部审计的指认，本轮逐条自己复看并**先复现再动手**。**① `git:rollback` 用错包装器——成立**：回滚会把 md/yaml 整体落回旧提交（真源改写）却注册在只读 `wrap` 上，同门 `snapshot:restore` 走的是 `wrapWrite`，两条"恢复文件"一条刷索引一条不刷 ⇒ 是漏不是设计；**根因是没人逼新通道表态**（`wrap`/`wrapWrite` 只差五个字母，diff 看不出来），所以除改这一处还新增 `ipc-write-wrappers.test.ts`（28 例：解析注册块，写通道清单每条必须 `wrapWrite`，另附"看着像写其实写派生物"对照表并写明理由——旁路 `.conflict-*.md` 被索引器 CONFLICT_SIDECAR_RE 排除 / 导出物 / `.yushu` 日志 / `.git` 内部）。**顺带查出同类第二条 `ai:saveConfig`**（覆盖 config/llm.yaml 却在 wrap 上，而 `ai:saveKey` 注释自己写着"会连带改真源 → 走 wrapWrite"），一并改。**② `.bak-v1` 明文副本——成立（安全级）**：先写测试复现（v1 带明文 api_key 时 `saveAiConfig` 把原文逐字备份进 Git 跟踪的 `config/llm.yaml.bak-v1`，主文件按 K12 清了副本还在），再修——新增 `redactPlaintextSecrets`（与 `detectPlaintextSecrets` **共用同一个单行判断**，两处各写一份就是"扫得出来但没抹掉"的静默泄漏），命中行改注释并留去标识化指纹（field + len=），备份保住结构回滚价值但不含明文；测试含**夹具自检**（先断言这份夹具真会被判明文）与"**脱敏结果再扫一遍检不出**"两条防空跑。**③ 抖动不进退出码——有意设计，保留**：三条理由 + 三条边界落 docs/06 §七（要点：退出码答"产品有没有坏"，把取证时窗踩空算失败会养出谁都不信的红灯；红仍然会红——状态变更型步骤重试救不回时退出码就是 1；信息没丢，`flakySteps`/`retryPolicy`/「（执行 N 次）」/`抖动=N` 都可 grep；**连续两轮同一 flaky 步骤按失败处理并开专项**——step21 正是照这条在 R58 找到根因）。**④ 规则 DSL 文档承诺大于实现——成立，改文档**：`priority` 只解析透传**无排序消费者**、同 id 只**重复点名**（`rules.ts` 自己注明"跨包版本合并不在本轮"）、语义冲突检测与弹确认都没做 ⇒ docs/03 §8.3 那行改成分层口径并把版本合并挂到 T4-12（R68）；**没有偷偷实现半套**（半套版本合并会让"看起来有生效日期"变成假安全感）。**验证**：单测 +34 → **862/862（86 文件）**，typecheck TC=0，e2e E2E=0（新增 `rollbackDirtiedConsistency` 探针），预演全新目录 **v136 → 44/44**（48.75s，抖动=0、证据缺失=0）。**变异校准**：`gitRollback` 改回 `wrap` → e2e 只红 1 条并点名该探针，还原后逐字节比对。**这条探针第一版是错的**：直接"回滚后看是否重算"会被回滚前那次 `chapter.write` 白送一个脏标记 ⇒ 不修产品也绿（永真）；改成**回滚前先把缓存洗干净**才有资格当回归锁 |
| R60 | M4/T4-5 影响传播（引擎侧）＝反向 BFS 与提案结构 | 新建 `world-engine/propagate.ts`：`propagate(change, {entities, refs}, {maxDepth=3, weights})` 吃 T4-2 已有的索引行表（**不长第二套图结构**），输出 `{proposalId, change, status, impact[], truncated, cycle, assumedRelations}`。三条"不猜"各有测试：**只沿反向边**（把被改实体自己引用的东西也算进影响面＝把依赖图读反）；**成环整单阻断并给环路径**、`impact` 给空数组（半张传播表比没有更危险，作者会以为那就是全部；自环也按环处理，不靠 visited 侥幸终止）；**权重没定义按 1 计并标 `weightAssumed`**、路径上有一条缺就整条标（编个小数＝把"这条边影响不大"写成事实）。封顶**如实报"下一层被砍掉的节点"**而不是整棵未展开子树（后者要再走全图，成本收益不成比例——如实少报范围比假装数得准更诚实）。排序全走**码点序**（不用 localeCompare），`proposalId` 取"改动+影响面+封顶+环"的 sha256 前 12 位 ⇒ 同输入两次逐字一致、改不同字段是另一份提案；实体不在索引里**抛 `E_PROPAGATE_NO_ENTITY`** 而不是返回空清单冒充"没有影响"。**验证**：新增 8 例 → **870/870（87 文件）**，typecheck TC=0；**纯引擎轮未碰桌面端，故没跑 e2e 与预演**。**变异 6 次全能红**：反向改正向→5、去环检测→2、去封顶点名→1、缺权重猜 0.5→1、码点序换 localeCompare→1、不存在改成静默空→1；跑完逐字节还原。**一次自我纠正**：变异脚本首轮把 vitest `--outputFile` 写成 Git-Bash 风格路径 ⇒ Node 解析不到，六个变异"全红"其实是同一个 ENOENT——**红的原因必须是产品变坏**，否则这次校准等于没做；换绝对路径重跑才拿到上面那组数。**T4-5 与 M4 验收 A1 均不勾选**：`prop-*.yaml` 落盘、面板逐项 accept/reject/pending、`pre_apply_proposal` 快照与 `applyProposal` 写回真源都在 R61（没有调用点之前不声称达成） |
| R61 | M4/T4-5 桌面侧：提案落派生区 + 逐项决策（A1 勾选） | **主命题是「跑完预览与决策，真源一个字节都不变」**：`propagation-ops.ts` 的 `previewPropagation` 用 `checkStructureFromSources` 拿真源行表 → `propagate()` → 提案写 `.yushu/proposals/prop-<id>.yaml`（派生物：不入 Git/索引/快照），`decideProposal` 只改那份派生文件，`listProposals` 逐份严格解析回读。**给派生区开了一扇窄门而不是继续绕**：`FileGateway.writeDerived / listDerived` 只认 `.yushu/` 前缀、越界检查照做、可选 `expectedHash` 拒盲写——`WRITE_EXCLUDES` 那道闸防真源误写不能松，而各模块因此裸 fs 直写正是审计「绕过 FileGateway」的成因；把守卫放宽，`file-gateway.test.ts` 的「拒写非派生区」立刻红（实测）。**格式判断放引擎侧** `proposal-file.ts`（与 `parseConsistencyAllowList` 同分层理由；未知键一律拒绝，半读半丢比读不了更坏），顺带撞出「`yaml` 在引擎包里、桌面端直接 import 会撞 pnpm 严格 node_modules」这条现实约束。**面板上没有「应用」按钮**：本轮不写回真源，边界写在面板末行——放个灰按钮会让读者以为只差一下，实际差的是一整套快照 + 并发拒覆盖。三条新通道走 `wrap` 并登记进 R59 源码锁的「看着像写、其实只写派生区」对照表（真源没动就不该刷索引、不该置脏结论）。**验证**：单测 +22 → **884/884（88 文件）**，TC=0，e2e E2E=0（`propagation:{impact:1, firstPathLen:2, undecidedBefore:1, undecidedAfter:0, lawHashSame:true, geoHashSame:true}`），预演新增 **step45** → **45/45**（v138 一次过、抖动=0）。**A1 勾选**；**T4-5 不勾选**（`applyProposal` 未做）。**一条流程坑记下来**：预演加载的是**已构建的 renderer**，改完渲染层只跑 `build:main` 就重跑预演 ⇒ step45 报「找不到输入框」而代码是对的；补 `build:renderer` 后一次过——**改渲染层必须先构建 renderer 再跑预演** |
| R62 | M4/T4-5 收口：`applyProposal` 写回真源（T4-5 勾选） | **只做机械可确定的编辑**：改名（`field === "id"` + `to`）才自动改指 `refs.target`，正文/别名/层级一律**拒绝写回并说明原因**——引擎不替作者决定「这条设定该怎么改」。四道闸按序：全部条目已表态 → 只认改名 → **写之前强制 `pre_apply_proposal` 快照**（拿不到即阻断）→ 逐张比对**生成提案时**就记进 `sources` 的 hash（最初现读现比是自己跟自己比、永远一致，「外部改过就拒写」根本没生效，那条测试先红后绿才逼出真缺口）。重复应用被拒。`proposal:apply` 第一版注册成 `wrap`，被 R59 的写通道源码锁当场点名改 `wrapWrite`。**验证**：单测 +6 → **890/890（88 文件）**、TC=0、e2e E2E=0（`appliedOk` / `reApplyRejected`，R61 的「预览与决策不碰真源」仍为真）、预演新增 **step46** → **46/46**（v141 一次过、抖动=0）。**变异 4 次 3 红 1 未杀到（如实登记）**：去掉「快照失败即阻断」测试全绿（本机 `takeSnapshot` 恒成功、该分支测不到），属防御代码、**未声称覆盖** |
| R63 | 用户插队轮：界面交互精修 + 死代码/冗余清理 + GitHub 展示页 | **动效定调 Premium**（一次性入场 + 克制反馈、0% 过冲）：新增 `Disclosure.tsx` 用 `grid-template-rows: 0fr→1fr` 让展开容器**按真实内容高度**连续过渡（不是 `max-height` 猜值）+ 箭头 `rotate(180deg)`；按钮 hover `translateY(-1px)` / active `scale(0.98)` / `:focus-visible` 描边；令牌 `--motion-quick/base/slow = 140/240/380ms` + `cubic-bezier(0.4,0,0.2,1)`；一次性入场 `yushu-settle` 只挂三处；`prefers-reduced-motion` **同时**关 `transition` 与 `animation`（原稿只关前者等于没关）；**零新增依赖**。预演新增 **step47**：60ms 中途采样取证（0 → 35/52 → 终值 236 = 内容高 236、被裁=false、`aria-expanded` false→true、箭头 `none → matrix(-1,0,0,-1,0,0)`）——**断言"存在中间态且终值等于内容高"，不是某个具体中间值**。**清理**：全仓扫描 = 未引用文件 0 / 孤儿 CSS 0 / 零调用点符号 3，处置各不相同——`stopRepoWorker`（索引 utility 进程的唯一收尾函数，从未被调用）**是资源泄漏不是死代码**，接进 `window-all-closed` 并加源码锁；`assertOutlineReadable`（注释声称"供报告合并前的一致性检查"而实际无人调用）连带两个未用 import 与文件尾空行一起删；`ChannelName` 删（留着就等于给自己写的规矩开例外）；修「十个标签页」过期注释（`TABS` 实为 11）。**剪掉 5 条未使用依赖声明**（`@codemirror/commands`、`@tiptap/pm`、cli 的 `@yushu/core`、genre-engine 的 `@yushu/schema`、memory 的 `yaml`）：`pnpm install` 后 lockfile 只减 15 行、`node_modules` 里链接确实消失，再跑 `build:main`+`build:renderer`+`typecheck`+`test` 才算过——**不 install 就验证等于没验证**。**展示页**：`README` 的「当前状态」原停在 **M2 已收口**（对外声称落后账本三十多轮），改写为 `docs/04` 实测里程碑表 + 怎么跑 + 四连门禁（**明写「本仓库目前没有 CI 流水线」**）+ 仓库结构 + 五条红线；新增 `CONTRIBUTING`（四连 + 三条硬规矩 + 分层/IPC 四同步/码点序/动效上限）、`SECURITY`（**只写已实现**：真源只记 `api_key_env`/`key_ref`、明文 error 阻断、safeStorage 不可用即拒存、迁移备份先脱敏、`assertAiEnabled` 主进程闸门、写前强制撤销快照；并登记「上游 HTTP 错误回显尚未统一掩码」「无签名与更新通道」）、`NOTICE`（三份许可分离，逐条对过 `pack.yaml` 的 `CC-BY-4.0` 与词库文件头的「占位示例版」）、`ROADMAP`（只做外部定位，细节指回 `docs/04` 防漂移）、`.github/` 两份 issue 表单 + `config.yml` + PR 模板（强制「验证数字 / 断言能不能红 / 红线自检」）。**`CODE_OF_CONDUCT` 与 `GOVERNANCE` 仍缺** ⇒ issue 模板里没放「已阅读行为准则」勾选项（不让模板引用不存在的文件），`docs/04` §11.6 前两条门槛保持未勾并写了进展注记。**验证**：`pnpm test` **892/892（89 文件）** TEST=0（+2 例 teardown 锁）、TC=0、E2E=0、预演 **47/47**（v142，51.5s，`flakySteps:[]`、`screenshotFailures:[]`、抖动=0，退出后 `tasklist` 无 electron 残留）。**两条如实登记**：① 本轮新断言是**源码文本级**锁，防"以后有人删那行"，防不了函数改名、也观测不到 utility 进程真退出；② 依赖剪枝**没有红测试**，证据只有四连全绿。另记一条编号纠正：先前两次预演用 `v130` 号段（照本机已删目录续号）而账本最大号是 `v141` ⇒ 记录会倒着走，**重跑 v142 并以它为准** |
| R64 | 前端第二批：中文排版与标签图标（先调研后落地，零新增依赖） | **规矩是"先有依据再改界面"**——否则没有任何东西能回答"为什么是这样"。调研范围：CLReq / CSS Text 3&4 / MDN 兼容页 / Chrome 版本公告 / 开源图标集许可页 / 桌面写作工具版面做法；**运行时能力实测而不是查表**（预演报告 `env` 里 Electron 44.4.5 / **Chromium 152.0.7977.130**，step48 里三个 `CSS.supports` 全 true）。落地：`line-break: strict`（避头尾）、`text-autospace: normal`（中西文之间约 1/4em）、`text-spacing-trim: normal`、阅读版心 `--prose-measure: 44em`（≈616px ≈ 44 字/行；中文按「字」度量所以用 `em` 不用 `ch`——`ch` 是 '0' 宽，CJK 下约半个全角字，68ch 听着像 68 字其实 34 字）、数字列 `tabular-nums`+`"tnum"`、`prefers-contrast: more` **只加深颜色不动版式**。图标：**Lucide v1.55.0（ISC）** 11 个 SVG path 从 `lucide-static` **逐字复制**成 inline 组件（不引运行时包；文件头保留 ISC 原文、`NOTICE` 登记），映射讲得出理由（起源=`layers` 分层建世界、规则=`scale` 裁量不是惩罚、档案=`book-open`…），`aria-hidden="true"` 让可访问名仍来自中文标签；`.tabs` 横向滚动 + `.tab` nowrap/flex:none，窄窗口不压扁文字。**明确不做并写理由**：`hanging-punctuation`（Chromium 未实现）、联网字体（必须离线）、令牌三层重构（全量 `var()` 替换会淹没同轮，排 R71）、密度切换（要先拍界面上给不给开关）。**一条克制**：`text-spacing-trim` 观感依赖字体含 `halt`/`chws`，本机字体是否含**未核实** ⇒ step48 断言"计算值落地 + 运行时支持"，**不是**"肉眼看到标点被压"。**验证**：892/892、TC=0、e2e E2E=0（渲染层改了照跑）、预演新增 **step48** → **48/48**（v145，52.3s，抖动=0，回执含 `版心=616px（实测宽 616px）`、`标签=11 图标=11 被压扁=0（最窄 69px）`）。**变异**：`--prose-measure` 改 `96em` ⇒ step48 两次未过并点名「版心=1344px」，其余 47 步仍绿（说明它测版心而不是测"页面能不能开"），还原转绿；**变异要走 `build:renderer`**，只改源文件不重建测的是旧包。**顺带关掉 R63 留的疑问**：入场动效**不需要**加 `key`——视图是 `{tab === "x" && <View/>}` 条件渲染，切页本就重挂载；当时没测先记疑问是对的，但**结论要回来关掉它**，否则假待办一直挂在账本上 |
| R65 | M4/T4-6 伏笔台账（引擎侧）＝判定层 | 新建 `@yushu/world-engine/foreshadow.ts`：真源 `world/foreshadow.yaml` 的**严格解析**（未知键 / 非法枚举 / 重复 id / 缺必填一律拒绝并点名到 `entries[i]（id）`——半读半丢最坏：作者以为 12 条而引擎只认 9 条是最贵的错）+ **手写键序序列化**（库 dump 会随版本漂键序，真源是给人看 diff 的）+ `buildForeshadowBoard(ledger, {chapters, ...})` 纯判定：`open / closed` 分桶、逾期章数、复查提示、单章埋设过密、终局窗口未回收升级 error、红鲱鱼被"兑现"、`paid` 却无回收章、`abandoned` 却无理由、预期回收早于埋设、章号引用不存在。**三条口径各钉一组测试**：① **合法终态不报缺陷**（红鲱鱼 + `abandoned` + 理由 ⇒ `findings` 必须为空，配负例夹具——把正当写法报成问题，作者就学会忽略整块看板）；② **报矛盾而不替作者改状态**（`paid` 无回收章出 finding，但 `rows[0].state` 仍是 `paid`）；③ **默认不猜阈值**（`droughtChapters` 缺省 0=关闭，未经真实语料定标的阈值不默认生效，同 T4-11）。章号定位**复用 `powerLogChapterNo`**（两处各写一套数字规则早晚漂移），认不出给 `null` 不编 0——"无法判断"≠"没有逾期"。**一个字段是被测试逼出来的**：`payoff_chapters?` 在 docs/03 §5.3 原模型里根本没有，"打算在哪收"有、"真的在哪收了"没位置 ⇒ 补字段同时把理由写进 docs/03。**验证**：测试**先写先看它红**（20 例首跑 20/20 红，模块还不存在），实现后 **912/912（90 文件）** TEST=0、TC=0；**变异 4 次全能红**（干旱默认 `0→10` 红在负例夹具并打印多出的 info；去逾期计算 / 未知键静默忽略 / 行不排序各红），每次还原 `diff -q` 确认。**T4-6 不勾选**（调用点在 R66）；**纯引擎轮 ⇒ 没跑 e2e 与预演，也不声称跑过** |
| R66 | M4/T4-6 伏笔台账（桌面侧）＝T4-6 收口并勾选 | `foreshadow:board` 只读通道 + 世界观档案底部看板（汇总行 / 分色结论 / 逐条表）；**面板没有"写回与应用"按钮**，step49 把 `面板内写回按钮=false` 钉成断言；台账数据按项目真实章序现场构造（先读大纲拿章 id），三种样本各验一事：逾期外显 / 红鲱鱼 + 放弃带理由**不被报缺陷** / `paid` 无回收章报矛盾。**顺带补上 R63 在 CONTRIBUTING 里声称、当时却不存在的那条四处对账锁**：`ipc-four-way.test.ts`（变异：注释掉 preload 一行 ⇒ 两条红并点名通道）。917/917（91 文件）、TC=0、E2E=0、预演 49/49（v147）。**边界**：登记 / 埋设 / 回收仍是编辑真源 YAML，无表单录入。明细见 docs/06 §八 第 66 轮 |
| R67 | M4/T4-7 时间线（引擎侧）＝判定层 | `world/timeline.yaml` 严格解析 + 手写键序序列化（往返逐字相等）；`buildTimelineView` 按 (year, id) 码点序；`checkTimelineConflicts` 覆盖锚点缺失 / 未归零（**只报不擅自平移**）、因果倒置（**按 year 比不按数组顺序**）、角色出身于已灭亡的国度、死者仍在场、悬空引用；**缺 `kind` 的事件逐条进 `notEvaluated` 点名**，历法认不出给 `null` 不退回 offset 0；为此补 `Event.kind?`（理由写进 docs/03 §5.3）。15 例先红后绿、变异 5 次全红（第 5 次第一次 sed 跨行没生效显示"没红"，换 `if (false)` 重跑才算——**变异没改到代码时的全绿是假绿**）；932/932（92 文件）、TC=0。**纯引擎轮：没跑 e2e 与预演**；T4-7 当时不勾（桌面侧在 R68）。另修 `git-ops` 一条满载超时用例的墙钟预算（20s，改预算不改判据）。明细见 docs/06 §八 第 67 轮 |
| R68 | M4/T4-7 时间线（桌面侧 + 视图）＝T4-7 收口并勾选 | `timeline-ops.ts` 读 `world/timeline.yaml` → 引擎换算与校验 → 只读通道 `timeline:view`（**历法切换只是显示参数，不产生任何写操作** ⇒ 走 `wrap`，四处对账锁给这条通道加了自己的点名）。视图落在「世界观档案」底部，**把「年份（历法换算）」与「刻度（内部数字年）」分成两列**——同一列混两种口径，迟早有人以为历法数字才是真值；冲突清单与「未判定」整块外显（缺 `kind` 的事件逐条列出，「没判的」要看得见）。**预演 step50 的最后一项断言是本轮核心**：切完历法重新 `doc.read` 比 hash ⇒ `真源 hash 未变=true`，「历法只在渲染层」从此不是注释里的承诺而是每轮重跑的运行时事实（实测 `行=4；首行=帝国纪年 1204 年；末行=1234 年；切历法后首行=通纪 元年；刻度列未动=true`）。**A5 的前半从「演一遍删库」升级成结构断言**：`truth-source-only-views.test.ts`（3 例）——`timeline-ops`/`foreshadow-ops` 出现 `@yushu/search`/`index-ops`/`openIndex`/`index.db` 任一 token 即红且必须走 `gateway.readDoc(`，引擎侧 `timeline.ts` 的 import 白名单只有 `@yushu/core`/`yaml`/`./power-log.js`；**删库只能证明这一次没坏，「不 import 索引层」是任何一次都不依赖**。这条锁自己也验过能红（临时加一行 `import { openIndex }` ⇒ 红并点名两个 token）。**两条工装教训**：① step50 首跑红在「等一个早就成立的条件」——上一步就停在世界观档案、面板只在挂载时取数，改成先去「规则」再回来强制重挂载（第 57 轮记下的那类坑又出现一次）；② 变异跑完后**重跑一次全新绿目录 v151 当证据**，预演每次都覆盖 `docs/assets`，拿变异那次的脏图配绿账等于没证据。验证：单测 +4 → **936/936（93 文件）**、TC=0、E2E=0、预演 **50/50**（v151，抖动=0、证据缺失=0）。**边界**：时间线登记仍是编辑真源 YAML（无表单，与伏笔台账同一处置）；**M4 验收 A5 不勾**——要图谱与时间线两个视图都齐，图谱在 R69 |

### 3.3 系统骨架关键约定（必须遵守，改代码前先读）

1. **真源与派生分离**：Markdown/YAML 是唯一真源；SQLite（`.yushu/index.db`）与 `.yushu/context-log/`、`.yushu/ai-usage.jsonl`、`.yushu/ai-feedback.jsonl`、`.yushu/recovery/`、`.yushu/snapshots/`、`exports/` 都是派生物——可删可重建，绝不作为真源，不入 Git。
2. **AI 候选化**：任何 AI 产物（正文草稿 / 摘要 / 抽取候选）一律先候选展示；写正文/入库必须是用户显式动作（采纳）。`summary_rev>0` 时 AI 覆盖被拒；抽取仅 `new` 可入库（服务端二次复核，`E_EXTRACT_CONFLICT`）。
3. **写操作并发检测**：凡更新既有文件必须携带 `baseHash`（读时 sha256）；冲突 → `E_DOC_CONFLICT`，主文件不覆盖（编辑器侧走冻结 + 旁路文件 / 重新载入 / 三方合并）。
4. **路径防护**：一切文件读写走 `FileGateway`（拒绝 `../` 与绝对路径逃逸；`.yushu/node_modules` 写入拦截）。
5. **IPC 白名单三重同步**：新增通道必须同时改 `src/shared/ipc.ts`（CHANNELS + 载荷类型）、`src/main/ipc.ts`（handler；只读用 `wrap`，写真源用 `wrapWrite`（写后调度索引刷新））、`preload/preload.cjs` + `renderer/src/api.ts`。漏一处即运行时报错。
6. **上下文组装槽位不可变序**：`system_prompt → world_core → volume_summary → chapter_summary → triggered_cards → facts → rag_chunks → recent_prose`（docs/03 §10.2）。
7. **确定性优先**：索引/检索/组装/快照必须「同输入同输出」（排序总有 id 兜底、指纹用稳定序列化）——A1 可复现验收的前提。
8. **中文检索口径**：CJK unigram 预处理在索引与查询两侧同规则（`toFtsText`/`buildMatchQuery`）；改分词方案须同步改两侧并全量重建。

---

## 4. 未完成清单（按优先级）

### 4.1 M3 功能任务收口状态（docs/04 §6.3——13 项已勾选，T3-14 待 M5 的导出剥离，下列两项曾分两轮拆做）

- ~~**T3-13 中文处理初版**~~ **已完成（R44 引擎侧 + R45 桌面端与取证）**：`@yushu/text` 五类检测（`proofread-punctuation-gb` / `proofread-typo` / `proofread-conversion-ambiguous` / `proofread-repetition-high` / `proofread-long-sentence` + `proofread-demiscue`）与**修复安全闸门** `proofread-autofix-unconfirmed`（error）。两条必须记住的口径：**span 是 UTF-16 下标**（与导出敏感词同口径）、**severity 只有 `error | warn | info`**；繁简**歧义字一律原样保留只登记候选**（绝不把猜出来的繁体写进正文）；`applyFixes` 未确认时文本一字不动。
- ~~**T3-14 安全**~~ **已完成（R42 + R43）**：API Key 走 safeStorage 加密，密文只落 `.yushu/secrets.json`（派生物，随 `.yushu/` 被 Git / 索引 / 快照排除），真源 `config/llm.yaml` 只写 `key_ref`；含明文的 `llm.yaml` 在 `parseLlmConfig` 入口即被 `E_LLM_CONFIG` 拒绝（`key-plaintext-detected`）。**注意两处口径升级**：① R42 前"明文禁止落盘"只是 docs 里的期望，代码中并无该规则（旧解析器对未知 `api_key` 字段静默丢弃），现已真正落地；② R43 起 `gitInit` 会幂等补齐**项目根 `.gitignore`**（`.yushu/` / `exports/` / `node_modules/`）——派生物与凭据的"不入 Git"从应用内过滤升级为仓库自身不收，用户 `git add .` 也不会提交密文库。**新增派生目录时必须同步 `PROJECT_GITIGNORE_LINES`**（有单测钉住它与 `GIT_EXCLUDES` 同源）。**R101 已接上导出侧**：项目迁移包导出前用 `redactPlaintextSecrets` 就地剥离明文密钥，落盘后再用 `detectPlaintextSecrets` 复扫一遍作纵深防御（仍检出 ⇒ 整包删除并抛 `E_EXPORT_SECRET_RESIDUE`）；`.yushu/`（含密文库）整棵不进包。剩余：**导入侧**——把别人给的包变成项目的流程还没做 ⇒ T3-14 仍不勾。

### 4.2 M3 验收未核项（docs/04 §6.5）

- `- [x] A1` 可复现快照与截断标记（R37 已达成，有机器证据）。
- `- [x] A2 任务路由生效`：**R46 已离线取证并勾选**——e2e 新建两个独立 mock 端点（旗舰全程 503 / 小模型正常），实测端点计数 `{badHits:3, badFailures:3, goodHits:3, goodFailures:0}`、回落原因「返回 HTTP 503…」→「冷却中（剩余 60s）…」，证明「正文优先旗舰 → 失败按 fallback 降级不断流 → 冷却内不再试坏端点 → 小档任务只打 small」；三条动作 = 三条 usage 记录、`promptTokensDelta 30 = 12+12+6`（失败尝试不计费）。**边界**：命名任务是本地确定性生成器（不经 LLM），以摘要任务作「走小模型」等价证据；真实 provider 配额/限流不在此口径（A3 同）。
- `- [ ] A3 成本面板`：R40（T3-12）已落地并取证——**可分解 / 双口径 / 不猜价已被机器断言**，R48 补齐 J09 四维的最后一维（**按章节分解**）与预算护栏 / 成本体检**引擎**；但「偏差在可接受范围内」**无法用 mock 证明**（mock 对任意请求固定回传 `prompt_tokens:12`，实测偏差 +4404%）。保持未勾选，接真 provider 后与 A2 同轮量化复核（证据与口径详见 docs/04 §6.5 A3 与 §6.3 T3-12 注记）。
- `- [x] A4 AI 整体关闭后本地能力无退化`：**R47 已达成并勾选**。取证前先修真实缺口——原先「关闭 AI」只是渲染层一个按钮禁用，主进程三个联网入口（`ai:start` / `memory:summarize` / `extract:preview`）无闸门；现改为主进程总开关（默认 false、`E_AI_DISABLED`、四处同步 `ai:setEnabled`、UI 由 `AiConfigState.aiEnabled` 派生）。证据：`ai-gate.test.ts` 7 例 + e2e A4 探针 `{blockedAll:true, localFailed:[], localCount:11}` 且 mock 端点计数零增长 + 预演 step39（39/39，v105）；变异「assertAiEnabled 永不误抛」→ 4 例转红。**口径**：`trial` 的 webRequest 审计只覆盖 renderer 会话（AI 走主进程 fetch），不得当作全进程零外网证据。
- `- [x] A5 记忆不跨项目泄漏`：**R41 已复核并勾选**——e2e 探针原文 `{"rejectedIds":["fact-foreign"],"errorCodes":["memory-cross-project-leak"]}`（异项目记录被拒、本项目 6 条事实台账不受影响）；证据文字已写入 docs/04 §6.5。
- `- [x] A6 上下文预算超限正确裁剪`：**R41 已复核并勾选**——小预算 40 token 探针 `smallEvicted/smallWithin/smallKeepsSystem` 全真 + 快照 `smallTruncated:1`；逐出顺序与「system_prompt 只截断不丢弃」按 docs/03 §10.2 断言，无中段丢失关键设定案例。

### 4.3 各轮「边界如实标注」的遗留（已在 docs/04 各注记写明，勿重复实现，按需推进）

- R36：sqlite-vec 扩展**加载路径代码就绪但本机无扩展未实测**（实测走本地余弦兜底，注记与回执均如实标注）；云端语义嵌入（bge-m3）与 bge-reranker 是 `VectorStore`/`rerankHits` 的**替换点**，接 provider 后替换即可。
- R38：provider 支持 `json_schema`/tools 时可把「提示词约束 + 后校验」升级为**原生强约束**（structured.ts 已是同一契约的另一端）；augment 的字段级合并 UI 与抽取失败池面板留 T4。
- R39：真 Batch 为异步批处理（24h），交互链路不排队——现行半价通道是「归属提示 + usage 记账」；多候选限 1-3；拒绝原因看板（分布视图/回流提示）与批量队列视图留 T4。
- ~~R48：预算护栏与 `lintCost` 引擎已完成并测透，但尚未接入面板~~ **接线已于 R49 完成**（归月已用金额 / 组装实测输入 / findings 与 skipped 全部渲染）。R49 之后成本线剩余：① `per_call_confirm_over`（单次超价须确认）**只有配置字段与解析，没有拦截点**——拦截会打断生成流程，属交互决策，需先与作者确认口径；② Batch 真实提交（异步 24h 队列）；③ 缓存命中率曲线与「前缀被击穿」历史趋势（J09 实践 4）；④ `budget-monthly-cap` 的"改用本地/小档"仍是 message 文本，**不自动切换模型**（J09「只报不改」）。
- 历史遗留（M2）：CI runner（ci-low-spec / ci-mid-spec）未接入；`real-sample-300k` 真实样本夹具待外部样本；`docs/06 §七` 记录了推送网络问题的历史处置。

### 4.4 架构级「替换点」清单（设计时就留好的口子）

| 口子 | 位置 | 替换为什么 |
|---|---|---|
| 向量存储 | `packages/@yushu/search/src/vector.ts` `VectorStore` | sqlite-vec（配置 `YUSHU_SQLITE_VEC` 环境变量指向扩展文件即可启用）/ 云端嵌入适配器 |
| 重排器 | `rag.ts` `rerankHits` | bge-reranker（经 provider 的 rerank 请求） |
| 分词 | `index-db.ts` `toFtsText` / `buildMatchQuery` | wangfenjin/simple（中文分词+拼音）——换后须全量重建索引 |
| 结构化输出 | `llm/structured.ts` | provider 原生 json_schema / tool use |
| 半价通道 | `llm/batch.ts` `planChannel` | 真 Batch API 提交器（异步队列） |
| 记忆检索层 | `assemble.ts` rag_chunks 槽位 | 已接 T3-8；未来换更复杂召回只改 `ragSearchIndex` |

---

## 5. 后续计划（路线图）

### 5.1 立即（M3 收口，建议 3-4 轮）

1. ~~**T3-12 成本与缓存**（含 A3 取证）~~ **已完成（R40；遗留的章节维度与预算护栏引擎补于 R48）** → 2. **A5 / A6 复核勾选** **已完成（R41）** → 3. ~~**T3-14 安全（Key 加密）**~~ **已完成（R42 引擎与主进程 + R43 桌面端与取证）** → 4. ~~**T3-13 中文处理**~~ **已完成（R44 引擎侧 + R45 桌面端与取证）** → 5. **A2 取证 已完成（R46）** → 6. **A4 取证 已完成（R47）** → 7. **T3-12 遗留补齐 已完成（R48 章节维度 + R49 预算护栏与体检接入面板，T3-12 勾选）** → 8. **A3 待用户侧真实端点**（唯一未勾项：偏差量化需真实 provider 回传 usage；**不要在 mock 上声称达成**）。M3 功能面 13 项已勾选（**T3-14 待 M5 打包接线，R55 复核时明写不补勾**），R50 起进入 **M4**（docs/04 §7，T4-1 起）；A3 取证与 `v0.4.0` 打 tag 等真实端点可用时一并执行（§6.7：A1–A6 全绿才打 tag）。

### 5.2 之后（以 docs/04 为准，勿偏离）

- **M4 一致性引擎 / 伏笔 / 时间线 / 关系图谱**（T4-1～T4-12）：规则 DSL 沙箱求值（禁循环禁 IO + 超时 + 深度上限）→ 规则分类（ref-dangling / 战力 / 视角 / 信息可见性 / 伏笔回收…）→ 一致性报告（span+evidence+fix 三件套）→ 影响传播（反向 BFS + 提案目录 + 整体回滚）→ 伏笔台账 / 时间线 / 编年史 / 关系图谱（SQLite nodes/edges）→ 爽点与期待感管理 → 规则回归集。前置：M2 的 refs 反向索引、M3 的注入与事实记忆（校验比对源）。
- **M5 内容与平台化**：平台规则包机制填充（docs/06 §9.6）、导出管线增强（EPUB/EPUBCheck）、真人试跑材料包维护。
- **M6 证据链与合规**：ai-usage 证据链完整性校验（R38 起 usage 已带 `channel`）、合规申报导出。
- 长期议题（docs/04 §6.6 风险表）：成本失控防控（预算上限拦截 + 批量半价 + 归因）、Lost-in-the-Middle（分层组装 + near_end + 预览器抽检）、本地模型体验断层（能力矩阵 + 差异提示）。

### 5.3 工程债（低优先，随手做）

- `docs/00-交接文档-给Trae.md` 是 M1 时代的；新内容一律写进 `docs/04/06` 与本文，避免多源。
- ~~walkthrough 报告 `scene` 字段仍写「步骤 10-25」，可顺手更新为当前范围。~~ **已更新**（R40「步骤 10-36」→ R43 10-37 → R45 10-38 → R47 10-39 → R51 10-40 → R54 10-41 → R56 10-42 → R57 10-43；**新增步骤时记得同步这里**，`grep "步骤 10-" apps/desktop/src/main/walkthrough.ts` 一眼可验）
- e2e 探针串行较长（~40s），暂无拆分必要；新增探针请保持「先落盘再断言、口径可打印」风格。

---

## 6. 每轮工作流（照做即可）

### 6.0 铁律

- 一轮 = **一遍仔细开发 + 提交前验证必须全绿**（`pnpm test` / `pnpm typecheck` / 按改动面跑 e2e / walkthrough 全新目录）；**取消独立复核轮**（2026-10-05 用户决定，见 docs/06 §复核规则）。
- 每轮 **3 条提交，逐条推送**（用户 2026-10-06 指示：看得出来项目是怎么一步步完成的）：① 引擎侧包 → ② 桌面端 → ③ docs + 预演证据。提交信息用中文、动词开头（`feat: M3/T3-x——…` / `docs: 第 N 轮记录——…`）。
- **每完成一轮立即推送**；不要问用户要 token（凭据已在本机 GCM）。
- 注释、汇报、文档 **全中文**；文档注记风格：**已完成什么 / 工程要点（如实记录）/ 验证数字 / 边界如实标注 / 遗留**。

### 6.1 一轮的标准步骤

1. **领任务**：读 `docs/04` 对应 T3-x 行（含前置依赖说明）与 `docs/03` 对应章节、以及相关 `docs/research/J-*.md`（J03/J04/J06/J08/J09/J15）。
2. **实现引擎侧**（packages）：纯逻辑优先，放对应包；**新文件记得从包 `index.ts` 导出**；写单测（每个包 `test/`，vitest；跑 `pnpm exec vitest run packages/@yushu/<pkg>` 快速迭代）。
3. **实现桌面端**：主进程编排（ops 文件）→ IPC 三重同步（§3.3-5）→ renderer 面板；**改 renderer 后必须跑完整 `pnpm --filter @yushu/desktop build`**（只 `build:main` 会留旧渲染产物——R33 教训）。
4. **验证四连**：`pnpm test` → `pnpm typecheck` → `pnpm --filter @yushu/desktop e2e` → walkthrough 全新目录（编号递增，如 `D:\Temp\yushu-walkthrough-v79`）。
5. **补文档三处**：`docs/04`（在任务行下加「进展注记（日期，第 N 轮）」）、`CHANGELOG.md`（M3 增量加一条）、`docs/06` §八（第 N 轮开发记录：本轮开发 / 工程要点 / 验证数字）；顺手更新 `docs/06 §五` 的测试计数。
6. **提交 ×3 + 推送**（见 6.2）。
7. **更新预演证据**：walkthrough 会把 `docs/assets/m1-preview/*.png` 与 `walkthrough-report.json` 全部刷新——随第 3 条提交一起提交。

### 6.2 推送（含被墙兜底）

- 先试常规：`git push https://github.com/Zhang-jx00/yushu.git main`（本机 GCM 已存凭据；**不要**加 `-c credential.helper=` 禁用）。成功标志：`old..new main -> main`（PowerShell 会把 git 的 stderr 当错误显示，属正常）。
- 若 `github.com:443` 被阻断（Connection reset / timeout，本机历史上反复出现；`api.github.com` 通常仍通）：使用仓库内已备好的兜底脚本 `.git/git-data-push.mjs`（Git Data API 逐提交重建 blobs/trees/commits，SHA 与本地一致，最后 PATCH ref），用法：
  ```powershell
  $env:GITHUB_TOKEN = ((("protocol=https`nhost=github.com`n`n" | git credential fill) | Select-String '^password=').Line -replace '^password=','')
  node .git/git-data-push.mjs <提交1> <提交2> <提交3>   # 按序：祖先→末端（可短 sha）
  Remove-Item Env:GITHUB_TOKEN
  ```
  脚本要点（改脚本时别破坏）：`core.quotepath=false` 才能正确处理非 ASCII 路径；日期转 ISO8601；每个对象创建后校验返回 SHA 与本地一致，不一致立即中止且不更新 ref；token 只经环境变量、不落盘不打印。
- 提交信息多行用 `git commit -F <file>`（PowerShell 不支持 heredoc；把消息写进临时文件后用 Write 工具写、提交完删除）。

### 6.3 预演与 e2e 的口径（改这些地方前务必先读）

- **mock LLM**（`apps/desktop/src/main/walkthrough.ts` `startMockOpenAI`，e2e 与预演共用）当前口径：
  - 流式（stream:true）：固定分片 `["天启","界的","夜色"]` → 全文 **「天启界的夜色」**；
  - 流式 + 请求含「**多候选生成 #i/N**」标记：返回 `夜色压下来。林渊拔剑而起（候选i）。`（T3-11）；
  - 非流式（stream 缺失/false）：固定返回 **「非流式一次性回复」**；**例外**：请求含 `yushu.extract/entity_extraction`（抽取任务契约 id）时返回固定候选 JSON（5 条：林渊=补充 / 玄铁令=新增 / 林渊·location=冲突 / 天启界=新增 / 测试设定1）；
  - `e2e` 启动参数 `failFirst:1, failStatus:429`：**首个请求 429**，用于重试探针（`hits>=2 && failures===1` 为断言口径）。
- **e2e 探针**都在 `apps/desktop/src/main/main.ts` 的 `runE2E` 大脚本（渲染层字符串）里，尾部一段很长的 `ok = ... && ...` 布尔表达式是唯一断言处；新增探针记得同时更新：脚本内 result 对象、外层 `result` 类型声明、尾部断言、成功消息文案。**坑位**：「AI 降级探针」会把 mock 模型保存为 `stream:false` **且不恢复**——任何在其之后需要流式的探针必须自行恢复（见 R39 的 `configForRestore` 段）。
- **walkthrough**：步骤数组 `STEPS`（`walkthrough.ts`），每步 `{step, title, file, body}`，`body` 用 **String.raw**（`'\n'` 才是真换行；普通模板会提前转义，见 memory 教训）。新步骤 append 到末尾即可（计数自动）；截图落在 `docs/assets/m1-preview/`。已知坑：**AiView 随标签页卸载重建**（`ProjectScreen` 里 `tab === "ai" && <AiView/>`），依赖其内部状态（如 AI 开关）的步骤要「自给自足」地先设置；断言选择器要避免误匹配面板标题（如 `局部采纳：` 全角冒号才指向回执）。 **e2e 侧同类坑（R43 实撞）**：`runE2E` 的大脚本是**普通模板字符串**，里面写的 `
` 会被外层先转义成真实换行，把注入脚本的字符串字面量截断 → 渲染层只报 `Uncaught SyntaxError: Invalid or unexpected token`（不带出错内容，极难定位）；注入脚本内需要换行时一律写双反斜杠形式。
- **auth/网络**：e2e / walkthrough / trial 全程离线 mock，不联网、不需要真 Key；perf-test 也离线。

---

## 7. 红线与禁区（违反即回退）

1. 不得删除/覆盖 `docs/research/` 下的 A–H/J/K 调研文档（项目基础资料）。
2. 派系包必须多维多选（遵循 G06 YAML 规范）；SQLite 不得作唯一真源；AI 结果必须候选化、不得直接覆盖正文。
3. 跨项目记忆泄漏是 error 红线（`memory-cross-project-leak`，测试必须覆盖）。
4. 写操作必须带 `baseHash` 并发检测；冲突绝不静默覆盖（主文件保持外部版本）。
5. 敏感词词库外置可更新；导出防手滑（UI 勾选 + 服务端 `confirmed` 强校验）；导出产物写 `exports/<书名>-<时间戳>.txt` 不覆盖。
6. 密钥安全：明文 Key 禁止落盘/进日志。**R42 起该保障已真实存在**（此前仅写在 docs/03 §13 与 K12 建议里，代码中并无此规则——本文上一版表述有误导，已更正）：`@yushu/llm` `detectPlaintextSecrets` + `parseLlmConfig` 将 `key-plaintext-detected` 落成 error 级阻断，密文只存 `.yushu/secrets.json`（safeStorage 后端不可用即拒绝保存，绝不写明文），错误信息只带去标识化证据。 **R43 起再收紧一层**：`gitInit` 幂等补齐项目根 `.gitignore`（`.yushu/` / `exports/` / `node_modules/`，与 `PROJECT_GITIGNORE_LINES` 同源并有单测钉住），使凭据库密文与索引库**连外部 `git add .` 也收不走**——不再只靠御书自己的结果侧过滤；同时 isomorphic-git 会剪掉整棵 ignored 子树，不再 stat `.yushu/` 里易失的 SQLite `-wal` / `-shm` 侧车。**新增派生目录时必须同步 `GIT_EXCLUDES` 与 `PROJECT_GITIGNORE_LINES` 两处**。
7. 不要触碰用户其它两个 GitHub 项目；推送凭据只按 §6.2 方式使用。
8. 性能：改动触及索引写入 / 启动 / 输入路径时，必须跑 `perf-test` 并对比回归（阈值 20%），把报告落到 `docs/assets/perf/` 并在 docs/06 如实记录；预算门禁在 `perf-budget.yaml`。

---

## 8. 验收与自测清单（接手后先跑一遍）

```bash
pnpm install
pnpm test          # 期望 1446/1446（136 文件，第 102 轮口径）
pnpm typecheck     # 期望 11 个包/应用 Done（R88 起每包跑两份配置：src 与 test）
pnpm --filter @yushu/desktop e2e      # 期望末行 [e2e] 通过：…（含 T3-12 成本与 T3-14 密钥安全探针）
pnpm --filter @yushu/desktop exec electron . "--ui-walkthrough=D:\Temp\yushu-walkthrough-<新编号>"   # 期望 DONE ok=62 fail=0 证据缺失=0（退出码把「证据缺失」也算失败）
pnpm --filter @yushu/desktop perf-test  # R83 起退出码=门禁：绝对预算未达标 ⇒ 1（热盘跑法：夹具已在 D:\Temp\yushu-perf-synth1m 时 reused=true）
```

验收基线数字：**单测 1446/1446（136 文件）、typecheck 11 包零错误、e2e 全链路通过、UI 预演 63/63（v216）均为 R102 收口实跑**（R102 加了视角引擎两模块 + 三条通道 + 规则页看板 + 一步预演；R101 的口径是 1407/133 与 v212 62/62）（R101 加了迁移包三条通道 + 面板 + 一步预演；R100 的口径是 1393/132 与 v208 61/61）（R100 只动行尾：`git status` 里 21 个被改写的文件一个都没显示 modified，这就是"内容未变"的最强自证）（R99 是复核轮：删掉两条全仓库零引用的导出、新增一条零引用导出棘轮锁、更正 README/ROADMAP/docs/09 四处对外漂移，四连全部复跑；R98 的口径是 1385/130 与 v206 61/61）
（typecheck 自 R88 起覆盖 `src` 与 `test` 两面，22 条 Done；e2e 含 RAG / 快照 / 抽取 / 写作 UX / 成本 / **密钥安全** /
**中文自查** 探针；预演 v195 抖动=0、证据缺失=0、`screenshotFailures:[]`，step58 一次过 attempts=1）。
上一轮（R90）的 v194 里真出过一份 5747 字节的 EPUB（zip 头 `PK`、内含 `mimetype`，同目录 500 字节 `.md` 源）。
R91 跑全四连的理由写清：`file-gateway.listTree` / `index-input` / `search/rag` / `memory` / `export` 的排序都改了，
这些顺序会进索引与报告，不能只靠单测收工。四连**顺序跑不并发**：预演对 CPU 敏感，同时开测试会把真稳定跑成假抖动。
**perf 最近一次实跑仍是 R83**：10/10 达标且退出码 0，R84–R91 未复跑。

---

## 9. 已知环境与工具注意事项

- 系统：Windows（PowerShell）。不要用 heredoc / `&&` 串命令；用 `;`。多行 commit 消息用 `-F 文件`。
- `pnpm test` 全量并行时，`apps/desktop/test/snapshot-ops.test.ts` 的「环形保留 22 次快照」用例对负载敏感，已显式放宽到 30s（勿改回）。
- 未经 `--lockfile-only` 直接 `pnpm install` 可能因 frozen-lockfile 失败；新增依赖前先确认 registry 可达。
- Electron 44 / Node 24（dev）；`node:sqlite` 用于索引（零原生依赖）；`loadExtension` 需要 `allowExtension`（旧运行时会自动回退——R36 已处理）。
- **R100 起仓库有 `.gitattributes`：文本一律 LF（index 与工作树都是），二进制不处理。**
  因此"LF will be replaced by CRLF"那类逐文件警告**不再是正常的了**——它现在意味着有文件绕过了口径，
  判据是 `apps/desktop/test/eol-hygiene.test.ts`（现场跑 `git ls-files --eol`，违规逐条点名）。
- `.git/git-data-push.mjs` 是推送兜底脚本，保留在 `.git/` 里（不入版本库）；如误删，可按 §6.2 要点重写。
- **2026-10-13 推送出现一种新失败形态，别再当网络问题查一遍**：`git push` 返回
  `remote: Permission to Zhang-jx00/yushu.git denied to Zhang-jx00`（403），而同一时刻 `api.github.com` 用
  同一个 token 建 blob 返回 `403 {"message":"Resource not accessible by personal access token"}`
  ⇒ **是凭据范围不够（fine-grained PAT 缺 `Contents: Read and write`），不是 `github.com:443` 被阻断**。
  此时 §6.2 的兜底脚本同样无效（它走的正是 Git Data API）。判别顺序：先看 403 的 body 有没有
  "Resource not accessible"，有就是范围问题，要用户侧重新授权；没有再按被墙重试。
  本轮三条提交（`7b0f9d3` / `1b345d2` / `61d80cc`）因此**留在本地未推**，工作树干净、历史完整，
  凭据修好后 `git push origin main` 即可续上。
- 满载并行的墙钟敏感用例已有两处先例：`snapshot-ops.test.ts` 的环形保留快照（30s）与
  `git-ops.test.ts` 的 init + 首次全量提交（20s，单跑实测 1.79s）。**只给那一条加预算、不改判据、
  不全局调大 `testTimeout`**——全局放宽等于放弃挂死检测。
- **git 凭据按「主机」只存一条，不按仓库**（2026-10-13 实测）：helper 是 `manager`，`credential.useHttpPath` 默认未设 ⇒ 整个 github.com 共用 `git:https://github.com` 那一条。库里另有 `git:https://gitee.com`，说明不是「只能存一个」，而是**查找键不带仓库路径**。曾因此推送一直 403「denied to Zhang-jx00」，而手上那枚 token 本身是好的（存进去的是另一枚对本仓库无 Contents 写权限的）。
  - **yushu 的处置**：`git config --local credential.https://github.com.useHttpPath true` + 写路径键条目 `git:https://github.com/Zhang-jx00/yushu`。**只动本仓库**，主机键那条原封不动（用户机器上还有多个项目在推，开全局会让它们下次推送全部重新要一次凭据）。
  - **403 先分清原因**：`x-accepted-github-permissions: contents=write` 且 `POST /git/blobs` 返 403 ⇒ 权限不够；`Could not resolve host` ⇒ 网络。别把权限问题报成网络问题。改凭据前先 `cmdkey /list` 列条目并复述影响面。
  - **不改凭据库时的一次性推送**：token 只进子进程环境变量 + 一个临时 helper 脚本（先 `-c credential.helper=` 清空链，否则 manager 抢先答），用完立刻删脚本；密钥不回显、不落盘。
- **~~全局 `http.sslverify false`~~ 已于 2026-10-14 恢复为默认（校验开启）**。原状：`~/.gitconfig` 里
  `http.sslVerify=false`，把所有 HTTPS 仓库的证书校验都关掉了（PAT 可被中间人截走），
  而 yushu 只在本地开了 `http.https://github.com.sslVerify true` 自救。
  **动手前取的证据**（用户授权"你自己解决"之后逐项核过，不是推测）：
  ① 本机 `find` 到 40 个仓库，带 origin 的只有 **3 个 github.com + 1 个 gitee.com + 1 个本地裸库**；
  ② `git -c http.sslVerify=true ls-remote origin` 对 GitHub **成功**（退出码 0）；
  ③ 那个 gitee 仓库开/关校验**行为完全一致**（都是 `404 not found` + 退出码 128，
     差异只有服务端回显的 session id）⇒ 它的问题是仓库改名/私有或凭据不对，**与 sslVerify 无关**，
     所以恢复校验不会改变它的推送结果。
  **动作**：先备份 `~/.gitconfig` 到 `D:\Temp\gitconfig.bak-before-sslverify-restore`，
  再 `git config --global --unset http.sslVerify`（回到 git 默认 = 校验开启）。
  **复验**：`git ls-remote` 退出码 0、`git push --dry-run` 输出 `Everything up-to-date` 退出码 0。
  **回退只需一行**：`git config --global http.sslVerify false`（或还原那份备份）。
  **今后若某个项目真的撞上自签证书**：给它单独配
  `git config --local --change... http.<该主机>.sslVerify false`，**不要再全机关校验**。
  另记：`core.autocrlf=true` 来自 **system 级**（`git config --system`，Git for Windows 装的默认），
  本仓库**R100 已补 `.gitattributes`**（`* text=auto eol=lf` + binary 名单）并把工作树里 21 个 CRLF/混杂文件按字节改成 LF，
  此后 `git diff` 不再逐文件打印 "LF will be replaced by CRLF"；仍**没动** system 级 `core.autocrlf`（那会波及这台机器上其他项目，
  且有了 `.gitattributes` 之后它对本仓库不再起作用）——原"单开一轮"的 earmark 到此结账。
- 大章/百万字性能夹具在 `D:\Temp\yushu-perf-synth1m`（幂等复用）；预演目录 `D:\Temp\yushu-walkthrough-v*` 可随意清理。

---

## 10. 关键文件索引（改哪里看哪里）

| 你要做的 | 从这里开始 |
|---|---|
| 领任务/对验收 | `docs/04-开发计划.md` §6.3（任务）§6.5（验收）§6.6（风险）§6.7（退出条件） |
| 看某轮怎么做的 | `docs/06-M1验收与自查清单.md` §八「第 N 轮开发记录」；`CHANGELOG.md` M3 增量 |
| 改 AI 调用/路由/降级 | `packages/@yushu/llm/src/{config,routing,reliability,downgrade,structured,batch,chat,stream}.ts` |
| 改上下文/记忆/快照 | `packages/@yushu/memory/src/{assemble,injection,snapshot,records,provenance,mentions}.ts` |
| 改检索/RAG | `packages/@yushu/search/src/{index-db,vector,rag}.ts` |
| 改抽取 | `packages/@yushu/world-engine/src/extract.ts` + `apps/desktop/src/main/extract-ops.ts` |
| 改桌面端 URL 表面 | `src/shared/ipc.ts` → `src/main/ipc.ts` → `preload/preload.cjs` → `renderer/src/api.ts` |
| 改 AI 副驾 UI | `renderer/src/views/AiView.tsx`（+ `typewriter-buffer.ts` / `candidate-diff.ts`） |
| 改记忆页 UI | `renderer/src/views/MemoryView.tsx` |
| 加 e2e 探针 | `src/main/main.ts` `runE2E`（脚本 + result 类型 + 尾部断言 + 成功消息） |
| 加预演步骤 | `src/main/walkthrough.ts` `STEPS`（append）+ mock 口径 |
| 改索引写路径 | `packages/@yushu/search/src/index-db.ts` + `apps/desktop/src/main/index-ops.ts`（注意同事务与增量一致性） |
| 性能预算 | `perf-budget.yaml` + `apps/desktop/src/main/perf-runner.ts` + `docs/assets/perf/` |

---

## 11. 交接后第一条建议任务（可直接开工）

**T3-12 Token 与成本已于 R40 完成**（2026-10-07：成本数学 / 跨协议 usage 归一 / 定价透传 / `ai:cost` 通道 / 成本面板 / 编排核对；单测 483/483、e2e 与预演 36/36 全绿（v84），详见 docs/04 §6.3 T3-12 注记与 docs/06 §八 第 40 轮）。下一轮按 §5.1 顺序建议：

**T3-14 安全已于 R42 + R43 完成**（2026-10-08：明文阻断 / 凭据库信封 / safeStorage 注入式后端 / `ai:saveKey`+`ai:clearKey` / 三态徽标 / e2e 密钥探针 / 预演 step37；单测 517/517（62 文件）、e2e 连续两次全绿、预演 **37/37**（v92），详见 docs/04 §6.3 T3-14 两轮注记与 docs/06 §八 第 42–43 轮）。

**T3-13 中文处理初版已于 R44 + R45 完成**（2026-10-08：`@yushu/text` 五类检测 + `applyFixes` 修复闸门 + 编辑器「中文自查」面板 + `text:proofread`/`text:fixBody` 只读通道 + e2e 探针 + 预演 step38；单测 607/607（69 文件）、e2e 连续全绿、预演 **38/38**（v103）。详见 docs/04 §6.3 T3-13 两轮注记与 docs/06 §八 第 44–45 轮）。**至此 M3 的 14 个功能任务全部完成，只剩 A2 / A3 / A4 三条验收取证。**

**A2 / A4 取证已完成（R46 / R47）**：A2 用两个独立 mock 端点（旗舰全程 503 / 小模型正常）实测 `{badHits:3, badFailures:3, goodHits:3, goodFailures:0}`；A4 先把「关闭 AI」从渲染层按钮禁用**升级为进程侧闸门**（`E_AI_DISABLED`，三入口前置断言）再取证（`{blockedAll:true, localFailed:[], localCount:11}` + step39）。证据原文见 docs/04 §6.5 与 docs/06 §八 第 46–47 轮。

**R48 + R49 补完 J09 成本线遗留（T3-12 至此勾选）**：R48 把 `byChapter` 贯通到面板并落地 `llm/budget.ts`（`parseBudgetConfig` / `lintCost` 四条规则，12 例单测）；R49 把体检真正接进面板——归自然月的「本月已用」（实报优先、缺实报用估算补，两口径分列）、组装实测输入 token **与编排核对共用同一次 preview**、`config/budget.yaml` 解析失败**外显而不静默回落**（追加 error 级 `budget-config-invalid`）、缺输入的规则整条列入 `skipped` 逐条点名。单测 639/639（71 文件）、e2e ✅、预演 **39/39**（终版 v110）。详见 docs/04 §6.3 T3-12 三轮注记与 docs/06 §八 第 48–49 轮。

**R50（M4/T4-1 求值层）已完成**：`@yushu/genre-engine/src/rule-dsl.ts` 落地四道沙箱闸门（操作符白名单 / 禁循环 / 加载期+求值期双深度闸 / **节点计数预算代替墙钟超时**），单测 +34 → 673/673（72 文件），6 次变异全能红；**纯引擎轮未碰桌面端，故没跑 e2e 与预演**（详见 docs/04 §7.3 T4-1 注记与 docs/06 §八 第 50 轮）。**两条与本文上一版建议不同的实现事实，以代码为准**：① `cat` 与 `then/action` **没有实现**——docs/03 §8.2 与 G06 的规则草案本身就没有动作字段，结论文案走 `message` 的 `{占位}`；② `in` 的候选侧支持**字面量清单**（`["爽文","黑深残"]`），这是规则里最常见的写法。

**R51（规则 DSL 桌面端接入）已完成，T4-1 勾选**：内容层加载（`rules.ts`）+ `lintPack` 三条规则检查 + 两个只读通道 `rule:catalog` / `rule:dryRun` + 第 11 个标签页「规则」+ 预演 step40（终版 v114 40/40、e2e 规则探针 `diskUnchanged:true`）。详见 docs/04 §7.3 T4-1 两轮注记与 docs/06 §八 第 50–51 轮。

**R52（结构完整性三条规则）已完成**：`world-engine/consistency.ts` 的 `checkStructure` / `checkStructureFromSources`（真源直算、不读索引），三条规则 + 27 例单测 + 6 次变异（其中一次删掉了无测试可杀的 `seen` 冗余分支）。详见 docs/04 §7.3 T4-2 注记与 docs/06 §八 第 52 轮。**T4-2 未勾选**：八类语义规则与"章节↔大纲"双向对账都还没做。

**R53（报告格式 + 豁免清单）已完成**：`consistency-report.ts` 的 `locateCardRefSpans` / `buildConsistencyReport` / `parseConsistencyAllowList`（详见 docs/04 §7.3 T4-3 注记与 docs/06 §八 第 53 轮）。**T4-3 仍不勾选**：M4 §7.5 A4 要的是"每条发现可**一键跳到**原文区间"，跳转动作属界面，留 R54 一并验收。

**R54（三态时机 + 一致性面板）已完成，T4-4 未勾选**（理由：`post-generate` 还没接在 AI 采纳之后的调用点、"重规则 + AI 采样"未实现、报告不落盘）。详见 docs/04 §7.3 T4-4 注记与 docs/06 §八 第 54 轮。**两个教训值得记**：切标签页会重挂载视图（要跨页保留的状态必须走缓存或上层 state）；探针项目里没有坏数据时"结论 0 + 断言全绿"是空跑，验收要求"能跳到原文"就必须自己造一条再复原。

**R55（批次收口轮）已完成**：e2e 断言具名化、预演有界重试与 `flakySteps` 留痕、T4-11 规则回归集、R46–R55 十轮总复核（并据此更正了 docs/04 的 M3 勾选账本与 docs/08 自身的过度声称）。详见 docs/06 §八 第 55 轮与「R46–R55 批次复核小结」、docs/04 §6.3 / §7.3 / §7.5 的复核注记。**一条方法教训值得带走**："完成"与"勾选"是两件事——连续十轮都在往注记里写"已完成"，却没动勾选框，而交接文档已经在替它宣称"全部勾选"；**声称跑在账本前面，比没做更坏**。以后每轮收口时当场把对应勾选与证据一起落下，别攒到复核轮。

**R56（采纳后即时轻校验接线 + 报告落盘裁决）已完成，T4-4 仍不勾选**：只剩"全书体检（重规则 + AI 采样）"一条，而语义类规则本身属 T4-2 尚未落地——**没有规则就先建采样，是给空集做工程**。详见 docs/04 §7.3 T4-4 第 56 轮注记与 docs/06 §八 第 56 轮。**本轮顺带证实了 R55 具名断言的价值**：首跑红直接点名 `result.consistency.diskUnchanged`，不再靠两份 JSON 逐项 diff。

**R57（第一条语义规则＝派系包规则拿项目数据求值）已完成，T4-2 与 M4 验收 A3 仍不勾选**（八类语义规则只做了战力一类；召回与误报阈值没有真实数据可定，不声称达成）。**本轮最大的一条方法收获已写进 docs/06 §八**：预演 step43 首跑红，先用一次性脚本对真实预演目录跑一遍产品路径确认产品没错，才定位到预演脚本「等了一个上一轮就在的条件」——**新增预演步骤的等待条件必须依赖本轮新数据**，否则测的是历史报告。**R58（全书体检的重规则 + AI 采样核验）已完成，T4-4 已勾选**：确定性采样（无 seed、逐章轮转、UTF-16 区间）+ "AI 只能指认给定片段"（越界与白名单外逐条丢弃并计 `rejected`）+ 只在 `manual` 显式请求时跑 + 三段结论并同一张表 + 每次采样记一条 usage。M4 验收 **A3 仍不勾**（阈值要真实 provider 与真实语料）。详见 docs/04 §7.3 T4-4 第 58 轮收口注记与 docs/06 §八 第 58 轮。**两条方法收获**：① 新断言写完后要拿变异问一句"它能不能红"——本轮自己写的 `counted.findings === counted.findings` 就是永真，靠这一步才发现；② 预演脚本的**解析期**错误没理由花 70 秒才暴露，`prepareWalkthrough` 现在开跑前逐段编译一遍（语义错误仍靠 note 里的原始值归因）。
**R59（外部审计 4 条复验与处置）已完成**：① ② 两条成立并修好（`git:rollback` 与顺带查出的 `ai:saveConfig` 改用 `wrapWrite` + 新增写通道源码锁；`.bak-v1` 迁移备份写盘前脱敏），③ 是有意设计（理由与边界已落 docs/06 §七），④ 是文档承诺大于实现（docs/03 §8.3 改成分层口径）。详见 docs/06 §八 第 59 轮与本文 §3.2 R59 行。**两条方法收获**：a) **回归探针要防"上一步白送脏状态"**——"回滚后是否重算"这条最初不修产品也绿，因为回滚前那次写已经把缓存弄脏了；先洗干净再测才有资格当回归锁。b) **审计指认不等于事实**，四条里两条成立、一条是设计被误读、一条是文档超发——逐条复看的成本远低于照单全改。

**R61（T4-5 桌面侧：提案 + 逐项决策）已完成，A1 勾选、T4-5 不勾选**：见 §3.2 R61 行与 docs/06 §八 第 61 轮。**R60（T4-5 影响传播·引擎侧）已完成**：反向 BFS + 环阻断 + 封顶点名 + 权重 assumed 标注，8 例单测与 6 次变异校准（详见 docs/04 §7.3 T4-5 注记与 docs/06 §八 第 60 轮）。**纯引擎轮，未碰桌面端 ⇒ 本轮没跑 e2e 与 UI 预演**；调用点（落盘 + 面板决策 + 写回真源）在 R61，**T4-5 与 M4 验收 A1 都不勾选**。

**R62（T4-5 收口：`applyProposal` 写回真源）已完成，T4-5 勾选**：只做机械可确定的改名改指；四道闸（全表态 / 只认改名 / 写前强制 `pre_apply_proposal` 快照 / 比对生成时 hash）；`proposal:apply` 走 `wrapWrite`——我第一版写成 `wrap`，被 R59 那道源码锁当场点名。另有一条**未杀到的变异如实登记**：去掉「快照失败即阻断」测试仍全绿（本机快照恒成功），该分支属防御、未声称覆盖。详见 docs/04 §7.3 T4-5 收口注记与 docs/06 §八 第 62 轮。**R63（用户插队的两件事：界面交互精修 + 死代码/冗余清理与 GitHub 展示页）已完成，不推 M4 功能台账**：动效定调 Premium（`Disclosure` 展开容器按**真实内容高度** `0fr→1fr` 连续过渡 + 箭头 180°、按钮 hover/active 微反馈、一次性入场 `yushu-settle`、reduced-motion 同时关 transition 与 animation，**零新增依赖**，`bae9903` / `7605d43`）；预演新增 **step47**（动画中途 60ms 采样取证）；清理侧把 3 个"只有定义没有调用点"的符号分别处置（`stopRepoWorker` **是资源泄漏**已接进 `window-all-closed` + 源码锁、`assertOutlineReadable` 与 `ChannelName` 删除）、剪掉 5 条未使用依赖声明（install 后 lockfile 只减 15 行）、修掉「十个标签页」这类过期注释；对外侧 `README` 按 `docs/04` 实测改写（原文还停在"M2 已收口"）并新增 `CONTRIBUTING` / `SECURITY` / `NOTICE` / `ROADMAP` / `.github` issue+PR 模板。**验证**：892/892（89 文件）、TC=0、E2E=0、预演 **47/47**（v142；先前两次的 v130 号段与账本最大号 v141 倒挂，已重跑取 v142）。详见 docs/06 §八 第 63 轮。**一条方法收获带走**：本轮唯一的新断言是**源码文本级**的（防"以后有人删掉那行"），它防不了函数改名、也观测不到 utility 进程真退出——**这类锁要如实登记弱点**，别拿"测试绿了"冒充运行时验证。

**R64–R73 十轮台账**（顺序说明：用户在批次里显式加了"前端多渠道调研 + 版面优化"，它排在功能台账之前，
功能链整体后移一位；**依赖顺序没变**——伏笔仍是引擎先于桌面，编年史仍复用时间线的数字刻度）：

1. **R64｜前端第二批：中文排版与图标（已完成）**：多渠道调研（CLReq / CSS Text 3&4 / MDN / Chrome 版本公告 / 开源图标集许可页）
   → 取舍清单写进 docs/03 §17.1 → **零依赖落地**：`line-break: strict`、`text-autospace: normal`、`text-spacing-trim: normal`、
   阅读版心 `--prose-measure: 44em`、数字列 `tabular-nums`、`prefers-contrast: more` 只改颜色、
   11 个标签图标（Lucide v1.55.0 ISC，SVG path 逐字复制为 inline 组件，`NOTICE` 已登记）；预演 **step48** 取真实
   computed style 为证。**明确没做**：三层令牌重构（diff 太大，单排 R71）、密度切换（要先拍"界面上给不给开关"）。
2. **R65｜T4-6 伏笔台账（引擎侧）已完成**：`world-engine/foreshadow.ts` 的严格解析 + 确定性序列化 +
   `buildForeshadowBoard` 纯判定（逾期 / 复查 / 密度 / 终局扫描 / 红鲱鱼审计 / 状态与事实矛盾）；
   **三条口径**：合法终态不报缺陷（红鲱鱼 + 放弃带理由 ⇒ 一条都不报，配负例夹具）、报矛盾而不替作者改状态、
   "多少章算干旱"未经真实语料定标故**默认关闭**。为「回收标记」补 `payoff_chapters?` 字段并把理由写进 docs/03 §5.3。
   单测 +20 → **912/912（90 文件）**、TC=0、**变异 4 次全能红**。**T4-6 不勾选**（调用点在 R66）；
   **纯引擎轮 ⇒ 本轮没跑 e2e 与 UI 预演，也不声称跑过**（R60 先例）。
   下一轮 R66 的落点：读 `world/foreshadow.yaml` 的通道 + 世界观档案里的看板与密度提示 + 预演新增 step49
   （**同步 `scene` 的「步骤 10-N」**；改渲染层先 `build:renderer`）。
3. **R66｜T4-6 伏笔台账（桌面侧 + 预演）已完成，T4-6 勾选**：`foreshadow:board` 只读通道（走 `wrap`）+ 世界观档案底部看板；**面板里没有写回/应用按钮**，step49 把 `面板内写回按钮=false` 钉成断言。预演数据**按本项目真实章序现场构造**（先读大纲拿章 id，再写台账），三种样本各验一事：逾期外显 / 红鲱鱼 + 放弃带理由**不被报缺陷** / `paid` 无回收章报矛盾。台账写入走产品写通道（`doc.write` 不带 baseHash=仅允许新建），工装不裸写磁盘。**顺带补一条 R63 欠下的锁**：`CONTRIBUTING.md` 当时声称"IPC 四处同步有源码锁拦住"，其实没有 ⇒ 本轮补 `ipc-four-way.test.ts`（5 例，注释掉 preload 一行即两条红并点名通道）。验证：917/917（91 文件）、TC=0、E2E=0、预演 **49/49**（v147，抖动=0）。**边界**：登记/埋设/回收仍是编辑真源 YAML，无表单录入（与派系包工坊一起评估，不为单个台账开一套表单框架）。
4. **R67｜T4-7 时间线（引擎侧）已完成**：`world-engine/timeline.ts` 严格解析 + 确定性序列化 + `buildTimelineView` + `checkTimelineConflicts`；三条不猜（锚点不为 0 只报不平移、因果按 year 不按数组序、历法认不出给 null），缺 `kind` 逐条进 `notEvaluated`；补 `Event.kind?` 并把理由写进 docs/03 §5.3。15 例先红后绿、变异 5 次全红、全量 932/932（92 文件）、TC=0；**T4-7 未勾**（视图与冲突结论的桌面侧没接）。同轮把 `git-ops` 一条满载超时的测试改成 20s 显式预算（单跑实测 1.79s，改的是墙钟不是判据）。
5. **R68｜T4-7 时间线（桌面侧 + 视图）已完成，T4-7 勾选**：`timeline:view` 只读通道 + 世界观档案底部视图（年份列与刻度列分开、冲突与未判定整块外显）；step50 断言**切历法后真源 hash 未变**；另加 `truth-source-only-views.test.ts` 把 A5 前半变成结构断言（视图模块不许 import 索引层）。936/936（93 文件）、TC=0、E2E=0、预演 50/50（v151）。
6. **R69｜T4-9 关系图谱 + M4 验收 A5 取证已完成，两项同时勾选**（原台账把 R69 排在编年史，实际先做图谱：
   A5 要"图谱与时间线两个视图都齐"，图谱不动 A5 就一直挂空）：`world-engine/relation-graph.ts` 的
   `buildRelationGraph(entities, refs, {focus, maxDepth, relationKinds})`——**图谱只是真源行表的一次投影，不长第二套图结构、不落盘**；
   认不出的 relation 归 `other` 并进 `unclassifiedRelations`（不猜），悬空引用、自环、重复边分别计数，排序走码点序。
   桌面侧 `graph:view` + 自算 SVG 布局（不引 React Flow / G6：为四张面板引两个图形库不值，理由写进 docs/06）。
   **A5 取证**：`truth-source-only-views.test.ts`（结构锁）+ e2e 删库前后逐字比对探针；预演 **step51**。
7. **R70｜T4-8 编年史·引擎侧已完成，本项未勾**：`world-engine/chronicle.ts` 的 `buildChronicle` **吃 R67 的 `TimelineFile`、
   年份一律走 `formatCalendarYear`**（模块自己没有年表结构）；三条不猜各钉一组测试（无视角 ⇒ `culture: null` 中性记载、
   时代边界由调用方给 ⇒ `uneraled` 点名而不塞进最后一段、多文化完全一致 ⇒ `differing:false` 且注明"这本身是证据"）。
   11 例先红后绿、变异 4 次全红、959/95、TC=0。**纯引擎轮 ⇒ 没跑 e2e 与 UI 预演**；界面拆到 R71。
8. **R71｜T4-8 编年史·桌面侧已完成，T4-8 勾选**：`chronicle:book` 只读通道 + `chronicle-ops.ts`（era 区间不齐 ⇒
   `eraSkipped` 点名，不猜边界）+ `ChronologyPanel`（六列，`分歧 N` / `诸说一致` 两种徽标，历法下拉只改显示）+ 预演 **step52**。
   **本轮另修三条"证据看着有、其实不成立"的账**（详见 docs/06 §八 第 71 轮）：① step33 等的是上一步留下的旧节点
   （等待一个已经为真的条件），判据改成"本步特有的预算文本 + 按钮转绿"；② M4 验收 A5 的 e2e 探针原来比的是两个空视图
   （`edges:0 / timelineRows:0`），补夹具与两条非空性断言，并分别变异打红；③ 世界观档案四张面板被定高网格压字
   （`.panel{min-height:0}` 让 auto 行基准高变 0、行高被视口均分），新增 **step53 布局回归锁**先红后绿。
   验证：**962/962（95 文件）**、TC=0、E2E=0、预演 **53/53**（v162，抖动=0、证据缺失=0）。
9. **R72｜T4-10 爽点与期待感（引擎侧）已完成，本项未勾**：`world-engine/satisfaction.ts` + 真源
   `world/satisfaction.yaml`（`hits` / `promises` / `curve` / `scenes` 四张表，严格解析 + 手写键序序列化）；
   15 条判定，三条不猜（无场景声明 ⇒ 推进率 `null` 且不判定；五个阈值旋钮不设就不跑、逐条进 `notEvaluated`；
   章号认不出给 `null` 并点名 `sf-chapter-unknown`）。**与伏笔台账按 I03 §2.2 划清**（载体不同、
   用 `foreshadow_id` 交叉引用、不重做一套伏笔逾期），**与 T3-13 的注水检测划清**（那边是字句级 lint，
   本模块一个字节都不读）。27 例先红后绿、**变异 5 次各红 1 例**、全量 **989/989（96 文件）**、TC=0。
   **一条被变异抓出来的漏测值得带走**：把**行级** `advanceRate` 写死成 1 第一次跑全绿——测试只断了全书均值，
   行级字段没人看着 ⇒ 补两条断言才红。**"字段存在但没被断言"就是死字段**，界面要用的那一层必须自带断言。
   **纯引擎轮 ⇒ 没跑 e2e 与 UI 预演**；通道 + 面板 + step54 在 R73。
10. **R73｜T4-10 爽点与期待感（桌面侧）已完成，T4-10 勾选**：`satisfaction:board` 只读通道（`wrap`，
    四处对账逐条点名）+ `satisfaction-ops.ts`（读真源 + 三级大纲有序章清单；**台账读不了就出 note 不出结论**，
    不退回"空台账"）+ `SatisfactionPanel`（世界观档案第五张面板）。界面上三条口径：
    **结论块与「没判的」块分开**（虚线框 + 引擎理由原样显示，把"没判"显示成绿灯比不显示更坏）、
    推进率三态（100% / 0% / **无声明**）、六个阈值输入框留空即不传（占位符写"不判定"，不给默认值）；
    面板内**没有写回按钮**（断言 `按钮数=0`）。预演 **step54** 按项目真实章序造夹具（逾期承诺 /
    dropped 无理由 / paid 无证据 / 场景 advances 自相矛盾 / 曲线中间断档），回执
    `结论四类齐=true；断档点名 co-zpxusg=true；逾期外显=true；无声明显示=true；阈值未设进「没判的」=true；
    设阈值后改出结论=true；面板内写回按钮=0；真源 hash 未变=true`。
    **两条断言写法直接吃了 R71 的教训**：设阈值后等的是"该规则从『没判的』里**消失**"而不是等节点存在；
    改完阈值重新 `doc.read` 比 hash ⇒ "阈值只是显示参数"成为运行时事实（同 step50 历法口径）。
    **一条调研结论被代码复核纠正**：子代理说 `scene_ids` 可作推进率数据源，grep 后确认该字段
    在 schema 里有、**没有任何写入方**（F03 场景卡从未实现）⇒ "字段存在"≠"数据存在"，已写进面板底部说明。
    验证：991/991（96 文件）、TC=0、E2E=0、预演 54/54（v163）。**边界**：登记仍是编辑真源 YAML（无表单）；
    引擎不判断"这章读起来爽不爽"，只做间隔与计数。下一轮 R74＝T4-2 语义规则第二批。
11. **R74｜T4-2 参与表改数据驱动已完成，T4-2 仍不勾**：`@yushu/genre-engine` 新增 `collectVarReferences(expr)`
    （收集表达式里的 `var` 路径），`rule-findings.ts` 删掉手写名单 `POWER_PAIR_RULES`，改成
    "先把战力相邻对一次拼好 → 每条规则逐个 `readPath` 比对 → 全取到才求值，否则进 `notEvaluated`
    并**点名缺哪些具体路径**"。动因有两条，第二条更要紧：旧名单会把"项目里没有战力台账"说成
    "`power-no-regress` 参与求值了"，**伪造的是结论的覆盖面**。
    **一条被测试逼出来的口径收紧**：改完 `consistency-ops.test.ts` 的"未参与点名"用例当场红——
    取证确认该夹具确实没有战力卡 ⇒ 旧断言编码的正是上面那个毛病，按新语义重写并补"数据齐时必须参与"的另一半。
    **改测试是因为测试测错了东西，不是为了让它绿**（这条区分写进了测试注释）。
    step43 断言同步从泛词"数据绑定"改成具体路径 `scene.combat_power`（更强）。
    验证：6 例先红后绿、997/997（97 文件）、TC=0、E2E=0、预演 54/54（v165）；**变异 3 次全红**
    （恒通过 4 红 / 恒不通过 2 红 / var 清单恒空 7 红），还原后 sha 逐字一致。
    **明确不做并写理由**：视角 head-hopping 与信息可见性**当前无数据源**——章节 `pov` 在模型与 schema 里都有，
    但 `grep apps/desktop` 零写入点（与 R73 的 `scene_ids` 恒空同类：**字段存在 ≠ 数据存在**）；
    没有视角标注就硬做越视角判定只能靠关键词猜，误报会让作者学会忽略整块看板。
12. **R75｜伏笔结论并入全书体检已完成，T4-2 仍不勾**：`foreshadowReportFindings` 把引擎结论**原样投影**成报告条目
    （判定零重写）+ `ledger-spans.ts` 按条目 id 在 `world/foreshadow.yaml` 里定位原文（定位不到就不给 span 键）+
    `FORESHADOW_RULE_IDS` 进 `knownRuleIds` 并配覆盖锁（漏一条就会"报得出来却豁免不掉"）。
    **自己的新测试抓到一个真缺陷**：「第 1 章」这类自然章号被判悬空——`chapterIndex` 的数字回退只比
    "id 里带的数字"，而大纲 id 是随机后缀 ⇒ 补第二层回退（先认 id 内数字，再认有序清单第 N 位；超界仍 null）。
    先写测试看它红再改绿。step49 扩了运行时证据（`体检同表含伏笔结论=true`）；变异：摘掉同表 ⇒ 3 条新测试同红。
    验证：1010/1010（98 文件）、TC=0、E2E=0、预演 54/54（v167）。顺带给 `git-ops` 的"整体回滚"补显式 20s 预算
    （98 文件满载越 5s 闸；单跑实测 945/952ms，改预算不改判据、不动全局 testTimeout）。
13. **R76｜T5-7 存量导入·引擎侧第一段已完成，T5-7 未勾**：`@yushu/text/import.ts` 四个纯函数——
    编码探测（BOM → 严格 UTF-8 → GB18030 兜底，兜底时 `assumed:true` 明写「这是猜的」；空字节连猜都不猜）、
    清洗（行尾归一 / 规则删行留样例与计数 / **疑似密钥剔除单独计数** / 空行折叠；坏正则抛错不静默跳过）、
    规则海选分章（认「第 N 章/节/回/Chapter N」才切，认不出整篇一章并说明；第一章前进 `preamble`、
    卷标题进 `volumeHints`）。**只覆盖任务文本前三步**：AI 筛选、误切校正、字数对账、实体抽取候选、
    可中断续跑**一步都没做**。18 例先红后绿、全量 1028/1028（99 文件）、TC=0、**变异 5 次各红 1 例**；
    **纯引擎轮 ⇒ 没跑 e2e 与 UI 预演**。夹具教训：`Buffer.from(s, "gb18030")` 在 Node 里直接抛
    `ERR_UNKNOWN_ENCODING`（Buffer 不支持 GB18030 编码方向，只有 TextDecoder 能解）⇒ 改用 iconv 真字节。
14. **R77｜T5-7 桌面侧第一段：导入挑选闸门已完成，T5-7 未勾**：`import-gate.ts`——路径只能由主进程原生
    对话框结果 `register()` 进来（验存在 / 是文件 / ≤32MB 才发票），渲染层此后只回传 10 分钟 TTL 的 ticket，
    取消即 `revoke`。**本轮无对外行为**（通道与面板在 R78）⇒ 不跑 e2e 与 UI 预演。11 例先红后绿、
    全量 1039/1039（100 文件）、TC=0。
15. **R78｜T5-7 桌面侧第二段：挑文件 + 预演已完成，T5-7 未勾**：两条**只读**通道 `import:pick` /
    `import:preview`（`import-ops.ts`，注册在 `wrap` 上并被 NON_WRITE 清单点名）+「稿件总览」折叠面板
    `ImportPanel`。三条硬口径：路径不出主进程（`pick` 只回 `{ticket, name, bytes}`）、正文不过 IPC
    （只回每章 `chars` 与 ≤80 字摘录；`chars` 用编辑器同一个 `countWords` 口径，R79 的字数对账靠它对得上）、
    这一段零写入。猜的编码挂「这是猜的」横幅、切不开显示"没找到章节标题"、密钥剔除单独计数、
    生效规则一并列出；**面板没有「确认入库」按钮并把这句写在界面上**。默认清洗规则三条 + 可追加自定义正则
    （坏正则抛错不静默跳过；ReDoS 挂起保护待 worker 化，边界写进注释）。19 例先红后绿、变异 5 次各红 1 例
    （含"预演偷写缓存文件"用来证明零写入断言能红）、全量 **1061/1061（101 文件）**、TC=0、E2E=0、
    预演 **55/55**（v174，抖动 0、证据缺失 0）。**顺带纠正一条长期误判**：step21 的"↓ 后高亮必须在第 2 项"
    其实是把**鼠标停在候选菜单上**当成了产品契约（`onMouseEnter` 会挪走 active，组件 `(active+1)%n` 正确）；
    已改断言"↓ 移动一格 + 回车插入的正是那一格"并打出实际项名 ⇒ 见 §1 表格与 docs/06 §八 第 78 轮。
16. **R79｜T5-7 桌面侧第三段：确认后建卷建章已完成，T5-7 未勾**：`import:apply` 是这条线**第一条真源写通道**
    （走 `wrapWrite`，WRITE_CHANNELS 点名）。建一卷 + 每章一条章纲（回填 `chapter_id`）+ 每章一个草稿文件；
    **章纲六项一律留空**（反推细纲是猜测，空着比编着诚实）。七条口径见 docs/04 第 79 轮注记，其中三条最要紧：
    预演与入库**共用同一条管线**（否则字数对账不可比）、**载荷里没有正文**（改不了要写什么）、
    **先大纲后草稿**（宁可留看得见的缺草稿，不留看不见的孤儿文件）。两层并发保护（预演回报 `outlineHash`
    → 确认时预检 + 写盘带 baseHash）、破坏前强制快照、逐章读回对账（对不上进 `mismatched` 不回滚不静默）、
    票据成功即作废而**失败不作废**。两条"不替作者猜"的闸：没切开必须显式勾选（未勾选时按钮禁用）、
    幕名认不出报错并列出可选。楔子不入库也不静默丢。项目没有大纲时自建最小一份（冷启动入口不能依赖 AI）。
    走查拆两步：step55 只看预演（真源未变），step56 才点入库（12 项断言）。
    **三条工装事实被走查抓出**（都不是产品缺陷但会伪装成）：折叠区点击不幂等（重试时再点一次就把它关掉）、
    稿件总览是虚拟滚动（新行不在 DOM 里，要靠过滤框）、`project.tree()` 含目录条目（数文件要按 type 收窄）。
    15 + 3 例先红后绿、**变异 7 次**（含"写序颠倒 + 去掉冲突预检"这个组合——单改写序杀不到孤儿断言）、
    全量 **1081/1081（102 文件）**、TC=0、E2E=0、预演 **56/56**（v177，抖动 0、证据缺失 0）。
    **T3-14 不由本轮收口**（上一版台账写的是"顺带收掉 T3-14"，那句不成立，已更正）：T3-14 缺的那半是
    "**导入或导出项目**时自动剔除密钥"，指的是**项目打包 / 迁移**（等 T5-4 导出链路与备份通道才有调用点）；
    稿件导入里的密钥剔除属清洗阶段就地替换（R76 起），两件事不是一回事，别拿后者勾掉前者。
    **T5-7 仍不勾**：AI 二次筛选切章、误切校正、实体抽取候选、可中断续跑状态机都没做。
17. **R80｜治理与安全余账·第一批已完成**：① **provider 错误回显脱敏**——`postJson` 把响应体前 300 字
    拼进 `E_LLM_HTTP` 消息，而有些网关会把收到的请求头原样贴回 401 body（正好带着 `Bearer sk-…` /
    `x-api-key`）。新增 `redactSecretsInText`（与 `detectPlaintextSecrets` 同一批高置信形态）在唯一
    收口处套用：字段名留下、值换掉、非密钥文字与状态码原样保留。② **`audit` 登记进默认路由**
    （R58 的采样核验一直在传这个 task id，但表里没有 ⇒ 档位落到 provider 原顺序、`require` 空 ⇒
    不支持结构化输出也不标 unmet）；补成与 `extract` 同类。③ **排除清单三向一致锁**
    （`GIT_EXCLUDES` ≡ `DEFAULT_INDEX_EXCLUDES` 逐字等集、`WALK_EXCLUDES` 是其子集、
    `exports/` 的反向不对称是**刻意的**并在测试注释里写明）。
    **④ `restoreDoc` 带 baseHash：裁决为不做**——`restoreSnapshotLocked` 在任何写之前已强制
    `pre_restore` 快照（拿不到即中断），被覆盖内容全部取得回；再叠 baseHash 只会让"撤销"在最常见
    场景（改了几轮再退回）里失败。**登记为不做而不是从清单擦掉**，下次审计再提时有结论可引。
    验证：11 + 4 例先红后绿、全量 **1096/1096（103 文件）**、TC=0、E2E=0、预演 **56/56**（v178）、
    **变异 5 次全能红**（含"只给 git 加 `imports/` 而索引不跟上"这个真实漂移场景）。详见 docs/06 §八 第 80 轮。
18. **R81｜社区健康文件补齐已完成，§11.6「健康文件齐备」门槛当场勾选**：`CODE_OF_CONDUCT.md`
    （适用范围含项目空间与公开空间 / 四级处置阶梯 督促→警告→临时封禁→永久开除 / 三条**真实可用**举报渠道）、
    `GOVERNANCE.md`（贡献者→复审者→维护者→核心团队 的准入与撤销、决策记录去向、独立 moderation、
    **核心离线能力永久免费 + 商业化只做可选服务 + 不牺牲数据主权**、继任与停维护处置）、
    `CODEOWNERS`（按领域拆，现在四行同一账号是事实不是缺陷——拆开是为了将来只改一行）、
    `.github/ISSUE_TEMPLATE/pack_submission.yml`（派系包是数据：只问许可、来源、lint 实测输出）。
    三份模板补行为准则勾选项；`SECURITY.md` 补支持版本范围与确认 7 天 / 高危 30 天 / 一般 90 天时限。
    **三份"不做"**：不复制 Covenant 全文（写实际会执行的版本）、不虚构举报邮箱、不虚构治理编制
    （第一句就写明单人维护）。
    新锁 `governance-docs.test.ts` 21 例：只钉可被问责的具体条款 + 一条**反漂移**
    （账本已动过的里程碑，ROADMAP/README 状态格不许写「未开始」；"动过"含"留了进展注记但没勾完"，
    T5-7 正是这一类）。**本轮抓出自己写的假锁**：反漂移那条最初把文件名拼进断言主语，
    `^` 锚在文件名上 ⇒ 永远不可能匹配，第一次变异跑出来全绿；改成断言状态格本身后立刻转红。
    **教训：诊断信息走 `expect(value, message)` 第二参，别拼进主语。**
    另记一条变异脚本自身的坑：`replace(字符串)` 只换第一处，CODEOWNERS 里 27 次只换了 1 次
    ⇒ 锁"没牙齿"是假象，批量替换一律 `split(from).join(to)`。
    验证：21 例先红后绿（首跑 11 红）、全量 **1117/1117（105 文件）**、TC=0、**变异 6 次各红 1 例**、
    还原后逐字一致。**纯文档与锁轮 ⇒ 未触运行时代码，没跑 e2e 与 UI 预演，也不声称跑过**。
    **余账**：SPDX 文件头仍缺（§11.6 第一条保持未勾，单开一轮 + 能红的抽样断言）；CI 完全没有（§11.6 第三条）。
19. **R82｜SPDX 文件头批量 + 流式错误出口复核已完成，§11.6「LICENSE+NOTICE+SPDX」门槛当场勾选**：
    295 个既有源文件加首行 `/* SPDX-License-Identifier: Apache-2.0 */`（shebang 入口 2 个落第二行，扫描范围实测 297 个文件），
    锁 `spdx-headers.test.ts` 4 例（扫描下限 ≥290 + 三个具体路径抽查 / 逐文件头比对 / shebang 例外名单锁死 /
    与根目录 LICENSE+NOTICE 同源）。**这条锁当轮真的红过**：批量加头后我又新建了一个测试文件，
    全量跑直接点名 `missing=["packages/@yushu/llm/test/stream-error.test.ts"]`。
    **顺带查出两件比"泄漏"更常发生的真缺陷**：`openai.ts` 与 `gemini.ts` 的 SSE 读取器
    **把 provider 在流里回的 `{"error":…}` 当心跳丢掉**——不报错、`ok` 为真，
    于是**半截稿子被当成完整候选、甚至被采纳进正文**（静默截断比明确失败坏得多：作者不知道少了什么）。
    两处改为抛 `E_LLM_STREAM`（详情先脱敏再截 300），openai 的 `catch` 补
    `if (err instanceof LlmError) throw err;`（否则流错误被外层改写成"网络中断"），
    三条网络兜底消息（openai/gemini/anthropic）由裸 `String(err)` 改为过 `redactSecretsInText`，
    错误事件之后的增量不再计入正文。新锁 `stream-error.test.ts` 8 例。
    **本轮最大的收获在变异环节：变异脚本两次伪装成"锁失效"，两次都不是锁的问题**——
    ① 脚本用 LF 拼多行模式而源文件是 CRLF ⇒ `includes` 试了两种行尾所以报"命中"、
    `split(from).join(to)` 却只用 LF ⇒ **静默没替换**，输出"无汇总"看着像锁不红。
    与第 63 轮"清扫脚本根目录写错=等于没扫"同族：**检查器的 bug 会表现成"被测代码没问题"**。
    ② 另一版变异删了 `if (…) {` 行首留下右括号 ⇒ 编译不过，**"改到语法不合法"不证明锁防的是语义退化**；
    换成恒假条件后立刻红。最终 6 次变异全部退出码 1（M1d 2 红 / M2 1 红 / M3d 1 红 / M4 1 红 / M5 1 红 / M6 1 红），
    还原后逐字一致。四个一次性脚本用完即删，删后未跟踪项只剩两个新测试文件。
    验证：全量 **1129/1129（107 文件）**、TC=0、E2E=0、预演**全新 v179** **56/56**（61.9s，
    `证据缺失=0`、`抖动=0`，截图复看过 `step55-import-preview.png` 确认区块在画面里）。
    **余账**：`usage` 日志那条出口查了——落盘是结构化字段而非拼好的错误串，本轮判为不需要额外脱敏
    （若将来把原始响应体写进日志要重开这条）；CI 仍完全没有（§11.6 第三条）。
20. **R83｜性能与包体测量已完成——结论是"两个都不做"，而且推翻了我自己开场那个假设**：
    ① **修掉一条不会红的门禁**：`perf-runner` 逐项算出 `checks`、终端打印 ❌，最后无条件 `app.exit(0)`。
    现在抽 `summarizePerfGate`（12 例）按它给退出码，并**拿真探针校过能不能红**
    （预算 2000→1ms ⇒ 退出码 1 且点名 `未达预算=[cold_to_editable]`，还原逐字一致）。
    ② **口径**：绝对预算翻红；**相对回退只报告不翻红**——同一份构建连跑两遍实测
    `cold` 3160→1434ms、`keystroke_mega` 2.8→3.6ms（+28.6%）、`chapter_write` 13→16ms（+23.1%）。
    ③ **开场假设"包长到 1.5 MB ⇒ 冷启动必然回退"被实测否证**：R36 热盘 1885ms vs 本轮热盘 1445ms，
    没退还更快 ⇒ "修冷启动"这件事取消。
    ④ **拆包裁决：不做**。新量的两项首屏指标（`module_exec` 136–139ms / `fcp` 200ms，
    纯函数 `summarizeRendererBoot` 归一 6 例，**只记录、暂不设预算**）显示：
    首屏脚本执行只占 `cold_to_editable` 的 ≈9.4%，拆到极限也就省这些，
    代价是 11 个视图各加异步边界与加载态。包体构成（sourcemap 129 条 sources / 4,044,437 原始字节、
    未归类 0）：CodeMirror 系 ≈32.7% + TipTap/ProseMirror 系 ≈20.9% + `react-dom` 15.7%，
    **自己的渲染层代码只占 10.9%**。
    ⑤ **CSS 三层重构也不做**：普查 2939 行 / 1442 声明 / `var()` 已用 246 次，
    `:root` 外字面量只剩 26 处 ⇒ 为 20 来处做全表改写收益不抵风险。
    实际做的是收口 18 处 + 新增 10 个语义令牌 + **棘轮锁** `css-token-ratchet.test.ts`（5 例：
    字面颜色上限 1、三处时长逐条登记、新令牌必须被用、高对比覆盖须对应已有令牌）；
    变异实测：把一处 `var(--heat-l1)` 改回字面量 ⇒ **2 条同时红**。
    ⑥ **加指标之前先把地基弄平**：`perf-budget.yaml` 与探针内 `BUDGETS` 两份定义靠注释维系，
    `BUDGETS` 搬进 `perf-budgets.ts` 并配 `perf-budget-sync.test.ts` 4 例双向对账
    （**实测当前一致、无既存漂移**；变异 80→81 立刻点名）。
    ⑦ 一条自查脚本自己的 bug 也落档：普查脚本按行剥注释时 `continue` 掉了整块注释 ⇒
    **注释之后所有行号整体前移十几行**，报出来的"第 2430 行"根本不在那儿（计数对、定位错）。
    改成"注释换成等长空格、不删行"后行号才与文件对齐。**检查器给出的位置信息也要能被复核。**
    验证：全量 **1153/1153（110 文件）**、TC=0、E2E=0、预演**全新 v180** **56/56**（62.3s，
    抖动=0、证据缺失=0）；CSS 属视觉改动 ⇒ `step18-stats.png` 与 HEAD 那版逐块对照，
    右下角棕色长条两版都在（单日数据下 30 天柱状的既有画法，非本轮引入）。
    报告留档 `docs/assets/perf/perf-report-local-dev-20261014-r83-perf-gate.json`，
    数字与口径同时写进 `perf-budget.yaml` 的 measurements 与门禁注释段。
    **T2-10 仍不勾**：任务原文要"被 CI 与本地共用"，CI 至今没有。
21. **R84｜T4-11 阈值做成可配置已完成——但把指标名字改回了它真正是什么，故 T4-11 仍不勾**：
    新增 `@yushu/world-engine/rule-stats.ts`（可选文件 `config/consistency-thresholds.yaml` 严格解析 +
    `computeRuleNoise`），主进程读阈值、算逐条规则的**豁免率**并入 `consistency:check` 载荷，
    规则页新增「规则豁免率」表。
    **为什么不叫误报率**：产品拿得到的只有"作者豁免了哪些结论"（A6 审计入口，每条带理由），
    而豁免既可能是"报错了"也可能是"确有问题但选择留白"——拿混合信号冒充 ground truth，
    等真有标注语料时历史数字就说不清口径了。面板里这句"豁免率不等于误报率"也原样写给作者看。
    **四种判定里两种是"没判"**（`not-configured` / `insufficient-sample`），界面上必须与 `ok` 不同：
    中性色 + 文字写明"不判"；分母为 0 给 `rate: null` 不编造 0%；阈值文件读不了 ⇒ 不判且错误外显。
    **变异 7 次全能红**，第 7 次改的是界面文案（把"样本不足，不判"标成"正常"）⇒ 预演
    `step41 FAIL、ok=55 fail=1、退出码 1`——这条最值得记：它证明"没判的不许看起来像没问题"
    这句主张**在界面上也有牙齿**，不只是引擎里的枚举值。
    两条自己踩的坑一并落档：① step41 新写的 `doc.write` 不带 baseHash，重试第二遍撞上
    `[E_DOC_CONFLICT] 文件已存在（未携带 baseHash，禁止盲写）`——**改的是脚本不是产品**，
    这恰好是反向证据：真源写入闸门连预演工装自己不规范时也照样拦；
    ② 那次变异预演把 `docs/assets/m1-preview/` 的 56 张图与报告覆盖成带错标签的版本 ⇒
    还原源码、重建产物、**重跑 v183 复绿**并打开 step41 截图复看。
    **教训：变异预演会写留档目录，跑之前就该想到跑之后要重出一版干净证据。**
    验证：全量 **1166/1166（112 文件）**、TC=0、E2E=0、预演 v183 **56/56**（抖动=0、证据缺失=0）。
    **T4-11 仍不勾**："校准"那一半要标注语料（外部条件③），且豁免率的历史记录才开始攒。
22. **R85｜T4-12 平台规则包机制已完成并勾选——M4 功能任务只剩 T4-2 与 T4-11**：
    `RULE_KEYS` 放开 `version` / `effective_from` / `effective_until`（R84 台账点名的前置），
    引擎 `mergeRuleSets` + 桌面 `applyRuleMerge` 落实 docs/03 §8.3 的"高版本胜出、并列交用户裁定"，
    生效日期的判定日期由**主进程**传（引擎内不读墙钟，取 UTC 今日），规则页外显合并行与
    "本轮未判生效期"提示。**三条字段口径**：版本号**必须带引号**（YAML 把 `1.10` 读成 `1.1`，
    尾零在解析阶段就丢，"顺手转字符串"等于换掉作者写的值）；比较按**数值段**不按字典序；
    缺版本按最旧算**且不报错**（现存包件都没写，报错等于把包判死）。
    **"没有消费者就不算做完"这条又用上一次**：`effective_from` 若没人读，它就是包件里一段没人看的注释，
    而面板看起来像"规则都在有效期内"——所以本轮加了 `dateCheck === "applied"` 的接线锁
    （R59 批评 `priority` "解析了却没有消费者"的同一件事，这次不留到下轮）。
    **自抓两处**：① `applyRuleMerge` 最初用全局 id→rule 表取本体 ⇒ 出处写新包、求值旧包那条，
    被刚写的那条测试当场抓到（那条测试的存在理由就是它）；
    ② **变异 M6 第一次没红**——改的是调用方的 `errors.push`，断言却在 `applyRuleMerge` 上
    （跨层断言管不到调用方，R82 第 7 条）⇒ 把成品文案 `errorLines` 的产生挪进被测试的函数，
    同一变异立刻转红。6 次变异最终全部退出码 1、还原逐字一致。
    **一条新的显示层教训**：Read/Grep 的**显示**把文件里的 `2026/01/01` 渲染成 `2026-01-01`，
    害我连续两次 Edit 报"0 occurrences"并差点去"修一个不存在的错测试"；
    用码点 dump 与 `String.fromCharCode(47)` 布尔判定才确认**断言本来就对**。
    ⇒ **字符级事实（分隔符、全半角、不可见字符）不能只看渲染文本，要用码点或布尔判定核对。**
    **一次未复现的预演中止**：四连最后一步 v186 在 step34 之后静默中止（退出码 1、无"执行中断"行、
    无 `DONE`），紧接着 v187 一次过 56/56。按"连续两轮同样红才追根因"本轮不追，
    日志与目录都留着备查（`D:\Temp\r85-walk3.log`、`D:\Temp\yushu-walkthrough-v186`）。
    另记一条工装口径：**改完引擎包要先 `pnpm -r --filter @yushu/genre-engine --filter @yushu/world-engine run build`**
    ——桌面端 typecheck 解析的是包 `dist` 类型，不重建就报 "has no exported member 'mergeRuleSets'"。
    验证：全量 **1186/1186（114 文件）**、TC=0、E2E=0、预演 v187 **56/56**。
    **边界**：五个平台包内容与生效日期的真实校准在 M5 填；同 id 规则不做语义 diff（并列即点名）。
23. **R86｜本批十轮（R76–R85）总复核已完成**，结论与改动：
    **三条勾选逐条指回锚点，全部成立**（§11.6 两条 + T4-12）。**没有发现"勾了但没做"或"做了但没记"的账**，
    抓到的是四处**对外与结构层面的滞后**：
    ① README 的测试数停在 R83 的「1153 例 / 110 文件」；
    ② 交接文档 **§7 的命令注释停在 R84 的「1166/1166（112 文件）」而 §1 已走到 1186/114**
       ——同一份文档两处不同步，且发生在一轮之内；
    ③ **§1 那句"当前进度"停在 R58 的口径**（"T4-1 / T4-3 / T4-4 已勾选；T4-2 / T4-11 已落地但验收未齐"、
       "T4-11 阈值仍写死 0"），**落后 28 轮**——开头这句是接手者唯一会先读的话，
       少报进度的后果是"重复劳动"而不是"误判已完成"；
    ④ `docs/06` §八 里**第 85 轮的整节被插到第 84 轮之前**（我 R85 那次编辑锚错了位置）。
    四处全部改正，并把前三类立成**会红的锁**：`governance-docs.test.ts` 新增三条对账
    （README↔§1、§7 每一处「期望 N/N（M 文件」↔§1、§1 的「M4 进度：已勾 N/M（未勾：…）」↔`docs/04` §7.3 实况），
    第三条带**绝对下限**（M4 必须解析出 12 条，防"正则坏了 ⇒ 零命中冒充一致"）。
    ①③ 是**到货即红**（加进去时 README 正落后、§1 正缺标记，当场各红一次）；
    ② 用变异复测（把 §7 改回旧数）⇒ 红并点名 `1166/112（基线 1188/114）`，还原逐字一致。
    **两条方法论收获**：**逐文件例数只能用 runner 的输出核**，`grep -c "^ *it("` 数不到循环动态生成的用例
    （把 21 数成 7，差点误报"台账夸大"）；**核对工具报错先确认是谁错**——我按 `.github/CODEOWNERS` 去找
    报了假 MISS，实际文件在仓库根且锁读的也是根路径，账本没错。
    另**反向验了一条对外声称**：CONTRIBUTING 说"新增 IPC 通道四处同步，仓库里有源码锁会当场拦住"——
    删掉 `preload.cjs` 里 `import:apply` 那一行 ⇒ `ipc-four-way.test.ts` **2 例转红**，还原逐字一致
    （第一次尝试命中=FALSE：我在 preload 里找驼峰键而不是通道串）。
    验证：**1188/1188（114 文件）**、TC=0；本轮未触运行时代码 ⇒ 不跑 e2e 与预演，也不声称跑过。
24. **R87｜M5/T5-4 第一段：导出能力判定与探测已完成，T5-4 不勾**：新建 `packages/@yushu/export/src/formats.ts`
    （纯判定 11 例：`assessExportFormats` / `interpretEpubCheck` / `epubGatePassed`）与
    `apps/desktop/src/main/export-tooling.ts`（可注入外部命令层 12 例：探测 5 + `onceTooling` 2 + 转换与门禁 5），
    导出预览新增 `capabilities` + `capabilitiesNote`（`export-ops.test.ts` 3 例：与现场探测判定一致 / 全程只读 /
    探测抛错只让矩阵留空），「导出与自查」页新增能力面板，预演新增 **step57**（只钉与机器无关的五条口径）。
    **本机实测事实**：pandoc 2.10 的输出格式表里有 `pdf`，七个 PDF 引擎**零安装** ⇒ PDF 判「暂不可」；
    EPUBCheck jar 不在 ⇒ 门禁"未校验"。**探测串行 1853ms → 并发 565ms**（同机同会话实测，且 `spawnSync` 换
    非阻塞 `spawn`——原来七次同步 `where` 会按住主进程事件循环约 1.3s）。
    **一条被预演撞出来的真缺陷**：v188 的 step7 抖动（`flaky:[7]`）根因是首帧预览变慢后「我已核对…」
    会被 `setReviewed(false)` 静默冲掉——改成"摘要未回前复选框 disabled"，v189/v190 均 `attempts=1`、`flaky:[]`。
    **方法收获**：与第 59 轮"抖动不进退出码"同族但方向相反——**抖动先归因再定性**，只看"最终 57/57"会把缺陷留在产品里。
    **变异校准 8 条全能红**（逐条还原后逐字校验一致）：EPUBCheck 不在当跑过 / 只看 pandoc 认不认 pdf / epub2 顶替 epub3 /
    jar 不在也 spawn java / 退回串行（`expected 1 to be ≥ 9`）/ 不显式要 epub3 / 抛错不兜住 / 失败探测留在缓存。
    其中并发那条是**收紧后**才红得下来的（原写 ≥ 4，把两条 pandoc 串起来照样绿）。
    验证：全量 **1214/1214（116 文件）**、TC=0、E2E=0、预演**全新 v190** **57/57**（抖动 0、证据缺失 0）。
25. **R88–R97 十轮台账（R87 收口时排定，按实际工作量滚动重排）**：
    R88 `test/` 纳入 typecheck **已完成（本轮）**：实测存量 75 条（desktop 62 / world-engine 11 / genre-engine 1 /
    llm 1，其余 7 包 0），逐条修完（其中三条是**源码或助手的类型在说谎**：`previewPropagation` 少写 `to`、
    `hit()` 助手把六选能力写成三选、`rule-regression` 用 `typeof CLEAN` 锁死夹具）；11 个包各加
    `tsconfig.test.json`（noEmit）接进 `typecheck` 脚本；新锁 `typecheck-coverage.test.ts` 23 例 + 3 条变异全红。
    详见 docs/06 §八 第 88 轮。
    R89 T5-4 第二段——导出源装配 **已完成（本批第 3 轮）**：`@yushu/export/markdown.ts`（`buildMarkdown` /
    `buildPandocMetadata` / `yamlScalar`，12 例 + 7 条变异全红且红得对位），三条"不做"是这一层的全部价值
    （不重排正文 / 不手搓目录 / 不读墙钟）；顺带让 `buildTxt` 出口自己按 `byOutlineOrder` 排（比较器导出共用），
    并加一条跨产物断言钉"章序与剥离口径一致"。**R88 扩面的门禁当场兑现**：本轮自己写的新测试被判出
    `TS18048`，且顺手把一条"两边都乱序也会绿"的弱断言改成"两侧位置都必须递增"。
    **本段仍无消费者**（R90 接进 `runExport`），T5-4 继续不勾。验证：1249/118、TC=0、E2E=0、预演 v191 57/57。
    R90 T5-4 第三段——`runExport` 的 format 参数与真实 EPUB/DOCX 产出 + 门禁接线 **已完成（2026-10-15）**：
    产品第一次真出非 TXT 格式，step58 在本机真跑出 5747 字节的 EPUB（zip 头 `PK`、含 `mimetype`）+ 500 字节 `.md` 源，
    回执写「EPUB 质检：未校验」。四条口径见 docs/06 §八 第 90 轮。
    **两条自己抓出来的账**：① v192 的 step58 红出"给 pandoc 传相对路径"这个真缺陷（spawn 的 cwd 是 apps/desktop），
    修完补了 `isAbsolute` 断言；② 变异 M1「删掉外层能力守卫」测试没红——两层都报"缺引擎"时只断言错误消息等于
    没断言是谁报的，改成断言错误码（`E_EXPORT_FORMAT_UNAVAILABLE` vs `E_EXPORT_CONVERT`）后立刻转红。
    另把 CSS 棘轮的例外登记从**行号**改成**选择器=字面量**（加一条 `.chip:disabled` 就让三条登记全体漂移）。
    验证：1255/118、TC=0、E2E=0、预演 v194 58/58。**T5-4 仍不勾**：PDF 真实产出（缺引擎）、K11 平台章节格式适配、
    EPUBCheck jar 接入三条还在。
    **R91（R89 插轮）红线与代码对齐 已完成**：实测生产代码 **15 处 `.localeCompare(`**（12 处不传 locale、
    3 处显式传中文 locale 做显示排序）。**核出处时发现我 R89/R90 的台账口径偏高**——这条"确定性用码点序"
    从没进过 `docs/03` §1.2 的规范红线表，也不在 `GOVERNANCE.md` 那五条里，只在轮次记录与代码注释里出现过。
    所以本轮不是"改代码去追一条红线"，而是**先把规矩写成规范条目**（`docs/03` §1.2 新增"顺序必须可复现"一行，
    含精确口径与唯一例外），再落实现与判据：新增 `@yushu/core/order.ts` 的 `codePointCompare`，
    改掉 13 处调用，把仓库里两份私藏副本（`llm/cost.ts`、`world-engine/propagate.ts`）折成一份，
    `apps/cli` 补 `@yushu/core` 依赖；锁 `order-determinism.test.ts`（6 例：白名单外零容忍 + 白名单内每处必须带
    locale + 扫描器自身要能红）。**三条方法账**：① 判断"有没有传 locale"不能用整行正则——一行两个调用会互相
    掩护，改成按括号深度逐调用取实参（变异 C 才红）；② 总数下限挡不住"少扫一个根"，必须逐根断言（变异 D 才红）；
    ③ 文件数下限我一开始拍成 300，实测 191，测试当场拒绝了这个猜测。
    验证：1266/1266（120 文件）、TC=0、E2E=0、预演 v195 58/58。详见 docs/06 §八 第 91 轮。
    R92 PDF 口径收口 **已完成（2026-10-15）**：`onceTooling` 带 `reset()`、预览带 `refresh`、「重新核对」把工具链
    也重问一遍——修掉"面板承诺装完引擎即可用、实际要重启应用"这件言行不一。参数五棒（渲染层→api→preload→主进程→
    `previewExport`）由一条逐棒点名的接线锁钉住，四条变异逐棒验证；顺手抓到自己写的 `onClick={refresh}` 会把 click
    事件当成 `forceTooling`（每次点都在重探）。**K11 顺延 R93**：K11 要求平台参数从 I07 规则包读取，而仓库还没有任何
    平台包本体——先填包再适配，不编数字冒充规则包。验证：1269/120、TC=0、E2E=0、预演 v196 58/58。
    R93 T5-4 第四段·K11 起手 **已完成（2026-10-15）**：`@yushu/export/platform-format.ts`（解析 / 渲染 / 核对，8 例 + 5 条变异全红）
    + 第一份平台导出包 `packs/platforms/fanqie/platform-export.yaml`。平台参数一律从包读、代码零硬编码；
    缺来源即抛（I07 pr-rule-source-missing）、未知键即拒、错占位符即抛；**宁缺毋造两处**——I07 只给了晋江的
    投稿材料四部分，番茄包就留空并有断言钉住「不替它补一套」；单章字数上限研究里没量化，就只报口径不判超限。
    R88 扩面的门禁第二次兑现：本轮新代码被 typecheck 判出两处（`matchAll` 的 `string|undefined` 进 `sort`、
    测试里对 `as const` 元组做 `includes`）。**包还没有消费者**（R94 接进导出预览），T5-4 不勾。验证：1277/121、TC=0。
    R94 K11 第二段——平台格式接进导出 **已完成（2026-10-15）**：`platform-ops.ts`（扫 `packs/platforms/`、坏包不静默丢） + `previewExport` 平台面板（溯源行 / "你写的标题 → 导出会写出的章头"样例 / 核对行）+ `runExport` 按模板落笔（error 级核对行**在落笔之前拒**，`E_EXPORT_PLATFORM_GATE`）+ 导出页平台选择区 + 预演 **step59**。**顺带查出一个能踩到投稿的真缺陷：跨卷导出时章号在每一卷重新开始**（章头用的是卷内 `idx`）——引擎新增 `withSequence` 注入全书序号，主进程按**大纲**数（没建草稿的章照样占号），`{index}` 用的就是这个数。第二条同源的坑：模板补"第N章"而标题自己也带 ⇒ 产物出现"第1章 第一章 边城少年"；裁决是**只改导出副本、真源一个字不动**，且必须在预览样例、warn 行原文与回执 `strippedPrefixes` 三处看得见。验证：1308/123、TC=0、E2E=0、预演 v197 59/59；变异 6 条全红且红得对位（含"handler 丢参数断在第三棒"与"代码写死平台名"）。**T5-4 仍不勾**：PDF 等本机引擎、EPUBCheck jar 等外部文件、其余四平台包等出处核齐。
    R95 T5-9 第一段·冷启动待补 **已完成（2026-10-15，T5-9 仍不勾：批量生成那段没做）**：`@yushu/memory/coldstart.ts` 的 `planColdStart` + `loadMemoryState.coldStart`（从已有 targets 就地派生，不新增通道）+ 记忆页「冷启动待补」面板 + 预演 step60。三条口径：没素材不列待补 / 覆盖率分母只算有素材的目标 / 无从判断时给 null 带原因。**开场先纠一处自己的台账**：这里原写"R79 已留挂载点"，回源核对**不成立**（`grep T5-9 apps/desktop/src` 零命中），已改成"衔接点是 `loadMemoryState` 的 targets"；同处"T4-2 现仅战力一类"也与 docs/04 不符，实际是 **结构三条 + 战力 + 伏笔回收链**（视角/信息可见性是 R74 裁决暂不做，桌面端没有 `pov` 写入点）。验证：1322/125、TC=0、E2E=0、预演 v199 60/60；变异 6 条，**其中 M6 先存活**（step60 比的是既有选中态），改成"必须把选中项从 A 挪到 B"后当场打红；R96 **UI 全面重构第一批（插轮，用户点名）已完成（2026-10-15）**：新增 `docs/10-前端设计契约.md`（学习清单与"只学口径不抄代码"的边界、2px 间距网格、圆角/字号/行高/层级/焦点环/动效令牌、中文排版五条、反参照清单、迁移策略）+ `ui-contract.test.ts` 13 例把它变成判据（圆角 58/58 全走令牌、长度字面量棘轮 620 只降不升、焦点环单源、`@keyframes` 锁死在 1、reduced-motion 必须逐条覆盖所有声明 animation 的选择器、键盘债登记 10 处只降不升）+ 记忆页两处列表行改成真按钮（键盘可达，视觉逐字不变）+ step29/step60 改点内层 button。**令牌取值全部照现有分布建阶，一个像素都没改画面**（把密度压到 4px 基准是另一次要带截图对照的改版，已写进契约 §7）；R97 T4-2 语义规则第二批 **已完成（2026-10-15，T4-2 仍不勾）**：`power-gate.ts` 落 D03 的 R3 升级三件套与 R5 临时增益要回落（10 例 + 主进程 3 例消费者测试 + 覆盖锁），结论并入同一份体检报告、出处点名"御书台账核对"、三条 id 进豁免清单；台账新增 `kind / expiry / gain` 三个可选字段，未知键与非法 kind 一律读错，不写就与 R57 逐字一致。顺带把编辑器草稿章节表改成真按钮（键盘债 10→9）。验证：1349/127、TC=0、E2E=0、预演 v201 60/60；变异 4 条（其中一条先点错对象、改对后打红，并据此把 aria-current 纳入判据）；R98 **T5-5 世界圣经自动汇编（设定集一键导出）已完成并勾选（2026-10-15）**：`@yushu/export/bible.ts`（18 例）按 `LAYER_KEYS` 编目录、层内码点序、层级选取 + 可见性脱敏 + `export-bible-visibility-leak` 逐条 warn；`bible-ops.ts` + `bible:preview` / `bible:run`（四处对账锁与写通道分类锁各加一条）+ 导出页 `BiblePanel`（零新增 CSS）+ 预演 **step61**；落笔前三道闸（未确认 / 引擎说不清 / 一条都编不出来 ⇒ `E_BIBLE_EMPTY`）全在写文件之前，坏卡不静默丢、warn 不阻断但外显四个数。验证：1385/130、TC=0、E2E=0、预演全新 v206 61/61；变异 8 条全红（含一条把预演当场打红）。**三条当场学到的账**：① 预演项目的 15 张卡全是未揭示 ⇒ 开脱敏后条目为 0，第一版 step61 因此红在「确认框永远不可勾」——是我拿「理想项目」当默认，改成两条分支都真跑并顺手当场验「空设定集不许落笔」；② 回执在未开脱敏时只写「未开脱敏」不报数 ⇒ 第二版仍红在略过计数没得核，改成开关与数字都必报（**核对项不许随开关消失**）；③ 变异脚本第一版直调 `pnpm`（Windows 需 shell）崩溃在还原之前，把一条变异留在了文件里——靠「改前读数 + 还原比哈希」发现并回滚，脚本随后加了预检全部锚点这一关；
    R99 本批十轮总复核 **已完成（2026-10-15）**：对外声称逐条回源（改真相位 4 处：M4 计数、T4-12 已勾没写、T4-2 已落类别、SPDX 历史数当现状）+ 死代码审计变成锁（`dead-exports.test.ts` 4 例，删 2 条真零引用、12 条有意留着并登记理由）+ 四连全新复跑 1389/131、TC=0、E2E=0、v207 61/61。另实测：workspace 11、标签页 11、无 CI 目录、tag 只有 v0.2.0、ADR 2 篇、dependencies 无一未用；研究库按 A–K 实测确为 125 个领域。**台账编号在此重排的原因**：R91 是 R89 插轮、R93 又被 K11 抢先，而上面那串"R93 T5-9…"是 R87 排定的计划行，与实际发生的 R93 已经冲突，留着就是文档与账本各说各话。
    **停牌点不进台账**：M3 A3、M4 A3、真人试跑、代码签名与更新通道、外部派系包投稿——这些等外部条件。
    R100 / R101 / R102 三轮 **已完成（2026-10-15 ~ 10-16）**：R100 换行口径（`.gitattributes` + renormalize + `eol-hygiene` 4 例）；R101 项目迁移包导出（`export-gate` 票据 + 三道闸 + 落盘后复扫 + `ProjectExportPanel` + step62，**并改掉台账里 10 处从来不存在函数名 `stripSecrets`**）；R102 视角第三批（`pov-config` / `pov-check` 五条可判定规则 + `pov-ops` 三条通道与**两处写入点** + `PovPanel` + step63 + 规则 id 覆盖锁，**T4-2 仍不勾**）。三轮验证数字见 docs/06 §七 各轮记录；本轮（R102）终值 **1446/136、TC=0、E2E=0、v216 63/63**。
    小账四条：step57 / step58 / step59 的红路未演（v189–v197 只在正确构建上绿过一次；**step60 的红路已在 R95 当场演过并打红**）；`module_exec_ms` / `fcp_ms` 未设预算（等多机样本）；
    perf 基线最近一次实跑是 R83，M5 动到启动路径时要复跑；`.gitattributes` **已在 R100 补上**（文本一律 LF + 工作树 renormalize + 会红的口径锁）
    （renormalize 要单开一轮，见第 82 轮注记）；v186 那次预演静默中止若再现即立案。

**两条常驻提醒**：① M3 的 **A3**（成本偏差量化）与 M4 的 **A3**（召回 / 误报阈值）都要真实 provider 端点与真实语料，拿不到就一直挂着、不挂空也不假勾；② 预演 **step21 的抖动根因有两层，R58 消掉第一层、R78 消掉第二层**：第一层是 `press()` 缓存了失效的 `.tiptap` 节点（改为每次按键重新查询）；第二层是断言把**鼠标位置**当成了产品契约——真鼠标停在候选菜单上时 `onMouseEnter` 会先把高亮挪走，而组件的 `(active+1)%n` 语义一直是对的（R78 连续两轮同样红才追到这里：**同样红两次就不是抖动**）。现断言"↓ 让高亮移动一格 + 回车插入的正是那一格"，v174 证据行显示"从第 4 项移到第 5 项，回车插入「@测试设定5」"；**剩余 step17 仍未解**——快照内容寻址使"重复点一次不产生新行"，**状态变更型步骤重试救不回来**，真要修需要"步骤前置状态归零"，别把 `抖动=0` 读成已解决。

> 提醒：**M3 的 A1 / A2 / A4 / A5 / A6 均已由机器证据达成并勾选；只剩 A3（成本偏差量化）需要用户侧真实 provider 端点**——纯离线轮次无法达成，不要在 mock 上声称达成。**M3 功能任务 13 项已勾选（T3-14 的"导入/导出剔除密钥"待 M5，故未勾——R55 复核纠正：此前这里写的是"已全部勾选"，与实际账本不符）**，R50 起在 M4（docs/04 §7）。

祝顺利。有任何与本文冲突的地方，以 `docs/04`/`docs/03` 与仓库实际代码为准，并把修正回写进相应文档。

—— 交接人：Trae（R30–R39 十轮执行者）