// src/queue.js
export class TaskQueue {
  #items = [];
  enqueue(t) {
    if (this.#items.length > 10) return false;
    this.#items.push(t);
    return true;
  }
}