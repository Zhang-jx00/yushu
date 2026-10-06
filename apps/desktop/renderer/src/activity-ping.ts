/**
 * 写作活动心跳节流（M2 / T2-9 切片 C「写作会话与真实速度」）：
 * 编辑器每次输入都上报太频（IPC + stats.json 读改写），这里按固定间隔合并——
 * 距上次发送不足 intervalMs 的输入直接忽略（活跃时长在主进程按心跳间隔累计，
 * 20s 粒度对「字/分钟」足够）；发送失败重置窗口，下一次输入可尽快重试。
 * 纯逻辑（send / now 注入），假定时器或注入时钟可单测。
 */

export interface ActivityPingOptions {
  /** 上报一次活动（主进程 recordActivity）；拒绝不抛出（由本模块静默处理） */
  send: () => Promise<void>;
  /** 心跳最小间隔（毫秒；默认 20s） */
  intervalMs?: number;
  /** 时钟（默认 Date.now；测试注入） */
  now?: () => number;
}

export interface ActivityPing {
  /** 提交一次输入活动；返回值 = 本次是否真正发送（供测试与诊断） */
  ping(): boolean;
  /** 重置节流窗口（卸载 / 切项目） */
  dispose(): void;
}

export const ACTIVITY_PING_INTERVAL_MS = 20_000;

export function createActivityPing(options: ActivityPingOptions): ActivityPing {
  const intervalMs = options.intervalMs ?? ACTIVITY_PING_INTERVAL_MS;
  const now = options.now ?? (() => Date.now());
  const NEVER = Number.NEGATIVE_INFINITY;
  let lastSentAt = NEVER;

  return {
    ping() {
      const at = now();
      if (at - lastSentAt < intervalMs) return false;
      lastSentAt = at;
      options.send().catch(() => {
        lastSentAt = NEVER; // 上报失败：重置窗口，下一次输入重试
      });
      return true;
    },
    dispose() {
      lastSentAt = NEVER;
    },
  };
}