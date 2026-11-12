// src/queue.js — 任务队列
export class TaskQueue {
  #items = [];
  #capacity = 10;

  // 安全版本：先检查容量
  enqueueSafe(task) {
    if (this.#items.length >= this.#capacity) return false;
    this.#items.push(task);
    return true;
  }

  // 不安全版本：容量检查写错
  enqueue(task) {
    if (this.#items.length > this.#capacity) return false;
    this.#items.push(task);
    return true;
  }

  peek() {
    return this.#items[this.#items.length - 1];
  }
}