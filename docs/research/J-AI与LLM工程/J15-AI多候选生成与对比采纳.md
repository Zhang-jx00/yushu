# J15-AI多候选生成与对比采纳

> 类别：J-AI与LLM工程 ｜ 世界构建金字塔层级：工程层 · AI 工程
> 质量要求：信息来源 ≥6 条、覆盖 ≥3 种来源类型；URL 必须来自真实检索结果。

## 1. 领域定义

研究"同一任务生成多个候选 → 对比 → 局部采纳"的工程化闭环：n 候选的参数化生成（温度/种子分离）、候选间 diff（文本级 + 语义级）、整段/按句/合并的采纳方式、拒绝原因记录与回流、采纳后写入真源并留 AI 使用记录。边界划分：任务定义与提示词归 J02，模型路由、排队与成本归 J09，证据链归 J13，候选"内容对不对"归 J07；本领域只管"多候选的产生-比较-采纳"这一段。对上游的呼应：docs/01 §4.5 明确要求"AI 多候选：同一任务生成多候选、diff 对比、整段或局部采纳"，本领域是该需求的落地领域。

## 2. 核心知识框架

1. **多候选采样原理**。Self-Consistency 的 `sample-and-marginalize`：多次采样后按一致性聚合答案，说明多样本可提升可靠性、削弱单次生成的随机性；best-of-N 则从 N 个候选中挑最优。御书取"人工挑选为主、机器预筛为辅"的折中。
2. **候选的表达参数化**。温度与种子是候选多样性与可复现的双旋钮：温度控制发散度，种子保证同参数可重放（便于复现与审计）。
3. **成本线性放大**。OpenAI 的 `n` 参数说明：多个候选"按所有候选的 token 计费"——n 候选 = 近似线性成本，因此必须限制 N（建议 2~4）、优先用便宜档做候选、仅高风险场景开多候选（对接 J09 成本面板）。
4. **选优方法与判官偏差**。LLM-as-judge 可近似人类偏好（MT-Bench 报告 >80% 一致），但存在位置、冗长、自我增强三类偏差；且 LLM 评分自一致性低（Rating Roulette），关闭采样反而降低与人类的一致性——需顺序随机化、多次采样取均值，或干脆以人工挑选为主。
5. **最佳选择 ≠ 最优决策**。best-of-N 的关键瓶颈是"平局"与 within-prompt 信号不足，"判官分数好看"不等于"选择决策可用"。
6. **diff 的两层**。文本级 diff 用 Myers O(ND) 最短编辑脚本（行/句级 LCS，附带语义清理）；语义级 diff 抽取"事实差异/风格差异/情节走向差异"三类，供作者按意图比较。
7. **采纳与留痕**。采纳结果写入唯一真源（正文文件），同时写 AI 使用记录（models/提示词哈希/候选 id/采纳区间），满足 docs/01 §4.5 人类创作证据链与 J13 审计要求。

## 3. 可转化为产品规则的关键实践

1. 候选参数化 → 逐候选记录 `temperature/seed/model`，支持一键复现同一候选，便于比对与审计。
2. 候选预算上限 → 默认 n=3，生成前显示成本预估；超上限需二次确认（对接 J09）。
3. 双层 diff → 文本级行内高亮 + 语义级标签（事实/风格/情节），语义差异由 J06 原子事实抽取的差集计算。
4. 风格差异度量 → 复用 E07 声线指标（句长分布/词频/口头禅）比对候选，偏离声线卡 → 提示。
5. 局部采纳 → 编辑器支持整段采纳、按句勾选、交叉合并（A 的开头 + B 的结尾），合并冲突处显式提示。
6. 拒绝原因记录 → 预置标签（太水/跑偏/人设不符/OOC/风格不符/战力崩）+ 自由文本，沉淀为风格偏好与提示词改进数据（回流 J02）。
7. 采纳即留痕 → 写入正文章节文件（唯一真源）+ `ai_usage` 记录（J13 证据链）。
8. 批量候选排队 → 批量走 Batch 半价通道、队列化、失败重试与冷却（J09 路由与限流）。
9. 多模型盲评 → 中文写作评测主观性强，内置多模型盲评对比而非硬编码推荐（S7 关键发现）。

## 4. 信息来源

