# ADR-0002：M1 中文全文检索采用「CJK unigram」过渡方案

- 状态：已采纳（M1，过渡性决策；M2 替换）
- 日期：2026-09-29
- 关联：docs/03 §1.3（FTS5 + wangfenjin/simple）、docs/03 §6（索引 schema）、docs/04 §4.3（T1-21）

## 背景

docs/03 §6 的索引方案要求 FTS5 使用 `tokenize='simple'`（wangfenjin/simple：中文分词 + 拼音）。但 M1 的运行时约束是：

- 索引库由 **Node 内置 `node:sqlite`** 承载（零原生依赖，桌面主进程与 Node CLI 共用同一二进制，无需 Electron ABI 重建）；
- `node:sqlite` 当前**不支持加载 SQLite 扩展**（`simple` / `jieba` 这类原生扩展无法挂载）；
- 内置 `unicode61` 分词器把**无空格的中文整句当作一个 token**：正文"夜色压下来，林渊拔剑而起"会被切成 `夜色压下来` / `林渊拔剑而起`，查询"林渊"是子串、并非整词 → **检索零命中**。

不做处理的话，M1 的"删索引重建后检索结果一致"（验收 A5）在中文场景下无从谈起。

## 决策

M1 采用 **CJK unigram 预处理**作为过渡方案，把中文切成可检索的"单字词元"：

1. 写入侧：`toFtsText()` 在每个 CJK 字符两侧插空格后存入独立的索引列 `chunks.text_fts`（外部内容表 `content='chunks'`，原文 `chunks.text` 保持原样，避免污染对账与展示）；
2. 查询侧：按空格切词，每词内同样逐字插空并以**短语**匹配（`"林 渊"`），多词之间为 AND；
3. snippet 展示时用 `unspaceCjk()` 去掉汉字间人为空格，保留 `【】` 高亮；
4. 查询串会剔除 FTS5 操作符字符（`" * ( ) ^ :`），用户输入不会引发语法错误。

## 后果

- **正向**：中文在有空格/无空格、长句/短句中均能命中；索引仍是标准 FTS5 `external content`，可随时 `rebuild`；重建结果确定（与验收 A5 一致）。
- **成本**：索引体积随中文文本线性增大（每个汉字一个词元）；短语匹配召回偏严（"林渊"可命中，但"渊拔"这类跨词误配不会发生）。
- **替换计划（M2）**：当引入支持扩展加载的 SQLite 绑定或迁移到 `better-sqlite3`（含 simple 分词扩展）后，删除 `text_fts` 特殊列，恢复 `tokenize='simple'` 与拼音搜索；本 ADR 届时标记为"已被 ADR-XXXX 取代"。`INDEX_SCHEMA_VERSION` 递增并触发全量重建（索引是派生物，无迁移数据风险）。

## 备选方案

| 方案 | 否决理由 |
|---|---|
| M1 直接引入 better-sqlite3 + simple 扩展 | 需分别对 Node CLI 与 Electron 两份 ABI 编译原生模块，M1 复杂度与失败面过大（已否决，留予 M2 评估） |
| 不建 FTS，改用 LIKE 检索 | 违背 docs/03 §6 的 FTS5 external content 结构目标，且性能随规模劣化（已否决） |
| 只在查询侧插空 | 写入侧 token 仍是整句，查询短语同样不命中（不可行） |