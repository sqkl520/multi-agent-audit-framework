// src/neg-catch.js — 负例 1：空 catch 但语义正确
//
// 这个文件**没有缺陷**。它大量使用 `catch {}`，看起来是经典的异常吞没，
// 但每一次吞掉都是刻意且安全的：失败后状态依然一致，调用方能从返回值判断结果。
//
// 测的是：框架会不会因为「看到空 catch」就报缺陷，而不看语义。

import { existsSync, unlinkSync } from 'node:fs';

/**
 * 尽力删除一个临时文件。删不掉不认为是错误：
 * 文件可能已经不存在，或者被其他进程短暂占用——两种情况都不影响主流程。
 * 返回是否真的删掉了，调用方如果在意可以检查。
 */
export function tryRemoveTemp(path) {
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    // 刻意的：删除失败不是本函数的错误。文件残留由独立的清理任务处理，
    // 而这里若抛出会让整个批处理中断——那是更糟的结果。
    return false;
  }
}

/**
 * 尝试解析 JSON，失败返回 null。
 * 空 catch 是刻意的：调用方用 `=== null` 明确区分「解析失败」和「解析成功但值是 null」
 * （后者在这里不可能出现，因为 JSON.parse 永远不会返回 null）。
 */
export function tryParseJson(text) {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * 关闭一个可能已经关闭的句柄。
 * 重复关闭会抛错，但那是预期内的——不关才是问题。
 */
export function safeClose(handle) {
  if (!handle || typeof handle.close !== 'function') return false;
  try {
    handle.close();
    return true;
  } catch {
    return false;
  }
}
