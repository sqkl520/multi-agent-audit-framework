#!/usr/bin/env node
/**
 * check-round-chain-live.mjs — 拿真实 state.json 验证自动续轮判定
 *
 * 模拟器（simulate-round-chain.mjs）验证的是「规则自洽」。
 * 这个脚本验证的是「规则能被真实数据驱动」——两者缺一不可：
 * 规则自洽但字段不存在，等于空中楼阁。
 */

import { readFileSync, existsSync } from 'node:fs';

const CASES = [
  { path: process.argv[2] },
].filter(c => c.path);

function analyze(statePath) {
  if (!existsSync(statePath)) {
    return { path: statePath, error: 'state.json 不存在' };
  }
  let s;
  try { s = JSON.parse(readFileSync(statePath, 'utf8')); }
  catch (e) { return { path: statePath, error: `解析失败: ${e.message}` }; }

  const status = s.status ?? null;
  const slices = s.slices ?? {};
  const deferred = Object.entries(slices)
    .filter(([, v]) => v?.state === 'DEFERRED')
    .map(([k]) => k);
  const done = Object.entries(slices)
    .filter(([, v]) => v?.state === 'DONE')
    .map(([k]) => k);
  const pending = Object.entries(slices)
    .filter(([, v]) => v?.state === 'PENDING' || v?.state === 'RUNNING')
    .map(([k]) => k);

  // §6 判定
  let action6;
  if (status === 'RUNNING') action6 = 'RESUME_SAME_ROUND';
  else if (['CLOSED', 'PARTIALLY_CLOSED', 'BLOCKED'].includes(status)) {
    action6 = deferred.length > 0 ? 'OPEN_NEXT_ROUND' : 'STOP';
  } else {
    action6 = 'UNKNOWN_STATUS';
  }

  // §6.5.1 判定
  let action65;
  if (['CLOSED', 'PARTIALLY_CLOSED'].includes(status) && deferred.length > 0) {
    action65 = 'OPEN_NEXT_ROUND';
  } else if (status === 'RUNNING') {
    action65 = 'RESUME_SAME_ROUND';
  } else {
    action65 = 'STOP';
  }

  // 报告是否已落盘
  const reportWritten = Boolean(s.report?.final_report_path) && s.report?.is_complete !== undefined;

  return {
    path: statePath, status, deferred: deferred.length, done: done.length, pending: pending.length,
    action6, action65, consistent: action6 === action65, reportWritten,
    reportPath: s.report?.final_report_path ?? null,
  };
}

let fail = 0;
console.log('\n=== 真实 state.json 的自动续轮判定 ===\n');
for (const c of CASES) {
  const r = analyze(c.path);
  if (r.error) { console.log(`✗ ${r.path}\n  ${r.error}`); fail++; continue; }
  console.log(`${r.path}`);
  console.log(`  status=${r.status}  DONE=${r.done}  DEFERRED=${r.deferred}  PENDING/RUNNING=${r.pending}`);
  console.log(`  §6   → ${r.action6}`);
  console.log(`  §6.5 → ${r.action65}`);
  console.log(`  ${r.consistent ? '✓ 两条规则一致' : '✗ 两条规则冲突'}`);
  if (!r.consistent) fail++;

  // 硬规则：已出报告的轮次不得被判为「续跑同一轮」
  if (r.reportWritten && r.action6 === 'RESUME_SAME_ROUND') {
    console.log(`  ✗ 已出报告却要续跑同一轮 —— 会产生两份报告`);
    fail++;
  } else if (r.reportWritten) {
    console.log(`  ✓ 已出报告，不续跑本轮（报告: ${r.reportPath}）`);
  }
  console.log();
}

process.exit(fail > 0 ? 1 : 0);
