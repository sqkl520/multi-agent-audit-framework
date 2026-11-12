// src/neg-race.js — 负例 3：看起来有竞态，实际没有
//
// 这个文件**没有缺陷**。它读写共享状态，看起来像经典的竞态，
// 但所有访问都在同一个同步代码块内完成，中间没有 await——
// JavaScript 单线程保证这段代码不会被交错。
//
// 测的是：框架会不会因为「共享可变状态 + 异步」就报竞态，而不检查
// await 的具体位置。

export class Counter {
  #value = 0;

  /**
   * 原子地读-改-写。
   * 注意：`this.#value = this.#value + 1` 看起来像经典的「非原子递增」，
   * 但 JS 单线程下整个表达式在一个 tick 内完成，中间不可能被其他代码插入。
   * 真正会出问题的是 `const v = this.#value; await something; this.#value = v + 1;`
   * ——本函数没有 await。
   */
  increment() {
    this.#value = this.#value + 1;
    return this.#value;
  }

  /**
   * 即使这个函数是 async，只要 await 之前没有读、之后没有再写回旧值，
   * 就不构成竞态。
   */
  async incrementAsync() {
    // sleep 在写之后，不影响正确性
    this.#value = this.#value + 1;
    const result = this.#value;
    await new Promise((r) => setTimeout(r, 0));
    return result;
  }

  get value() {
    return this.#value;
  }
}

/**
 * 批量累加。任务用 runWithConcurrency 并发跑，但每次 increment 都是原子的，
 * 所以最终值一定等于任务数。这里的不变量有测试保护（见 test-base.mjs）。
 */
export async function batchIncrement(counter, count) {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError('count must be a non-negative integer');
  }
  const jobs = [];
  for (let i = 0; i < count; i++) {
    jobs.push(counter.incrementAsync());
  }
  await Promise.all(jobs);
  return counter.value;
}
