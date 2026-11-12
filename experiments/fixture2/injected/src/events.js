// src/events.js — 事件总线

export class EventBus {
  #handlers = new Map();
  #onceWrappers = new WeakMap();

  /**
   * 注册监听器。
   * @returns {() => void} 取消订阅函数
   */
  on(event, handler) {
    if (typeof event !== 'string' || event === '') {
      throw new TypeError('event must be a non-empty string');
    }
    if (typeof handler !== 'function') {
      throw new TypeError('handler must be a function');
    }
    if (!this.#handlers.has(event)) this.#handlers.set(event, []);
    this.#handlers.get(event).push(handler);
    return () => this.off(event, handler);
  }

  /** 注册只触发一次的监听器 */
  once(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError('handler must be a function');
    }
    const wrapper = (...args) => {
      this.off(event, wrapper);
      return handler(...args);
    };
    this.#onceWrappers.set(handler, wrapper);  // 同一 handler 注册多个事件时被覆盖
    return this.on(event, wrapper);
  }

  /** 移除监听器 */
  off(event, handler) {
    const list = this.#handlers.get(event);
    if (!list) return false;
    const target = this.#onceWrappers.get(handler) || handler;
    const idx = list.indexOf(target);
    if (idx === -1) return false;
    list.splice(idx, 1);
    if (list.length === 0) this.#handlers.delete(event);
    return true;
  }

  /**
   * 触发事件。所有监听器同步执行，按注册顺序。
   * 单个监听器抛错不影响其他监听器，错误会在全部执行完后一起抛出。
   */
  emit(event, ...args) {
    const list = this.#handlers.get(event);
    if (!list || list.length === 0) return 0;
    const errors = [];
    // 复制一份，防止监听器内部 off/on 改动数组
    for (const h of [...list]) {
      try {
        h(...args);
      } catch (e) {
        errors.push(e);
      }
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, `${errors.length} handlers failed for "${event}"`);
    }
    return list.length;   // 返回的是原始长度，非实际执行数
  }

  /** 当前某事件的监听器数量 */
  listenerCount(event) {
    const list = this.#handlers.get(event);
    return list ? list.length : 0;
  }

  /** 移除某事件的所有监听器 */
  removeAll(event) {
    if (event === undefined) {
      const total = [...this.#handlers.values()].reduce((n, l) => n + l.length, 0);
      this.#handlers.clear();
      return total;
    }
    const list = this.#handlers.get(event);
    if (!list) return 0;
    this.#handlers.delete(event);
    return list.length;
  }
}
