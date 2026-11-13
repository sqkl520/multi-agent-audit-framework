#!/usr/bin/env node
/**
 * attempt-ledger.mjs — attempt 计数的机械实现（L2 契约层第 2 项）
 *
 * 为什么需要它（`protocol.md` §4.1）：
 *
 *   规则写的是「`attempt` 按 `(agent_id, task_payload_digest)` 累计，不因失败类型重置」，
 *   但**从来没有任何代码实现过它**。主 Agent 只能靠记忆维护——而 round31 的
 *   无限重派就是「attempt 归零」造成的。
 *
 *   更关键的一点（§4.1 自己也承认）：重派时 `agent_id` 必然换新，
 *   所以真正的累计键是 **digest**，不是 `(agent_id, digest)`。
 *   照字面实现会得到一个永远为 1 的计数器。
 *
 * 这个脚本把这件事变成可执行的：
 *   - 维护一个 attempt 账本文件（JSON）
 *   - 按 payload 的 sha256 累计
 *   - 到上限时拒绝，并说明原因
 *
 * 用法：
 *   node attempt-ledger.mjs --ledger <path> --payload <payload.json> [--max 3] [--json]
 *   node attempt-ledger.mjs --ledger <path> --payload <payload.json> --record-failure --error-type SKELETON_ONLY
 *   node attempt-ledger.mjs --ledger <path> --list
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const hasFlag = (name) => args.includes(name);
const jsonOut = hasFlag('--json');

const ledgerPath = getArg('--ledger');
if (!ledgerPath) {
  console.error('用法: node attempt-ledger.mjs --ledger <path> --payload <payload.json> [--max 3]');
  console.error('       node attempt-ledger.mjs --ledger <path> --list');
  process.exit(2);
}

// ────────────────────────────────────────────────────────────────────
// 摘要计算：必须与 protocol.md §4.1 的规则逐字对应
//
//   负载 = payload 全文，排除 trace_id / agent_id / spawned_at
//   序列化 = 键排序（等价于 jq -S）
//   换行 = 不依赖 shell 的 here-string（这里用 JSON.stringify，天然确定）
//
// 2026-11-14 修（红队实测）：
//   protocol.md:1198 自己写过「若把每次都会变的字段算进摘要，累计键就会退化成
//   『永远是新任务』——与本次修订要解决的死锁是同一个形状」。
//   但只排除了 3 个字段，**漏掉了「产物路径」这一类**。
//
//   而 run-state.md:300 明确要求：重派时「你的产物请写到 <独立路径>，不要碰 <原路径>」。
//   调用方把该路径放进 payload（最自然的做法）后，每次重派 payload 必变 →
//   每次生成新键 → attempts 永远从 1 开始 → 防无限重派的护栏完全失效。
//
//   实测：按规则重派 6 次，attempts 恒为 1/3，**一次都没被拦**。
//        同一 payload 重复 6 次则在第 3 次正确拦下——说明护栏本身没问题，
//        是累计键的选取让它形同虚设。
// ────────────────────────────────────────────────────────────────────
const VOLATILE_KEYS = new Set([
  // 协议原本排除的三个
  'trace_id', 'agent_id', 'spawned_at',
  // 2026-11-14 补：重派时按 run-state.md:300 必然改变，但语义上仍是「同一个任务」
  'output_path', 'artifact_path', 'artifact_paths',
  'output_file', 'output_dir', 'outdir',
  'instance_id', 'attempt', 'attempts', 'retry_id',
  'timestamp', 'started_at', 'finished_at', 'created_at',
]);

function computeDigest(payload) {
  const clean = {};
  for (const k of Object.keys(payload).sort()) {
    if (VOLATILE_KEYS.has(k)) continue;
    clean[k] = payload[k];
  }
  const canonical = JSON.stringify(clean);
  return 'sha256:' + createHash('sha256').update(canonical, 'utf8').digest('hex');
}

// ────────────────────────────────────────────────────────────────────
// 账本读写
// ────────────────────────────────────────────────────────────────────
function loadLedger(p) {
  if (!existsSync(p)) {
    return { schema_version: 'attempt-ledger-v1', entries: {} };
  }
  try {
    const l = JSON.parse(readFileSync(p, 'utf8'));
    if (!l.entries) l.entries = {};
    return l;
  } catch (e) {
    console.error(`账本解析失败: ${e.message}`);
    process.exit(1);
  }
}

function saveLedger(p, l) {
  writeFileSync(p, JSON.stringify(l, null, 2), 'utf8');
}

// ────────────────────────────────────────────────────────────────────
// --list
// ────────────────────────────────────────────────────────────────────
if (hasFlag('--list')) {
  const l = loadLedger(resolve(ledgerPath));
  const rows = Object.entries(l.entries);
  if (jsonOut) {
    console.log(JSON.stringify(l, null, 2));
  } else {
    console.log(`\nattempt 账本: ${ledgerPath}\n`);
    if (rows.length === 0) {
      console.log('  （空）\n');
    } else {
      for (const [digest, e] of rows) {
        console.log(`  ${digest.slice(0, 23)}…  attempts=${e.attempts}  status=${e.status}`);
        if (e.error_types?.length) console.log(`      错误类型: ${e.error_types.join(' → ')}`);
      }
      console.log();
    }
  }
  process.exit(0);
}

// ────────────────────────────────────────────────────────────────────
// 计算 / 判定
// ────────────────────────────────────────────────────────────────────
const payloadPath = getArg('--payload');
if (!payloadPath) {
  console.error('缺少 --payload');
  process.exit(2);
}
if (!existsSync(payloadPath)) {
  console.error(`payload 文件不存在: ${payloadPath}`);
  process.exit(2);
}

let payload;
try {
  payload = JSON.parse(readFileSync(payloadPath, 'utf8'));
} catch (e) {
  console.error(`payload 解析失败: ${e.message}`);
  process.exit(1);
}

const maxAttempts = Number(getArg('--max') ?? 3);
const digest = computeDigest(payload);
const ledger = loadLedger(resolve(ledgerPath));
const entry = ledger.entries[digest] ?? {
  attempts: 0, status: 'PENDING', error_types: [], first_seen: new Date().toISOString(),
};

const recordFailure = hasFlag('--record-failure');
const errorType = getArg('--error-type');

// ────────────────────────────────────────────────────────────────────
// 记录一次尝试
// ────────────────────────────────────────────────────────────────────
if (recordFailure) {
  entry.attempts += 1;
  entry.last_attempt = new Date().toISOString();
  if (errorType) {
    entry.error_types.push(errorType);
    // 连续 2 次同 error_type → 系统性缺陷，直接终止（protocol.md §4.1）
    const n = entry.error_types.length;
    if (n >= 2 && entry.error_types[n - 1] === entry.error_types[n - 2]) {
      entry.status = 'SYSTEMATIC_DEFECT';
      entry.reason = `连续 2 次相同 error_type: ${errorType}`;
    } else if (entry.attempts >= maxAttempts) {
      entry.status = 'EXHAUSTED';
      entry.reason = `attempts 达上限 ${maxAttempts}`;
    } else {
      entry.status = 'RETRY';
    }
  } else {
    entry.status = entry.attempts >= maxAttempts ? 'EXHAUSTED' : 'RETRY';
    if (entry.status === 'EXHAUSTED') entry.reason = `attempts 达上限 ${maxAttempts}`;
  }
  ledger.entries[digest] = entry;
  saveLedger(resolve(ledgerPath), ledger);
}

// ────────────────────────────────────────────────────────────────────
// 判定：这次该不该派
// ────────────────────────────────────────────────────────────────────
const blocked = entry.status === 'EXHAUSTED' || entry.status === 'SYSTEMATIC_DEFECT';
const result = {
  digest,
  attempts_so_far: entry.attempts,
  max_attempts: maxAttempts,
  status: entry.status,
  blocked,
  reason: blocked ? entry.reason : null,
  next_attempt_number: entry.attempts + 1,
};

if (jsonOut) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\nattempt 判定\n`);
  console.log(`  digest        ${digest.slice(0, 30)}…`);
  console.log(`  已尝试        ${result.attempts_so_far} / ${maxAttempts}`);
  console.log(`  状态          ${result.status}`);
  if (blocked) {
    console.log(`  ✗ 不得重派     ${result.reason}`);
  } else {
    console.log(`  ✓ 可派下一次   第 ${result.next_attempt_number} 次`);
  }
  console.log();
}

process.exit(blocked ? 1 : 0);
