# J08-流式输出与写作UX

> 类别：J-AI与LLM工程 ｜ 世界构建金字塔层级：工程层 · AI 工程
> 质量要求：信息来源 ≥6 条、覆盖 ≥3 种来源类型；URL 必须来自真实检索结果。

## 1. 领域定义

研究 AI 文本生成从"模型吐出 token"到"作者在编辑器里看到并接住文字"这条链路的工程实现与交互设计：流式协议（SSE / fetch ReadableStream）的客户端消费、chunk 缓冲与打字机渲染、生成中止（AbortController）与半成品处置、生成期间的用户编辑冲突、批量生成队列与进度反馈、失败降级提示，以及生成状态在 UI 的可见性。边界划分：J01 管模型接入与协议适配，J02 管 Token 与成本计量，本领域只管"流怎么送到屏幕、作者怎么控制它"；J03/J11 管上下文与长文本策略，本领域不管"生成什么内容"；编辑器内核与文档模型属 J09（TipTap/ProseMirror，见 docs/01 §4.7）。核心工程问题：如何在不卡顿、不丢稿、不打断作者思路的前提下，让 AI 生成过程"可见、可控、可恢复"。

## 2. 核心知识框架

1. **流式协议的两条路线**。OpenAI 兼容接口以 `stream:true` 返回 Server-Sent Events：每行 `data: {...}` 承载一个 delta，`[DONE]` 收尾，末块可带 usage（S7）。浏览器侧有两条消费路径：`EventSource` 简单且自动重连，但仅支持 GET、无法自定义 Authorization 头；因此写作工具普遍改用 `fetch` + `response.body.getReader()` 手动解析 SSE，以便携带密钥头并走 POST。
2. **客户端消费与 UTF-8 边界**。`ReadableStream.getReader()` 逐个 `Uint8Array` 块读取，用 `TextDecoder({stream:true})` 增量解码；中文一个字占多字节，块边界可能截断字符，必须保留残片。事件按空行分隔，行内剥去 `data:` 前缀；Vercel 官方示例明确警告"一次 read 可能停在半行，把行尾残片留在缓冲区，否则解析半个事件会抛错"。
3. **chunk 缓冲 + rAF 打字机**。token 到达频率远高于屏幕刷新率，若每个 token 都触发一次状态更新与重排会明显卡顿。通行做法：token 先入缓冲队列，用 `requestAnimationFrame` 在每帧只 flush 一次 DOM 更新；rAF 回调与显示器刷新率对齐、后台标签页自动暂停，且必须用回调的 `timestamp` 计算进度，否则高刷屏上打字机跑得更快。渲染层再叠加"匀速输出"（按时间推进可见字符数）与"积压追赶"（缓冲过长时提速）。
4. **中止与半成品**。`AbortController.abort()` 让 fetch 立即结束并断开连接，服务端随之停算；`AbortSignal.timeout()` 处理超时。停止后前端已渲染的文字必须落盘为草稿（御书"防丢稿"承诺），并保留"继续生成"入口。
5. **生成中的编辑冲突**。流式文字须落在受控的 pending 区间：用户编辑区间之外不干扰流；一旦用户编辑区间之内，则必须暂停流、把当前已生成文本固化，再让用户决定保留/丢弃/继续。
6. **批量生成队列**。大纲候选、设定卡抽取等可离线批量任务进队列，支持进度、暂停、取消、失败重试；批量走半价通道以控成本（S7）。
7. **失败降级**。网络中断、429 限流、超时三类要给不同提示与动作；429 应读 `Retry-After` 并采用带抖动的指数退避。
8. **状态可见性**。生成过程应显式暴露 `submitted / streaming / stopped / failed / retry` 状态，对齐 Vercel useChat 的 `status`，让作者任何时候都知道"AI 在干嘛、能不能停、能不能再来一次"。

## 3. 可转化为产品规则的关键实践

