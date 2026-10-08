# 御书 · 交接文档（给 QoderCN）

> 交接时间：2026-10-07 ｜ 交接时远端 main：`2d3115a4`（R30–R39 十轮全部已推送）
> **R40 续跑更新（2026-10-07，QoderCN）**：T3-12 已完成，远端 main 随后同步；本文 §1 快照与 §4 未完成清单已按 R40 实况更正（上一版误记 tag 未推、远端停在 `2d3115a4`，实际 `git ls-remote` 显示 main 已含交接文档提交、`v0.2.0` tag 已在远端）。
> 本文写给接手的 AI 编码助手（QoderCN）：读完这一份 + `docs/04-开发计划.md`（唯一任务清单）+ `docs/06-M1验收与自查清单.md` §八（逐轮记录），即可无缝续跑。
> 阅读顺序建议：本文 §1 状态快照 → §7 每轮工作流（照做）→ §4 未完成清单（领任务）→ 其余按需查阅。

---

## 1. 项目一句话与当前状态快照

**御书**：本地优先的开源网文创作工具（Electron + React + TypeScript monorepo）。核心理念：Markdown/YAML 为唯一真源、SQLite 仅作索引、AI 结果一律候选化（采纳是用户显式动作）、离线能力完整（AI 可整体关闭）。

当前进度：**M1（世界基座）、M2（编辑器与索引，v0.2.0）已完成验收；M3（AI Provider 与上下文记忆）的 14 个功能任务全部完成并勾选（T3-1～T3-14，R30–R45，其中 T3-12 于 R48–R49 补齐遗留后勾选）**。M3 剩余：§6.5 的 **A3（成本偏差需真实 provider）** 一条——A1 / A2 / A4 / A5 / A6 已达成并有机器证据（A2 于 R46 离线取证勾选，A4 于 R47，A5/A6 于 R41）。收口动作：A1–A6 全绿 → `v0.4.0` 打 tag（docs/04 §6.7）；**A3 必须等真实端点，不要在 mock 上声称达成**。

| 项目 | 状态 |
|---|---|
| 工作目录 | `d:\Zcode对话\workspace\novel` |
| 远端 | `https://github.com/Zhang-jx00/yushu.git`（公开仓库；main 与本地同步；`git push --dry-run` 已验证凭据可用） |
| 单测 | **639/639 全绿**（71 个测试文件）——`pnpm test`（第 49 轮 R49 / T3-12 收口后） |
| 类型检查 | **11 个包/应用零错误**——`pnpm typecheck`（注意：内含 `pnpm -r run build`，即构建全部产物） |
| e2e | 全链路通过（离线 mock LLM，无需外网/Key）——`pnpm --filter @yushu/desktop e2e`；R43 起含「密钥安全」探针、R45 起含「中文自查」探针（`diskUnchanged:true` 即「两个只读通道不写盘」的实测） |
| UI 预演 | **39/39 全绿**（最近一次新目录 **v110**，44.2s，`screenshotFailures:[]`、证据缺失=0）——见 §6.3；step17 / step21 存在**偶发抖动**（非本轮引入、根因未定，见 docs/06 §七） |
| 性能实测 | 10/10 达标（最近一次 R36 报告 `docs/assets/perf/perf-report-local-dev-20261007-r36-rag.json`）；R40 未触热路径，本轮不适用 |
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

### 3.2 M3 逐轮明细（每轮 = 3 条提交：引擎 → 桌面端 → docs+证据）

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

### 4.1 M3 功能任务收口状态（docs/04 §6.3——14 项全部完成，下列两项曾分两轮拆做）

