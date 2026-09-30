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