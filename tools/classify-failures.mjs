#!/usr/bin/env node
/**
 * classify-failures.mjs — 从产物与 state.json 机械判定失败原因
 *
 * 为什么需要它：2026-11-05 的链式实测里，8 个切片失败了 2 个（25%），
 * 而 state.json 里只有裸的 `state: FAILED`。两种失败形态完全不同——
 *   slice-02：产物 0 字节，从没写过
 *   slice-06：产物 44 字节骨架，写了就没再动
 * 处置策略也不同，但当时无法区分，只能盲目重派。
 *
 * 这个脚本把「看现象 → 定类型」的机械部分拿下来，
 * 让主 Agent 不必靠读 transcript 去猜。
 *
 * 用法：
 *   node classify-failures.mjs --state <state.json> [--json]
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const si = args.indexOf('--state');
const statePath = si >= 0 ? args[si + 1] : null;

if (!statePath) {
  console.error('用法: node classify-failures.mjs --state <state.json> [--json]');
  process.exit(2);
}

function normalizePath(p) {
  if (!p) return p;
  const m = String(p).match(/^\/([a-zA-Z])\/(.*)$/);
  if (m) return `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`;
  return p;
}

const sp = resolve(normalizePath(statePath));
if (!existsSync(sp)) {
  console.error(`state.json 不存在: ${sp}`);
  process.exit(2);
}

const state = JSON.parse(readFileSync(sp, 'utf8'));
const outdir = state.outdir ? resolve(normalizePath(state.outdir)) : dirname(sp);
const roundDir = dirname(sp);

/**
 * 判定单个切片的失败类型。
 * 判据全部来自可观察的事实，不需要读 transcript。
 */
function classify(sliceId, slice) {
  const files = slice.files || [];
  // 产物路径约定：round{N-02-sweep-{slice_id}.md
  const candidates = [
    join(roundDir, `${state.round_id}-02-sweep-${sliceId}.md`),
    join(roundDir, `${sliceId}.md`),
  ];
  let artifactPath = candidates.find(existsSync) ?? null;

  // 槽位里若显式记了 artifact_paths，优先用它
  if (Array.isArray(slice.artifact_paths) && slice.artifact_paths.length > 0) {
    const p = resolve(normalizePath(slice.artifact_paths[0]));
    if (existsSync(p)) artifactPath = p;
  }

  if (!artifactPath) {
    return {
      slice_id: sliceId,
      error_type: 'NO_OUTPUT',
      observed: '产物文件不存在',
      artifact_bytes: 0,
      last_write_at: null,
      inferred_cause: 'agent 从未写入产物（可能从未启动或立即失败）',
      retry_policy: 'RETRY_AS_IS',
    };
  }

  const st = statSync(artifactPath);
  const bytes = st.size;
  const mtime = st.mtime.toISOString();
  const text = bytes > 0 ? readFileSync(artifactPath, 'utf8') : '';

  // 空文件
  if (bytes === 0) {
    return {
      slice_id: sliceId,
      error_type: 'NO_OUTPUT',
      observed: '产物文件存在但为 0 字节',
      artifact_bytes: 0,
      last_write_at: mtime,
      inferred_cause: '写入被中断或权限拒绝',
      retry_policy: 'CHECK_PATH_THEN_RETRY',
    };
  }

  // 骨架判定：status 仍是 IN_PROGRESS，且没有线索条目
  const hasInProgress = /status\s*[:：]\s*IN_PROGRESS/i.test(text);
  const hasComplete = /status\s*[:：]\s*COMPLETE/i.test(text);
  const leadCount = (text.match(/^###\s+L\d+/gim) ?? []).length;

  if (hasInProgress && !hasComplete && leadCount === 0) {
    return {
      slice_id: sliceId,
      // 2026-11-09 更名：原名 SCRIPT_TIMEOUT 暗示「超时」，但实测表明
      // 47 分钟是同类任务的常态，这个形态更可能是「还没写完」或「被误杀」。
      // 名字改成 SKELETON_ONLY，只描述观察到的事实（只有骨架），不推断原因。
      error_type: 'SKELETON_ONLY',
      observed: `只有骨架，无任何线索条目（${bytes} 字节，status 未改为 COMPLETE）`,
      artifact_bytes: bytes,
      last_write_at: mtime,
      inferred_cause: '不确定：可能是仍在运行 / 被提前终止 / 陷入分析循环。**不得据此判定 agent 失败**，需先查 harness 的运行时状态',
      retry_policy: 'CHECK_HARNESS_STATE_FIRST',
    };
  }

  if (hasComplete && leadCount === 0) {
    return {
      slice_id: sliceId,
      error_type: 'EMPTY_RESULT',
      observed: 'status COMPLETE 但零线索',
      artifact_bytes: bytes,
      last_write_at: mtime,
      inferred_cause: '读到了但没发现可疑点',
      retry_policy: 'DO_NOT_RETRY',
    };
  }

  // 有内容但没标 COMPLETE —— 部分完成
  if (!hasComplete && leadCount > 0) {
    return {
      slice_id: sliceId,
      error_type: 'EMPTY_RESULT',
      observed: `有 ${leadCount} 条线索但 status 未标 COMPLETE`,
      artifact_bytes: bytes,
      last_write_at: mtime,
      inferred_cause: '内容已产出但未收尾，可视为部分成功',
      retry_policy: 'ACCEPT_PARTIAL',
    };
  }

  return {
    slice_id: sliceId,
    error_type: null,
    observed: `已完成（${leadCount} 条线索）`,
    artifact_bytes: bytes,
    last_write_at: mtime,
    inferred_cause: null,
    retry_policy: 'NONE',
  };
}

// ────────────────────────────────────────────────────────────────────
const results = [];
for (const [id, slice] of Object.entries(state.slices ?? {})) {
  if (slice.state === 'FAILED') {
    results.push(classify(id, slice));
  }
}

const failedCounts = results.reduce((a, r) => { a[r.error_type] = (a[r.error_type] ?? 0) + 1; return a; }, {});

if (jsonOut) {
  console.log(JSON.stringify({ round: state.round_id, failures: results, counts: failedCounts }, null, 2));
} else {
  console.log(`\n失败分类: ${state.round_id}\n`);
  if (results.length === 0) {
    console.log('  无 FAILED 切片\n');
  } else {
    for (const r of results) {
      console.log(`  ${r.slice_id}  →  ${r.error_type}`);
      console.log(`    观察: ${r.observed}`);
      console.log(`    字节: ${r.artifact_bytes}   最后写入: ${r.last_write_at ?? '从未'}`);
      console.log(`    推断: ${r.inferred_cause}`);
      console.log(`    重派: ${r.retry_policy}\n`);
    }
    console.log('  合计:', Object.entries(failedCounts).map(([k, v]) => `${k}=${v}`).join('  '), '\n');
  }
}

// 连续失败的判据：同 slice_id 在 chain 中多轮 FAILED
// 这里只检查本轮；跨轮判定由主 Agent 结合 history 完成
process.exit(0);
