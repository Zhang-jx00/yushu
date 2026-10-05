# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)；版本号遵循语义化版本，目标里程碑版本见 `docs/04-开发计划.md`。

## [Unreleased]

目标版本：`v0.1.0-alpha`（M1 世界基座 MVP，退出条件见 docs/04 §4.7）

### M2 增量（T2-1 / T2-2 / T2-6 切片）

- **章节编辑器（双形态）**：新增「编辑器」标签页——源码形态（CodeMirror 6 + Markdown 高亮 / 行号 / 历史）与富文本形态（TipTap StarterKit：标题、粗斜、引用、列表、分隔线）自由切换；磁盘真源始终为章节 Markdown 文件（`markdown-it` 解析进富文本、`turndown` 序列化回 Markdown）。
- **防丢数据策略**：富文本暂不支持表格/代码块/图片/链接/原始 HTML——切换前检测并提示，建议保持源码形态；切换章节先落盘再切换（T2-6 起，见下），仅自动保存失败冻结时才需确认。
- **字数对账不回退**：保存经 `chapter:write` 自动同步 frontmatter `word_count`（与导出对账、AI 采纳共用 countWords 口径）；并发冲突给出"重新载入"操作指引。
- 草稿章节列表、实时字数、baseHash 并发检测；新增 IPC：`chapter:read` / `chapter:write`；UI 预演 step10 覆盖双形态挂载与切回（walkthrough 10/10）。
- **实体 `@` 提及（T2-2 切片）**：正文 `@名称`/`@别名` 在源码形态高亮（悬停提示，Ctrl/⌘+点击打开设定卡）；编辑器底部「本章提及」面板（去重、一键跳转「世界观档案」并选中）；「重新载入」按钮（并发冲突恢复路径；同值点击章节亦可强制重载）。UI 预演 step11（walkthrough 11/11）。
- **保存管线切片（T2-6）**：编辑即自动保存（防抖 800ms、高频上限 5s；纯逻辑调度器，假定时器单测 6 例）；失焦（两种形态）与切换章节前 `flush()` 立即落盘；`baseHash` 冲突时自动保存**冻结不静默重试**，提供「写入旁路文件」（新增 IPC `chapter:writeSidecar` → `<章节>.conflict-<时间戳>.md`，主文件不动）与「重新载入」（解除冻结）两条人工路径；FileGateway 原子写升级为 tmp → `fsync` → rename。e2e 新增「外部改动 → 冲突拒绝 → 旁路文件 → 主文件保持外部版本」探针；UI 预演 step12 覆盖自动保存落盘 + frontmatter 字数同步（walkthrough 12/12）。完整版（三方合并、关闭前 flush、杀进程实测）见 docs/04 T2-6 遗留项。
- **载入竞态保护与预演证据加固（复核修复）**：章节重载期间若编辑器已有新输入，不再用磁盘内容覆盖（保留输入并提示，「重新载入」为显式覆盖路径）；UI 预演截图改为 moveTop 解除遮挡 + 最多 3 轮取样并在滞后时如实标注（修复"旧图/上一帧充当证据"问题）。
- **写作视图切片（T2-3 切片 A）**：无干扰（专注）模式——一键隐藏顶栏 / 标签栏 / 草稿侧栏 / 提及面板，正文单列居中，`Esc` 退出（离开编辑器页自动退出）；打字机滚动把光标行稳定保持在视口中央（阈值防抖）。UI 预演 step13（walkthrough 13/13）。切片 B（双栏对照）待做。
- **写作视图切片（T2-3 切片 B）**：双栏对照（左设定右正文）——「本章设定」栏显示本章提及的设定卡（名称 / 类型｜层级 / 别名 / 正文摘要前 140 字 / 一键「打开设定卡」跳档案页并选中），开启时底部提及面板收起；仅在提及集合变化时重新读卡。UI 预演 step14（walkthrough 14/14）；**T2-3 三项（无干扰 / 打字机滚动 / 双栏对照）齐备**。
- **索引增量与自愈切片（T2-5 切片 A）**：`index:rebuild` 支持增量——与 `file_index` 逐文件比对（mtime+size 快速跳过 → hash 确认 → 仅重解析变更文件；真源删除的文件从索引移除），FTS5 external content 用**行级 delete/insert** 同步；增量前完整性校验（`PRAGMA integrity_check` + FTS5 `('integrity-check',1)`），失败**自动回退全量**并回报问题项（自愈）。「项目文件」页新增「增量重建」按钮与「复用 / 更新 / 移除」回执。单测 181 例、e2e 增量探针、UI 预演 step15（walkthrough 15/15）。
- **保存即增量切片（T2-5 切片 B·第一项）**：写通道（章节 / 设定卡 / 文档 / 大纲 / AI 采纳）成功后由 `IndexRefreshScheduler` 在后台执行增量重建——防抖 2.5s、单飞 + 脏补跑、失败不阻断写并在下次保存自动重试（失败原因显示在状态行）；**仅在索引已存在时刷新**（首次构建仍由用户显式触发，「索引可控」原则）。`index:status` 返回刷新状态（pending / running / lastRunAt / lastError），「项目文件」页显示「自动增量：已同步（时间）」并在待命 / 执行中自动轮询；`openIndex` 增加 `busy_timeout=3000`（后台刷新与用户手动重建并发防锁冲突）。单测 4 例（调度器）、e2e 探针（保存 → 不点重建 → 新词可检索）、UI 预演 step16（walkthrough 16/16）。
- **可读性与摘要修复（复核修复）**：设定卡「类型 / 层级」由英文枚举改为中文标签（新增 `card-labels.ts`，层级派生自起源工作台步骤配置；覆盖档案页 / 双栏设定栏 / 提及悬停 / 索引实体列表）；双栏卡片摘要清洗 Markdown 标记并超长加省略号。
- **索引口径与 racy 防护修复（第 10 轮复核）**：① 增量快速跳过仅在文件 mtime **早于**上次索引写入（builtAt）时可信，同刻 / 更晚一律退回 hash 确认（借鉴 Git index 的 racy timestamp 处理）——修复"同大小 + mtime 未变的同刻改写被静默漏索引"（单测先红灯复现再转绿）；② `ftsRows` 改为 FTS5 影子表 `chunks_fts_docsize` 真实行数口径（原 `count(*) FROM chunks_fts` 在 external content 表上回落 content 表、恒等于 chunks——自愈单测的"对齐"断言实为空断言，现能暴露"索引缺行"）；③ `docs/06` §一 / §五 复跑数字按 M1 时点标注并修正 typecheck 表述（9 个包/应用）。
- **关闭前 flush 切片（T2-6 完整版·第一项）**：关闭窗口时主进程的 `CloseCoordinator` 拦截 close → 请求渲染层落盘（新增通道 `app:beforeClose` 单向推送）→ 回执（`app:flushDone`，载荷含调度器状态 / 路径 / dirty，供主进程日志诊断；渲染层无论成败必回执）后 `win.destroy()` 真正关闭；**5s 超时兜底**（渲染层无响应 / 崩溃不阻塞退出），页面未加载完成直接放行。单测 5 例（拦截 / 回执放行 / 重复点击 / 超时 / 无法请求）；e2e 两段式探针「编辑器输入（不等自动保存）→ 立即关窗 → 输入到窗口 closed **23ms**（<800ms 自动保存防抖窗口）→ 重读磁盘含标记」；`--open-and-quit` 冒烟验证 app.quit 退出链路兼容。顺带修复：e2e 入口 `did-finish-load` 在探针 reload 后二次触发会并发跑两遍（曾表现为"flush 成功但磁盘无标记"的伪缺陷）→ 改 `once`。
- **保存即增量测试补强（第 11 轮复核）**：补 `IndexRefreshScheduler` reset 代际保护单测（运行中 reset → 不回写状态、不触发脏补跑）；修正注释中英混排。边缘项复验记录见 `docs/06` §八（exists 检查与 rebuild 的毫秒级 TOCTOU、每次自动刷新全库 `integrity_check` 的性能事项、写通道覆盖清单）。
- **编辑日志与启动恢复切片（T2-8 切片 A）**：编辑器输入期间以 500ms 固定间隔把正文快照写入 `.yushu/recovery/`（写入期间新输入进入下一轮、失败自动重试；保存成功即 cancel 并清除 journal）；进入项目时检测「journal 与磁盘不一致」→ 恢复面板（[恢复] 载入编辑器为脏内容并自动保存 / [丢弃]），保存后漏清自愈、损坏 / 章节缺失保守保留不提示；journal 原子写、不入索引与 Git；新增 `recovery:*` 四个通道与 `recovery-ops`（主进程）/`recovery-journal`（快照调度器）/`recovery-inbox`（恢复投递）。单测 10 例；e2e 探针「输入 → journal 落盘（磁盘未保存）→ reload 模拟崩溃 → 恢复面板 → 恢复 → 编辑器载入 → 自动保存落盘 → journal 清除」六项断言全绿。**顺带修复**：窗口被遮挡时 Chromium 后台节流使渲染层计时器（自动保存 800ms / journal 500ms）延迟到 1s+ → 窗口禁用 `backgroundThrottling`（防丢稿为硬约束；walkthrough 总耗时同步从 ~100s 降至 ~18s）。
- **关闭前 flush 复核修复（第 12 轮复核）**：① `requestFlush` 调用包 try/catch——`isDestroyed` 检查与 `send` 之间的毫秒竞态抛异常不再冒泡进 Electron close 事件处理器（视为"无法送达"立即放行；单测 +1）；② **切页卸载即 flush**（此前"切页后 800ms 防抖窗口内关窗"没有任何落盘路径）并修复清理顺序问题——形态编辑器可能先于 flush 被销毁（读到空正文，且 run() 清掉自动保存定时器导致彻底不落盘）→ 正文读取增加「最近一次编辑快照」兜底；e2e 新增「切页落盘」探针（输入 → 切页 **55ms** 落盘、<800ms 证明非自动保存）。
- **恢复边界复核修复（第 13 轮复核）**：① **撤销回磁盘态残留 journal 误报**——输入期间 500ms 快照已写下中途内容，用户撤销 / 删回与磁盘一致后退出，残留 journal 会被下次进入项目误报为「崩溃前的未保存编辑」（恢复反而复活已撤销内容）→ 编辑器在「同一章节由脏转净」时清除该章 journal（章节切换 / 载入导致的转净不误清他章）；② **失效恢复条目过期覆盖**——进入项目后该章又被编辑并保存（journal 已被保存成功清除），但恢复面板状态仍是旧快照，点击「恢复」会把过期内容载入编辑器并经自动保存（800ms）覆盖更新版本正文 → 恢复前用 `recovery:list` 同一检测逻辑复核条目，失效即同步列表并拒绝恢复（检测失败保守不恢复）。e2e 新增「恢复边界」双探针（先红灯复现后转绿）。
- **本地快照切片（T2-7 切片 A·内容寻址）**：`.yushu/snapshots/` 内容寻址 blob 去重（`blobs/<前2位>/<hash>`）+ manifest 清单（`manifests/snap-<时间>-<rand>.json`，记录 路径 → blob / size / mtime）；打开项目即建立基线，主进程每 60s 自动检查（不足 60s 跳过 too_soon、内容一致跳过 unchanged、仅变更文件重读并落新 blob，未变文件按 mtime+size 复用），**环形保留 20**（超出裁 manifest 并清理不再被引用的孤儿 blob）；「项目文件」页新增快照面板（列表 / 立即快照（手动强制）/ 恢复）；恢复为**整体回滚**——恢复前强制生成 `pre_restore` 快照（撤销窗口，可再回滚）、被删文件重建、被改文件写回、快照后新增文件保守保留（列出不删除），写入经 FileGateway 原子写（无 baseHash——显式回滚语义由二次确认 + pre_restore 共同兜底）；源文件范围 = 文本白名单（.md/.yaml/.yml/.toml/.txt/.json）且排除 `exports/`；新增 `snapshot:state/take/restore` 三通道。单测 10 例（生成与去重 / 增量复用 / 60s 最小间隔 / 环形保留与孤儿 blob 清理 / 整体回滚 / 损坏容错 / 循环单飞与失败重试）；e2e 探针「手动快照 → 误改 + 误删 + 快照后新增 → 整体回滚 → 正文写回 / 被删卡重建 / 新增保守保留 / pre_restore 可再回滚」五项断言全绿；UI 预演 step17（walkthrough 17/17）。
- **快照存储健壮性复核修复（第 14 轮复核）**：① **并发 take 竞态（快照损坏）**——两个 take 并发时，后完成者的环形保留清理会把先完成者「已写 blob、尚未写 manifest」的内容当孤儿删除，导致 manifest 引用缺失 blob → take / restore 改为**串行队列**（同时消除"恢复写文件与自动快照读取交错"把半恢复状态拍成快照）；② **blob 损坏静默写回**——恢复读取 blob 时增加 sha256 内容校验，损坏 / 被改写 → `E_SNAPSHOT_INVALID` 明确报错，绝不把坏内容写回项目；③ **manifest 解析防御纵深**——id / blob / entry.path 校验不合法时视为损坏 manifest 跳过（原实现中手工构造的 id/blob 参与路径拼接）；④ 环形保留顺带清理 blob 目录中原子写崩溃残留的 `.tmp`。单测 +4 例（并发串行化 / blob 损坏 / 非法 manifest / .tmp 清理，先红灯复现后转绿）。
- **杀进程不丢稿实测（T2-8 切片 B·第一项；M2 门禁 §5.5 A1）**：新增**真实强杀**集成测试 `pnpm --filter @yushu/desktop kill-test`——`scripts/kill-recovery.mjs` 编排两个应用阶段：子进程 A（`--kill-edit`：建夹具（项目 / 大纲 / 草稿章节）+ 编辑器**持续输入**使自动保存防抖永不触发、编辑日志照常落盘，经产品自身检测接口确认后打印 KILL_READY）→ `taskkill /F` 真强杀 → harness 磁盘取证（章节不含标记、journal 含标记）→ 子进程 B（`--kill-recover`）重启进入项目 → 恢复面板 → 「恢复」→ 编辑器载入恢复内容 → 自动保存落盘 + journal 清除；证据 JSON（killedExit=1 / journalHasMarker / diskNotSaved / persisted / journalCleared），连跑 3 次稳定。
- **kill-test 编排健壮性修复（第 15 轮复核）**：① 强杀后等待子进程退出增加超时（`waitExit`，A 15s / B 10s）——taskkill 静默失败不再让脚本**永久挂起**；② 清理阶段改为统一强杀**全部登记子进程**（含子进程 B 异常挂起场景），不残留 Electron 进程。修复后 kill-test 复跑通过。

