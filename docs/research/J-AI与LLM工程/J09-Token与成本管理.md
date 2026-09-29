# J09-Token与成本管理

> 类别：J-AI与LLM工程 ｜ 世界构建金字塔层级：工程层 · AI 工程
> 质量要求：信息来源 ≥6 条、覆盖 ≥3 种来源类型；URL 必须来自真实检索结果。

## 1. 领域定义

研究御书的"花多少 token、花多少钱、如何省"：Token 计数双轨（本地估算 vs API usage 实报）、成本面板与归因（项目/任务/模型/章节）、生成前预估与生成后结算、Prompt Caching 的计价机制（写入溢价 / 命中折扣 / TTL / 门槛）、Batch 半价离线通道、上下文预算与模型选择对成本的影响、免费额度与本地模型零成本路径。上游需求见 docs/01 §4.5（Token 计数=本地估算+usage 实报；成本面板；prompt caching 稳定前缀；大纲候选走批量半价通道）。边界：J01 管接入、J02 管提示词编排、J03 管分层记忆；本领域只管"计量与省钱"这一件事。

## 2. 核心知识框架

1. **Token 计数双轨**。本地用 tiktoken 系 BPE（`cl100k_base`/`o200k_base`）做估算，用于生成前预算与截断（经验值约 4 bytes/token）；真实计费以响应 `usage` 为准。流式响应在最后一个 chunk 返回 usage，需在解析层单独捕获；本地模型可能不返回 usage，只能估算。
2. **成本归因模型**。每条调用记录：项目、任务类型、Provider/模型、输入/输出/缓存 token、单价与折算金额、通道（sync/batch/local）、时间戳与章节关联，形成可聚合的立方体。
3. **预估 vs 结算**。生成前按模板 token 预算 × 单价给出成本预估（含缓存命中假设）；生成后以 usage 结算并回写，二者偏差进入"估算准确度"指标。
4. **Prompt Caching 计价**。缓存按字节相同前缀命中：Anthropic 写 1.25×（1h 缓存 2×）、读 0.1×，默认 5 分钟 TTL；OpenAI 旧模型免写入费、读最高九折，GPT-5.6 系改为 1.25× 写 / 0.1× 读；Azure 要求前 1024 token 相同；DeepSeek 命中/未命中分档、峰谷半价。盈亏平衡约"2 次复用即回本"。
5. **Batch 半价通道**。异步 Batch API 24 小时内完成，输入输出各省 50%，适合离线批量任务（大纲候选、摘要回填、存量稿实体抽取），不适合交互续写。
6. **上下文预算与位置衰减**。Lost-in-the-Middle：相关信息位于长上下文中部时召回显著下降，且上下文越长成本越高 → 分层组装（J03：核心常驻 + 摘要 + 最近窗口 + RAG），把 token 花在高信号处。
7. **免费额度与零成本路径**。多数 Provider 有新用户额度；本地 Ollama/llama.cpp/vLLM 推理边际成本为零（仅电费与算力），是审稿、批量试算与离线场景的兜底。

## 3. 可转化为产品规则的关键实践

1. 每次调用产出 `cost_record` → 成本面板按 项目/任务/模型/章节 四维聚合，可下钻到单次调用。
2. 本地估算器（tiktoken 系）+ usage 实报 → UI 显示"预估 vs 实付"，偏差超阈值提示校准 tokenizer/定价表。
3. 生成前成本预估 → 续写/批量任务弹"预计消耗 ¥x / N tokens"，超预算需用户确认（低成本护栏）。
4. 缓存友好度指标 → 显示命中率、写入/命中 token 占比与折扣金额；命中率骤降提示"前缀被击穿"（与 J02 断点设计联动）。
5. Batch 通道分流 → 任务标记 `batch_eligible`（大纲候选、摘要回填、实体抽取）自动建议或提交批量队列；交互任务保持同步。
6. 上下文预算器 → 组装前校验 `输入 token ≤ context − max_output`，超出按分层优先级裁剪或升级模型上下文。
7. 模型选择建议 → 依成本表 + 中文评测，给出"同任务更省且质量达标"的替代模型建议（不硬编码推荐，用盲评数据）。
8. 免费额度与本地提醒 → 显示各 Provider 余额/额度余量；本地端点标注"零成本"，在省钱/离线模式优先路由。

## 4. 信息来源

