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

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
