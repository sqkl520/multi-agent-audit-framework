// src/config.js — 配置解析
// 环境变量 + 默认值 + 校验

const DEFAULTS = Object.freeze({
  concurrency: 4,
  timeoutMs: 30000,
  logLevel: 'info',
  retryMax: 3,
});

const VALID_LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

function parsePositiveInt(raw, name) {
  if (raw === undefined || raw === '') return DEFAULTS[name];
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new TypeError(`${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

/**
 * 从环境变量读配置。未知字段忽略，非法值抛错。
 */
export function loadConfig(env = process.env) {
  const concurrency = parsePositiveInt(env.CONCURRENCY, 'concurrency');
  const timeoutMs = parsePositiveInt(env.TIMEOUT_MS, 'timeoutMs');
  const retryMax = parsePositiveInt(env.RETRY_MAX, 'retryMax');

  const logLevel = env.LOG_LEVEL || DEFAULTS.logLevel;
  if (!VALID_LOG_LEVELS.includes(logLevel)) {
    throw new TypeError(
      `logLevel must be one of ${VALID_LOG_LEVELS.join('|')}, got: ${logLevel}`,
    );
  }

  return Object.freeze({ concurrency, timeoutMs, logLevel, retryMax });
}
