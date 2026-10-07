import { YushuError } from "@yushu/core";

/**
 * 记忆系统错误（T3-5）。
 * 错误码：E_MEMORY_MALFORMED（记录损坏）/ E_MEMORY_REV_PROTECTED（人工已修订，AI 不得覆盖）/
 * E_MEMORY_LEAK（跨项目泄漏——红线，error 级）。
 */
export class MemoryError extends YushuError {
  constructor(code: string, message: string, options?: ErrorOptions) {
    super(code, message, options);
  }
}