#!/usr/bin/env node
/**
 * check-blindspots.test.mjs — 盲区模式检测器的自测
 *
 * 这三个模式对应 2026-11-11 实验里「6 个 agent × 3 轮 = 18 次审查，零命中」的缺陷。
 * 工具的价值在于：它不需要 agent 意识到这些模式，只要代码有对应特征就能命中。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-blindspots.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

function run(dir) {
  try {
    const out = execFileSync('node', [SCRIPT, dir], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

function fx(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bs-'));
  for (const [n, c] of Object.entries(files)) writeFileSync(join(dir, n), c);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

console.log('\n=== check-blindspots 自测 ===\n');

console.log('B1: 返回内部容器元素');
{
  const f = fx({
    'q.js': `export class Q {\n  #items = [];\n  peek() {\n    return this.#items[0];\n  }\n}\n`,
  });
  const r = run(f.dir);
  expect('报 B1', /\[B1\]/.test(r.out), r.out.slice(0, 200));
  f.cleanup();
}

console.log('B1 反例：返回拷贝 → 不报');
{
  const f = fx({
    'q.js': `export class Q {\n  #items = [];\n  peek() {\n    return { ...this.#items[0] };\n  }\n}\n`,
  });
  const r = run(f.dir);
  expect('不报 B1', !/\[B1\]/.test(r.out), r.out.slice(0, 200));
  f.cleanup();
}

console.log('B2: 同类函数守卫不一致');
{
  const f = fx({
    'q.js': `export class Q {\n  enqueue(task) {\n    if (typeof task !== 'object') throw new Error('x');\n    if (typeof task.id !== 'string') throw new Error('y');\n  }\n  remove(id) {\n    return this.items.filter((t) => t.id !== id);\n  }\n}\n`,
  });
  const r = run(f.dir);
  expect('报 B2', /\[B2\]/.test(r.out), r.out.slice(0, 300));
  f.cleanup();
}

console.log('B3: 数值校验缺 isFinite（NaN 漏过）');
{
  const f = fx({
    'q.js': `export class Q {\n  constructor(n) {\n    if (typeof n !== 'number' || n <= 0) throw new Error('x');\n  }\n}\n`,
  });
  const r = run(f.dir);
  expect('报 B3', /\[B3\]/.test(r.out), r.out.slice(0, 300));
  f.cleanup();
}

console.log('B3 反例：用了 Number.isFinite → 不报');
{
  const f = fx({
    'q.js': `export class Q {\n  constructor(n) {\n    if (!Number.isFinite(n) || n <= 0) throw new Error('x');\n  }\n}\n`,
  });
  const r = run(f.dir);
  expect('不报 B3', !/\[B3\]/.test(r.out), r.out.slice(0, 300));
  f.cleanup();
}

console.log('B3 反例：用了 Number.isInteger → 不报');
{
  const f = fx({
    'q.js': `export class Q {\n  set(n) {\n    if (!Number.isInteger(n) || n <= 0) throw new Error('x');\n  }\n}\n`,
  });
  const r = run(f.dir);
  expect('不报 B3', !/\[B3\]/.test(r.out), r.out.slice(0, 300));
  f.cleanup();
}

// ── 真实 fixture 双向验证 ──
const EXP = join(HERE, '..', 'experiments');
if (existsSync(join(EXP, 'injected'))) {
  console.log('真实 fixture：injected 上三条都应命中');
  {
    const r = run(join(EXP, 'injected'));
    expect('命中 B1（peek 返回内部引用 = GT-011）', /\[B1\]/.test(r.out), r.out.slice(0, 400));
    expect('命中 B2（remove 缺校验 = GT-012）', /\[B2\]/.test(r.out), r.out.slice(0, 400));
    expect('命中 B3（capacity 缺 isFinite = GT-013）', /\[B3\]/.test(r.out), r.out.slice(0, 400));
  }
} else {
  console.log('跳过真实 fixture 验证（找不到 experiments/injected）');
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
