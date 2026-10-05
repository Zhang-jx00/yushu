/**
 * 提及重算节流（M2 / T2-4 切片 B「大章性能」）：
 * 对全文做「实体提及扫描」是 O(全文长度 × 实体数)——小文档逐键即时重算；
 * 超过阈值的大文档改为节流合并（默认 250ms 只算最后一次），把逐键成本降为 O(1) 调度。
 * 纯逻辑（回调注入），假定时器可单测。
 */

export interface MentionThrottleOptions {
  /** 大文档阈值（字符）：超过即走节流路径 */
  threshold: number;
  delayMs?: number;
  /** 实际重算（小文档立即调用；大文档合并后调用最后一次文本） */
  run: (text: string) => void;
}

export interface MentionThrottle {
  /** 提交一次文本；返回值 = 本次是否走了节流路径（供测试与诊断） */
  push(text: string): boolean;
  /** 立即执行待发任务（切换章节等需要即时结果的时点） */
  flush(): void;
  /** 丢弃待发任务（卸载） */
  dispose(): void;
}

export function createMentionThrottle(options: MentionThrottleOptions): MentionThrottle {
  const delayMs = options.delayMs ?? 250;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingText: string | null = null;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    push(text) {
      if (text.length <= options.threshold) {
        clear();
        pendingText = null;
        options.run(text);
        return false;
      }
      pendingText = text;
      clear();
      timer = setTimeout(() => {
        timer = null;
        const last = pendingText;
        pendingText = null;
        if (last !== null) options.run(last);
      }, delayMs);
      return true;
    },
    flush() {
      clear();
      const last = pendingText;
      pendingText = null;
      if (last !== null) options.run(last);
    },
    dispose() {
      clear();
      pendingText = null;
    },
  };
}