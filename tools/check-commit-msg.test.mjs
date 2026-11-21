// check-commit-msg 自测
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-commit-msg.mjs');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

/** 用 --msg 直接验单条，不依赖 git */
function check(msg) {
  try {
    const out = execFileSync(process.execPath, [TOOL, '--msg', msg, '--json'], { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out }; }
  }
}

console.log('\n=== check-commit-msg 自测 ===\n');

console.log('case 1: 七种合法 type 全部放行');
for (const t of ['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'perf']) {
  const r = check(`${t}: 做了一件事`);
  expect(`${t} 放行`, r.code === 0, JSON.stringify(r.data?.problem));
}

console.log('case 2: 带 scope 也放行');
{
  const r = check('fix(r45): 保留用户的 provider 配置');
  expect('fix(scope) 放行', r.code === 0, JSON.stringify(r.data?.problem));
}

console.log('case 3: 自创 type 必须被抓（本仓库历史上真实出现过的）');
for (const t of ['cleanup', 'correct', 'diagnosis', 'probe', 'verdict']) {
  const r = check(`${t}: 某件事`);
  expect(`${t} 被抓`, r.code === 1 && r.data?.problem?.id === 'M1',
    JSON.stringify(r.data?.problem));
}

console.log('case 4: revert 单独放行（Conventional Commits 的合法特殊形式）');
{
  const r = check('revert: 还原 bug_report.yml');
  expect('revert 放行', r.code === 0, JSON.stringify(r.data?.problem));
}

console.log('case 5: 缺冒号 → M2');
{
  const r = check('feat 没有冒号');
  expect('报 M2', r.data?.problem?.id === 'M2', JSON.stringify(r.data?.problem));
}

console.log('case 6: 有 type 没描述 → M3');
{
  const r = check('feat: ');
  expect('报 M3', r.data?.problem?.id === 'M3', JSON.stringify(r.data?.problem));
}

console.log('case 7: 描述只有标点 → M3');
{
  const r = check('fix: ...');
  expect('报 M3', r.data?.problem?.id === 'M3', JSON.stringify(r.data?.problem));
}

console.log('case 8: 空 message → M3');
{
  const r = check('');
  expect('报 M3', r.data?.problem?.id === 'M3', JSON.stringify(r.data?.problem));
}

console.log('case 9: 真实仓库最近一次提交应合规（本工具自己不许是脏的）');
{
  const r = check('feat: 中英双语互链检查 —— PROJECT-RULES 规则 6 要求的 CI 检查');
  expect('放行', r.code === 0, JSON.stringify(r.data?.problem));
}

console.log('case 10: --all 能扫到历史里的自创 type（应当抓到 ≥5 条）');
{
  // 在临时 git 仓库里造几条历史，验证 --all 确实会扫
  const dir = mkdtempSync(join(tmpdir(), 'cm-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-commit-msg.mjs'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  for (const [i, msg] of ['feat: 第一条改动', 'cleanup: 第二条改动', 'correct: 第三条改动', 'fix: 第四条改动'].entries()) {
    writeFileSync(join(dir, `f${i}.txt`), String(i));
    g('add', '-A');
    g('commit', '-q', '-m', msg);
  }
  let code = 0, out = '';
  try {
    out = execFileSync(process.execPath, [join(dir, 'tools', 'check-commit-msg.mjs'), '--all', '--json'],
      { encoding: 'utf8' });
  } catch (e) { code = e.status; out = e.stdout?.toString() ?? ''; }
  const data = JSON.parse(out);
  expect('exit 1', code === 1, `code=${code}`);
  expect('恰好抓到 2 条自创 type', data.violations?.length === 2, JSON.stringify(data.violations?.map((v) => v.problem.id)));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 11: 浅克隆（CI 默认）→ 不得 exit 2，降级为只查 HEAD');
{
  // 2026-11-21 CI 实红：actions/checkout 默认 fetch-depth: 1，
  // 历史里没有父提交，`git log HEAD~1..HEAD` 报 "ambiguous argument"。
  // 第一版把它当「配置错误」exit 2，于是 CI 直接失败。
  // **本地仓库有完整历史，本地怎么测都测不出来。**
  const src = mkdtempSync(join(tmpdir(), 'cm-src-'));
  const g0 = (...a) => execFileSync('git', a, { cwd: src, stdio: 'pipe' });
  g0('init', '-q');
  g0('config', 'user.email', 't@t');
  g0('config', 'user.name', 't');
  for (const [i, msg] of ['feat: 第一个提交', 'fix: 第二个提交'].entries()) {
    writeFileSync(join(src, `f${i}.txt`), String(i));
    g0('add', '-A');
    g0('commit', '-q', '-m', msg);
  }

  // 克隆成一个只有 1 个提交的浅仓库
  const shallow = mkdtempSync(join(tmpdir(), 'cm-shallow-'));
  rmSync(shallow, { recursive: true, force: true });
  execFileSync('git', ['clone', '-q', '--depth', '1', `file://${src.replace(/\\/g, '/')}`, shallow],
    { stdio: 'pipe' });

  mkdirSync(join(shallow, 'tools'), { recursive: true });
  cpSync(TOOL, join(shallow, 'tools', 'check-commit-msg.mjs'));

  let code = 0, out = '';
  try {
    out = execFileSync(process.execPath, [join(shallow, 'tools', 'check-commit-msg.mjs'), '--json'],
      { encoding: 'utf8' });
  } catch (e) { code = e.status; out = e.stdout?.toString() ?? ''; }
  // 关键：不能是 exit 2（配置错误），要么 0（HEAD 合规），要么 1（HEAD 不合规）
  expect('不得 exit 2', code !== 2, `code=${code}, out=${out.slice(0, 200)}`);
  const data = out ? JSON.parse(out) : null;
  expect('至少检查了 1 条（HEAD）', (data?.checked ?? 0) >= 1, `checked=${data?.checked}`);

  rmSync(shallow, { recursive: true, force: true });
  rmSync(src, { recursive: true, force: true });
}

console.log('case 12: 非 --json 的「人类可读」分支也要有正确退出码');
{
  // 2026-11-21 变异测试发现：把 `process.exit(1)` 改成 `process.exit(0)` 后，
  // 自测仍然全过。原因是一直只用 `--msg ... --json` 调用，
  // 而那条 exit(1) 在**非 json 的人类可读分支**里，从没被执行过。
  //
  // 这个盲区很典型：CI 与脚本都走 --json，人类可读分支平时没人跑，
  // 它坏了也不会有任何信号。但它正是 `pre-commit` 里手敲时用的那条路径。
  const runRaw = (args) => {
    try {
      const out = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8' });
      return { code: 0, out };
    } catch (e) { return { code: e.status, out: (e.stdout ?? '') + (e.stderr ?? '') }; }
  };

  const badHuman = runRaw(['--msg', 'cleanup: 自创 type']);
  expect('人类可读分支：不合规 → exit 1', badHuman.code === 1, `code=${badHuman.code}`);
  expect('人类可读分支：指出 M1', /M1/.test(badHuman.out), badHuman.out.slice(0, 150));

  const okHuman = runRaw(['--msg', 'fix: 修了一件事']);
  expect('人类可读分支：合规 → exit 0', okHuman.code === 0, `code=${okHuman.code}`);
  expect('人类可读分支：报合规', /格式合规/.test(okHuman.out), okHuman.out.slice(0, 150));
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
