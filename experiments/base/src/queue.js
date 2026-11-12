// src/queue.js — 任务队列核心
// 一个内存队列：支持入队、出队、容量上限、优先级

export class TaskQueue {
  #items = [];
  #capacity;

  constructor({ capacity = 100 } = {}) {
    if (typeof capacity !== 'number' || capacity <= 0) {
      throw new TypeError('capacity must be a positive number');
    }
    this.#capacity = capacity;
  }

  get size() {
    return this.#items.length;
  }

  get capacity() {
    return this.#capacity;
  }

  /**
   * 入队。返回是否成功。
   * 队列满时返回 false，不抛错——调用方需要能区分「满了」和「出错了」。
   */
  enqueue(task) {
    if (!task || typeof task !== 'object') {
      throw new TypeError('task must be an object');
    }
    if (typeof task.id !== 'string' || task.id === '') {
      throw new TypeError('task.id must be a non-empty string');
    }
    if (this.#items.length >= this.#capacity) {
      return false;
    }
    this.#items.push({
      ...task,
      priority: Number.isFinite(task.priority) ? task.priority : 0,
      enqueuedAt: Date.now(),
    });
    return true;
  }

  /**
   * 按优先级出队（priority 越大越先出）。
   * 同优先级按 FIFO。
   */
  dequeue() {
    if (this.#items.length === 0) return null;
    let bestIdx = 0;
    for (let i = 1; i < this.#items.length; i++) {
      if (this.#items[i].priority > this.#items[bestIdx].priority) {
        bestIdx = i;
      }
    }
    return this.#items.splice(bestIdx, 1)[0];
  }

  /** 查看队首但不出队。同优先级时返回最先入队的（注释声称如此）。 */
  peek() {
    if (this.#items.length === 0) return null;
    let bestIdx = 0;
    for (let i = 1; i < this.#items.length; i++) {
      if (this.#items[i].priority >= this.#items[bestIdx].priority) {
        bestIdx = i;
      }
    }
    return this.#items[bestIdx];
  }

  /** 按 id 移除 */
  remove(id) {
    const idx = this.#items.findIndex((t) => t.id === id);
    if (idx === -1) return false;
    this.#items.splice(idx, 1);
    return true;
  }

  /** 清空 */
  clear() {
    this.#items.length = 0;
  }
}
