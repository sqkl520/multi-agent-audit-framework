// check-suite-vitality 自测
//
// 这个工具本身也要能被验证——否则它可能"什么都没测就报绿"，
// 那正好是它要抓的那种病。
//
// 核心是 case 3：造一个**假校验器 + 假自测**，其中自测没断言退出码，
// 变异工具必须报 SURVIVED。如果它报 KILLED，说明它自己的判定是坏的。
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-suite-vitality.mjs');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

/**
 * 造一个最小仓库，含一个假校验器 + 假自测。
 * @param checkBody  校验器源码
 * @param testBody   自测源码（跑它时若校验器被改坏，它应当失败）
 */
function mk(checkBody, testBody) {
  const dir = mkdtempSync(join(tmpdir(), 'vit-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-suite-vitality.mjs'));
  cpSync(join(HERE, 'lib'), join(dir, 'tools', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'fakecheck.mjs'), checkBody);
  writeFileSync(join(dir, 'tools', 'fakecheck.test.mjs'), testBody);
  return dir;
}

function runVitality(dir, extra = []) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-suite-vitality.mjs'), '--json', ...extra],
      { encoding: 'utf8', timeout: 120000 });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out, err: e.stderr?.toString() }; }
  }
}

// 一个最小的"有判定逻辑"的校验器
const GOOD_CHECK = `
const problems = [];
problems.push({ kind: 'a' });
if (problems.length > 0) { console.log('有问题'); process.exit(1); }
console.log('通过');
`;

// 自测：**断言了校验器的退出码** → 变异会被抓到
//
// 2026-11-21 修正：第一版写成「校验器非 0 退出 → 自测 exit(1)」，
// 把语义搞反了。校验器 exit 1 表示"发现了问题"——那正是它的**正确行为**，
// 自测不该因此失败。
//
// 正确的断言是：这个校验器在有 problems 时**必须以 1 退出**。
// 变异把 exit(1) 改成 exit(0) 之后，自测发现"它居然 0 退出了" → 报错。
const GOOD_TEST = `
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = dirname(fileURLToPath(import.meta.url));
let code = 0;
try {
  execFileSync(process.execPath, [join(HERE, 'fakecheck.mjs')], { stdio: 'pipe' });
  code = 0;
} catch (e) { code = e.status ?? 1; }
if (code === 1) { console.log('正确：发现问题时 exit 1'); process.exit(0); }
console.log('错误：期望 exit 1，实际 ' + code); process.exit(1);
`;

// 自测：**不断言任何东西** → 永远通过，变异全部存活
const WEAK_TEST = `
console.log('我什么都没测');
process.exit(0);
`;

console.log('\n=== check-suite-vitality 自测 ===\n');

console.log('case 1: 自测断言了退出码 → 变异应全部被抓');
{
  const dir = mk(GOOD_CHECK, GOOD_TEST);
  const r = runVitality(dir);
  const survived = r.data?.survived ?? -1;
  expect('有存活变异=0', survived === 0, `survived=${survived}`);
  expect('exit 0', r.code === 0, `code=${r.code}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 2: 自测什么都不测 → 变异应存活（这就是它要抓的病）');
{
  const dir = mk(GOOD_CHECK, WEAK_TEST);
  const r = runVitality(dir);
  const survived = r.data?.survived ?? -1;
  expect('有存活变异 > 0', survived > 0, `survived=${survived}`);
  expect('exit 1', r.code === 1, `code=${r.code}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 3: 判定阈值被放大后自测仍过 → 必须报 SURVIVED');
{
  // 这个用例钉的是工具自己的判定：M3 把 problems.length > 0 改成 > 999999，
  // 校验器便永远走"通过"分支。若自测断言了退出码，它应当失败；
  // 若没断言，就是存活。
  const weak = `
console.log('不检查退出码');
process.exit(0);
`;
  const dir = mk(GOOD_CHECK, weak);
  const r = runVitality(dir);
  const m3 = (r.data?.results?.[0]?.detail ?? []).find((d) => d.mutator === 'M3-threshold-inflate');
  expect('M3 被判为存活', m3?.status === 'SURVIVED', JSON.stringify(m3));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 4: 没有自测的校验器被跳过（不报错）');
{
  const dir = mkdtempSync(join(tmpdir(), 'vit-none-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-suite-vitality.mjs'));
  cpSync(join(HERE, 'lib'), join(dir, 'tools', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'lonely.mjs'), 'console.log(1);');
  let code = 0, stderr = '';
  try {
    execFileSync(process.execPath, [join(dir, 'tools', 'check-suite-vitality.mjs'), '--json'],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; stderr = e.stderr?.toString() ?? ''; }
  expect('exit 2（没有可测对象 = 分母为 0）', code === 2, `code=${code}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 5: 生成器类（gen-*）被排除，不当成"该失败"的校验器');
{
  const dir = mkdtempSync(join(tmpdir(), 'vit-gen-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-suite-vitality.mjs'));
  cpSync(join(HERE, 'lib'), join(dir, 'tools', 'lib'), { recursive: true });
  writeFileSync(join(dir, 'tools', 'gen-thing.mjs'), GOOD_CHECK);
  writeFileSync(join(dir, 'tools', 'gen-thing.test.mjs'), WEAK_TEST);
  let code = 0;
  try {
    execFileSync(process.execPath, [join(dir, 'tools', 'check-suite-vitality.mjs'), '--json'],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; }
  // 生成器被排除 → 一个可测对象都没有 → exit 2
  expect('exit 2（gen-* 不计入）', code === 2, `code=${code}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 6: 变异只写临时副本，不碰工作区');
{
  // 2026-11-20 的真实事故：在工作区做变异，脚本超时被杀，
  // 框架文件停在变异状态，是靠批判 Agent 发现才还原的。
  const dir = mk(GOOD_CHECK, GOOD_TEST);
  const origSrc = execFileSync('node', ['-e',
    `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(dir, 'tools', 'fakecheck.mjs'))}, 'utf8'))`],
    { encoding: 'utf8' });
  runVitality(dir);
  const afterSrc = execFileSync('node', ['-e',
    `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(dir, 'tools', 'fakecheck.mjs'))}, 'utf8'))`],
    { encoding: 'utf8' });
  expect('原文件逐字节未变', origSrc === afterSrc);
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 7 (2026-11-26): 自测在未变异时就失败 → 报 BASELINE_RED，不算 KILLED');
{
  // 锐评实测：severity-consistency.test.mjs 依赖 experiments/fixture2，
  // 而 vitality 不拷 experiments/ → 自测在临时目录里**不施加任何变异就已经失败**，
  // 于是任何变异都被判 KILLED：仪表显示 killed:4/4，实际一条都没测过。
  //
  // 造一份「无论校验器怎样都会失败」的自测，验证它被归到 BASELINE_RED 而不是 KILLED。
  const ALWAYS_FAIL = `
process.exit(1);
`;
  const dir = mk(GOOD_CHECK, ALWAYS_FAIL);
  const r = runVitality(dir);
  const d = (r.data?.results?.[0]?.detail ?? []);
  const red = d.filter((x) => x.status === 'BASELINE_RED').length;
  expect('有 BASELINE_RED', red > 0, JSON.stringify(d.map((x) => `${x.mutator}:${x.status}`)));
  expect('killed 为 0（不能把基线红算成抓到）', (r.data?.killed ?? -1) === 0, `killed=${r.data?.killed}`);
  expect('exit 1（基线红也要让整个人工检查失败）', r.code === 1, `code=${r.code}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
