#!/usr/bin/env node
/**
 * check-promises.test.mjs — 「承诺兑现」检查器的自测
 *
 * 为什么必须测：这是唯一一个能机械抓到「缺失型缺陷」的工具。
 * 它的失败模式很隐蔽——漏检看起来和「代码没问题」一模一样。
 *
 * 关键用例：在 ground truth 的 base（无缺陷）和 injected（有缺陷）上对比。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-promises.mjs');

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

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'prom-'));
  for (const [name, content] of Object.entries(files)) {
    const p = join(dir, name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

console.log('\n=== check-promises 自测 ===\n');

console.log('case 1: @returns {boolean} 但无 return → FAIL');
{
  const f = fixture({
    'a.js': `/**\n * 清空\n * @returns {boolean} 总是 true\n */\nexport function clear() {\n  this.x = 0;\n}\n`,
  });
  const r = run(f.dir);
  expect('退出码 1', r.code === 1);
  expect('报 P1', /\[P1\]/.test(r.out), r.out.slice(0, 200));
  f.cleanup();
}

console.log('case 2: @returns {boolean} 且有 return → 不报');
{
  const f = fixture({
    'a.js': `/**\n * @returns {boolean}\n */\nexport function ok() {\n  return true;\n}\n`,
  });
  const r = run(f.dir);
  expect('退出码 0', r.code === 0);
  expect('无 FAIL', !/✗/.test(r.out));
  f.cleanup();
}

console.log('case 3: @throws 但从不 throw → FAIL');
{
  const f = fixture({
    'a.js': `/**\n * @throws {Error} 参数非法时\n */\nexport function check(x) {\n  return x;\n}\n`,
  });
  const r = run(f.dir);
  expect('报 P2', /\[P2\]/.test(r.out), r.out.slice(0, 200));
  f.cleanup();
}

console.log('case 4: 声称只读但返回可变对象 → FAIL');
{
  const f = fixture({
    'a.js': `/**\n * 返回只读配置，调用方不应修改\n */\nexport function load() {\n  return { a: 1 };\n}\n`,
  });
  const r = run(f.dir);
  expect('报 P3', /\[P3\]/.test(r.out), r.out.slice(0, 300));
  f.cleanup();
}

console.log('case 5: 声称只读且 freeze 了 → 不报 P3 FAIL');
{
  const f = fixture({
    'a.js': `/**\n * 返回只读配置，调用方不应修改\n */\nexport function load() {\n  return Object.freeze({ a: 1 });\n}\n`,
  });
  const r = run(f.dir);
  expect('无 P3 FAIL', !/P3\].*\n.*声称/.test(r.out) || !/✗ \[P3\]/.test(r.out), r.out.slice(0, 300));
  f.cleanup();
}

console.log('case 6: 无 JSDoc → 不报（只检查明确写了承诺的）');
{
  const f = fixture({
    'a.js': `export function f() {\n  return { a: 1 };\n}\n`,
  });
  const r = run(f.dir);
  expect('退出码 0', r.code === 0, r.out.slice(0, 200));
  f.cleanup();
}

console.log('case 7: 空目录 → 干净退出');
{
  const f = fixture({ 'x.js': 'export const a = 1;\n' });
  const r = run(f.dir);
  expect('退出码 0', r.code === 0);
  f.cleanup();
}

// ── 真实 ground truth 双向验证 ──
const GT = 'D:/audit-out/ground-truth';
if (existsSync(join(GT, 'base')) && existsSync(join(GT, 'injected'))) {
  console.log('case 8: ground truth base（无缺陷）→ 必须干净');
  {
    const r = run(join(GT, 'base'));
    expect('无 FAIL', !/✗/.test(r.out), r.out.split('\n').filter((l) => l.includes('✗')).join('; '));
  }

  console.log('case 9: ground truth injected → 必须抓到 GT-013 与 GT-014');
  {
    const r = run(join(GT, 'injected'));
    expect('抓到 GT-013（P1，queue.js）', /\[P1\].*queue\.js/.test(r.out) || /queue\.js:\d+[\s\S]{0,80}\[P1\]/.test(r.out) || /\[P1\] src\/queue\.js/.test(r.out), r.out.slice(0, 400));
    expect('抓到 GT-014（P3，config.js）', /\[P3\].*config\.js/.test(r.out) || /config\.js:\d+[\s\S]{0,80}\[P3\]/.test(r.out) || /\[P3\] src\/config\.js/.test(r.out), r.out.slice(0, 400));
  }
} else {
  console.log('case 8-9: 跳过（找不到 ground truth 目录）');
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