- ~~**T3-13 中文处理初版**~~ **已完成（R44 引擎侧 + R45 桌面端与取证）**：`@yushu/text` 五类检测（`proofread-punctuation-gb` / `proofread-typo` / `proofread-conversion-ambiguous` / `proofread-repetition-high` / `proofread-long-sentence` + `proofread-demiscue`）与**修复安全闸门** `proofread-autofix-unconfirmed`（error）。两条必须记住的口径：**span 是 UTF-16 下标**（与导出敏感词同口径）、**severity 只有 `error | warn | info`**；繁简**歧义字一律原样保留只登记候选**（绝不把猜出来的繁体写进正文）；`applyFixes` 未确认时文本一字不动。
- ~~**T3-14 安全**~~ **已完成（R42 + R43）**：API Key 走 safeStorage 加密，密文只落 `.yushu/secrets.json`（派生物，随 `.yushu/` 被 Git / 索引 / 快照排除），真源 `config/llm.yaml` 只写 `key_ref`；含明文的 `llm.yaml` 在 `parseLlmConfig` 入口即被 `E_LLM_CONFIG` 拒绝（`key-plaintext-detected`）。**注意两处口径升级**：① R42 前"明文禁止落盘"只是 docs 里的期望，代码中并无该规则（旧解析器对未知 `api_key` 字段静默丢弃），现已真正落地；② R43 起 `gitInit` 会幂等补齐**项目根 `.gitignore`**（`.yushu/` / `exports/` / `node_modules/`）——派生物与凭据的"不入 Git"从应用内过滤升级为仓库自身不收，用户 `git add .` 也不会提交密文库。**新增派生目录时必须同步 `PROJECT_GITIGNORE_LINES`**（有单测钉住它与 `GIT_EXCLUDES` 同源）。剩余：M5 做项目打包 / 导入导出时接显式 `stripSecrets`。

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

1. ~~**T3-12 成本与缓存**（含 A3 取证）~~ **已完成（R40；遗留的章节维度与预算护栏引擎补于 R48）** → 2. **A5 / A6 复核勾选** **已完成（R41）** → 3. ~~**T3-14 安全（Key 加密）**~~ **已完成（R42 引擎与主进程 + R43 桌面端与取证）** → 4. ~~**T3-13 中文处理**~~ **已完成（R44 引擎侧 + R45 桌面端与取证）** → 5. **A2 取证 已完成（R46）** → 6. **A4 取证 已完成（R47）** → 7. **T3-12 遗留补齐 已完成（R48 章节维度 + R49 预算护栏与体检接入面板，T3-12 勾选）** → 8. **A3 待用户侧真实端点**（唯一未勾项：偏差量化需真实 provider 回传 usage；**不要在 mock 上声称达成**）。M3 功能面已全部勾选，下一批轮次进入 **M4**（docs/04 §7，T4-1 起）；A3 取证与 `v0.4.0` 打 tag 等真实端点可用时一并执行（§6.7：A1–A6 全绿才打 tag）。

### 5.2 之后（以 docs/04 为准，勿偏离）

- **M4 一致性引擎 / 伏笔 / 时间线 / 关系图谱**（T4-1～T4-12）：规则 DSL 沙箱求值（禁循环禁 IO + 超时 + 深度上限）→ 规则分类（ref-dangling / 战力 / 视角 / 信息可见性 / 伏笔回收…）→ 一致性报告（span+evidence+fix 三件套）→ 影响传播（反向 BFS + 提案目录 + 整体回滚）→ 伏笔台账 / 时间线 / 编年史 / 关系图谱（SQLite nodes/edges）→ 爽点与期待感管理 → 规则回归集。前置：M2 的 refs 反向索引、M3 的注入与事实记忆（校验比对源）。
- **M5 内容与平台化**：平台规则包机制填充（docs/06 §9.6）、导出管线增强（EPUB/EPUBCheck）、真人试跑材料包维护。
- **M6 证据链与合规**：ai-usage 证据链完整性校验（R38 起 usage 已带 `channel`）、合规申报导出。
- 长期议题（docs/04 §6.6 风险表）：成本失控防控（预算上限拦截 + 批量半价 + 归因）、Lost-in-the-Middle（分层组装 + near_end + 预览器抽检）、本地模型体验断层（能力矩阵 + 差异提示）。

### 5.3 工程债（低优先，随手做）

