# J04-RAG与向量检索

> 类别：J-AI与LLM工程 ｜ 世界构建金字塔层级：工程层 · AI 工程
> 质量要求：信息来源 ≥6 条、覆盖 ≥3 种来源类型；URL 必须来自真实检索结果。

## 1. 领域定义

研究"从百万字全库中取出与当前写作最相关的一小撮文本"的检索工程：中文向量化、本地向量存储、文本切块、混合检索与重排，以及检索结果的出处回溯与索引重建。边界划分：J03 研究如何把检索结果组装进上下文预算，本领域只负责"取什么"；K09 研究全文检索与中文分词的通用技术，本领域聚焦其在长篇小说（Markdown 真源、索引可重建）场景下的落地；J05 处理结构化设定卡的注入选择。核心工程问题：中文 embedding 如何在本地/API 间选型、sqlite-vec 等嵌入式向量方案能否替代独立向量库、切块粒度与 overlap 如何定、混合检索如何融合排序、检索结果如何保证可跳回源章节。

## 2. 核心知识框架

1. **中文 embedding 选型**。BAAI 的 BGE 系列是当前事实基线：`bge-large-zh-v1.5`（326M，中文 STS/检索稳健）、`bge-base-zh-v1.5`（102M，性价比档）、`bge-m3`（569M，稠密 + 稀疏 + 多向量三合一、支持 100+ 语言与 8192 token 长输入）；社区侧另有 `text2vec`（CoSENT 训练，含中文匹配模型）。选型依据是 C-MTEB（6 类任务 35 数据集）与 MTEB 榜单；检索时查询侧需加指令前缀（"为这个句子生成表示以用于检索相关文章："），文档侧不加。
2. **本地 vs API 权衡**。本地 embedding（ONNX/GGUF，bge-small/base 量级）保隐私、零边际成本、可离线，契合"本地优先/不强制云端"承诺（docs/01 §6），代价是首次下载与 CPU 推理延迟；API embedding 免运维但有网络、成本与数据出境问题。工程解：embedding 提供方抽象为可插拔 Provider，索引记录 `model_id` 与 `dim`，换模型触发全量重建。
3. **本地向量方案 sqlite-vec**。`vec0` 虚拟表用纯 C 实现、零依赖，可存 float32/int8/bit 向量并做 KNN 查询，支持元数据/分区键列——与"Markdown 真源 + 单文件 SQLite 可重建索引"（种子库 S8、docs/01 技术基线）天然同构。风险：项目处于 pre-v1、可能有破坏性变更，且上游对部分平台（如 windows-arm64）覆盖不全、社区出现 fork 接棒，选型须锁定版本并预留替换层。
4. **文本切块策略**。BGE 系默认最优输入 512 token，长文必须切块：章节级（粗、上下文完整）↔ 场景/节拍级（中，推荐）↔ 段落级（细，易碎片化）。工程共识是"不是塞得越多越好"——检索精度优先于体量；推荐按语义边界（场景卡 / 自然段 / 标点）切，块间保留 overlap（10%~15%）避免跨界语句被割裂，块内可加"章节标题 + 出场实体"头部以提升可检索性。
5. **混合检索与 RRF 融合**。关键词检索（SQLite FTS5 + `wangfenjin/simple` 中文/拼音 tokenizer，支持 `jieba_query()` 词组匹配与 bm25 rank）擅长专名/术语精确命中，向量检索擅长同义改写；两者分数尺度不可比，用 **RRF**（`Σ 1/(k+rank)`，k=60）按名次融合最稳，无需归一化、对参数不敏感。研究（Bruch 等）显示：无训练数据时 RRF 是默认推荐，数据充足时 Learning-to-Rank 更优。
6. **重排序与检索评估**。召回后可用 cross-encoder 重排（`bge-reranker-base/large`、`bge-reranker-v2-m3`）对 top-k 精排；评估用 Precision@k / Recall@k / MRR 与"魔鬼查询集"（作者手写的 must-hit 场景），而非主观印象。
7. **出处回溯与可重建索引**。每个切块必须携带 `chapter_id + 字符区间 + 文本 hash`，检索结果可一键跳回源章节并高亮；FTS5 的 `external content` 表 + `rebuild` 命令、embedding 按文件 hash 缓存，保证索引可随时从 Markdown 全量重建而不丢数据（docs/01 §6 数据主权）。

