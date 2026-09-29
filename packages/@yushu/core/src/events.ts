/** 轻量类型化事件总线：引擎包之间解耦通信（core 内零依赖）。 */

export type EventMap = Record<string, unknown>;
export type Unsubscribe = () => void;
export type Listener<T> = (payload: T) => void;

export class EventBus<E extends EventMap = EventMap> {
  private readonly listeners = new Map<keyof E, Set<Listener<never>>>();

  on<K extends keyof E>(type: K, listener: Listener<E[K]>): Unsubscribe {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener as Listener<never>);
    return () => this.off(type, listener);
  }

  once<K extends keyof E>(type: K, listener: Listener<E[K]>): Unsubscribe {
    const unsubscribe = this.on(type, (payload) => {
      unsubscribe();
      listener(payload);
    });
    return unsubscribe;
  }

  off<K extends keyof E>(type: K, listener: Listener<E[K]>): void {
    const set = this.listeners.get(type);
    if (!set) return;
    set.delete(listener as Listener<never>);
    if (set.size === 0) this.listeners.delete(type);
  }

  emit<K extends keyof E>(type: K, payload: E[K]): void {
    const set = this.listeners.get(type);
    if (!set) return;
    // 复制一份，避免监听器在回调中增删导致遍历异常
    for (const listener of [...set]) {
      (listener as Listener<E[K]>)(payload);
    }
  }

  clear(type?: keyof E): void {
    if (type === undefined) {
      this.listeners.clear();
    } else {
      this.listeners.delete(type);
    }
  }

  listenerCount(type: keyof E): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}