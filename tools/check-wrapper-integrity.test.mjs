#!/usr/bin/env node
/**
 * check-wrapper-integrity.test.mjs — 完整性检查器自测
 *
 * 为什么补这个：`check-wrapper-integrity.mjs` 此前**一个测试都没有**，
 * 而它恰恰是唯一能发现「wrapper 内容被删掉但结构还在」的检查器。
 * 2026-11-13 实测发现它自己就有一处自相矛盾：表格按 `r.issues` 画 ✓，
 * 合计却按 `findings` 数问题——基线不足时表格全绿而合计说「5 项问题」。
 * 一份报告的两处结论互相矛盾，比没有报告更糟。
 *
 * 这里除了钉住各种缺陷能被抓到，还专门钉住「表格与合计一致」。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-wrapper-integrity.mjs');
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

function withCopy(mutator, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'wi-test-'));
  cpSync(join(ROOT, 'framework'), join(dir, 'framework'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-wrapper-integrity.mjs'));
  mutator(join(dir, 'framework', 'wrappers'), dir);
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runIn(dir, extra = []) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-wrapper-integrity.mjs'), ...extra],
      { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: e.stdout?.toString() ?? '' };
  }
}

console.log('\n=== wrapper 完整性检查器自测 ===\n');

console.log('case 1: 未改动的仓库应通过（无基线）');
{
  withCopy(() => {}, (dir) => {
    const r = runIn(dir);
    expect('退出码 0', r.code === 0, `实际 ${r.code}`);
    expect('无问题', /合计: 0 项问题/.test(r.out), r.out.slice(-150));
  });
}

console.log('case 2: 删掉必备小节 → 必须判失败');
{
  withCopy((wrap) => {
    const p = join(wrap, 'fix-worker.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/^## ?5\. ?返回要求.*/m, '## 5. 改了标题'));
  }, (dir) => {
    const r = runIn(dir);
    expect('退出码非 0', r.code !== 0, `实际 ${r.code}`);
    expect('报出缺失', /返回要求|缺失|问题/.test(r.out), r.out.slice(-200));
  });
}

console.log('case 3: 小节只剩标题没有正文 → 必须判失败（防「结构在内容没了」）');
{
  withCopy((wrap) => {
    const p = join(wrap, 'verifier.md');
    const t = readFileSync(p, 'utf8');
    // 按行切：找到「返回要求」标题，把其后直到下一个二级标题的正文全部删掉。
    // 用逐行处理而不是一条正则，因为正则的非贪婪 + 前瞻在中文正文里很容易匹配失败
    // （实测第一版正则长度 2422 → 2422，什么都没删）。
    const lines = t.split('\n');
    const start = lines.findIndex((l) => /^## ?\d*\.?\s*返回要求/.test(l));
    if (start < 0) throw new Error('测试前提不成立：没找到「返回要求」标题');
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (/^## /.test(lines[i])) { end = i; break; }
    }
    const emptied = [...lines.slice(0, start + 1), '', ...lines.slice(end)].join('\n');
    if (emptied.length >= t.length) throw new Error('测试前提不成立：正文没有被删掉');
    writeFileSync(p, emptied);
  }, (dir) => {
    const r = runIn(dir);
    expect('退出码非 0', r.code !== 0, `实际 ${r.code}｜${r.out.slice(-200)}`);
  });
}

console.log('case 4: 基线不足时，表格与合计必须一致（回归：曾表格全绿却报 5 项问题）');
{
  withCopy((wrap, dir) => {
    // 人为造一个高基线，让每个文件都"低于基线"
    const baseline = {};
    for (const f of readFileSync(join(ROOT, 'framework', 'wrappers', 'planner.md'), 'utf8') ? [] : []) void f;
    const files = ['audit-specialist', 'critique-panel', 'fix-worker', 'planner', 'recon-scout', 'sweep-scout', 'verifier'];
    for (const f of files) baseline[f] = 500;
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify(baseline));
  }, (dir) => {
    const r = runIn(dir, ['--baseline', join(dir, 'baseline.json')]);
    expect('退出码非 0', r.code !== 0, `实际 ${r.code}`);

    // 统计表格里 ✗ 的数量，与合计声明的数字比对
    const crosses = (r.out.match(/^✗ /gm) ?? []).length;
    const summary = r.out.match(/合计: (\d+) 项问题/);
    const declared = summary ? Number(summary[1]) : null;
    expect('合计数字可解析', declared !== null, r.out.slice(-120));
    expect('表格 ✗ 数与合计数一致', crosses === declared, `✗=${crosses} 合计=${declared}`);
    expect('每个文件都标出问题', crosses === 7, `✗=${crosses}`);
  });
}

console.log('case 5: JSON 输出里 results[].issues 与 findings 必须都有基线问题');
{
  withCopy((wrap, dir) => {
    const baseline = {};
    for (const f of ['audit-specialist', 'critique-panel', 'fix-worker', 'planner', 'recon-scout', 'sweep-scout', 'verifier']) {
      baseline[f] = 500;
    }
    writeFileSync(join(dir, 'baseline.json'), JSON.stringify(baseline));
  }, (dir) => {
    let data = null;
    try {
      execFileSync(process.execPath,
        [join(dir, 'tools', 'check-wrapper-integrity.mjs'), '--json', '--baseline', join(dir, 'baseline.json')],
        { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      try { data = JSON.parse(e.stdout?.toString() ?? 'null'); } catch { data = null; }
    }
    expect('拿到 JSON', data !== null);
    const withIssues = (data?.results ?? []).filter((r) => (r.issues ?? []).length > 0).length;
    const findingCount = (data?.findings ?? []).filter((f) => f.level === 'FAIL').length;
    expect('results[].issues 也记录了基线问题', withIssues === 7, `实际 ${withIssues}`);
    expect('findings 与 issues 数量一致', findingCount === withIssues, `findings=${findingCount} issues=${withIssues}`);
  });
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