1. 统一流式客户端（fetch + ReadableStream 手解 SSE）→ 抽象为 `AIStreamClient`，支持自定义头/超时/中止信号，兼容所有 OpenAI 兼容后端（S7）。
2. UTF-8 残片缓冲 → 解码器与事件解析器维护"未完成行"缓冲，杜绝中文半字符与半事件丢失。
3. token 缓冲 + rAF flush → 生成视图用单一"待渲染缓冲"，每帧提交一次，未 flush 内容不计入编辑历史。
4. AbortController 停止 → 生成区常驻"停止"按钮；停止即固化已生成文本为草稿块，附"继续/重试"。
5. 生成中编辑冲突策略 → pending 区间模型：区间外可编辑，区间内编辑触发暂停并固化。
6. 批量队列 → 任务卡片显示进度条/状态/取消；与 J02 成本面板联动显示预计花费。
7. 失败降级提示 → 网络/429/超时分别给文案与动作（重试、降级模型、缩短上下文、切本地模型）；429 按 Retry-After 退避。
8. 状态机可视化 → 生成状态徽标（正在生成/已停止/失败可重试/排队中），与上下文预览器同区显示本次调用状态。
9. 流式内容标识 → 未采纳的 AI 文本以视觉标识呈现，采纳后落库并写入"AI 使用记录"（合规证据链，docs/01 §4.5）。
10. 断线续传提示 → 参考可续传流（服务端保留 run id），刷新或超时后询问"继续上次生成"。

## 4. 信息来源

1. [官方文档] OpenAI Agents SDK《流式传输》 — https://openai.github.io/openai-agents-js/zh/guides/streaming/ — 流式事件类型、`toTextStream()`，以及"停止一个流并在同一轮次继续"。
2. [官方文档] MDN《ReadableStream》 — https://developer.mozilla.org/en-US/docs/Web/API/ReadableStream — Fetch 的 `Response.body` 即 ReadableStream；`getReader()/cancel()/tee()` 语义与锁定规则。
3. [官方文档] MDN《使用服务器发送事件》 — https://developer.mozilla.org/zh-CN/docs/Web/API/Server-sent_events/Using_server-sent_events — EventSource 单向连接、错误处理与关闭；HTTP/1 下每域仅允许约 6 个 SSE 连接。
4. [官方文档] MDN《AbortSignal》 — https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal — `abort()/timeout()/any()` 与 `throwIfAborted()`，用于停止生成与超时。
5. [官方文档] MDN《Window: requestAnimationFrame()》 — https://developer.mozilla.org/en-US/docs/Web/API/Window/requestAnimationFrame — 回调对齐刷新率、后台标签页暂停、必须用 timestamp 计算进度。
6. [官方文档] Vercel AI SDK《Chatbot（useChat）》 — https://ai-sdk.dev/v5/docs/ai-sdk-ui/chatbot — `status` 取值 submitted/streaming/ready/error，`stop()` 中止当前生成。
7. [官方文档] Vercel AI SDK《streamText()》 — https://ai-sdk.dev/v5/docs/reference/ai-sdk-core/stream-text — `textStream` 异步可迭代；`stopStream()` 与 `stopSequences` 停止生成。
8. [官方文档] Vercel《Streaming Functions》 — https://vercel.com/docs/functions/streaming-functions — 以 `Content-Type: text/event-stream` 逐块返回，降低首字延迟。
9. [官方文档] Vercel AI Gateway《OpenResponses Streaming》 — https://vercel.com/docs/ai-gateway/sdks-and-apis/openresponses/streaming — 强调保留行尾残片缓冲，避免解析半行事件报错。
10. [官方文档] OpenAI Help Center《排查 API 速率限制和 429 错误》 — https://help.openai.com/zh-hans-cn/articles/5955604-how-can-i-solve-429-too-many-requests-errors — 读 `Retry-After`，缺失时用带抖动的指数退避并限制重试次数。
11. [技术文章] Vercel《What is WorkflowAgent?》 — https://vercel.com/kb/guide/what-is-workflowagent — 流在超时/断网/刷新后凭 run id 重连续传，单步失败自动重试。
12. [学术论文] Rethinking HTTP API Rate Limiting: A Client-Side Approach — https://arxiv.org/pdf/2510.04516v1 — 客户端自适应退避可将 429 错误降低最多 97.3%。

