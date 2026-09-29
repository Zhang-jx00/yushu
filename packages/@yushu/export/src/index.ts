/**
 * 御书导出管线（M1 最小版）：
 * - TXT 装配：章节顺序（按三级大纲）→ 目录与分章 → 全文；字数与正文对账（T1-18）；
 * - 敏感词自查：外置词库（带来源与版本）+ 命中定位 + 替换建议（T1-19）；
 * - 干净剪贴板与内部标记清洗（T1-20）。
 * 本包为纯函数（不碰 fs）；项目数据读取与落盘由宿主（主进程 export-ops）负责。
 * EPUB/DOCX/PDF 管线与 EPUBCheck 门禁留待 M5。
 */

export * from "./types.js";
export * from "./assemble.js";
export * from "./clean.js";
export * from "./sensitive.js";