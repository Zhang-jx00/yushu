# 预研种子库 S7：LLM 官方文档与多模型接入（43 份）

> 来源：2026-09-28 预研。12 个关键页面（DeepSeek 价格页、智谱兼容页、Ollama 兼容页、Gemini 兼容层、OpenAI/Anthropic 缓存指南、MDN SSE、LiteLLM Router、one-api、llama.cpp、LongBench 等）经 WebFetch 验证。

## 官方文档
1. [官方文档] OpenAI Chat Completions API Reference — https://platform.openai.com/docs/api-reference/chat — messages/tools/response_format/stream 全参数。★协议母本
2. [官方文档] OpenAI Structured Outputs — https://platform.openai.com/docs/guides/structured-outputs — json_schema+strict 严格输出。
3. [官方文档] OpenAI Function Calling — https://platform.openai.com/docs/guides/function-calling — 工具调用与流式 delta.tool_calls。
4. [官方文档] OpenAI Prompt Caching — https://developers.openai.com/api/docs/guides/prompt-caching [已验证] — 前缀匹配、1024 门槛、读 0.1x/写 1.25x、TTL。
5. [官方文档] Anthropic Prompt Caching — https://platform.claude.com/docs/en/docs/build-with-claude/prompt-caching [已验证] — cache_control 断点、5m/1h TTL、乘数表。
6. [官方文档] Gemini API OpenAI 兼容层 — https://ai.google.dev/gemini-api/docs/openai [已验证] — base_url .../v1beta/openai/，beta 限制。
7. [官方文档] DeepSeek API 文档 — https://api-docs.deepseek.com/ — 换 base_url 即用 OpenAI SDK，国产兼容标杆；另有 /anthropic 端点。
8. [官方文档] DeepSeek 价格页 — https://api-docs.deepseek.com/quick_start/pricing [已验证] — 缓存命中/未命中分档、峰谷半价、1M 上下文。
9. [官方文档] 智谱 GLM OpenAI 兼容 — https://docs.bigmodel.cn/cn/guide/develop/openai/introduction [已验证] — base_url、流式/工具调用/thinking 字段。
10. [官方文档] 智谱对话补全 API 参考 — https://docs.bigmodel.cn/api-reference/模型-api/对话补全 — 多模态/流式/工具调用参数。
11. [官方文档] 阿里云百炼 OpenAI 兼容 — https://docs.bailian.console.aliyun.com — compatible-mode 端点与 Batch 5 折。
12. [官方文档] Moonshot Kimi 开放平台 — https://platform.moonshot.cn/docs — api.moonshot.cn/v1。
13. [官方文档] MiniMax 开放平台 — https://platform.minimax.chat — /v1/chat/completions。
14. [官方文档] 阶跃星辰开放平台 — https://platform.stepfun.com — api.stepfun.com/v1。
15. [官方文档] Ollama OpenAI Compatibility — https://docs.ollama.com/openai [已验证] — localhost:11434/v1，支持/不支持字段清单（不支持 tool_choice/logit_bias/n）。
16. [官方文档] LM Studio 本地服务器 — https://lmstudio.ai/docs/app/api — localhost:1234/v1。
17. [官方文档] vLLM OpenAI-Compatible Server — https://docs.vllm.ai/en/latest/serving/online_serving/openai_compatible_server — GPU 自托管。
18. [官方文档] MDN Server-Sent Events — https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events [已验证] — SSE 事件流规范。
19. [官方文档] OpenAI 价格页 — https://openai.com/api/pricing — 各模型单价与缓存价目。

