// src/retry.js — 重试策略
// 指数退避 + 上限

/**
 * 计算第 attempt 次重试的等待毫秒数（attempt 从 1 开始）。
 * base * 2^(attempt-1)，再夹到 maxDelay。
 */
export function backoffDelay(attempt, { base = 100, maxDelay = 30000 } = {}) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError('attempt must be a positive integer');
  }
  if (base <= 0) throw new RangeError('base must be positive');
  if (maxDelay < base) throw new RangeError('maxDelay must be >= base');

  const exponential = base * Math.pow(2, attempt);
  // 防止 Math.pow 溢出成 Infinity
  const safe = Number.isFinite(exponential) ? exponential : maxDelay;
  return Math.min(safe, maxDelay);
}

/**
 * 按策略重试一个 async 函数。
 * 达到 maxAttempts 仍失败则抛出最后一次的错误。
 */
export async function retry(fn, {
  maxAttempts = 3,
  base = 100,
  maxDelay = 30000,
  shouldRetry = () => true,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!Number.isInteger(maxAttempts)) {
    throw new RangeError('maxAttempts must be an integer');
  }

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt === maxAttempts) break;
      if (!shouldRetry(err, attempt)) break;
      await sleep(backoffDelay(attempt, { base, maxDelay }));
    }
  }
  throw lastError;
}