1. [官方文档] OpenAI Prompt Caching — https://developers.openai.com/api/docs/guides/prompt-caching — 前缀匹配、1024 token 门槛、读/写乘数与 TTL（[已验证]）。
2. [官方文档] Anthropic Prompt caching — https://platform.claude.com/docs/en/build-with-claude/prompt-caching — 写 1.25×（1h 2×）、读 0.1×，缓存覆盖 tools→system→messages 完整前缀。
3. [官方文档] Azure OpenAI Prompt caching — https://learn.microsoft.com/en-za/azure/foundry/openai/how-to/prompt-caching — 前 1024 token 需一致、`prompt_cache_key` 与显式断点、GPT-5.6 起计入写费用。
4. [官方文档] DeepSeek 价格页 — https://api-docs.deepseek.com/quick_start/pricing — 缓存命中/未命中分档、峰谷半价、1M 上下文（[已验证]）。
5. [官方文档] OpenAI API 定价（中文） — https://openai.com/zh-Hans-CN/api/pricing/ — Batch API 输入输出各省 50%、缓存输入低至 0.1×、弹性处理档位。
6. [开源项目] tiktoken — https://github.com/openai/tiktoken — 快速 BPE 分词器，本地 token 估算与截断的基础（约 4 bytes/token）。
7. [技术文章] IntuitionLabs《LLM Prompt Caching: Cost Savings, Invalidation & Workload Design》 — https://intuitionlabs.ai/pdfs/llm-prompt-caching-cost-savings.pdf — 缓存盈亏平衡公式 N*=(w−r)/(1−r)≈1.28、前缀一字符变更即整体失效。
8. [学术论文] Lost in the Middle: How Language Models Use Long Contexts — https://arxiv.org/abs/2307.03172 — 长上下文中部信息召回衰减（U 形曲线），支撑"预算花在高信号处"。
9. [评测] chinese-llm-benchmark — https://github.com/jeinlee1991/chinese-llm-benchmark — 374+ 中文模型多维评测，辅助"同任务更省且达标"的模型选择（[已验证]）。
10. [官方文档] Anthropic Prompt caching with Claude（发布说明） — https://www.anthropic.com/news/prompt-caching — 缓存带来最高 90% 成本下降、缓存读仅 0.1× 基准价。

## 5. 对御书设计的启示

**数据结构建议：成本记录（SQLite 索引可从文件重建，符合 docs/01 §6）**

```yaml
# .yushu/cost/records.jsonl —— 每次调用一行
- id: call-20260929-0042
  project: my-xuanhuan
  task: drafting                 # outline|naming|polish|drafting|extract|summary
  provider: openai
  model: gpt-5.6-luna
  channel: sync                  # sync | batch | local
  chapter_ref: ch-012
  tokens:
    input: 8421
    cached_input: 6016           # 命中缓存的前缀 token
    cache_write: 0
    output: 1480
  estimate: {input: 8500, output: 1500}   # 生成前预估，用于准确度对比
  cost: {currency: CNY, amount: 0.0912}
  usage_source: api              # api | local_estimate
  ts: 2026-09-29T21:14:07+08:00
```

**数据结构建议：定价表与预算配置**

```yaml
# pricing/deepseek.yaml —— 随官方价格页更新
model: deepseek-chat
currency: CNY
per_mtok:
  input_miss: 2.0
  input_hit: 0.2                # 缓存命中价
  output: 8.0
  batch_mult: 0.5               # 批量通道折扣
  peak_offpeak: {peak_mult: 1.0, offpeak_mult: 0.5}
cache: {min_tokens: 64, read_mult: 0.1, write_mult: 1.0, ttl: auto}
```

```yaml
# config/budget.yaml
budget:
  monthly_cap: 30.0              # 月度上限（CNY）
  per_call_confirm_over: 1.0     # 单次预估超此值需确认
  context_policy: {reserve_output: true, trim_order: [rag, recent_window, summaries, core]}
batch_eligible: [outline, summary, extract]   # 走半价通道的任务
free_tier_reminder: true
```

**功能建议**
- 成本面板：四维聚合（项目/任务/模型/章节）+ 时间趋势 + 单次下钻；缓存折扣单独一栏。
- 预估-结算对账：显示估算准确度中位数，偏差大时提示更新本地 tokenizer/定价表。
- 缓存健康度：命中率曲线 + "前缀被击穿"告警，跳转到 J02 模板断点设置。
- Batch 队列：离线批量任务的可视化提交、进度与半价节省统计。
- 本地零成本标注：Ollama 等端点显示"¥0"，省钱/离线模式优先路由。
- 预算护栏：临近月度上限时降级到小模型或本地模型并提示。

**校验规则建议**
- `cost-usage-missing`：模型声明 `usage: true` 却无 usage 回写 → warn（检查解析层）。
- `budget-context-overflow`：组装输入 token > `context − max_output` → error。
- `cache-prefix-unstable`：缓存命中率低于阈值（前缀段疑似含日期/章节号）→ info，联动 J02。
- `batch-eligible-unsynced`：`batch_eligible` 任务走同步通道且非交互 → info，建议改批量。
- `cost-per-chapter-anomaly`：单章成本超过全书均值 N 倍 → warn（可能提示词失控或上下文膨胀）。

**AI 提示词建议**
- 「成本优化」：输入某任务的 token 构成明细，输出降本方案（前置缓存、裁剪 RAG、换档位、改批量）。
- 「模型选型」：输入任务类型 + 质量底线 + 预算，结合评测与定价输出候选模型与理由。
- 「预算解释」：用自然语言向作者解释"这个月钱花在哪、下月怎么省"，生成可读的成本小结。

## 6. 领域内子主题备忘（可选）

- 多币种与汇率折算（海外 Provider 计价、账单导出口径统一）。
- 团队/多项目成本分摊（本地工具下的轻量多用户口径）。
- 缓存 TTL 与工作节奏的匹配（日更作者 5m vs 1h 缓存的选择）。
- 与 I08 码字统计的"每千字成本"指标联动。
- 自托管 vLLM 的算力成本折算（电费/GPU 时租 vs API 单价）。