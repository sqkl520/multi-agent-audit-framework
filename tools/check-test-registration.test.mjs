// check-test-registration 自测
//
// 这个检查器是「接线」这件事的把关者，它自己失灵 = 所有接线缺口重新隐形。
// R4（2026-11-24 补）测的是最容易复发的那一类：
// 校验器写好了、自测也写了、CI 全绿，但**校验器本人从没对着真实输入跑过**。
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-test-registration.mjs');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

const dirs = [];

/**
 * 造一个最小仓库。
 * @param {object} o
 *   registered   check-all 里登记的 script 列表（首项写进文件即可）
 *   tools        { 'name.mjs': 源码, 'name.test.mjs': 源码 }
 *   ciRuns       CI workflow 里 `node tools/xxx.mjs` 的脚本名列表
 */
function mk({ registered = [], tools = {}, ciRuns = [], ciExtra = '' }) {
  const dir = mkdtempSync(join(tmpdir(), 'tr-'));
  dirs.push(dir);
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-test-registration.mjs'));
  // 2026-11-25：R4 现在走 lib/code-scan.mjs（去注释 + 完整文件名匹配）。
  // 只拷工具本身会让它在临时目录里 import 失败，自测全红——
  // 而那不是判据坏了，是夹具缺文件。
  cpSync(join(HERE, 'lib'), join(dir, 'tools', 'lib'), { recursive: true });

  for (const [rel, body] of Object.entries(tools)) {
    writeFileSync(join(dir, 'tools', rel), body);
  }
  const entries = registered.map((s) => `  { script: '${s}', desc: 'x' },`).join('\n');
  writeFileSync(join(dir, 'tools', 'check-all.mjs'), `const CHECKS = [\n${entries}\n];\n`);

  if (ciRuns.length > 0 || ciExtra) {
    mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
    const lines = ciRuns.map((s) => `        run: node tools/${s}`).join('\n');
    writeFileSync(join(dir, '.github', 'workflows', 'checks.yml'), `steps:\n${lines}\n${ciExtra}`);
  }
  return dir;
}

function run(dir) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-test-registration.mjs'), '--json'], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status ?? 1, data: JSON.parse(out) }; }
    catch { return { code: e.status ?? 1, data: null, raw: out + (e.stderr ?? '') }; }
  }
}

const okIds = (r) => (r.data?.problems ?? []).map((p) => p.id);

console.log('\n=== check-test-registration 自测 ===\n');

console.log('case 1: 全部接线（check-repo 收录 + 自测已注册）→ exit 0');
{
  const d = mk({
    registered: ['check-all.mjs', 'fake.test.mjs', 'check-repo.mjs'],
    tools: {
      'fake.mjs': 'process.exit(0);\n',
      'fake.test.mjs': 'process.exit(0);\n',
      'check-repo.mjs': "const TARGETS = [{ script: 'fake.mjs' }]; const SKIPPED = [];\n",
    },
  });
  const r = run(d);
  expect('exit 0', r.code === 0, `${r.code}: ${JSON.stringify(r.data?.problems)}`);
  expect('problems 为空', (r.data?.problems ?? []).length === 0, JSON.stringify(r.data?.problems));
}

console.log('case 2: 测试文件没注册 → R1');
{
  const d = mk({
    registered: ['check-all.mjs', 'check-repo.mjs'],
    tools: {
      'fake.mjs': 'process.exit(0);\n',
      'fake.test.mjs': 'process.exit(0);\n',
      'check-repo.mjs': "const TARGETS = [{ script: 'fake.mjs' }]; const SKIPPED = [];\n",
    },
  });
  const r = run(d);
  expect('exit 1', r.code === 1, `实际 ${r.code}`);
  expect('报 R1', okIds(r).includes('R1'), JSON.stringify(r.data?.problems));
}

console.log('case 3: 有自测、但校验器没有任何真实调用路径 → R4');
{
  // fake.mjs 有自测、自测已注册，但既不在 check-repo 里，也没被别的工具引用。
  // 这正是 check-fixture-portability 2026-11-24 之前的处境。
  const d = mk({
    registered: ['check-all.mjs', 'fake.test.mjs', 'check-repo.mjs'],
    tools: {
      'fake.mjs': 'process.exit(0);\n',
      'fake.test.mjs': 'process.exit(0);\n',
      'check-repo.mjs': 'const TARGETS = []; const SKIPPED = [];\n',
    },
  });
  const r = run(d);
  expect('exit 1', r.code === 1, `实际 ${r.code}`);
  expect('报 R4 且点名 fake.mjs', (r.data?.problems ?? []).some((p) => p.id === 'R4' && p.file === 'fake.mjs'),
    JSON.stringify(r.data?.problems));
}

