#!/usr/bin/env node
/**
 * check-contract-examples.test.mjs — 契约示例检查器自测
 *
 * 核心命题：**示例错了，比没有示例更糟。**
 *   wrapper 让 agent「照抄契约示例再改」。如果示例本身通不过校验器，
 *   agent 会陷入「我按文档写的却被拒」，而且没有任何提示说文档是错的。
 *
 * 这属于三层闭环之外的第 0 层：示例必须是真的。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TOOL = join(HERE, 'check-contract-examples.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

function withCopy(mutator, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ce-test-'));
  cpSync(join(ROOT, 'framework'), join(dir, 'framework'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  for (const f of ['check-contract-examples.mjs', 'check-payload.mjs']) {
    cpSync(join(HERE, f), join(dir, 'tools', f));
  }
  mutator(join(dir, 'framework', 'components', 'output-contract'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runIn(dir) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-contract-examples.mjs'), '--json'], { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out }; }
  }
}

console.log('\n=== 契约示例检查器自测 ===\n');

console.log('case 1: 真实仓库 7 份示例全部通过');
{
  try {
    const out = execFileSync(process.execPath, [TOOL], { encoding: 'utf8' });
    expect('退出码 0', true);
    expect('报告全部通过', /全部通过校验器/.test(out), out.slice(-200));
    expect('覆盖 7 个角色', /7 个完整信封示例/.test(out), out.match(/\d+ 个完整信封示例/)?.[0]);
  } catch (e) {
    expect('退出码 0', false, `实际 ${e.status}: ${e.stdout?.toString().slice(-300)}`);
  }
}

console.log('case 2: 示例被破坏（字段名改错）→ 必须拒绝');
{
  const r = withCopy((od) => {
    const p = join(od, 'examples', 'audit.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('"findings": [', '"findings_X": ['));
  }, runIn);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'example_file_rejected');
  expect('报 example_file_rejected', !!hit, JSON.stringify(r.data?.problems));
}

console.log('case 3: 缺某角色的示例文件 → 必须报出');
{
  const r = withCopy((od) => {
    rmSync(join(od, 'examples', 'verify.md'), { force: true });
  }, runIn);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'example_missing');
  expect('报 example_missing', !!hit, JSON.stringify(r.data?.problems));
  expect('指出是 verify', /verify/.test(hit?.detail ?? ''), hit?.detail);
}

console.log('case 4: 整个示例目录不见 → 必须报出（不能默默通过）');
{
  const r = withCopy((od) => {
    rmSync(join(od, 'examples'), { recursive: true, force: true });
  }, runIn);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'examples_dir_missing');
  expect('报 examples_dir_missing', !!hit, JSON.stringify(r.data?.problems));
}

console.log('case 5: 示例里 role 与文件不匹配 → 必须拒绝');
{
  const r = withCopy((od) => {
    const p = join(od, 'examples', 'fix.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('"role": "fix"', '"role": "audit"'));
  }, runIn);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
}

console.log('case 6: 示例缺必填字段 → 必须拒绝（这是示例最常犯的错）');
{
  // 注：artifact_path 的存在性用 --no-exists 跳过了（示例里是 <OUTDIR> 占位），
  // 所以这里改测另一类错误：删掉角色必填字段。这类错误如果混进示例，
  // agent 照抄就一定过不了校验。
  const r = withCopy((od) => {
    const p = join(od, 'examples', 'sweep.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/"lead_count": \d+/, '"lead_count_X": 1'));
  }, runIn);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'example_file_rejected');
  expect('报 example_file_rejected', !!hit, JSON.stringify(r.data?.problems));
  expect('规则名可读（不是只有「N 项违规」）',
    /\[[a-z_]+\]/.test(hit?.detail ?? ''), hit?.detail);
}

console.log('case 7: 示例的 artifact_path 用 <OUTDIR> 约定占位，不得写成本机路径');
{
  // 相对路径会随 cwd 变化（从 tools/ 跑就失效），绝对路径不可移植。
  // 示例必须用约定占位，否则「照抄示例」在不同运行环境下行为不同。
  const r = withCopy(() => {}, runIn);
  const results = r.data?.results ?? [];
  expect('示例全部通过（含占位路径）', results.every((x) => x.passes),
    JSON.stringify(results.filter((x) => !x.passes)));

  const ex = readFileSync(join(ROOT, 'framework', 'components', 'output-contract', 'examples', 'sweep.md'), 'utf8');
  expect('artifact_path 是 <OUTDIR> 占位', /"artifact_path": "<OUTDIR>/.test(ex),
    ex.match(/"artifact_path": "[^"]*"/)?.[0]);
  expect('不含盘符路径', !/"artifact_path": "[A-Za-z]:/.test(ex));
}

console.log('case 8: 生成器幂等 —— 重跑到临时目录，与仓库内示例逐字节一致');
{
  // 2026-11-14 补。示例是「第 0 层」（第 0 层 = 示例必须是真的）。
  // 若生成物可以被手改而无人发现，示例就会慢慢偏离契约——而这正是
  // CHECKOUT-INCIDENT 的同源风险（人工回退一次就丢）。
  // check-contract-slices.test.mjs 早就有这条断言，examples 这边一直缺。
  const tmp = mkdtempSync(join(tmpdir(), 'ce-idem-'));
  try {
    execFileSync(process.execPath,
      [join(HERE, 'gen-contract-examples.mjs'), '--out', tmp], { encoding: 'utf8', stdio: 'pipe' });
    const roles = ['planner', 'recon', 'sweep', 'audit', 'critique', 'fix', 'verify'];
    const diffs = [];
    for (const r of roles) {
      const a = readFileSync(join(ROOT, 'framework', 'components', 'output-contract', 'examples', `${r}.md`), 'utf8');
      const b = readFileSync(join(tmp, `${r}.md`), 'utf8');
      if (a !== b) diffs.push(r);
    }
    expect('7 份示例全部幂等', diffs.length === 0, `不一致: ${diffs.join(', ')}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
