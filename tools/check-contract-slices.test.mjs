#!/usr/bin/env node
/**
 * check-contract-slices.test.mjs — 切片完整性检查器 + 生成器自测
 *
 * 拆分契约是这轮唯一「为了过 lint 而改动共享文件」的动作，风险在于：
 * 生成器切错节 → 某角色拿到不含自己字段的切片 → 它再也写不出合规产物，
 * 而表面上一切正常（文件在、行数更小、lint 绿）。
 *
 * 所以这里同时钉住两件事：
 *   1. 掺杂检测器能发现「切片缺字段」「缺通用节」「孤儿切片」
 *   2. 生成器是幂等的：重跑后产物与仓库中已提交的一致（防手改产物）
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CHECKER = join(HERE, 'check-contract-slices.mjs');
const GEN = join(HERE, 'gen-contract-slices.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

function withCopy(mutator, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-test-'));
  cpSync(join(ROOT, 'framework'), join(dir, 'framework'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  for (const f of ['check-contract-slices.mjs', 'check-payload.mjs', 'gen-contract-slices.mjs']) {
    cpSync(join(HERE, f), join(dir, 'tools', f));
  }
  mutator(join(dir, 'framework', 'components'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runChecker(dir) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'tools', 'check-contract-slices.mjs'), '--json'],
      { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out }; }
  }
}

console.log('\n=== 契约切片检查器自测 ===\n');

console.log('case 1: 真实仓库的切片应全部完整');
{
  try {
    const out = execFileSync(process.execPath, [CHECKER], { encoding: 'utf8' });
    expect('退出码 0', true);
    expect('报告「全部完整」', /全部完整/.test(out), out.slice(-200));
  } catch (e) {
    expect('退出码 0', false, `实际 ${e.status}: ${e.stdout?.toString().slice(-300)}`);
  }
}

console.log('case 2: 切片缺该角色的必填字段 → 必须报错');
{
  const r = withCopy((comp) => {
    const p = join(comp, 'output-contract', 'planner.md');
    // 删掉 planner 的必填字段之一（member_count），保留其它
    writeFileSync(p, readFileSync(p, 'utf8').replaceAll('member_count', '__GONE__'));
  }, runChecker);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'slice_missing_fields');
  expect('报 slice_missing_fields', !!hit, JSON.stringify(r.data?.problems));
  expect('指出是 member_count', /member_count/.test(hit?.detail ?? ''), hit?.detail);
}

console.log('case 3: 切片缺通用节（信封/错误/检查清单）→ 必须报错');
{
  const r = withCopy((comp) => {
    const p = join(comp, 'output-contract', 'fix.md');
    const t = readFileSync(p, 'utf8');
    // 删掉「第 1 节 统一返回信封」整段
    const lines = t.split('\n');
    const start = lines.findIndex((l) => /^##\s*第\s*1\s*节/.test(l));
    const end = lines.findIndex((l, i) => i > start && /^##\s*第\s*2\s*节/.test(l));
    writeFileSync(p, [...lines.slice(0, start), ...lines.slice(end)].join('\n'));
  }, runChecker);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'slice_missing_sections');
  expect('报 slice_missing_sections', !!hit, JSON.stringify(r.data?.problems));
  expect('指出是第 1 节', /第\s*1\s*节/.test(hit?.detail ?? ''), hit?.detail);
}

console.log('case 4: 孤儿切片（有文件但校验器里没这个角色）→ 必须报错');
{
  const r = withCopy((comp) => {
    writeFileSync(join(comp, 'output-contract', 'ghost_role.md'), '# ghost\n\n## 第 1 节\n## 第 3 节\n## 第 4 节\n');
  }, runChecker);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'orphan_slice');
  expect('报 orphan_slice', !!hit, JSON.stringify(r.data?.problems));
}

console.log('case 5: 切片缺失（母文件有节但产物没生成）→ 必须报错');
{
  const r = withCopy((comp) => {
    rmSync(join(comp, 'output-contract', 'verify.md'), { force: true });
  }, runChecker);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'slice_missing');
  expect('报 slice_missing', !!hit, JSON.stringify(r.data?.problems));
}

console.log('case 6: 生成器重跑后产物应与已提交的一致（防手改产物 / 生成器漂移）');
{
  const dir = mkdtempSync(join(tmpdir(), 'cs-gen-'));
  cpSync(join(ROOT, 'framework'), join(dir, 'framework'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(GEN, join(dir, 'tools', 'gen-contract-slices.mjs'));

  const before = {};
  const sliceDir = join(dir, 'framework', 'components', 'output-contract');

  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(sliceDir)) {
    const fp = join(sliceDir, f);
    // 跳过子目录（examples/ 就在这一层）——readFileSync 读目录会 EISDIR
    if (!f.endsWith('.md')) continue;
    before[f] = readFileSync(fp, 'utf8');
  }

  // 重跑生成器
  execFileSync(process.execPath, [join(dir, 'tools', 'gen-contract-slices.mjs')], { stdio: 'pipe' });

  let identical = true;
  const diffs = [];
  for (const f of Object.keys(before)) {
    const after = readFileSync(join(sliceDir, f), 'utf8');
    if (after !== before[f]) { identical = false; diffs.push(f); }
  }
  expect('重跑生成器产物幂等', identical, `变化的文件: ${diffs.join(', ')}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
