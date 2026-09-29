# 预研种子库 S4：AI 写作工具与 LLM 应用（52 份）

> 来源：2026-09-28 预研。13 个关键页面（NovelAI/SillyTavern/NovelCrafter 官方文档、Sudowrite 官网、Anthropic/OpenAI 工程文档、GitHub README、arXiv）经逐页核实。

## 官方文档
1. [官方文档] NovelAI Lorebook — https://docs.novelai.net/en/text/lorebook/ — 激活关键词/正则/Always On/Token Budget/插入顺序/级联激活。★设定卡注入权威规格
2. [官方文档] SillyTavern World Info — https://docs.sillytavern.app/usage/core-concepts/worldinfo/ — 扫描深度、递归、互斥组、时序效果、预算与插入位置。★最全 Lorebook 机制
3. [官方文档] NovelCrafter Help（Codex） — https://www.novelcrafter.com/help — Codex 条目结构、Aliases & Mentions、Codex Tracking、Progressions、Series Codex。
4. [官方文档] OpenAI Prompt Caching — https://developers.openai.com/api/docs/guides/prompt-caching — 缓存前缀 KV 复用、最高 90% 折扣、1024 token 门槛与 TTL。
5. [官方文档] OpenAI Structured model outputs — https://developers.openai.com/api/docs/guides/structured-outputs — JSON Schema 强制输出，用于设定卡抽取。
6. [官方文档] Anthropic《Effective context engineering for AI agents》 — https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents — context rot、just-in-time 检索、压缩、笔记记忆、子代理五策略。
7. [官方文档] Sudowrite 官网功能页 — https://www.sudowrite.com/ — Story Bible（想法→大纲→章 beats→草稿）与 Describe/Write/Expand/Rewrite/Brainstorm/Canvas/Feedback。
8. [官方文档] SillyTavern 文档站（Prompts/角色卡） — https://docs.sillytavern.app — 默认提示词结构与角色卡字段。
9. [官方文档] 彩云小梦官网 — https://www.xiaomengai.com — 中文 AI 续写鼻祖，"云锦天章"自研模型。

## 学术论文
10. [学术论文] Re3（EMNLP 2022） — https://arxiv.org/abs/2210.06774 — 计划+递归重注入+重排序+修订，长篇连贯性 +14~20%。
11. [学术论文] DOC（ACL 2023） — https://arxiv.org/abs/2212.10077 — 大纲控制字符细粒度约束"何时发生什么"。
12. [学术论文] DOME（ICLR 2024） — https://arxiv.org/abs/2310.12924 — 动态分层大纲+记忆增强，边写边改大纲。
13. [学术论文] Dramatron — https://arxiv.org/abs/2307.09288 — logline→角色→情节→场景→对话五层链式生成。
14. [学术论文] RecurrentGPT — https://arxiv.org/abs/2305.13304 — 自然语言短期/长期记忆+每步更新计划，人机协同。
15. [学术论文] Weaver: Foundation Models for Creative Writing — https://arxiv.org/abs/2401.17268 — 专职写作领域模型，小领域模型可胜通用大模型。
16. [学术论文] LongWriter（含 AgentWrite 管线） — https://arxiv.org/abs/2408.07079 — 单次输出 2000 词上限；分段规划+字数控制方案。
17. [学术论文] Plan-and-Write（AAAI 2019） — https://arxiv.org/abs/1811.05701 — "先规划故事线再写作"范式奠基。
18. [学术论文] Generative Agents — https://arxiv.org/abs/2304.03442 — 记忆流+重要性/相关性/新近度评分+反思架构。
19. [学术论文] RAG Survey — https://arxiv.org/abs/2312.10997 — Naive/Advanced/Modular RAG 三范式。
20. [学术论文] A Survey on LLMs for Story Generation — https://mariateleki.github.io/pdf/EXTENDED_A_Survey_on_LLMs_for_Story_Generation.pdf — 全局连贯性/故事状态跟踪/长程约束困难综述。
21. [学术论文] Learning to Reason for Long-Form Story Generation — https://arxiv.org/html/2503.22828v1 — RL 训练长篇推理（规划、审阅）。
22. [学术论文] SCORE: Story Coherence and Retrieval Enhancement — https://arxiv.org/html/2503.23512v1 — 检索增强维护长程连贯与情感一致。
23. [学术论文] Consistency Bugs in Long Story Generation — https://arxiv.org/html/2603.05890v1 — LLM 长文生成"自我矛盾设定/人物/世界规则"失败模式分析。
24. [学术论文] DOME 扩展版（NAACL 2025） — https://arxiv.org/html/2412.13575v1 — DHO+MEM 组合升级实验。

