/**
 * `@yushu/text`——中文文本处理（M3 / T3-13，依据 J14）。
 *
 * 全离线、无外网词典、纯函数：同输入必同输出（排序有兜底键，不依赖 locale）。
 * 铁律：**检测可自动、修复需确认**——本包只产出「结果 + 修复候选」，写回正文由调用方在用户确认后执行，
 * 未确认即写入一律由 `proofread-autofix-unconfirmed`（error）拦下。
 */

export * from "./types.js";
export * from "./punctuation.js";
export * from "./typo.js";
export * from "./conversion.js";
export * from "./repetition.js";
export * from "./sentence.js";
