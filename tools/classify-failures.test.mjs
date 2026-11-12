#!/usr/bin/env node
/**
 * classify-failures.test.mjs — 失败分类器的自测
 *
 * 关键点：每个 case 都构造一个真实的产物形态，验证分类结果与重派策略。
 * 这些形态全部来自 2026-11-05 链式实测中真实出现过的失败。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'classify-failures.mjs');
let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};
;

function run(statePath) {
  try {
    const out = execFileSync('node', [SCRIPT, '--state', statePath, '--json'], { encoding: 'utf8' });
    return JSON.parse(out);
  } catch (e) {
    return { error: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

function fixture(slices, artifacts) {
  const root = mkdtempSync(join(tmpdir(), 'cf-test-'));
  const roundDir = join(root, 'round1');
  mkdirSync(roundDir, { recursive: true });

  for (const [name, content] of Object.entries(artifacts)) {
    writeFileSync(join(roundDir, name), content);
  }

  const state = {
    round_id: 'round1',
    outdir: root,
    slices: Object.fromEntries(slices.map(([id, st]) => [id, { state: st, files: [] }])),
  };
  const sp = join(roundDir, 'state.json');
  writeFileSync(sp, JSON.stringify(state, null, 2));
  return { sp, root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

console.log('\n=== 失败分类器自测 ===\n');

// 1. 产物不存在 → NO_OUTPUT
console.log('case 1: 产物文件不存在 → NO_OUTPUT');
{
  const f = fixture([['slice-01', 'FAILED']], {});
  const r = run(f.sp);
  const x = r.failures?.[0];
  expect('判 NO_OUTPUT', x?.error_type === 'NO_OUTPUT', x?.error_type);
  expect('策略 RETRY_AS_IS', x?.retry_policy === 'RETRY_AS_IS', x?.retry_policy);
  expect('字节 0', x?.artifact_bytes === 0);
  f.cleanup();
}

// 2. 骨架停在 IN_PROGRESS → SKELETON_ONLY（实测真实形态）
console.log('case 2: 44 字节骨架、status IN_PROGRESS、无线索 → SKELETON_ONLY');
{
  const f = fixture([['slice-02', 'FAILED']], {
    'round1-02-sweep-slice-02.md': '# slice-02 宽扫 (S02)\nstatus: IN_PROGRESS\n',
  });
  const r = run(f.sp);
  const x = r.failures?.[0];
  expect('判 SKELETON_ONLY', x?.error_type === 'SKELETON_ONLY', x?.error_type);
  expect('策略 CHECK_HARNESS_STATE_FIRST', x?.retry_policy === 'CHECK_HARNESS_STATE_FIRST', x?.retry_policy);
  expect('字节 44', x?.artifact_bytes === 44, String(x?.artifact_bytes));
  f.cleanup();
}

// 3. 0 字节文件 → NO_OUTPUT
console.log('case 3: 产物存在但 0 字节 → NO_OUTPUT');
{
  const f = fixture([['slice-03', 'FAILED']], { 'round1-02-sweep-slice-03.md': '' });
  const r = run(f.sp);
  const x = r.failures?.[0];
  expect('判 NO_OUTPUT', x?.error_type === 'NO_OUTPUT', x?.error_type);
  expect('策略 CHECK_PATH_THEN_RETRY', x?.retry_policy === 'CHECK_PATH_THEN_RETRY', x?.retry_policy);
  f.cleanup();
}

// 4. COMPLETE 但零线索 → EMPTY_RESULT，不重派
console.log('case 4: status COMPLETE 但零线索 → EMPTY_RESULT，不重派');
{
  const f = fixture([['slice-04', 'FAILED']], {
    'round1-02-sweep-slice-04.md': '# slice-04\nstatus: COMPLETE\n\n未发现可疑点。\n',
  });
  const r = run(f.sp);
  const x = r.failures?.[0];
  expect('判 EMPTY_RESULT', x?.error_type === 'EMPTY_RESULT', x?.error_type);
  expect('策略 DO_NOT_RETRY', x?.retry_policy === 'DO_NOT_RETRY', x?.retry_policy);
  f.cleanup();
}

// 5. 有线索但没标 COMPLETE → 接受部分
console.log('case 5: 有线索但未标 COMPLETE → ACCEPT_PARTIAL');
{
  const f = fixture([['slice-05', 'FAILED']], {
    'round1-02-sweep-slice-05.md': '# slice-05\nstatus: IN_PROGRESS\n\n### L1 — logic / HIGH\n- quote: `x`\n',
  });
  const r = run(f.sp);
  const x = r.failures?.[0];
  expect('策略 ACCEPT_PARTIAL', x?.retry_policy === 'ACCEPT_PARTIAL', x?.retry_policy);
  f.cleanup();
}

// 6. 正常完成 → 不进 FAILED 列表
console.log('case 6: DONE 的切片不应出现在失败列表');
{
  const f = fixture([['slice-06', 'DONE'], ['slice-07', 'FAILED']], {
    'round1-02-sweep-slice-07.md': '# s7\nstatus: IN_PROGRESS\n',
  });
  const r = run(f.sp);
  expect('只列 FAILED', r.failures?.length === 1, String(r.failures?.length));
  expect('是 slice-07', r.failures?.[0]?.slice_id === 'slice-07', r.failures?.[0]?.slice_id);
  f.cleanup();
}

// 7. 多个失败 → 计数汇总
console.log('case 7: 多失败时给出按类型的计数');
{
  const f = fixture([['a', 'FAILED'], ['b', 'FAILED'], ['c', 'FAILED']], {
    'round1-02-sweep-a.md': '# a\nstatus: IN_PROGRESS\n',
    'round1-02-sweep-b.md': '# b\nstatus: IN_PROGRESS\n',
    'round1-02-sweep-c.md': '',
  });
  const r = run(f.sp);
  expect('两个 SKELETON_ONLY', r.counts?.SKELETON_ONLY === 2, JSON.stringify(r.counts));
  expect('一个 NO_OUTPUT', r.counts?.NO_OUTPUT === 1, JSON.stringify(r.counts));
  f.cleanup();
}

// 8. 无失败切片 → 空列表，不报错
console.log('case 8: 无 FAILED 切片 → 空列表');
{
  const f = fixture([['x', 'DONE'], ['y', 'DEFERRED']], {});
  const r = run(f.sp);
  expect('failures 为空', Array.isArray(r.failures) && r.failures.length === 0);
  f.cleanup();
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
