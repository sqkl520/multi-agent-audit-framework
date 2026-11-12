// src/worker-pool.js — 并发受限的任务执行器

/**
 * 以固定并发度跑一组异步任务。
 * 任何一个抛错不会中断其余任务；最终把所有结果/错误按索引返回。
 */
export async function runWithConcurrency(tasks, concurrency, runner) {
  if (!Array.isArray(tasks)) throw new TypeError('tasks must be an array');
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new RangeError('concurrency must be a positive integer');
  }
  if (typeof runner !== 'function') throw new TypeError('runner must be a function');

  const results = new Array(tasks.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const idx = cursor;
      await Promise.resolve();
      cursor += 1;
      if (idx >= tasks.length) return;
      try {
        results[idx] = { ok: true, value: await runner(tasks[idx], idx) };
      } catch (err) {
        results[idx] = { ok: false, error: err };
      }
    }
  }

  const n = concurrency;
  const workers = [];
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);

  return results;
}
