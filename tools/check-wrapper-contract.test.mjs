#!/usr/bin/env node
/**
 * check-wrapper-contract.test.mjs — 覆盖检查器自测
 *
 * 核心要钉住的是**检测器自身的正确性**，因为它的失败方向很危险：
 * 漏报会让「wrapper 没写必填字段」继续潜伏，误报会让人去改本来就对的文件。
 *
 * 2026-11-13 开发时实际踩过两次误报：
 *   1. 只切 §4「产物格式」→ 所有 wrapper 都报「没写字段」，因为字段模板在 §5「返回要求」里
 *   2. 「遇到任何标题即停」→ planner.md 的子标题之后的内容被漏掉，`members` 被误判
 * 这两个都变成了下面的用例。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-wrapper-contract.mjs');
const ROOT = join(HERE, '..');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

/** 在工具副本上跑，让它指向临时搭建的 framework 目录 */
function runAgainst(mutator, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'wc-test-'));
  cpSync(join(ROOT, 'framework'), join(dir, 'framework'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(join(HERE, 'check-payload.mjs'), join(dir, 'tools', 'check-payload.mjs'));
  cpSync(TOOL, join(dir, 'tools', 'check-wrapper-contract.mjs'));

  mutator(join(dir, 'framework', 'wrappers'));

  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-wrapper-contract.mjs'), '--json', ...extraArgs],
      { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out, err: e.stderr?.toString() }; }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runAgainstStrict = (mutator) => runAgainst(mutator, ['--strict']);

console.log('\n=== wrapper 覆盖检查器自测 ===\n');

console.log('case 1: 真实仓库应全部通过（--strict）');
{
  try {
    const out = execFileSync(process.execPath, [TOOL, '--strict'], { encoding: 'utf8' });
    expect('--strict 退出码 0', true);
    expect('输出含「全部」结论', /全部 \d+ 个角色/.test(out), out.slice(-200));
  } catch (e) {
    expect('--strict 退出码 0', false, `实际 ${e.status}: ${e.stdout?.toString().slice(-300)}`);
  }
}

console.log('case 2: 删掉某个必填字段的所有出现 → 必须报 missing');
{
  const r = runAgainst((wrap) => {
    const p = join(wrap, 'sweep-scout.md');
    const t = readFileSync(p, 'utf8').replaceAll('lead_count', 'XXX_REMOVED');
    writeFileSync(p, t);
  });
  const fields = (r.data?.problems ?? []).filter((p) => p.field === 'lead_count');
  expect('报出 lead_count 缺失', fields.length > 0, JSON.stringify(r.data?.problems));
  expect('kind 是 missing', fields[0]?.kind === 'field_coverage_missing', fields[0]?.kind);
}

console.log('case 3: 字段只出现在无关章节 → 不能算强覆盖，且不得谎报「全部强覆盖」');
{
  // 「中」在非 strict 下不判失败，但**必须如实说明它不是强覆盖**。
  // 2026-11-13 实测踩到：工具打印「中 files_touched」的同时又说「全部强覆盖」，
  // 自相矛盾的汇总语会让真实缺失被掩盖。
  const r = runAgainst((wrap) => {
    const p = join(wrap, 'fix-worker.md');
    const t = readFileSync(p, 'utf8');
    const stripped = t.replaceAll('files_touched', 'XXX');
    writeFileSync(p, stripped + '\n\n## 99. 附录\n\n`files_touched` 是旧名称。\n');
  });
  const fix = (r.data?.results ?? []).find((x) => x.role === 'fix');
  const ft = fix?.fields?.find((f) => f.field === 'files_touched');
  expect('files_touched 不是强覆盖', ft?.level !== 'strong', JSON.stringify(ft));

  // strict 下必须判失败
  const strict = runAgainstStrict((wrap) => {
    const p = join(wrap, 'fix-worker.md');
    const t = readFileSync(p, 'utf8').replaceAll('files_touched', 'XXX');
    writeFileSync(p, t + '\n\n## 99. 附录\n\n`files_touched` 是旧名称。\n');
  });
  expect('--strict 下判失败', strict.code === 1, `实际 ${strict.code}`);
  const hit = (strict.data?.problems ?? []).find((p) => p.field === 'files_touched');
  expect('--strict 下报出该字段', !!hit, JSON.stringify(strict.data?.problems));
}

console.log('case 4: 字段写在 §5 的 JSON 模板里 → 必须算强覆盖（防「只切 §4」的误报）');
{
  // planner.md 的字段全在 §5 的 json 块里；这是回归用例
  const r = runAgainst(() => {});
  const planner = (r.data?.results ?? []).find((x) => x.role === 'planner');
  expect('planner 找到', !!planner);
  const allStrong = planner?.fields?.every((f) => f.level === 'strong');
  expect('planner 全部字段强覆盖', allStrong === true,
    JSON.stringify(planner?.fields));
}

console.log('case 5: 子标题之后的字段也要算进来（防「遇标题即停」的误报）');
{
  const r = runAgainst((wrap) => {
    const p = join(wrap, 'verifier.md');
    const t = readFileSync(p, 'utf8');
    // 在返回要求里插入一个子标题，字段放在子标题之后
    const patched = t.replace('## 5. 返回要求', '## 5. 返回要求\n\n### 子标题\n');
    writeFileSync(p, patched);
  });
  const v = (r.data?.results ?? []).find((x) => x.role === 'verify');
  const stillStrong = v?.fields?.every((f) => f.level === 'strong');
  expect('插入子标题后仍是强覆盖', stillStrong === true, JSON.stringify(v?.fields));
}

console.log('case 6: 删掉整个产物格式小节 → 必须报 no_product_section');
{
  const r = runAgainst((wrap) => {
    const p = join(wrap, 'fix-worker.md');
    const t = readFileSync(p, 'utf8')
      .replace('## 4. 产物格式（硬要求）', '## 4. 随便什么标题')
      .replace('## 5. 返回要求', '## 5. 另一个标题');
    writeFileSync(p, t.replace(/```json[\s\S]*?```/g, ''));
  });
  const kinds = (r.data?.problems ?? []).map((p) => p.kind);
  expect('报出无产物规格区', kinds.includes('no_product_section') || kinds.some((k) => k.startsWith('field_coverage_')),
    kinds.join(','));
}

console.log('case 7: 校验器里的 ROLE_REQUIRED 改了，检查器必须跟着变（防两处漂移）');
{
  // 这个检查器不自己维护字段表，而是从 check-payload.mjs 解析——所以
  // 在副本里改 ROLE_REQUIRED 加一个不存在的字段，检查器必须立刻报出来。
  const dir = mkdtempSync(join(tmpdir(), 'wc-drift-'));
  cpSync(join(ROOT, 'framework'), join(dir, 'framework'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  const src = readFileSync(join(HERE, 'check-payload.mjs'), 'utf8')
    .replace("fix: ['files_touched'],", "fix: ['files_touched', 'brand_new_field_zzz'],");
  writeFileSync(join(dir, 'tools', 'check-payload.mjs'), src);
  cpSync(TOOL, join(dir, 'tools', 'check-wrapper-contract.mjs'));

  try {
    execFileSync(process.execPath, [join(dir, 'tools', 'check-wrapper-contract.mjs'), '--json'],
      { encoding: 'utf8', stdio: 'pipe' });
    expect('新增必填字段应导致失败', false, '竟然通过了');
  } catch (e) {
    const data = JSON.parse(e.stdout?.toString() ?? '{}');
    const hit = (data.problems ?? []).find((p) => p.field === 'brand_new_field_zzz');
    expect('新增必填字段被报出', !!hit, JSON.stringify(data.problems));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('case 8: wrapper 声称「只包含 N 个字段」且漏掉必填字段 → 必须报');
{
  // 2026-11-20：旧 fix-worker.md:76 写「payload 只包含四个字段」，漏掉 disposition。
  // 照它写产物 → check-payload 报 missing_disposition，而 wrapper 又要求
  // 「写完自检、非 0 不返回」——Agent 无法自救。
  // 关键：ROLE_REQUIRED.fix 里只有 files_touched，只查「字段出现过」的老判据会报
  // 「强覆盖 1/1，全部通过」。必须把条件必填的 disposition 并进来。
  const r = runAgainst((wr) => {
    const p = join(wr, 'fix-worker.md');
    const t = readFileSync(p, 'utf8');
    writeFileSync(p, '顶层信封 `role` 必须为 `"fix"`。`payload` 只包含四个字段：'
      + '`files_touched`、`verification_commands`、`affected_issues`、`residual_risks`。\n');
  });
  const hit = (r.data?.problems ?? []).some((p) => p.kind === 'exclusive_field_claim' && p.role === 'fix');
  expect('报 exclusive_field_claim', hit, JSON.stringify((r.data?.problems ?? []).map((p) => p.kind)));
}

console.log('case 9: wrapper 说「findings: [] 是一个结论」→ 必须报（与契约相反）');
{
  const r = runAgainst((wr) => {
    const p = join(wr, 'audit-specialist.md');
    writeFileSync(p, '顶层信封 `role` 必须为 `"audit"`。\n\n'
      + '- **`findings`**：即使一条都没找到，也要写 `"findings": []`。空数组是一个结论（「本切片无缺陷」）。\n');
  });
  const hit = (r.data?.problems ?? []).some((p) => p.kind === 'contradicts_contract' && p.role === 'audit');
  expect('报 contradicts_contract', hit, JSON.stringify((r.data?.problems ?? []).map((p) => p.kind)));
}

console.log('case 10: 修正说明块里的引文不得被当成现行规则（防「修完还是红的」）');
{
  // 本工具第一版踩的坑：勘误注释逐字引用被推翻的旧原文，检查器读全文
  // 就把引文当规则，于是修好之后仍然报错。
  const r = runAgainst((wr) => {
    const p = join(wr, 'fix-worker.md');
    const t = readFileSync(p, 'utf8');
    writeFileSync(p, t + '\n> **2026-11-20 修正**：本节此前写的是「`payload` 只包含四个字段：'
      + '`files_touched`、`verification_commands`、`affected_issues`、`residual_risks`」。\n');
  });
  const hit = (r.data?.problems ?? []).some((p) => p.kind === 'exclusive_field_claim');
  expect('勘误引文不产生 exclusive_field_claim', !hit, JSON.stringify((r.data?.problems ?? []).map((p) => p.kind)));
}

console.log('case 11: wrapper 文件整个缺失 → 必须报 wrapper_missing');
{
  // 2026-11-21 变异测试：M4（丢掉第一处 problems.push）存活，
  // 说明 `wrapper_missing` 与 `no_wrapper_mapping` 这两条从没被测过。
  // 它们正是「角色有要求但文件不在」的路径——wrapper 被误删时唯一的信号。
  const r = runAgainst((wr) => {
    rmSync(join(wr, 'verifier.md'), { force: true });
  });
  const hit = (r.data?.problems ?? []).some((p) => p.kind === 'wrapper_missing');
  expect('报 wrapper_missing', hit, JSON.stringify((r.data?.problems ?? []).map((p) => p.kind)));
}

console.log('case 12: 人类可读分支：有问题时也必须 exit 1');
{
  // 与 check-contract-* 同型：两套独立退出路径，测试只走 --json。
  // 人手动敲 `node tools/check-wrapper-contract.mjs` 时走的是另一条。
  const dir = mkdtempSync(join(tmpdir(), 'wc-human-'));
  cpSync(join(ROOT, 'framework'), join(dir, 'framework'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(join(HERE, 'check-payload.mjs'), join(dir, 'tools', 'check-payload.mjs'));
  cpSync(TOOL, join(dir, 'tools', 'check-wrapper-contract.mjs'));
  rmSync(join(dir, 'framework', 'wrappers', 'verifier.md'), { force: true });

  let code = 0, out = '';
  try {
    out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-wrapper-contract.mjs')],   // 不加 --json
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status ?? 1; out = e.stdout?.toString() ?? ''; }
  expect('exit 1（不是 0）', code === 1, `code=${code}`);
  expect('确实报出了问题', /问题/.test(out), out.slice(-200));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 13: 校验器新增了角色但映射表没跟上 → 必须报 no_wrapper_mapping');
{
  // 2026-11-21 变异测试：M4（丢掉第一处 problems.push，即 no_wrapper_mapping）存活。
  // 这条路径要造出来：/  check-payload 的 ROLE_REQUIRED 里多一个角色，
  // 而 check-wrapper-contract 的 ROLE_WRAPPER 映射表里没有它。
  //
  // 这是真实会发生的：给校验器加一个新角色，忘了在 wrapper 侧建文件。
  const dir = mkdtempSync(join(tmpdir(), 'wc-nomap-'));
  cpSync(join(ROOT, 'framework'), join(dir, 'framework'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-wrapper-contract.mjs'));

  // 造一个含新角色 `newrole` 的 check-payload（映射表里没有它）
  const payload = readFileSync(join(HERE, 'check-payload.mjs'), 'utf8').replace(
    /const ROLE_REQUIRED = \{/,
    'const ROLE_REQUIRED = {\n  newrole: [\'x\'],');
  writeFileSync(join(dir, 'tools', 'check-payload.mjs'), payload);

  let code = 0, out = '';
  try {
    out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-wrapper-contract.mjs'), '--json'],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status ?? 1; out = e.stdout?.toString() ?? ''; }
  let data = null;
  try { data = JSON.parse(out); } catch { /* ignore */ }
  const hit = (data?.problems ?? []).some((p) => p.kind === 'no_wrapper_mapping');
  expect('报 no_wrapper_mapping', hit, JSON.stringify((data?.problems ?? []).map((p) => p.kind)));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
