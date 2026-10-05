/**
 * 恢复收件箱（M2 / T2-8 切片 A）：
 * ProjectScreen 的恢复面板把「崩溃前未保存正文」投入收件箱（按章节路径），
 * 编辑器视图载入该章节时取出并作为脏内容呈现（savedBody 仍记磁盘正文，随后的自动保存落盘）。
 * 单次消费语义：take 后即清除，避免重复注入。
 */

const pending = new Map<string, string>();

export function putPendingRecovery(path: string, body: string): void {
  pending.set(path, body);
}

/** 取出并清除该章节的恢复内容（无则返回 null） */
export function takePendingRecovery(path: string): string | null {
  const body = pending.get(path);
  if (body === undefined) return null;
  pending.delete(path);
  return body;
}