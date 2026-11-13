#!/usr/bin/env node
/**
 * check-contract-slice-fidelity.test.mjs — 拆分无损性检查器自测
 *
 * 这个检查器存在的理由：拆分契约解决了加载量，但**切掉的东西不会自己喊疼**。
 * 一个字段在母文件里、在切片里都出现过，不代表它周围的约束说明还在；
 * 反过来，字段整个被切掉了，切片也照样是「一个完整的 .md 文件」。
 *
 * 所以这里钉住三件事：
 *   1. 真实仓库无损
 *   2. 切片丢字段 → 必须报出具体是哪个字段
 *   3. 母文件结构变了（节序被打乱/节消失）→ 必须拒绝执行，不能瞎报绿
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TOOL = join(HERE, 'check-contract-slice-fidelity.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

function withCopy(mutator, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-test-'));
  cpSync(join(ROOT, 'framework'), join(dir, 'framework'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-contract-slice-fidelity.mjs'));
  mutator(join(dir, 'framework', 'components'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runIn(dir) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-contract-slice-fidelity.mjs'), '--json'], { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out }; }
  }
}

console.log('\n=== 契约切片保真度检查器自测 ===\n');

console.log('case 1: 真实仓库应无损');
{
  try {
    const out = execFileSync(process.execPath, [TOOL], { encoding: 'utf8' });
    expect('退出码 0', true);
    expect('报告「无损」', /无损/.test(out), out.slice(-200));
    expect('字段总数为正', /共 (\d+) 个字段/.test(out) && Number(out.match(/共 (\d+) 个字段/)[1]) > 100,
      out.match(/共 \d+ 个字段/)?.[0]);
  } catch (e) {
    expect('退出码 0', false, `实际 ${e.status}: ${e.stdout?.toString().slice(-300)}`);
  }
}

console.log('case 2: 切片丢掉该角色节里的字段 → 必须报出具体字段名');
{
  const r = withCopy((comp) => {
    const p = join(comp, 'output-contract', 'critique.md');
    writeFileSync(p, readFileSync(p, 'utf8').replaceAll('direct_contradiction', '__GONE__'));
  }, runIn);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'slice_lost_fields');
  expect('报 slice_lost_fields', !!hit, JSON.stringify(r.data?.problems));
  expect('点名 direct_contradiction', /direct_contradiction/.test(hit?.detail ?? ''), hit?.detail);
}

console.log('case 3: 母文件的角色节消失 → 必须拒绝执行（不能瞎报绿）');
{
  const r = withCopy((comp) => {
    const p = join(comp, 'output-contract.md');
    // 必须真的把标题改到正则匹配不上——只改后缀（"2.3 标题没了"）仍匹配 ^#### 2\.3
    const t = readFileSync(p, 'utf8').replace(/^#### 2\.3 .*$/m, '#### 锐评角色（标题被改）');
    writeFileSync(p, t);
  }, runIn);
  expect('退出码 2（结构异常）', r.code === 2, `实际 ${r.code}`);
}

console.log('case 4: 母文件角色节顺序被打乱 → 必须拒绝执行');
{
  const r = withCopy((comp) => {
    const p = join(comp, 'output-contract.md');
    const lines = readFileSync(p, 'utf8').split('\n');
    const i24 = lines.findIndex((l) => /^#### 2\.4 /.test(l));
    const i25 = lines.findIndex((l) => /^#### 2\.5 /.test(l));
    const i3 = lines.findIndex((l) => /^## 第 3 节/.test(l));
    // 把 2.4 整段挪到 2.5 之后
    const block24 = lines.slice(i24, i25);
    const rest = [...lines.slice(0, i24), ...lines.slice(i25)];
    const newI3 = rest.findIndex((l) => /^## 第 3 节/.test(l));
    writeFileSync(p, [...rest.slice(0, newI3), ...block24, ...rest.slice(newI3)].join('\n'));
  }, runIn);
  expect('退出码 2（顺序异常）', r.code === 2, `实际 ${r.code}`);
}

console.log('case 5: 切片没标「自动生成」→ 必须报出（防读者以为它是独立权威）');
{
  const r = withCopy((comp) => {
    const p = join(comp, 'output-contract', 'fix.md');
    const t = readFileSync(p, 'utf8').replace(/自动生成/g, '手写').replace(/母文件/g, '原件');
    writeFileSync(p, t);
  }, runIn);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'slice_not_marked_generated');
  expect('报 slice_not_marked_generated', !!hit, JSON.stringify(r.data?.problems));
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
