// check-doc-paths 自测
//
// 重点是 case 3-6：第一版判据抽出 13 条"断链"，逐个看全是误报
// （带行号的引用、模板占位符、跨仓库引用）。误报率高的检查第一天就会被关掉，
// 所以这几条防回归很重要。
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-doc-paths.mjs');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

function run(dir) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-doc-paths.mjs'), '--json'], { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out, err: e.stderr?.toString() }; }
  }
}

/** 造一个最小仓库：tools/ + framework/ + docs/ */
function mk(docs = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dp-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'framework'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'analysis'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-doc-paths.mjs'));
  writeFileSync(join(dir, 'framework', 'real.md'), '# real\n');
  writeFileSync(join(dir, 'tools', 'real.mjs'), '// real\n');
  for (const [name, body] of Object.entries(docs)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

console.log('\n=== check-doc-paths 自测 ===\n');

console.log('case 1: 真实存在的路径 → 通过');
{
  const dir = mk({
    'README.md': '# T\n\n见 `framework/real.md` 与 `tools/real.mjs`。\n',
  });
  const r = run(dir);
  expect('exit 0', r.code === 0, JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 2: 不存在的路径 → 必须报');
{
  const dir = mk({
    'README.md': '# T\n\n见 `framework/does-not-exist.md`。\n',
  });
  const r = run(dir);
  expect('exit 1', r.code === 1, `code=${r.code}`);
  expect('报出断链', (r.data?.problems ?? []).some((p) => /does-not-exist/.test(p.target)),
    JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 3: 带行号的引用 `file.md:185` 不得误判（行号不是路径）');
{
  const dir = mk({
    'README.md': '# T\n\n见 `framework/real.md:185` 与 `framework/real.md:53-54`。\n',
  });
  const r = run(dir);
  expect('不报断链', (r.data?.problems ?? []).length === 0,
    JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 4: 模板占位符 `round{N}/` 不得误判');
{
  // 关键：必须**同时**有一条真引用，否则分母为 0 时工具会 exit 2，
  // 那也是"没通过"而不是"判据正确"——测不出想测的东西。
  const dir = mk({
    'README.md': '# T\n\n报告写在 `docs/reports/round{N}/` 下，契约见 `framework/real.md`。\n',
  });
  const r = run(dir);
  expect('工具确实跑了（分母 > 0）', (r.data?.refs ?? 0) > 0, `refs=${r.data?.refs}`);
  expect('不报断链', (r.data?.problems ?? []).length === 0,
    JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 5: 目录提示 `docs/reports/round1/` 父目录存在即放行');
{
  const dir = mk({
    'README.md': '# T\n\n放在 `docs/analysis/x/` 下（目录还没建）。\n',
  });
  const r = run(dir);
  // docs/analysis 存在但 docs/analysis/x 不存在；以 / 结尾视为"放这里"，父目录在就行
  expect('不报断链', (r.data?.problems ?? []).length === 0,
    JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 6: 跨仓库引用不得误判（同一行有别的盘符路径）');
{
  // 复刻真实误报：docs/analysis/xxx.md:3 里提到另一个项目的 DEV-PLAN.md。
  // 同样要配一条真引用，否则分母为 0 测不出判据。
  const dir = mk({
    'docs/analysis/diag.md': '# 诊断\n\n> 依据：该项目 `D:\\Projects\\other-repo` 的 `docs/DEV-PLAN.md` §3。\n\n另见 `framework/real.md`。\n',
  });
  const r = run(dir);
  expect('工具确实跑了（分母 > 0）', (r.data?.refs ?? 0) > 0, `refs=${r.data?.refs}`);
  expect('不报断链', (r.data?.problems ?? []).length === 0,
    JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 7: 通配符 `framework/*.md` 至少匹配一个文件即通过');
{
  const dir = mk({
    'README.md': '# T\n\n规则在 `framework/*.md` 里。\n',
  });
  const r = run(dir);
  expect('不报断链', (r.data?.problems ?? []).length === 0,
    JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 8: 通配符匹配不到任何文件 → 必须报');
{
  const dir = mk({
    'README.md': '# T\n\n规则在 `framework/*.nonexistent` 里。\n',
  });
  const r = run(dir);
  expect('报断链', (r.data?.problems ?? []).length > 0,
    JSON.stringify(r.data?.problems));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 9: 分母为 0（一个引用都抽不到）→ exit 2');
{
  const dir = mk({ 'README.md': '# 没有任何路径引用\n' });
  let code = 0, stderr = '';
  try {
    execFileSync(process.execPath, [join(dir, 'tools', 'check-doc-paths.mjs'), '--json'],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; stderr = e.stderr?.toString() ?? ''; }
  expect('exit 2', code === 2, `code=${code}`);
  expect('说明分母为 0', /分母为 0|一条仓库内路径引用都没抽到/.test(stderr), stderr.slice(0, 150));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 10: 文档声称「已在 .gitignore 里拦住」→ 配置必须真的兑现');
{
  // 2026-11-22 实测：README:99 让读者把运行产物写在 `.work/`、`logs/` 下，
  // 并说这些「已在 .gitignore 里拦住」——而 `.work/` 和 `logs/` 根本没被忽略。
  // 一次 `git add -A` 就把运行产物扫进公开仓库，这个坑 2026-11-17 已踩过一次。
  //
  // 两个方向都要测：
  //   ① 声称了且真的被忽略 → 通过
  //   ② 声称了但没被忽略   → 必须报
  const mkGit = (gitignore) => {
    const dir = mk({
      'README.md': '# T\n\n产物写在 `.work/` 下——`.work/`、`.run-*/` 已在 `.gitignore` 里拦住。\n'
        + '\n见 `framework/real.md`。\n',
      '.gitignore': gitignore,
    });
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    return dir;
  };

  const good = mkGit('.work/\n.run-*/\n');
  const rGood = run(good);
  expect('声称且真被忽略 → 不报 P3',
    !(rGood.data?.problems ?? []).some((p) => p.id === 'P3'),
    JSON.stringify(rGood.data?.problems));
  rmSync(good, { recursive: true, force: true });

  const bad = mkGit('.run-*/\n');   // 漏了 .work/
  const rBad = run(bad);
  const p3 = (rBad.data?.problems ?? []).filter((p) => p.id === 'P3');
  expect('声称但没被忽略 → 必须报 P3', p3.length > 0, JSON.stringify(rBad.data?.problems));
  expect('报告里点出是哪个目录', p3.some((p) => String(p.target).includes('.work')), JSON.stringify(p3));
  rmSync(bad, { recursive: true, force: true });
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);