1. [学术论文] Self-Consistency Improves Chain of Thought Reasoning in Language Models（ICLR 2023） — https://arxiv.org/abs/2203.11171 — `sample-and-marginalize`：多次采样后按一致性聚合，多种子候选的理论基座。
2. [学术论文] Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena — https://arxiv.org/abs/2306.05685 — LLM 判官的位置/冗长/自我增强偏差与缓解手段（顺序随机、参考基准），候选选优防偏依据。
3. [学术论文] Rating Roulette: Self-Inconsistency in LLM-As-A-Judge Frameworks — https://arxiv.org/html/2510.27106 — LLM 评分自一致性低，关闭采样反而降低与人类一致性 → 判官需采样 + 均值聚合。
4. [学术论文] Self-rationalization improves LLM as a fine-grained judge — https://arxiv.org/html/2410.05495 — best-of-N 采样与 self-consistency 的对比及其局限，细粒度 rubric 打分的改进路径。
5. [学术论文] When LLM Judge Scores Look Good but Best-of-N Decisions Fail — https://arxiv.org/html/2603.12520 — 评分相关性 ≠ 决策可用性，平局与 within-prompt 信号是 best-of-N 的主要瓶颈。
6. [官方文档] Azure OpenAI v1 REST API reference（Create chat completion） — https://learn.microsoft.com/en-in/azure/ai-foundry/openai/latest?view=foundry — `n` 生成多个候选，且"按所有候选的 token 计费"→ 候选数直接线性放大成本。
7. [技术文章] Myers Diff Algorithm Explained（LineDiff） — https://linediff.app/blog/myers-diff-algorithm-explained — O(ND) 最短编辑脚本（LCS）+ 语义清理，文本级 diff 的标准算法。
8. [技术文章] Myers' Diff Algorithm: A Powerful Tool for Efficient Sequence Comparison（jsdiff） — https://www.jsdiff.com/docs/myers-diff-algorithm.html — 编辑图与 k 线分层搜索的通俗解释，落为行内/句级高亮实现。
9. [技术文章] 用 API 方式免费使用 GPT 写小说 — https://zhaozhiming.github.io/2024/04/26/free-use-gpt-api-write-novel/ — gpt-author 流程中"选择最吸引人的情节"的候选挑选环节，人挑候选的实践样本。
10. [开源项目] gpt-author — https://github.com/mshumer/gpt-author — 候选情节→大纲→逐章写作→EPUB，多候选 + 人工审阅的流水线参照。

## 5. 对御书设计的启示

**数据结构建议：候选与采纳记录 schema**

```yaml
# candidates/task-7f3/applied.yaml
task_id: task-7f3
task_type: continue                # continue|expand|polish|rewrite
base: {chapter: ch-012, start: 640, end: 900}
candidates:
  - id: cand-a
    model: deepseek-chat
    temperature: 0.8
    seed: 10241                    # 可复现
    text_ref: candidates/task-7f3/cand-a.md
    diff:
      text: {added: 34, removed: 6}          # Myers 行/句级
      semantic: {facts: ["新增『玉佩来源』"], style: "句长偏长", plot: "另起支线"}
  - id: cand-b
    model: deepseek-chat
    temperature: 0.8
    seed: 55071
    diff:
      text: {added: 41, removed: 2}
      semantic: {facts: [], style: "贴合声线", plot: "推进主线"}
adoption:
  mode: partial                    # full|partial|merge
  accepted: [{candidate: cand-b, spans: [[0, 180], [260, 340]]}]
  rejected: [{candidate: cand-a, reasons: [太水, 跑偏]}]
  written_to: chapters/vol1/ch-012.md      # 写入唯一真源
ai_usage_ref: usage/2026-09-29-7f3.json    # J13 证据链
```

**校验规则建议**

- `candidate-n-over-budget`：n 超过项目上限且未二次确认 → warn（防成本失控，对接 J09）。
- `candidate-no-seed`：`temperature>0` 但未记录 `seed` → info（候选不可复现）。
- `candidate-merge-unconfirmed`：merge 模式未逐句确认即写入真源 → error。
- `usage-unrecorded`：采纳后缺 `ai_usage` 记录 → error（合规，docs/01 §4.5）。
- `candidate-style-drift`：采纳候选与声线卡（E07）偏差超阈值 → warn。

**功能建议**

- 候选面板：并排展示 n 个候选（可折叠），顶部显示模型/温度/种子/成本；支持标记"基准候选"再逐条对比。
- diff 视图：文本级行内高亮 + 语义级差异表（事实/风格/情节三列），差异可点击跳原文。
- 局部采纳器：编辑器内按句勾选，实时预览合并结果；合并句冲突处弹"保留 A/B/手改"。
- 拒绝原因看板：统计标签分布，输出"高频拒绝原因 → 提示词改进建议"清单（回流 J02）。
- 批量队列视图：Batch 任务进度、失败重试、成本累计（对接 J09 成本面板）。

**AI 提示词建议**

- 多候选差异化：「生成 3 个候选，分别侧重①推进主线②强化人物弧光③制造悬念；各自独立，不得互相参照」——保证候选多样性而非同质复制。
- 判官提示：「按 [一致性/声线/爽点] 三条 rubric 给两候选打分并说明理由，注意不要偏好更长文本」；调用时随机化候选顺序以对抗位置偏差。
- 合并提示：「把候选 A 的开头（至第 X 句）与候选 B 的结尾合并，保持称呼与时间线一致」，并回检 J07 校验。

## 6. 领域内子主题备忘（可选）

- 候选自动去重（语义近似候选合并）与"N 候选自动预筛为 2 个"的降本策略。
- 偏好数据沉淀：拒绝原因 + 采纳结果积累为 DPO 式风格偏好训练数据的合规边界。
- 跨模型候选对比（同一提示词跑多 Provider 盲评，S7 思路）与本地模型参与候选的可行性。
- 长段生成的候选切分粒度（整章 vs 按节 vs 按场景各出候选）对 diff 可用性的影响。