### Added

- **世界基座**：monorepo 骨架（`packages/@yushu/*` + `apps/desktop` + `apps/cli`）；核心类型与序列化基元（`@yushu/core`）；JSON Schema 校验（`@yushu/schema`，含 world / 设定卡 / 三级大纲 / 章节）。
- **派系包**：`loadPack / lintPack / fuse` 与融合预演报告（新增 / 覆盖 / 冲突三类，未确认不落库）；内置派系包 `xuanhuan-xitong`（11 件套齐全，lint 通过）；taboos 件套解析。
- **新建项目向导**：四维多选（频道 × 世界 × 手法 × 基调）+ 感情线独立开关 + 融合预演确认 → 落盘 `world/world.yaml` 与 `project.toml`。
- **起源工作台**：9 步引导式问卷（逐步建档、可跳过、可稍后补充）；设定卡 Markdown + YAML frontmatter 真源；世界层级开关（渐进披露）。
- **三级大纲**：总纲 → 卷纲 → 章纲（`outline/outline.yaml`）；派系包 `outline_templates` 一键生成骨架（生成≠写死）；章纲七要素、按钮排序与保存时重编号；细纲一键创建草稿章节（`chapter_id` ↔ `outline_ref` 双向映射）。
- **世界约束注入与 AI 最小接入**：`@yushu/llm`（`chat / stream` 两动词、OpenAI Chat Completions 兼容主干 + 本地端点 fallback、AbortController 停止并保留部分文本）；上下文槽位组装（稳定前缀 + `cache.breakpoint_after` 断点，M1 粗预算）；生成后轻提示（隐藏设定泄底 / 关闭层级引用 / 未引用设定）；AI 使用记录 `.yushu/ai-usage.jsonl`（生成 / 采纳双事件关联）；AI 副驾面板（默认关闭、上下文预览器、流式候选、整段采纳替换 / 追加）。
- **TXT 导出与敏感词自查**：`@yushu/export`（按大纲装配 → 目录与分章 → TXT；字数与正文对账）；外置词库（内置 `wordlists/sensitive-basic.yaml` 带来源与版本 + 项目内 `wordlists/` 覆盖）；命中定位 + 替换建议；防手滑确认（UI 勾选 + 服务端 `confirmed` 强校验）；干净剪贴板（去注释 / 去 AI 标识可选）。
- **检索索引**：`@yushu/search`（Node 内置 `node:sqlite`，零原生依赖）；`entities / refs / chunks / file_index` + FTS5 `external content`；中文检索（M1 采用 CJK unigram 方案，见 ADR-0002）；`apps/cli` 提供 `yushu rebuild|status|search` 无头命令；桌面「项目文件」页索引卡（重建 + 检索试跑）。
- **命名生成器**：三套文化规则（仙侠 / 西幻 / 现代都市，音位池 + 构词模式），按世界维度自动选择；显式种子可复现；世界观档案「取名助手」（本地、离线可用）。
- **文档与工程**：M1 验收 checklist（`docs/06-M1验收与自查清单.md`）；ADR（`docs/adr/`）；真人试跑材料包与本地模拟 LLM（`docs/07-真人试跑材料包.md` + `scripts/mock-llm.mjs`，无需真实 Key/网络即可体验完整 AI 流程）；UI 自动化预演（`--ui-walkthrough`，截图与报告见 `docs/assets/m1-preview/`）；**A0 三画像自动化试跑**（`--ui-trial`：新人/连载中/老作者三组虚拟用户 × 9 步全通过 + 网络审计 renderer 外网请求 0，截图 27 张与报告见 `docs/assets/m1-preview/trial/`）；vitest 用例 163 例（M1 交付时口径；M2 增量持续追加）；e2e 全链路冒烟（本地 mock OpenAI，不联网、不需要真实 Key）。

### Security

- API Key 禁止落盘明文：仅支持环境变量（`api_key_env`）与会话内存 Key（docs/03 §13）。
- 所有渲染层文件操作经主进程 FileGateway（路径防护 + 原子写 + baseHash 并发检测），白名单 IPC 全部返回 `{ok, data|error}` 信封。

## 未发布前的提交约定

- 每个增量：`pnpm test` / `pnpm typecheck` / `pnpm --filter @yushu/desktop e2e` 全绿后提交。
- 提交信息使用 `feat: M1 ...` / `fix: ...` 等约定式前缀（详见各增量记录）。