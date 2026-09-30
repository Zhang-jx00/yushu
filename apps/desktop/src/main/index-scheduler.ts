import type { IndexRefreshState } from "../shared/ipc.js";

/**
 * 保存即增量（T2-5 切片 B）：写通道成功后的后台索引刷新调度器。
 *
 * 设计要点：
 * - 防抖合并：连续保存（自动保存高频落盘）只在安静 debounceMs 后触发一次增量重建；
 * - 单飞 + 脏补跑：刷新进行中再次触发只标记 dirty，结束后补跑一次（不并发、不丢触发）；
 * - 错误不阻断写通道：失败仅记录 lastError（下次保存自动重试），索引始终可由用户手动重建兜底；
 * - reset 代际保护：项目切换/关闭时重置状态，进行中的旧一轮不再回写状态。
 *
 * 是否真的需要重建（索引是否存在）由注入的 refresh 处理器决定——本类只管时序。
 */
export type IndexRefreshHandler = () => Promise<void>;

export class IndexRefreshScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private dirty = false;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private generation = 0;

  constructor(
    private readonly refresh: IndexRefreshHandler,
    private readonly debounceMs = 2500,
  ) {}

  /** 写通道成功后调用：合并到防抖窗口；窗口内重复调用不重置计时（避免高频保存starving） */
  schedule(): void {
    if (this.running) {
      this.dirty = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  state(): IndexRefreshState {
    return {
      pending: this.timer !== null,
      running: this.running,
      lastRunAt: this.lastRunAt,
      lastError: this.lastError,
    };
  }

  /** 项目切换/关闭：取消待命定时器并清空状态（进行中的旧一轮由代际守卫丢弃回写） */
  reset(): void {
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = false;
    this.dirty = false;
    this.lastRunAt = null;
    this.lastError = null;
  }

  private async run(): Promise<void> {
    const gen = this.generation;
    this.running = true;
    try {
      await this.refresh();
      if (this.generation === gen) {
        this.lastError = null;
        this.lastRunAt = new Date().toISOString();
      }
    } catch (err) {
      if (this.generation === gen) {
        this.lastError = err instanceof Error ? err.message : String(err);
      }
    } finally {
      if (this.generation === gen) {
        this.running = false;
        if (this.dirty) {
          this.dirty = false;
          this.timer = setTimeout(() => {
            this.timer = null;
            void this.run();
          }, this.debounceMs);
          this.timer.unref?.();
        }
      }
    }
  }
}