## 3. 可转化为产品规则的关键实践

1. 切块器按项目可调 → `chunk_granularity`（chapter | scene | paragraph）与 `overlap_ratio`，默认 scene + 12%。
2. FTS5 中文检索 → 装载 `simple` 扩展，建 `fts5(..., tokenize='simple')` 外部内容表，提供 `simple_query` / `jieba_query` 两档查询（与 K09 共用）。
3. 双路召回 + RRF → 一次查询并行走向量与 FTS，各取 top-50，RRF k=60 融合后取 top-k 送重排。
4. 重排序开关 → 本地 `bge-reranker` 可选开启，标注"精度↑ / 延迟↑"；未启用时直接用 RRF 名次。
5. 检索调试面板 → 展示每路召回的原始名次、RRF 得分、重排后名次、最终入上下文的片段（与 J03 上下文预览器联动）。
6. 出处卡片 → 每个检索结果附"来源章节 + 引文 + 跳转"，作者可核对 AI 引用是否真实（反幻觉，引用 J07）。
7. 索引自愈 → 文件变更（chokidar）触发增量索引；检测到"源文件存在但索引缺失/陈旧"时提示一键重建。
8. 模型切换保护 → 更换 embedding 模型时强制重建，禁止混用不同维度的向量。

## 4. 信息来源

1. [官方文档] SQLite FTS5 Extension — https://sqlite.org/fts5.html — 外部内容表、`rebuild`/`optimize`、bm25 排序与自定义 tokenizer 接口。
2. [开源项目] wangfenjin/simple — https://github.com/wangfenjin/simple — 支持中文 + 拼音的 FTS5 tokenizer，含 `jieba_query()` 词组匹配与全平台预编译产物。
3. [技术文章] Simple: SQLite3 结巴分词插件 — https://www.wangfenjin.com/posts/simple-jieba-tokenizer/ — 单字索引 + query 改写实现词组命中，以及 FTS 表使用建议。
4. [开源项目] sqlite-vec — https://github.com/asg017/sqlite-vec — vec0 虚表、float32/int8/bit 向量、KNN、纯 C 零依赖的嵌入式向量方案。
5. [官方文档] sqlite-vec 安装文档 — https://alexgarcia.xyz/sqlite-vec/installation.html — 各语言包与预编译扩展的分发方式。
6. [开源项目] BAAI/bge-large-zh-v1.5 — https://huggingface.co/BAAI/bge-large-zh-v1.5 — 中文检索稳健基线与查询指令用法。
7. [学术论文] BGE M3-Embedding: Multi-Lingual, Multi-Functionality, Multi-Granularity — https://arxiv.org/abs/2402.03216 — 稠密/稀疏/多向量三合一、8192 token 长输入与自知识蒸馏训练。
8. [学术论文] C-Pack: Packaged Resources To Advance General Chinese Embedding — https://arxiv.org/abs/2309.07597 — C-MTEB（6 任务 35 数据集）中文 embedding 评测基准。
9. [开源项目] embeddings-benchmark/mteb — https://github.com/embeddings-benchmark/mteb — 多语言 embedding 评测框架与榜单，选型依据。
10. [技术文章] Advanced RAG — Understanding Reciprocal Rank Fusion in Hybrid Search — https://glaforge.dev/posts/2026/02/10/advanced-rag-understanding-reciprocal-rank-fusion-in-hybrid-search/ — RRF 公式、k=60 的取舍与"先 RRF 后 cross-encoder 重排"模式。
11. [学术论文] An Analysis of Fusion Functions for Hybrid Retrieval — https://arxiv.org/abs/2210.11934 — 线性结合 vs RRF vs LTR 的系统对比，RRF 无需调参且稳定。
12. [学术论文] Hybrid Retrieval-Augmented Generation with Knowledge Graph Expansion, RRF Fusion... — https://arxiv.org/pdf/2609.01617 — 生产级三路混合（BGE 向量 + SQLite FTS5 BM25 + 图谱）用加权 RRF 融合的实证。
13. [开源项目] text2vec — https://shibing624.github.io/text2vec/ — 中文 CoSENT 匹配模型与多种文本向量表征方案。

## 5. 对御书设计的启示

**数据结构建议：可重建索引结构（SQLite，Markdown 为真源）**