## 5. 对御书设计的启示

**数据结构建议：生成任务状态 schema**

```yaml
# .yushu/ai-tasks/<task-id>.yaml —— 一次生成任务的状态机与产物
id: task-20260929-0007
kind: continue            # continue | expand | polish | outline | extract
scope: {doc: chapters/vol1/ch-012.md, anchor: {from: 1024, to: 1024}}  # 插入锚点
status: streaming         # queued | submitted | streaming | stopped | done | failed | retrying
provider: {id: deepseek, model: deepseek-chat, tier: main}   # 引 J01 Provider 矩阵
cursor:
  buffer_pending: ""      # rAF 未 flush 的 token 缓冲
  decoded_chars: 812      # 已落盘字符数（停止时用于固化）
  usage: {in: 1520, out: 812}     # 引 J02 计量
abort:
  reason: user_stop       # user_stop | timeout | network | rate_limit | switch_model
  preserved_draft: true   # 停止时是否已把半成品固化为草稿
retry:
  attempt: 1
  backoff_ms: 0           # 429 时按 Retry-After + jitter 计算
ui_state: streaming       # submitted|streaming|stopped|failed|retry（对齐 useChat.status）
```

**生成状态机**

```text
queued → submitted → streaming → done
                        ├─ stopped（用户中止，固化草稿）
                        └─ failed（network/429/timeout）→ retrying → streaming
```

**功能建议**

- 生成区常驻"停止"按钮；停止后原地显示"已停止·保留 X 字草稿 / 继续 / 重试"。
- 打字机渲染：单一缓冲 + rAF 每帧 flush，提供"匀速 / 瞬时"两档（瞬时用于长文补全）。
- 批量生成中心：队列列表 + 进度 + 取消，显示预计成本（J02）与是否走半价通道。
- 失败横幅：区分网络/限流/超时的动作按钮，429 显示 Retry-After 倒计时。
- 断线续传：记录 run id，刷新后询问是否继续上次生成。

**校验规则建议**

- `stream-abort-lost-text`：停止生成后 `cursor.decoded_chars>0` 但 `abort.preserved_draft=false` → error（违反防丢稿承诺）。
- `stream-no-abort`：生成持续 > N 秒仍无可用的中止入口 → warn。
- `typewriter-token-rerender`：生成视图每 token 触发一次提交（未用 rAF 合并）→ info（性能反模式）。
- `stream-edit-conflict-unsafe`：用户编辑落在 pending 区间内却未暂停流 → error。
- `stream-state-missing`：任务缺少 `ui_state` 或失败态无重试动作 → warn。
- `retry-no-backoff`：429 失败后无延迟立即重试 → warn。
- `sse-chunk-boundary-loss`：解码未保留残片（中文出现替换符 U+FFFD）→ error。
- `queue-no-progress`：批量任务无进度反馈 ≥ 30 秒 → info。

**AI 提示词建议**

- 「停止后续写」：以已固化草稿为前缀，注入上下文（J03），要求"从断点自然接续，不重复已写内容"。
- 「流式失败重试」：重试时自动改用更小模型并压缩上下文（J02 任务路由），提示词附"简短、直达"约束。
- 「批量候选」：一次请求多候选时要求结构化数组输出，便于队列逐条落库与 diff 对比。

## 6. 领域内子主题备忘（可选）

- SSE 自动重连与 `Last-Event-ID` 在长文生成断点续传中的可行性。
- WebSocket 与 SSE 在双端取消、多路并行候选场景下的取舍。
- 移动端/低端机打字机降级策略（帧率不足时切分块直出）。
- 生成完成时"整段替换 vs 追加"的交互，与全书版本历史、AI 使用记录对齐。
- 与 J10（提示词与评测）联动的生成质量埋点（采纳率、废弃率、平均停顿）。