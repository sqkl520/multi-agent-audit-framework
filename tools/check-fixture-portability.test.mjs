// check-fixture-portability 自测
//
// 这条检查的由来：contract-probe 的 18 份探针把**建库那台机器**的盘符写进了
// `artifact_path`，于是 Windows 19/19、Linux/CI 17/19，而 runner 结尾是
// `process.exit(0)`——CI 稳定打「2 个不符」，check-all 仍然全绿。
//
// 所以这里要防的是两件事：
//   1. 新夹具又写死本机路径（检查器本身能抓到）
//   2. 检查器**误报**：注释里的历史说明、<FRAMEWORK_ROOT> 占位、
//      real-artifacts 里的真实证据，都不该被拦——
//      误报率高的检查第一天就会被关掉。
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-fixture-portability.mjs');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });

/** 造一个最小 git 仓库，带上被跟踪的夹具 */
function mk(fixtures) {
  const dir = mkdtempSync(join(tmpdir(), 'fp-'));
  mkdirSync(join(dir, 'tools', 'fixtures'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-fixture-portability.mjs'));
  for (const [rel, body] of Object.entries(fixtures)) {
    const abs = join(dir, 'tools', 'fixtures', rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t.local');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  return dir;
}

function run(dir) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-fixture-portability.mjs'), '--json'], { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out }; }
  }
}

console.log('\n=== check-fixture-portability 自测 ===\n');
const dirs = [];
const mk2 = (f) => { const d = mk(f); dirs.push(d); return d; };

console.log('case 1: 相对 artifact_path → 通过');
{
  const d = mk2({ 'probe/A1.md': '{\n  "artifact_path": "A1.md"\n}\n' });
  const r = run(d);
  expect('exit 0', r.code === 0, `实际 ${r.code}: ${r.raw ?? ''}`);
  expect('problems 为空', r.data?.problems?.length === 0, JSON.stringify(r.data));
}

console.log('case 2: Windows 盘符绝对路径 → 报 windows_abs');
{
  const d = mk2({ 'probe/A2.md': '{\n  "artifact_path": "D:\\\\Projects\\\\x\\\\probe/A2.md"\n}\n' });
  const r = run(d);
  expect('exit 1', r.code === 1, `实际 ${r.code}`);
  expect('命中 windows_abs', r.data?.problems?.some((p) => p.kind === 'windows_abs'),
    JSON.stringify(r.data?.problems));
}

console.log('case 3: POSIX 绝对路径（/mnt/d）→ 报 posix_abs');
{
  const d = mk2({ 'probe/A3.md': '{\n  "artifact_path": "/mnt/d/projects/x/probe/A3.md"\n}\n' });
  const r = run(d);
  expect('exit 1', r.code === 1, `实际 ${r.code}`);
  expect('命中 posix_abs', r.data?.problems?.some((p) => p.kind === 'posix_abs'),
    JSON.stringify(r.data?.problems));
}

console.log('case 4: .mjs 注释里的历史说明（D:\\Projects\\...）→ 不报');
{
  // 这正是 gen.mjs 修完后保留的那种注释：说「原先写的是 D:\...」。有价值，不能拦。
  const d = mk2({ 'gen.mjs': '// 原先写的是 D:\\\\Projects\\\\x\nconst a = 1;\n' });
  const r = run(d);
  expect('exit 0', r.code === 0, `${r.code}: ${JSON.stringify(r.data?.problems)}`);
}

console.log('case 5: .mjs 代码行里的写死路径 → 报');
{
  const d = mk2({ 'gen.mjs': 'const p = "D:\\\\Projects\\\\x\\\\a.md";\n' });
  const r = run(d);
  expect('exit 1', r.code === 1, `实际 ${r.code}`);
}

console.log('case 6: <FRAMEWORK_ROOT> 占位 → 通过，且计入 placeholders');
{
  const d = mk2({ 'arts2/honest.md': '{\n  "artifact_path": "<FRAMEWORK_ROOT>/tools/fixtures/x.md"\n}\n' });
  const r = run(d);
  expect('exit 0', r.code === 0, `实际 ${r.code}`);
  expect('placeholders 记到 1 条', r.data?.placeholders?.length === 1, JSON.stringify(r.data?.placeholders));
}

console.log('case 7: real-artifacts 里的真实证据路径 → 不报（那是记录不是夹具）');
{
  // 同时放一份正常夹具：否则分母为 0 会走 case 8 的 exit 2 分支，
  // 测到的就不是「排除生效」而是「没有夹具」。
  const d = mk2({
    'probe/A1.md': '{\n  "artifact_path": "A1.md"\n}\n',
    'real-artifacts/round1.md': 'node "D:/Projects/x/tools/a.mjs"\n',
  });
  const r = run(d);
  expect('exit 0', r.code === 0, `${r.code}: ${JSON.stringify(r.data?.problems)}`);
  expect('没有把 real-artifacts 算成问题', r.data?.problems?.length === 0,
    JSON.stringify(r.data?.problems));
}

console.log('case 8: 一份夹具都没有 → exit 2（分母为 0 不能算通过）');
{
  const dir = mkdtempSync(join(tmpdir(), 'fp0-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'tools', 'fixtures'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-fixture-portability.mjs'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t.local');
  git(dir, 'config', 'user.name', 't');
  writeFileSync(join(dir, 'README.md'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init');
  const r = run(dir);
  expect('exit 2', r.code === 2, `实际 ${r.code}`);
  expect('说明分母为 0', r.data?.error === 'no_fixtures_found', JSON.stringify(r.data));
}

console.log('case 9: 不是 git 仓库 → exit 2（无法确定哪些被跟踪）');
{
  const dir = mkdtempSync(join(tmpdir(), 'fpn-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-fixture-portability.mjs'));
  const r = run(dir);
  expect('exit 2', r.code === 2, `实际 ${r.code}`);
  expect('说明原因', r.data?.error === 'not_a_git_repo', JSON.stringify(r.data));
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