## 开源项目
20. [开源项目] LiteLLM — https://github.com/BerriAI/litellm [已验证] — 100+ Provider 统一接口+网关。★Provider 抽象最佳参考
21. [开源项目] LiteLLM Router 文档 — https://docs.litellm.ai/docs/routing [已验证] — 6 种路由策略/重试/冷却/fallback/并发上限。
22. [开源项目] one-api — https://github.com/songquanpeng/one-api [已验证] — 37k star 国内聚合网关：渠道/令牌/配额。
23. [开源项目] new-api — https://github.com/QuantumNous/new-api — one-api 增强版，智能路由与成本管控。
24. [开源项目] llama.cpp — https://github.com/ggml-org/llama.cpp [已验证] — llama-server OpenAI 兼容 HTTP 服务。
25. [开源项目] tiktoken — https://github.com/openai/tiktoken — BPE tokenizer（cl100k/o200k）。
26. [开源项目] Anthropic Cookbook: prompt caching — https://github.com/anthropics/anthropic-cookbook/blob/main/misc/prompt_caching.ipynb — 缓存降本 >90% 实操。
27. [开源项目] LongBench — https://github.com/THUDM/LongBench [已验证] — 中英双语长上下文基准（8k–2M）。
28. [开源项目] LLMTest_NeedleInAHaystack — https://github.com/gkamradt/LLMTest_NeedleInAHaystack — 大海捞针测试原始实现。
29. [开源项目] chinese-llm-benchmark — https://github.com/jeinlee1991/chinese-llm-benchmark [已验证] — 374+ 中文模型多维评测榜。
30. [社区讨论] GLM-5 issue #39：请求支持 OpenAI /responses 协议 — https://github.com/zai-org/GLM-5/issues/39 — Responses API 兼容分化趋势。
31. [社区讨论] cc-switch issue #1013：智谱强制拼接 /v1 — https://github.com/farion1231/cc-switch/issues/1013 — base_url 兼容踩坑。

## 技术文章
32. [技术文章] Vellum：What to do when an LLM request fails — https://www.vellum.ai/blog/what-to-do-when-an-llm-request-fails — 规则路由与 fallback 策略。
33. [技术文章] Portkey：Task-Based LLM Routing — https://portkey.ai/blog/task-based-llm-routing — 按任务类型路由。
34. [技术文章] Merge.dev：LLM Routing 综述 — https://www.merge.dev/blog/llm-routing — 质量底线内选最便宜模型。
35. [技术文章] MindStudio：Three-Tier LLM Routing — https://www.mindstudio.ai/blog/set-up-ai-model-router-llm-stack-c2610 — Fast/Smart/Power 三档+熔断。
36. [技术文章] AYDesign：AI streaming UI patterns — https://www.aydesign.ai — Stop 按钮与中断交互。
37. [技术文章] HinterBuild：Streaming in Production — https://hinterbuild.com — 生产流式渲染与双端取消。
38. [技术文章] yage.ai：The Canonical Harness — https://yage.ai — OpenAI 兼容协议统一性的反方视角。
39. [技术文章] Distill Labs：Run a Fine-Tuned SLM with llama.cpp — https://www.distillabs.ai — GGUF+OpenAI 兼容服务实践。
40. [技术文章] 腾讯云社区：使用 OneAPI 聚合模型调用 — https://developer.cloud.tencent.com — 渠道聚合/鉴权部署经验。

## 评测
41. [评测] SuperCLUE 官网 — https://www.superclueai.com — 中文大模型综合基准（含写作维度）。
42. [评测] CLUE Benchmarks — https://cluebenchmarks.com — SuperCLUE 各专项报告。
43. [评测] Omdia 中文创意写作评测（东方财富号） — https://caifuhao.eastmoney.com — 2026 中文创意写作横评。

## 关键发现备忘
- OpenAI Chat Completions 是事实标准：DeepSeek/智谱/百炼/Kimi/MiniMax/阶跃/千帆/Ollama/llama.cpp/vLLM/LM Studio 全兼容 → 统一客户端+Provider 描述文件。
- "兼容≠一致"：每 Provider 声明 capabilities{tools, structured_output, stream, usage, reasoning} 并自动降级。
- Prompt 缓存：OpenAI 读 0.1x/写 1.25x（≥1024 token）；Anthropic cache_control 最多 4 断点；DeepSeek 命中 1/20~1/50+峰谷半价 → 稳定前缀编排。
- 计费以响应 usage 为准（流式最后 chunk 带 usage），tiktoken 仅估算。
- 任务路由：大纲/命名/润色用小模型、正文用旗舰；Batch 半价通道适合离线批量。
- 长上下文召回随位置衰减（Lost in the Middle）→ 摘要层+RAG+最近原文窗口分层组装。
- 中文写作评测主观性强 → 内置"多模型盲评对比"而非硬编码推荐。
