#!/usr/bin/env node
/**
 * attempt-ledger.test.mjs — attempt 计数器自测
 *
 * 核心验证点（protocol.md §4.1）：
 *   1. digest 必须对 {trace_id, agent_id, spawned_at} 不敏感
 *      —— 否则重派时 agent_id 换新，计数器永远是 1（这正是要解决的死锁）
 *   2. 连续 2 次同 error_type → SYSTEMATIC_DEFECT
 *   3. 不同 error_type → 允许继续
 *   4. 到上限 → EXHAUSTED
 */

import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'attempt-ledger.mjs');
let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};
;

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'al-test-'));
  return {
    dir,
    ledger: join(dir, 'L.json'),
    payload(name, obj) {
      const p = join(dir, name);
      writeFileSync(p, JSON.stringify(obj));
      return p;
    },
    run(pl, extra = []) {
      try {
        const out = execFileSync('node', [SCRIPT, '--ledger', this.ledger, '--payload', pl, '--json', ...extra],
          { encoding: 'utf8' });
        return { code: 0, r: JSON.parse(out) };
      } catch (e) {
        try { return { code: e.status ?? 1, r: JSON.parse(e.stdout) }; }
        catch { return { code: e.status ?? 1, r: null }; }
      }
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

console.log('\n=== attempt 计数器自测 ===\n');

console.log('case 1: 不同 agent_id / trace_id 的同一任务 → 同 digest');
{
  const f = mk();
  const a = f.run(f.payload('a.json', { trace_id: 't1', agent_id: 'a1', task: 'sweep-01', files: ['x.js'] }));
  const b = f.run(f.payload('b.json', { trace_id: 't2', agent_id: 'a2', task: 'sweep-01', files: ['x.js'] }));
  expect('digest 相同', a.r?.digest === b.r?.digest, `${a.r?.digest} vs ${b.r?.digest}`);
  f.cleanup();
}

console.log('case 2: 不同任务内容 → 不同 digest');
{
  const f = mk();
  const a = f.run(f.payload('a.json', { task: 'sweep-01', files: ['x.js'] }));
  const b = f.run(f.payload('b.json', { task: 'sweep-01', files: ['y.js'] }));
  expect('digest 不同', a.r?.digest !== b.r?.digest);
  f.cleanup();
}

console.log('case 3: 键顺序不影响 digest（jq -S 等价）');
{
  const f = mk();
  const a = f.run(f.payload('a.json', { task: 'X', files: ['1'], extra: 2 }));
  const b = f.run(f.payload('b.json', { extra: 2, files: ['1'], task: 'X' }));
  expect('digest 相同', a.r?.digest === b.r?.digest);
  f.cleanup();
}

console.log('case 4: 连续 2 次同 error_type → SYSTEMATIC_DEFECT 且 blocked');
{
  const f = mk();
  const p1 = f.payload('1.json', { task: 'X' });
  const p2 = f.payload('2.json', { task: 'X', agent_id: 'different' });
  f.run(p1, ['--record-failure', '--error-type', 'SKELETON_ONLY']);
  const r = f.run(p2, ['--record-failure', '--error-type', 'SKELETON_ONLY']);
  expect('status=SYSTEMATIC_DEFECT', r.r?.status === 'SYSTEMATIC_DEFECT', r.r?.status);
  expect('blocked=true', r.r?.blocked === true);
  expect('attempts=2', r.r?.attempts_so_far === 2, String(r.r?.attempts_so_far));
  expect('退出码 1', r.code === 1);
  f.cleanup();
}

console.log('case 5: 不同 error_type → 继续 RETRY');
{
  const f = mk();
  const p = f.payload('p.json', { task: 'Y' });
  f.run(p, ['--record-failure', '--error-type', 'NO_OUTPUT']);
  const r = f.run(p, ['--record-failure', '--error-type', 'SKELETON_ONLY']);
  expect('status=RETRY', r.r?.status === 'RETRY', r.r?.status);
  expect('blocked=false', r.r?.blocked === false);
  f.cleanup();
}

console.log('case 6: 达上限 → EXHAUSTED');
{
  const f = mk();
  const p = f.payload('p.json', { task: 'Z' });
  f.run(p, ['--record-failure', '--error-type', 'NO_OUTPUT', '--max', '2']);
  const r = f.run(p, ['--record-failure', '--error-type', 'TOOL_REJECTED', '--max', '2']);
  expect('status=EXHAUSTED', r.r?.status === 'EXHAUSTED', r.r?.status);
  expect('blocked=true', r.r?.blocked === true);
  f.cleanup();
}

console.log('case 7: 从未失败过的新任务 → 可派第一次');
{
  const f = mk();
  const r = f.run(f.payload('n.json', { task: 'NEW' }));
  expect('attempts=0', r.r?.attempts_so_far === 0);
  expect('blocked=false', r.r?.blocked === false);
  expect('next_attempt_number=1', r.r?.next_attempt_number === 1);
  f.cleanup();
}

console.log('case 8: 账本持久化（两次调用共享状态）');
{
  const f = mk();
  const p = f.payload('p.json', { task: 'P' });
  f.run(p, ['--record-failure', '--error-type', 'NO_OUTPUT']);
  const r = f.run(p);
  expect('读回 attempts=1', r.r?.attempts_so_far === 1, String(r.r?.attempts_so_far));
  f.cleanup();
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
