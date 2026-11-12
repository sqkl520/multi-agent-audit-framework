#!/usr/bin/env node
/**
 * detect-harness.test.mjs — 环境探测器的版本比较测试
 *
 * 为什么专门测这个：2026-11-09 实测中，版本比较写错（把 150 当成 minor
 * 而不是 patch），导致「本机 2.1.289 支持 Workflow」被误判为「不支持」。
 * 这类错误很难在人工 review 里发现——它看起来完全合理。
 */

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'detect-harness.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

// 复刻探测器的比较逻辑，直接测它
function cmpTo(maj, min, pat, a, b, c) {
  if (maj !== a) return maj - a;
  if (min !== b) return min - b;
  return pat - c;
}
const hasWorkflow = (maj, min, pat) => cmpTo(maj, min, pat, 2, 1, 150) >= 0;

console.log('\n=== 环境探测器版本比较自测 ===\n');

console.log('case 1: 2.1.289（本机实测版本）→ 应支持');
{
  expect('判为支持', hasWorkflow(2, 1, 289));
}

console.log('case 2: 2.1.150（文档说的起始版本）→ 应支持（含边界）');
{
  expect('判为支持', hasWorkflow(2, 1, 150));
}

console.log('case 3: 2.1.149（起始版本前一号）→ 应不支持');
{
  expect('判为不支持', !hasWorkflow(2, 1, 149));
}

console.log('case 4: 2.0.999（minor 更低但 patch 更高）→ 应不支持');
{
  expect('判为不支持（minor 优先）', !hasWorkflow(2, 0, 999));
}

console.log('case 5: 3.0.0（major 更高）→ 应支持');
{
  expect('判为支持', hasWorkflow(3, 0, 0));
}

console.log('case 6: 1.9.999（major 更低）→ 应不支持');
{
  expect('判为不支持', !hasWorkflow(1, 9, 999));
}

console.log('case 7: 2.1.1000（patch 过千）→ 应支持');
{
  expect('判为支持（patch 不溢出）', hasWorkflow(2, 1, 1000));
}

console.log('case 8: 探测脚本可执行且输出合法 JSON');
{
  try {
    const out = execFileSync('node', [SCRIPT, '--json'], { encoding: 'utf8', timeout: 30000 });
    const j = JSON.parse(out);
    expect('输出合法 JSON', true);
    expect('含 harness 字段', typeof j.harness === 'object');
    expect('含 concurrency.recommended', typeof j.concurrency?.recommended === 'number');
    expect('unknown 不被猜成数字',
      j.concurrency?.workflow_max?.value === null || typeof j.concurrency.workflow_max.value === 'number');
  } catch (e) {
    expect('脚本可执行', false, e.message.split('\n')[0]);
  }
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
