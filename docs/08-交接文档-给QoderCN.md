# 御书 · 交接文档（给 QoderCN）

> 交接时间：2026-10-07 ｜ 交接时远端 main：`2d3115a4`（R30–R39 十轮全部已推送）
> **R40 续跑更新（2026-10-07，QoderCN）**：T3-12 已完成，远端 main 随后同步；本文 §1 快照与 §4 未完成清单已按 R40 实况更正（上一版误记 tag 未推、远端停在 `2d3115a4`，实际 `git ls-remote` 显示 main 已含交接文档提交、`v0.2.0` tag 已在远端）。
> 本文写给接手的 AI 编码助手（QoderCN）：读完这一份 + `docs/04-开发计划.md`（唯一任务清单）+ `docs/06-M1验收与自查清单.md` §八（逐轮记录），即可无缝续跑。
> 阅读顺序建议：本文 §1 状态快照 → §7 每轮工作流（照做）→ §4 未完成清单（领任务）→ 其余按需查阅。

---

## 1. 项目一句话与当前状态快照

**御书**：本地优先的开源网文创作工具（Electron + React + TypeScript monorepo）。核心理念：Markdown/YAML 为唯一真源、SQLite 仅作索引、AI 结果一律候选化（采纳是用户显式动作）、离线能力完整（AI 可整体关闭）。

当前进度：**M1（世界基座）、M2（编辑器与索引，v0.2.0）已完成验收；M3（AI Provider 与上下文记忆）已完成 T3-1～T3-12（共 12 个任务、R30–R40 十一轮）**。M3 只剩 T3-13 / T3-14 两个任务 + §6.5 三条验收（A2 / A3 / A4——均需真实 provider 或真人试跑才能量化）待核；A1/A5/A6 已达成并有机器证据（A5/A6 于 R41 复核勾选）。

| 项目 | 状态 |
|---|---|
| 工作目录 | `d:\Zcode对话\workspace\novel` |
| 远端 | `https://github.com/Zhang-jx00/yushu.git`（公开仓库；main 与本地同步；`git push --dry-run` 已验证凭据可用） |
| 单测 | **483/483 全绿**（59 个测试文件）——`pnpm test`（第 40 轮 R40 / T3-12 后） |
| 类型检查 | **10 个包/应用零错误**——`pnpm typecheck`（注意：内含 `pnpm -r run build`，即构建全部产物） |
| e2e | 全链路通过（离线 mock LLM，无需外网/Key）——`pnpm --filter @yushu/desktop e2e` |
| UI 预演 | **36/36 全绿**（最近一次新目录 v84）——见 §6.3 |
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
│  └─ memory      五层记忆：records/provenance/mentions/injection/assemble/snapshot
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

### 4.1 M3 剩余任务（docs/04 §6.3 的两个未做项）

- **T3-13 中文处理初版**：OpenCC 繁简转换、中文标点规范化、错别字与重复表达检测（J14）。可先做纯逻辑包（不依赖外网词典），检测结果候选化。
- **T3-14 安全**：API Key 走 `safeStorage.encryptStringAsync`（只存 ciphertext + key_ref）；导入/导出项目自动剔除密钥（K12）。当前是「环境变量/会话内存 Key」过渡态（明文禁止落盘已有 lint 保障）。

### 4.2 M3 验收未核项（docs/04 §6.5）

- `- [x] A1` 可复现快照与截断标记（R37 已达成，有机器证据）。
- `- [ ] A2 任务路由生效`：命名/润色走小模型、正文走旗舰、失败按 fallback 降级——机制（T3-2）与 e2e 重试探针已具备，但**尚缺一次针对 A2 的端到端演示/取证**（建议：e2e 增加「模拟主 provider 失败 → fallback 小模型完成命名任务」的探针，并在 docs/04 A2 处附机器证据）。
- `- [ ] A3 成本面板`：R40（T3-12）已落地并取证——**可分解 / 双口径 / 不猜价已被机器断言**，但「偏差在可接受范围内」**无法用 mock 证明**（mock 对任意请求固定回传 `prompt_tokens:12`，实测偏差 +4404%）。保持未勾选，接真 provider 后与 A2/A4 同轮量化复核（证据与口径详见 docs/04 §6.5 A3 与 §6.3 T3-12 注记）。
- `- [ ] A4 AI 整体关闭后本地能力无退化`：M1 有「renderer 外网请求 0」的 trial 证据（旧口径），建议以当前代码重跑一次 trial/网络审计并在 A4 附证据。
- `- [x] A5 记忆不跨项目泄漏`：**R41 已复核并勾选**——e2e 探针原文 `{"rejectedIds":["fact-foreign"],"errorCodes":["memory-cross-project-leak"]}`（异项目记录被拒、本项目 6 条事实台账不受影响）；证据文字已写入 docs/04 §6.5。
- `- [x] A6 上下文预算超限正确裁剪`：**R41 已复核并勾选**——小预算 40 token 探针 `smallEvicted/smallWithin/smallKeepsSystem` 全真 + 快照 `smallTruncated:1`；逐出顺序与「system_prompt 只截断不丢弃」按 docs/03 §10.2 断言，无中段丢失关键设定案例。

