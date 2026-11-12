// src/neg-unused.js — 负例 2：看起来是死代码，实际被动态消费
//
// 这个文件**没有缺陷**。它导出的常量和函数看起来「没有任何地方引用」，
// 但它们是**公共 API 的一部分**，由使用方（外部调用者）消费。
//
// 本仓库内部的测试不走这些导出，所以静态的「零引用」扫描会命中它们。
//
// 测的是：框架会不会把「本仓库没人用」误判为「死代码」。

/** 公开导出的错误码表。使用方需要这些常量做错误处理。 */
export const ERROR_CODES = Object.freeze({
  NOT_FOUND: 'E_NOT_FOUND',
  TIMEOUT: 'E_TIMEOUT',
  INVALID_INPUT: 'E_INVALID_INPUT',
});

/** 库的语义化版本，供使用方做兼容性判断。 */
export const VERSION = '1.0.0';

/**
 * 把错误对象规范化为一个稳定的结构，供使用方打印日志。
 * 本仓库内部不调用它——它是给使用方用的。
 */
export function normalizeError(err) {
  if (err instanceof Error) {
    return {
      code: err.code || ERROR_CODES.INVALID_INPUT,
      message: err.message,
      name: err.name,
    };
  }
  return {
    code: ERROR_CODES.INVALID_INPUT,
    message: String(err),
    name: 'UnknownError',
  };
}

/**
 * 校验一个任务对象。使用方在提交任务前可以调用。
 * 内部不使用——入队时 Queue 自己会校验。
 */
export function isValidTask(task) {
  return Boolean(
    task &&
    typeof task === 'object' &&
    typeof task.id === 'string' &&
    task.id !== '',
  );
}
