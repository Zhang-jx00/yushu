/**
 * 御书记忆系统（M3 / T3-5）：五层记忆的数据层。
 * - world_core：世界核心设定卡（常驻）——由既有设定卡层提供（@yushu/world-engine + 上下文组装）；
 * - volume_summary / chapter_summary：卷 / 章摘要真源记录（human rev 保护，AI 候选化）；
 * - fact：事实级记忆（chapter_id + 字符区间 + hash 出处链）；
 * - rag：全文检索层——数据源为既有索引（chunks/FTS），检索与融合见 T3-8。
 *
 * 本包为**纯逻辑**（解析 / 规则 / 校验 / 提及追踪），文件读写由应用层经 FileGateway 完成。
 */

export * from "./types.js";
export * from "./errors.js";
export * from "./records.js";
export * from "./provenance.js";
export * from "./mentions.js";
export * from "./injection.js";
export * from "./assemble.js";