### 4.3 各轮「边界如实标注」的遗留（已在 docs/04 各注记写明，勿重复实现，按需推进）

- R36：sqlite-vec 扩展**加载路径代码就绪但本机无扩展未实测**（实测走本地余弦兜底，注记与回执均如实标注）；云端语义嵌入（bge-m3）与 bge-reranker 是 `VectorStore`/`rerankHits` 的**替换点**，接 provider 后替换即可。
- R38：provider 支持 `json_schema`/tools 时可把「提示词约束 + 后校验」升级为**原生强约束**（structured.ts 已是同一契约的另一端）；augment 的字段级合并 UI 与抽取失败池面板留 T4。
- R39：真 Batch 为异步批处理（24h），交互链路不排队——现行半价通道是「归属提示 + usage 记账」；多候选限 1-3；拒绝原因看板（分布视图/回流提示）与批量队列视图留 T4。
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

1. ~~**T3-12 成本与缓存**（含 A3 取证）~~ **已完成（R40）** → 2. **A5 / A6 复核勾选** **已完成（R41）** → 3. **T3-14 安全（Key 加密）** → 4. **T3-13 中文处理** → 5. **A2 / A4 取证轮**（补 e2e/网络审计探针与 docs 证据；A3 的偏差量化需真实 provider）。收口后按 docs/04 §6.7：A1–A6 全绿 → `v0.4.0` 打 tag。

### 5.2 之后（以 docs/04 为准，勿偏离）

- **M4 一致性引擎 / 伏笔 / 时间线 / 关系图谱**（T4-1～T4-12）：规则 DSL 沙箱求值（禁循环禁 IO + 超时 + 深度上限）→ 规则分类（ref-dangling / 战力 / 视角 / 信息可见性 / 伏笔回收…）→ 一致性报告（span+evidence+fix 三件套）→ 影响传播（反向 BFS + 提案目录 + 整体回滚）→ 伏笔台账 / 时间线 / 编年史 / 关系图谱（SQLite nodes/edges）→ 爽点与期待感管理 → 规则回归集。前置：M2 的 refs 反向索引、M3 的注入与事实记忆（校验比对源）。
- **M5 内容与平台化**：平台规则包机制填充（docs/06 §9.6）、导出管线增强（EPUB/EPUBCheck）、真人试跑材料包维护。
- **M6 证据链与合规**：ai-usage 证据链完整性校验（R38 起 usage 已带 `channel`）、合规申报导出。
- 长期议题（docs/04 §6.6 风险表）：成本失控防控（预算上限拦截 + 批量半价 + 归因）、Lost-in-the-Middle（分层组装 + near_end + 预览器抽检）、本地模型体验断层（能力矩阵 + 差异提示）。

### 5.3 工程债（低优先，随手做）

- `docs/00-交接文档-给Trae.md` 是 M1 时代的；新内容一律写进 `docs/04/06` 与本文，避免多源。
- walkthrough 报告 `scene` 字段仍写「步骤 10-25」，可顺手更新为当前范围。
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
- **walkthrough**：步骤数组 `STEPS`（`walkthrough.ts`），每步 `{step, title, file, body}`，`body` 用 **String.raw**（`'\n'` 才是真换行；普通模板会提前转义，见 memory 教训）。新步骤 append 到末尾即可（计数自动）；截图落在 `docs/assets/m1-preview/`。已知坑：**AiView 随标签页卸载重建**（`ProjectScreen` 里 `tab === "ai" && <AiView/>`），依赖其内部状态（如 AI 开关）的步骤要「自给自足」地先设置；断言选择器要避免误匹配面板标题（如 `局部采纳：` 全角冒号才指向回执）。
- **auth/网络**：e2e / walkthrough / trial 全程离线 mock，不联网、不需要真 Key；perf-test 也离线。