```yaml
# .yushu/index.sqlite 逻辑结构（索引可删可重建，不承载任何唯一真源）
index_meta:                 # 元信息：决定是否需要重建
  schema_version: 3
  embedding: {model: BAAI/bge-m3, dim: 1024, normalize: true}
  chunking: {granularity: scene, max_tokens: 512, overlap_ratio: 0.12}
  fts: {tokenizer: simple, query_fn: jieba_query}
  rrf: {k: 60, w_vector: 0.55, w_fts: 0.45}
chunks:                     # 主表
  - id: ch-012#scene-03
    chapter_id: ch-012
    volume: vol1
    kind: scene             # chapter | scene | paragraph
    text: "..."
    char_start: 812
    char_end: 1974
    text_hash: "sha256:..."
    entities: [char-linyuan, loc-cangjingge]   # 出场实体（供 J05 选卡）
    reveal_state: revealed                     # 与 A08 联动
    tokens: 431
embeddings:                 # 对应 sqlite-vec 的 vec0 虚表
  - {chunk_id: ch-012#scene-03, vec: "[...1024 floats]"}
fts_index:                  # FTS5 external content 表，可 rebuild
  create: "CREATE VIRTUAL TABLE fts USING fts5(text, content='chunks', content_rowid='id', tokenize='simple')"
file_index:                 # 增量索引依据
  - {path: chapters/vol1/ch-012.md, mtime: 2026-09-29T10:00:00+08:00, hash: "sha256:...", indexed_at: "..."}
```

**检索管线（固定顺序）**

```text
query(当前场景 / 大纲节点 / 选中文本)
  ├─ 向量路: embed(query) → vec0 KNN top-50
  └─ 关键词路: simple_query / jieba_query → FTS5 bm25 top-50
        └─ RRF 融合 (k=60, 加权) → top-20
              └─ [可选] bge-reranker 精排 → top-6
                    └─ 带出处打包 → 交给 J03 上下文组装
```

**校验规则建议**

- `index-stale`：源章节 `mtime/hash` 与 `file_index` 不一致 → warn，提示增量重建。
- `index-embedding-dim-mismatch`：`index_meta.embedding.dim` 与向量实际维度不符 → error，强制重建。
- `chunk-empty`：切块结果为空或过短（< 20 字）→ warn（切块器异常）。
- `chunk-overlap-out-of-range`：`overlap_ratio` 不在 0~0.3 → error。
- `rrf-weight-invalid`：`w_vector + w_fts ≠ 1` 或 k 非正 → error。
- `citation-dangling`：检索结果或 AI 引用指向已删除/不存在的 chunk → error（反幻觉红线，引用 J07）。
- `retrieval-must-hit-miss`：作者标记的"魔鬼查询集"中某场景未被召回 → info，记录为检索质量回归。

**功能建议**

- 检索调试面板：双路名次 + RRF 得分 + 重排名次 + 最终入上下文片段一屏可见。
- 出处跳转：检索结果与 AI 引用均可点击跳回源章节并高亮原文（类似 GitHub 式定位）。
- 索引重建向导：显示"将重算 N 个文件 / 预计耗时 / 需下载模型"，支持后台重建与进度显示。
- 检索质量回归：保存"魔鬼查询集"，重构切块/模型后一键回放对比。
- 模型/切块切换保护：变更前弹出"需全量重建索引"确认，禁止混合维度向量。

**AI 提示词建议**

- 「查询改写」：把当前场景摘要与大纲节点改写为 3~5 条检索查询（覆盖专名、情绪、事件），提升召回。
- 「引用核验」：给定检索片段与 AI 生成正文，输出"哪些句子有出处支撑、哪些无出处"（引用 J07）。
- 「切块摘要」：为每个 chunk 生成一句话标签与出场实体列表，写入 `entities` 供 J05 选卡。

## 6. 领域内子主题备忘（可选）

- 多向量 / ColBERT 式晚交互检索在长篇小说中的性价比评估。
- 稀疏检索（SPLADE、BGE-M3 sparse）替代 BM25 的可行性。
- 角色专名的拼音 / 繁简 / 异体字检索（与 K09、OpenCC 联动）。
- 跨卷时间衰减权重（新近度 × 相关性的混合打分）。
- 增量索引的代价控制（只重算变更场景而非整章）。