- `docs/00-交接文档-给Trae.md` 是 M1 时代的；新内容一律写进 `docs/04/06` 与本文，避免多源。
- ~~walkthrough 报告 `scene` 字段仍写「步骤 10-25」，可顺手更新为当前范围。~~ **已更新**（R40「步骤 10-36」→ R43 10-37 → R45 10-38 → R47 10-39；**新增步骤时记得同步这里**，`grep "步骤 10-" apps/desktop/src/main/walkthrough.ts` 一眼可验）
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
pnpm test          # 期望 607/607（69 文件，第 45 轮口径）
pnpm typecheck     # 期望 10 个包/应用 Done
pnpm --filter @yushu/desktop e2e      # 期望末行 [e2e] 通过：…（含 T3-12 成本与 T3-14 密钥安全探针）
pnpm --filter @yushu/desktop exec electron . "--ui-walkthrough=D:\Temp\yushu-walkthrough-<新编号>"   # 期望 DONE ok=38 fail=0 证据缺失=0（退出码把「证据缺失」也算失败）
```

验收基线数字（截至 R45）：单测 **607/607（69 文件）**、typecheck 11 包全绿、e2e 全链路通过（含 RAG / 快照 / 抽取 / 写作 UX / 成本 / **密钥安全** / **中文自查** 探针）、walkthrough **38/38**（v103，总耗时 ~43s，`screenshotFailures:[]`）、perf 10/10（R36 报告，其后各轮未触热路径）。

---

## 9. 已知环境与工具注意事项

- 系统：Windows（PowerShell）。不要用 heredoc / `&&` 串命令；用 `;`。多行 commit 消息用 `-F 文件`。
- `pnpm test` 全量并行时，`apps/desktop/test/snapshot-ops.test.ts` 的「环形保留 22 次快照」用例对负载敏感，已显式放宽到 30s（勿改回）。
- 未经 `--lockfile-only` 直接 `pnpm install` 可能因 frozen-lockfile 失败；新增依赖前先确认 registry 可达。
- Electron 44 / Node 24（dev）；`node:sqlite` 用于索引（零原生依赖）；`loadExtension` 需要 `allowExtension`（旧运行时会自动回退——R36 已处理）。
- LF/CRLF 警告是正常的（仓库未设 .gitattributes）。
- `.git/git-data-push.mjs` 是推送兜底脚本，保留在 `.git/` 里（不入版本库）；如误删，可按 §6.2 要点重写。
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

**下一轮（R50）——M4 / T4-1 规则 DSL 求值层（引擎侧，先不碰桌面端）**：
1. 落在 **`@yushu/genre-engine`**（docs/04 §7.4 已指定该包承载「规则 DSL 求值沙箱 + 规则加载与版本合并」；它已有 `loadPack / lintPack / fuse`，规则即数据的口径与派系包同源）。研究依据 `docs/research/G-流派总论/G06-派系包建模.md`：§2 第 4 条「规则 DSL 沙箱 → 表达式禁循环禁 IO，求值超时与递归深度上限」，§5 第 86 行起有「条件=JSONLogic 子集 + 产出=结构化动作」的 YAML 示例草案。
2. **必须实现的四道沙箱闸门**：① 操作符白名单（`var / > / < / == / and / or / in / cat` 一类的纯函数子集，**未知操作符直接报错不降级**）；② **禁循环**——不实现任何迭代原语（`reduce`/`map` 类一律拒绝），只允许有限深度嵌套；③ **递归深度上限**（建议 16，超限报 `E_RULE_DEPTH`）；④ **求值超时**（同步求值无法真中断，用「节点计数上限」代替墙钟时间，**别拿 `Date.now()` 假装超时**——那会让同输入同输出被破坏）。
3. 规则形状按 T4-1 验收口径：`{id, severity: error|warn|info, scope: scene|chapter|cross_chapter|project, when: <JSONLogic 子集>, then: <结构化动作>, source: {pack, version}}`；**`severity` 与 T3-13 一样只有三档**，`scope` 决定 R53 报告聚合粒度。**求值输出** `{rule_id, severity, span?, evidence, fix?}`——与 `@yushu/text` 的 finding 同形，别让 M4 长出第二套结果结构。
4. 单测要求（沿用本项目口径）：每条闸门一例命中 + 一例**不该命中**；新断言先做**红/绿配对**（改判定看它能不能红）；确定性断言（同输入同输出、排序有码点兜底键）。
5. 桌面端接入留 R51（规则管理面板 + `rule:*` 通道四处同步）；本轮纯引擎，**不要提前写 IPC**。

> 提醒：**M3 的 A1 / A2 / A4 / A5 / A6 均已由机器证据达成并勾选；只剩 A3（成本偏差量化）需要用户侧真实 provider 端点**——纯离线轮次无法达成，不要在 mock 上声称达成。**M3 功能任务（T3-1～T3-14）已全部勾选**，R50 起进入 M4（docs/04 §7）。

祝顺利。有任何与本文冲突的地方，以 `docs/04`/`docs/03` 与仓库实际代码为准，并把修正回写进相应文档。

—— 交接人：Trae（R30–R39 十轮执行者）