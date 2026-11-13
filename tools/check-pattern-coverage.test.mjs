#!/usr/bin/env node
/**
 * check-pattern-coverage.test.mjs — 模式归属检查器自测
 *
 * 这个检查器守的是一条"不许装看不见"的规则：
 *   一条 ground truth 缺陷，要么被某个模式覆盖，要么被明确记录为「无覆盖」。
 *   悬空是不允许的——因为它会让覆盖率那一栏失去意义。
 *
 * 所以用例集中在：悬空能被抓到、理由是必填的、引用了不存在的模式能被抓到。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TOOL = join(HERE, 'check-pattern-coverage.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

function withCopy(mutator, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pc-test-'));
  cpSync(join(ROOT, 'framework'), join(dir, 'framework'), { recursive: true });
  cpSync(join(ROOT, 'experiments'), join(dir, 'experiments'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-pattern-coverage.mjs'));
  mutator(join(dir, 'experiments'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runIn(dir) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-pattern-coverage.mjs'), '--json'], { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out }; }
  }
}

console.log('\n=== 模式归属检查器自测 ===\n');

console.log('case 1: 真实仓库两个 fixture 全部有归属');
{
  try {
    const out = execFileSync(process.execPath, [TOOL], { encoding: 'utf8' });
    expect('退出码 0', true);
    expect('同时报告两个 fixture', /fixture1/.test(out) && /fixture2/.test(out), out.slice(0, 200));
    expect('报告全部有归属', /全部有明确归属/.test(out), out.slice(-200));
  } catch (e) {
    expect('退出码 0', false, `实际 ${e.status}: ${e.stdout?.toString().slice(-300)}`);
  }
}

console.log('case 2: 某条缺陷没有 pattern 字段 → 必须报悬空');
{
  const r = withCopy((exp) => {
    const p = join(exp, 'manifest.json');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    delete m.defects[0].pattern;
    delete m.defects[0].none_reason;
    writeFileSync(p, JSON.stringify(m, null, 2));
  }, runIn);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'pattern_undeclared');
  expect('报 pattern_undeclared', !!hit, JSON.stringify(r.data?.problems));
}

console.log('case 3: 标了 none 但没写理由 → 必须报错（「不属于任何模式」是个判断）');
{
  const r = withCopy((exp) => {
    const p = join(exp, 'manifest.json');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    const none = m.defects.find((d) => d.pattern === 'none');
    delete none.none_reason;
    writeFileSync(p, JSON.stringify(m, null, 2));
  }, runIn);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'none_without_reason');
  expect('报 none_without_reason', !!hit, JSON.stringify(r.data?.problems));
}

console.log('case 4: 标了一个模板里不存在的模式号 → 必须报错');
{
  const r = withCopy((exp) => {
    const p = join(exp, 'manifest.json');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    m.defects[0].pattern = 99;
    writeFileSync(p, JSON.stringify(m, null, 2));
  }, runIn);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'pattern_not_in_template');
  expect('报 pattern_not_in_template', !!hit, JSON.stringify(r.data?.problems));
  expect('点名 99', /99/.test(hit?.detail ?? ''), hit?.detail);
}

console.log('case 5: fixture2 也必须被检查（只查 fixture1 会漏掉跨领域盲区）');
{
  const r = withCopy((exp) => {
    const p = join(exp, 'fixture2', 'manifest.json');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    delete m.defects[0].pattern;
    writeFileSync(p, JSON.stringify(m, null, 2));
  }, runIn);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  const hit = (r.data?.problems ?? []).find((p) => /fixture2/.test(p.id ?? ''));
  expect('问题指向 fixture2', !!hit, JSON.stringify(r.data?.problems?.map((x) => x.id)));
}

console.log('case 6: 模板里模式表被删 → 必须拒绝执行，不能瞎报绿');
{
  const r = withCopy((exp) => {
    // 破坏 wave2 的模式表（框架侧）
    const w = join(exp, '..', 'framework', 'templates', 'wave2-audit.md');
    const t = readFileSync(w, 'utf8')
      .replace(/^\|\s*\*\*\d\*\*\s*\|.*$/gm, '')
      .replace(/模式\s*\d/g, 'XX');
    writeFileSync(w, t);
  }, runIn);
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
}

console.log('case 7: 标 "none" 但没给 none_keywords → 必须报错（「无覆盖」要经得起搜）');
{
  const r = withCopy((exp) => {
    const p = join(exp, 'manifest.json');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    const none = m.defects.find((d) => d.pattern === 'none');
    delete none.none_keywords;
    writeFileSync(p, JSON.stringify(m, null, 2));
  }, runIn);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'none_without_keywords');
  expect('报 none_without_keywords', !!hit, JSON.stringify(r.data?.problems?.map(x => x.kind)));
}

console.log('case 8: none_keywords 里的词在模板中真的存在 → 必须报错');
{
  // 这条规则抓的是「我声称查过、其实模板里有相关指引」。
  // 2026-11-14 实测就靠它抓出 4 条错误标注（原型链被模式 4a 覆盖）。
  const r = withCopy((exp) => {
    const p = join(exp, 'manifest.json');
    const m = JSON.parse(readFileSync(p, 'utf8'));
    const none = m.defects.find((d) => d.pattern === 'none');
    // 「原型链」在模板 §4.8.2.1 的 4a 里明确出现
    none.none_keywords = ['原型链', '某个绝不可能出现的词'];
    writeFileSync(p, JSON.stringify(m, null, 2));
  }, runIn);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'none_but_template_mentions_it');
  expect('报 none_but_template_mentions_it', !!hit, JSON.stringify(r.data?.problems?.map(x => x.kind)));
  expect('点名命中的关键词', /原型链/.test(hit?.detail ?? ''), hit?.detail);
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