console.log('case 4: 被另一个非 test 工具引用 → R4 放行');
{
  const d = mk({
    registered: ['check-all.mjs', 'fake.test.mjs', 'user.mjs', 'check-repo.mjs'],
    tools: {
      'fake.mjs': 'process.exit(0);\n',
      'fake.test.mjs': 'process.exit(0);\n',
      'user.mjs': "execFileSync('node', ['fake.mjs']);\n",
      'check-repo.mjs': 'const TARGETS = []; const SKIPPED = [];\n',
    },
  });
  const r = run(d);
  expect('没有 R4', !okIds(r).includes('R4'), JSON.stringify(r.data?.problems));
}

console.log('case 4b: 只在**注释里**提到（不是代码引用）→ 仍报 R4');
{
  // 2026-11-25 锐评实测：旧判据是裸子串，注释里提到就算接线——
  // check-contract-slices 与 check-suite-vitality 就是这样被误判成绿的。
  const d = mk({
    registered: ['check-all.mjs', 'fake.test.mjs', 'user.mjs', 'check-repo.mjs'],
    tools: {
      'fake.mjs': 'process.exit(0);\n',
      'fake.test.mjs': 'process.exit(0);\n',
      'user.mjs': '// 说明：与 fake.mjs 的分工见下\nconst a = 1;\n',
      'check-repo.mjs': 'const TARGETS = []; const SKIPPED = [];\n',
    },
  });
  const r = run(d);
  expect('报 R4', (r.data?.problems ?? []).some((p) => p.id === 'R4' && p.file === 'fake.mjs'),
    JSON.stringify(r.data?.problems));
}

console.log('case 4c: 只在**注释掉的 CI 步骤**里出现 → 仍报 R4');
{
  const d = mk({
    registered: ['check-all.mjs', 'fake.test.mjs', 'check-repo.mjs'],
    tools: {
      'fake.mjs': 'process.exit(0);\n',
      'fake.test.mjs': 'process.exit(0);\n',
      'check-repo.mjs': 'const TARGETS = []; const SKIPPED = [];\n',
    },
    ciRuns: [],
    ciExtra: '      # disabled: node tools/fake.mjs\n',
  });
  const r = run(d);
  expect('报 R4', (r.data?.problems ?? []).some((p) => p.id === 'R4' && p.file === 'fake.mjs'),
    JSON.stringify(r.data?.problems));
}

console.log('case 5: 只在 CI workflow 里跑 → 也算真实调用路径（防误报）');
{
  // 2026-11-24 实测：check-bilingual-links / check-commit-msg 是这类，
  // 第一版 R4 把它们误报成「只在自测里」。
  const d = mk({
    registered: ['check-all.mjs', 'fake.test.mjs', 'check-repo.mjs'],
    tools: {
      'fake.mjs': 'process.exit(0);\n',
      'fake.test.mjs': 'process.exit(0);\n',
      'check-repo.mjs': 'const TARGETS = []; const SKIPPED = [];\n',
    },
    ciRuns: ['fake.mjs'],
  });
  const r = run(d);
  expect('没有 R4', !okIds(r).includes('R4'), JSON.stringify(r.data?.problems));
}

console.log('case 6: check-repo.mjs 存在却没注册 → R4 点名它本身');
{
  const d = mk({
    registered: ['check-all.mjs', 'fake.test.mjs'],
    tools: {
      'fake.mjs': 'process.exit(0);\n',
      'fake.test.mjs': 'process.exit(0);\n',
      'check-repo.mjs': "const TARGETS = [{ script: 'fake.mjs' }]; const SKIPPED = [];\n",
    },
  });
  const r = run(d);
  expect('exit 1', r.code === 1, `实际 ${r.code}`);
  expect('R4 点名 check-repo.mjs', (r.data?.problems ?? []).some((p) => p.id === 'R4' && p.file === 'check-repo.mjs'),
    JSON.stringify(r.data?.problems));
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
