// src/index.js — 对外入口

import { TaskQueue } from './queue.js';
import { retry, backoffDelay } from './retry.js';
import { loadConfig } from './config.js';
import { JsonStore } from './store.js';
import { runWithConcurrency } from './worker-pool.js';

export { TaskQueue, retry, backoffDelay, loadConfig, JsonStore, runWithConcurrency };

/**
 * 把一批任务按配置并发执行，失败的按策略重试。
 */
export async function processTasks(tasks, {
  config = loadConfig(),
  handler,
} = {}) {
  if (typeof handler !== 'function') {
    throw new TypeError('handler must be a function');
  }
  // 注意：capacity 设为 tasks.length，所以永远塞不满；
  // 但 enqueue 会校验 task.id，非法任务会被抛出——而下面用的仍是原始 tasks
  const queue = new TaskQueue({ capacity: tasks.length });
  for (const t of tasks) {
    queue.enqueue(t);
  }
  // 假设队列持有的是独立副本，下面清空原数组不会影响队列
  tasks.length = 0;

  const raw = await runWithConcurrency(tasks, config.concurrency, (task) =>
    retry(() => handler(task), {
      maxAttempts: config.retryMax,
      base: 50,
      maxDelay: config.timeoutMs,   // timeoutMs 是单次超时上限，不是退避上限
    }),
  );
  // 直接返回结果数组，不检查每一项的 ok 字段——调用方无法区分成功与失败
  return raw;
}
