// check-round-chain-live 自测
//
// 这个脚本 2026-11-25 之前**没有自测、没有用法守卫、也没有任何调用方**：
// 无参数时什么都不分析、直接 exit 0。`check-repo.mjs` 的 R1
//（「被标为需要运行时输入的脚本，无参数时必须 exit 2」）不得不为它开豁免，
// 而豁免就是一条不检查也能过的路径。
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-round-chain-live.mjs');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const dirs = [];

function run(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

function state(obj) {
  const d = mkdtempSync(join(tmpdir(), 'rcl-'));
  dirs.push(d);
  const p = join(d, 'state.json');
  writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}

const slices = (states) => Object.fromEntries(Object.entries(states).map(([k, v]) => [k, { state: v }]));

console.log('\n=== check-round-chain-live 自测 ===\n');

console.log('case 1: 无参数 → exit 2 并打用法（2026-11-25 补的守卫）');
{
  const r = run([]);
  expect('exit 2', r.code === 2, `code=${r.code}`);
  expect('打用法', /用法/.test(r.out), r.out);
}

console.log('case 2: 文件不存在 → exit 1 并说明（不是静默通过）');
{
  const r = run([join(tmpdir(), 'definitely-not-here-', 'state.json')]);
  expect('exit 1', r.code === 1, `code=${r.code}`);
  expect('说明不存在', /不存在/.test(r.out), r.out);
}

console.log('case 3: RUNNING → §6 与 §6.5.1 都给 RESUME_SAME_ROUND（一致）');
{
  const p = state({ status: 'RUNNING', slices: slices({ a: 'RUNNING', b: 'DONE' }) });
  const r = run([p]);
  expect('两条规则一致', /✓ 两条规则一致/.test(r.out), r.out);
  expect('§6 = RESUME_SAME_ROUND', /§6\s+→ RESUME_SAME_ROUND/.test(r.out), r.out);
}

console.log('case 4: CLOSED 且有 DEFERRED → OPEN_NEXT_ROUND，两条一致');
{
  const p = state({ status: 'CLOSED', slices: slices({ a: 'DONE', b: 'DEFERRED' }) });
  const r = run([p]);
  expect('两条一致', /✓ 两条规则一致/.test(r.out), r.out);
  expect('OPEN_NEXT_ROUND', /OPEN_NEXT_ROUND/.test(r.out), r.out);
}

console.log('case 5: 已出报告却要续跑同一轮 → 判失败（会产生两份报告）');
{
  // report.final_report_path 有值 + status=RUNNING → §6 会给 RESUME_SAME_ROUND，
  // 而这是硬规则禁止的（「已出报告」的轮次不该被续跑）。
  const p = state({
    status: 'RUNNING',
    slices: slices({ a: 'RUNNING' }),
    report: { final_report_path: 'docs/reports/round1/round1-final-report.md', is_complete: true },
  });
  const r = run([p]);
  expect('exit 1', r.code === 1, `code=${r.code}\n${r.out}`);
  expect('点名「会产生两份报告」', /两份报告/.test(r.out), r.out);
}

console.log('case 7: 真实快照（RUNNING + is_complete:false）不得判失败——那是用户中断的合法形态');
{
  // 2026-11-26 锐评 11：旧判据 `is_complete !== undefined` 把 false 也算「已出报告」，
  // 而 run-state.md:826 明写「用户中断 = 出报告 + is_complete:false + PARTIALLY_CLOSED」。
  const p = state({
    status: 'RUNNING',
    slices: slices({ a: 'RUNNING' }),
    report: { final_report_path: 'docs/reports/round1/round1-final-report.md', is_complete: false },
  });
  const r = run([p]);
  expect('exit 0（未完成的报告不算「已出报告」）', r.code === 0, `code=${r.code}
${r.out}`);
}

console.log('case 8: is_complete 整个省略 = 未完成，同样允许续跑（不得留后门）');
{
  const p = state({
    status: 'RUNNING',
    slices: slices({ a: 'RUNNING' }),
    report: { final_report_path: 'docs/reports/round1/round1-final-report.md' },
  });
  const r = run([p]);
  expect('exit 0', r.code === 0, `code=${r.code}
${r.out}`);
}

console.log('case 6: 两条规则冲突 → 必须同时「打印 ✗」且「exit 1」');
{
  // 2026-11-26 锐评实测：上一版写成 `正则 || r.code === 1`——**只要 exit 1 就算过**，
  // 不管有没有打印；反过来只打印不置失败位也能过。两个方向都没钉住。
  // §6 与 §6.5.1 对同一状态的判定不同：status=BLOCKED 且有 DEFERRED ——
  // §6 给 OPEN_NEXT_ROUND，§6.5.1 只在 CLOSED/PARTIALLY_CLOSED 时给，BLOCKED 走 STOP。
  const p = state({ status: 'BLOCKED', slices: slices({ a: 'DEFERRED' }) });
  const r = run([p]);
  expect('打印「✗ 两条规则冲突」', /✗ 两条规则冲突/.test(r.out), r.out);
  expect('exit 1', r.code === 1, `code=${r.code}`);
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