## 开源项目
25. [开源项目] Long-Novel-GPT — https://github.com/MaoXiaoYuZ/Long-Novel-GPT — 中文长篇生成器：大纲→章节→正文三层扩写、RAG 上下文、拆书导入、成本显示。
26. [开源项目] gpt-author — https://github.com/mshumer/gpt-author — 候选情节→大纲→逐章写作→EPUB。
27. [开源项目] SillyTavern — https://github.com/SillyTavern/SillyTavern — AGPL 多后端 LLM 前端：角色卡、World Info、扩展系统、向量存储。★模型无关架构参照
28. [开源项目] show-me-the-story — https://github.com/Nigh/show-me-the-story — 自托管中文长篇应用：设定条目全量注入、事实抽取带出处、伏笔追踪、一致性校验。★中文场景完整开源实现
29. [开源项目] StoryToolkitAI — https://github.com/octimot/StoryToolkitAI — 本地转写+语义检索+LLM 故事编辑器。
30. [开源项目] doc-story-generation（DOC 官方代码） — https://github.com/yangkevin2/doc-story-generation — 大纲控制 prompt 工程样例。
31. [开源项目] RecurrentGPT 官方代码 — https://github.com/aiwaves-cn/RecurrentGPT — 语言化记忆+交互式长文生成参考实现。
32. [开源项目] THUDM/LongWriter — https://github.com/THUDM/LongWriter — AgentWrite 管线与 LongWriter-6k 数据集。
33. [开源项目] Awesome-Story-Generation — https://github.com/yingpengma/Awesome-Story-Generation — 故事生成论文/资源合集。
34. [开源项目] ainovelprompter — https://github.com/danielsobrado/ainovelprompter — 一致性提示词组织工具。
35. [开源项目] NousResearch/autonovel — https://github.com/NousResearch/autonovel — 写作/修订/排版/插画全自主流水线。

## 技术文章
36. [技术文章] Tapwavezodiac《NovelAI Context 指南》 — https://tapwavezodiac.github.io/novelaiplus-info/ — NovelAI 上下文组装剖析（Memory/Lorebook/Author's Note 排布与 View Last Context）。
37. [技术文章] NovelAI Blog — https://blog.novelai.net — Lorebook 设计初衷与 Memory/Author's Note 联动。
38. [技术文章] Grammarly 工程博客 — https://www.grammarly.com/blog/engineering/grammarly-business-gateway — 商业写作助手工程架构。
39. [技术文章] Foreverse《小梦把"接着写"带给中文互联网》 — https://foreverse.cn/zh/blog/after-caiyun-xiaomeng — "三选一续写+平行世界"交互设计。
40. [技术文章] Anthropic 工程博客索引 — https://www.anthropic.com/engineering — 子代理隔离上下文、多代理编排。

## 评测
41. [评测] AITuts NovelAI 评测 — https://aituts.com/novelai-review/ — 触发关键词命中才注入的 token 节省机制。
42. [评测] Capterra：Sudowrite — https://www.capterra.com/p/230438/Sudowrite/ — 全流程功能与 Story Bible 定位。

## 社区讨论
43. [社区讨论] 知乎《对话彩云科技》 — https://zhuanlan.zhihu.com/p/663274540 — AI-Native 续写产品技术取舍。
44. [社区讨论] BAAI Hub 专访彩云小梦 — https://hub.baai.ac.cn/view/38829 — 自定义世界设定、扮演角色、AI 协作推进情节机制。
45. [社区讨论] Character Tavern — https://character-tavern.com — 社区打磨的叙事/扮演系统提示词。
46. [社区讨论] RP|Fiend — https://rpfiend.com — "角色卡=是谁、系统提示=怎么写"关注点分离。
47. [社区讨论] HF Discuss：SillyTavern World Info 与 Data Bank — https://discuss.huggingface.co/t/sillytavern-roleplay-llm-context-management/128563 — 可变故事状态放模型权重之外、按需注入。
48. [社区讨论] Royal Road《I looked at 100 AI-tagged novels》 — https://www.royalroad.com — AI 检测器在小说场景误判争论。

## 百科词条
49. [百科词条] 百度百科：彩云小梦 — https://baike.baidu.com/item/彩云小梦/59403428 — 中文 AI 续写沿革与"世界设定"玩法。
50. [百科词条] AI Dynamic Storytelling Wiki: Lorebooks — https://aids.miraheze.org — Lorebook 社区定义。

## 合规补充
51. [技术文章] ABA：注册含 AI 生成内容的作品 — https://www.americanbar.org — 版权保护要求人类作者身份。
52. [评测] BookWiz：Amazon KDP AI 内容披露规则 — https://bookwiz.io — AI-generated（须披露）与 AI-assisted（免披露）二分。

## 关键发现备忘
- 设定注入双轨：关键词触发（省 token）+ 常驻注入（强制）；Token 预算/插入优先级/扫描深度为一等参数。
- "提及检测"（Aliases & Mentions）+ Progressions（设定随剧情演进）+ 事实级记忆带出处，值得御书吸收。
- 上下文预览器（View Last Context）是排查"AI 忘设定"的必备调试功能。
- 分层计划→递归重注入→修订是长篇生成定论；单次输出约 2000 词上限 → 按节生成。
- 自然语言摘要记忆可行且可人工修正（RecurrentGPT）。
- 一致性需要独立校验层（生成后事实/人设/时间线审查）。