---

## 7. 红线与禁区（违反即回退）

1. 不得删除/覆盖 `docs/research/` 下的 A–H/J/K 调研文档（项目基础资料）。
2. 派系包必须多维多选（遵循 G06 YAML 规范）；SQLite 不得作唯一真源；AI 结果必须候选化、不得直接覆盖正文。
3. 跨项目记忆泄漏是 error 红线（`memory-cross-project-leak`，测试必须覆盖）。
4. 写操作必须带 `baseHash` 并发检测；冲突绝不静默覆盖（主文件保持外部版本）。
5. 敏感词词库外置可更新；导出防手滑（UI 勾选 + 服务端 `confirmed` 强校验）；导出产物写 `exports/<书名>-<时间戳>.txt` 不覆盖。
6. 密钥安全：明文 Key 禁止落盘/进日志。**R42 起该保障已真实存在**（此前仅写在 docs/03 §13 与 K12 建议里，代码中并无此规则——本文上一版表述有误导，已更正）：`@yushu/llm` `detectPlaintextSecrets` + `parseLlmConfig` 将 `key-plaintext-detected` 落成 error 级阻断，密文只存 `.yushu/secrets.json`（safeStorage 后端不可用即拒绝保存，绝不写明文），错误信息只带去标识化证据。
7. 不要触碰用户其它两个 GitHub 项目；推送凭据只按 §6.2 方式使用。
8. 性能：改动触及索引写入 / 启动 / 输入路径时，必须跑 `perf-test` 并对比回归（阈值 20%），把报告落到 `docs/assets/perf/` 并在 docs/06 如实记录；预算门禁在 `perf-budget.yaml`。

---

## 8. 验收与自测清单（接手后先跑一遍）

```bash
pnpm install
pnpm test          # 期望 425/425（56 文件）
pnpm typecheck     # 期望 10 个包/应用 Done
pnpm --filter @yushu/desktop e2e      # 期望末行 [e2e] 通过：…（含 T3-8/9/10/11 探针）
pnpm --filter @yushu/desktop exec electron . "--ui-walkthrough=D:\Temp\yushu-walkthrough-<新编号>"   # 期望 DONE ok=35 fail=0
```

验收基线数字（截至 `2d3115a4`）：单测 425、typecheck 10 包全绿、e2e 全链路通过（含 RAG/快照/抽取/写作 UX 探针）、walkthrough 35/35（v78，总耗时 ~40s）、perf 10/10（R36 报告）。

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

**T3-14 安全（API Key 加密落盘）**：
1. `ai-ops.ts` 的会话内存 Key（`sessionKeys`）之外，新增持久态：`safeStorage.encryptStringSync` 产 ciphertext，只写 `.yushu/secrets.json`（派生物、不入 Git）+ `key_ref`；解密只在主进程内存态，**密文与明文都不经 IPC 回传渲染层**。
2. `config/llm.yaml` 保持只存 `api_key_env`（或 `key_ref` 标识）；`lintLlmConfig` 增加 `key-plaintext-detected` 的 error 级判定路径（现为规则名，需要落到实际校验）。
3. 导入/导出项目（`export:*` 与项目迁移路径）自动剔除密钥文件与 frontmatter 中的密钥字段。
4. Provider 面板增加「已加密保存 / 仅本次会话 / 环境变量」三态显示（不显示 Key 本体，哪怕是掩码）。
5. 单测覆盖：密文可回解、明文绝不落盘（写盘路径拦截断言）、导出包剔除密钥；e2e 探针 + 预演新 step。
6. 顺带把 §4.2 的 **A5 / A6 标记 `[x]`**（**R41 已完成**：e2e 探针原文与证据文字已写入 docs/04 §6.5 与 docs/06 §八 第 41 轮），并同步 docs/06 §五 的测试计数（现 483/483，59 个文件）。

> 提醒：A2 / A3 / A4 三条验收都卡在「需要真实 provider 或真实网络审计」，纯离线轮次无法达成——安排取证轮时需要先确认用户侧可用端点，不要在 mock 上声称达成。

祝顺利。有任何与本文冲突的地方，以 `docs/04`/`docs/03` 与仓库实际代码为准，并把修正回写进相应文档。

—— 交接人：Trae（R30–R39 十轮执行者）