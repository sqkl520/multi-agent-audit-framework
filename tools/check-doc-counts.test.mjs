// check-doc-counts 自测
//
// 这个工具最值得测的不是"能过"，而是"过期数字会不会被放过"。
// case 2 直接复刻本仓库历史上真实发生过的 8.9% 陈旧数字。
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-doc-counts.mjs');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** 造一个最小仓库：tools/check-all.mjs（N 个套件）+ docs */
function mk(nSuites, docs) {
  const dir = mkdtempSync(join(tmpdir(), 'dc-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'i18n'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-doc-counts.mjs'));

  // 造一个含 N 个套件的 check-all.mjs
  //
  // 2026-11-25：条目名必须带 `.test.mjs`。N1 现在区分两个口径——
  // 「N 个自测套件」对 .test.mjs 的数量，「N 个校验套件」对全部条目数——
  // 造 `t0.mjs` 会让自测数恒为 0，用例就测不到真的判据了。
  const entries = Array.from({ length: nSuites }, (_, i) => `  { script: 't${i}.test.mjs' },`).join('\n');
  writeFileSync(join(dir, 'tools', 'check-all.mjs'), `const CHECKS = [\n${entries}\n];\n`);
  // 造一个最小 ledger（本工具会调它拿出口率）
  writeFileSync(join(dir, 'tools', 'check-rule-ledger.mjs'), `
const rows = [
  { has_exit: true, exits: ['script:a'] },
  { has_exit: true, exits: ['rule:b'] },
  { has_exit: true, exits: ['artifact:x.md'] },
  { has_exit: false, exits: [] },
];
const withExit = rows.filter(r => r.has_exit).length;
console.log(JSON.stringify({
  rule_sentences: rows.length,
  with_exit: withExit,
  exit_rate_pct: Number((withExit / rows.length * 100).toFixed(1)),
  rows,
}));
`);

  for (const [name, body] of Object.entries(docs)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

function run(dir) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-doc-counts.mjs'), '--json'], { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out, err: e.stderr?.toString() }; }
  }
}

console.log('\n=== check-doc-counts 自测 ===\n');

console.log('case 1: 文档数字与代码一致 → 通过');
{
  // 4 个套件；出口率 = 3/4 = 75%（宽），严格 = 2/4 = 50%
  const dir = mk(4, {
    'README.md': '# T\n\n共 4 个自测套件。出口率 75%（严格口径 50%）。\n',
  });
  const r = run(dir);
  expect('exit 0', r.code === 0, JSON.stringify(r.data?.problems));
  expect('抽到了数字', (r.data?.numbers_checked ?? 0) > 0, `n=${r.data?.numbers_checked}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 2: 过期数字（复刻真实的 8.9%）→ 必须报');
{
  const dir = mk(4, {
    'README.md': '# T\n\n共 4 个自测套件。出口率 8.9%。\n',
  });
  const r = run(dir);
  expect('exit 1', r.code === 1, `code=${r.code}`);
  const hit = (r.data?.problems ?? []).some((p) => p.id === 'N2');
  expect('报 N2（出口率过期）', hit, JSON.stringify((r.data?.problems ?? []).map((p) => p.id)));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 3: 套件数写错 → 必须报');
{
  const dir = mk(4, {
    'README.md': '# T\n\n共 40 个自测套件。\n',
  });
  const r = run(dir);
  expect('exit 1', r.code === 1, `code=${r.code}`);
  const hit = (r.data?.problems ?? []).some((p) => p.id === 'N1');
  expect('报 N1', hit, JSON.stringify((r.data?.problems ?? []).map((p) => p.id)));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 4: 两种口径的值都接受（不硬猜口径）');
{
  // 这是本工具刻意放宽的地方：分辨不出「把严格口径的数写成宽口径的标签」，
  // 但两种值本身都是工具诚实输出，只要等于其中之一就算没过期。
  const dir = mk(4, {
    'README.md': '# T\n\n共 4 个自测套件。出口率 75%。严格口径 50%。\n',
  });
  const r = run(dir);
  expect('exit 0', r.code === 0, JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 5: 英文写法 "N self-test suites" 也要查');
{
  const dir = mk(4, {
    'README.en.md': '# T\n\nThis runs 40 self-test suites. Exit rate 75%.\n',
  });
  const r = run(dir);
  const hit = (r.data?.problems ?? []).some((p) => p.id === 'N1' && /README\.en\.md/.test(p.doc));
  expect('报英文文档的 N1', hit, JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 6: 一条数字都抽不到 → exit 2（分母为 0 不等于通过）');
{
  const dir = mk(4, { 'README.md': '# 没有任何数字的文档\n' });
  let code = 0, stderr = '';
  try {
    execFileSync(process.execPath, [join(dir, 'tools', 'check-doc-counts.mjs'), '--json'],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; stderr = e.stderr?.toString() ?? ''; }
  expect('exit 2', code === 2, `code=${code}`);
  expect('说明分母为 0', /一条数字都没抽到/.test(stderr), stderr.slice(0, 150));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 7: 同一指标多处出现，只报错的那一处');
{
  const dir = mk(4, {
    'README.md': '# T\n\n共 4 个自测套件。\n\n| 校验器 | 4 个自测套件 |\n\n机械校验套件（40 个）|\n',
  });
  const r = run(dir);
  const n1 = (r.data?.problems ?? []).filter((p) => p.id === 'N1');
  expect('只报那处错的（1 条）', n1.length === 1, JSON.stringify(n1));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 8: 「N 项检查」这类写法必须被扫（2026-11-26 补的正则）');
{
  // mk(59) 造的是 59 个 .test.mjs，所以自测数与条目数同为 59。
  const dir = mk(59, { 'README.md': '# T\n\n共 59 项检查。\n' });
  const r = run(dir);
  expect('正确值放行', r.code === 0, JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}
{
  const dir = mk(59, { 'README.md': '# T\n\n共 999 项检查。\n' });
  const r = run(dir);
  expect('错值报 N1', (r.data?.problems ?? []).some((p) => p.id === 'N1'), JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 9: HISTORICAL 只看命中所在行——当前进度表里的日期不得把数字也跳过');
{
  // 验收实测：第一版用前后 120 字窗判历史，于是「## 当前进度 / 最后更新：2026-11-18 /
  // | 机械校验（59 项） |」这张**表里的现值**被整行跳过；CAPABILITIES 的「适用版本」同理。
  const dir = mk(59, {
    'README.md': '# T\n\n## 当前进度\n\n> 最后更新：2026-11-18\n\n| 机械校验（999 项） | ✅ |\n',
  });
  const r = run(dir);
  expect('当前进度表里的错值必须报', (r.data?.problems ?? []).some((p) => p.id === 'N1'),
    JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 10: 真正的历史行（0 误拦 / 那 7 条修复）不得被报');
{
  // 加一行现在的正确值，保证「抽出数字 > 0」——否则整份文档全是历史行时
  // 分母为 0 会走 exit 2，测到的就不是「历史行被跳过」而是「没有数字」。
  const dir = mk(59, {
    'README.md': '# T\n\n共 59 项检查。\n\n| 机械闸门 | 57 项检查，0 误拦 |\n\n2026-11-16 那 7 条修复，57 项检查全绿。\n',
  });
  const r = run(dir);
  expect('历史行不报（只有现值的 59 被计入）', r.code === 0, JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
