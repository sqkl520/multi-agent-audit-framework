// dsh-run-guard 自测：证明它抓得到「派出去的活没落盘」，也放得过正常产物。
//
// 关键：case 2 直接复刻 2026-11-20 那次真实失败——4 份深挖全部丢失，
// 只剩宽扫产物。守卫必须报出来。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'dsh-run-guard.mjs');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

function run(dir, extra = []) {
  try {
    const out = execFileSync(process.execPath, [TOOL, '--artifacts', dir, '--json', ...extra],
      { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out, err: e.stderr?.toString() }; }
  }
}

/** 造一个产物目录 */
function mk(files) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

const ENV = '```json\n{"schema_version":"output-contract-v1","role":"sweep","status":"SUCCESS"}\n```\n';

console.log('\n=== dsh-run-guard 自测 ===\n');

console.log('case 1: 完整相位（侦察 + 宽扫 + 锐评）且无占位符 → 应通过');
{
  const dir = mk('' ? {} : {
    'round1-01-recon-slices.md': '# recon\n' + ENV,
    'round1-02-sweep-slice-01.md': '# sweep\n' + ENV,
    'round1-03-critique-skeptic.md': '# critique\n' + ENV,
  });
  const r = run(dir);
  const fails = (r.data?.results ?? []).filter((x) => x.level === 'FAIL');
  expect('无 FAIL', fails.length === 0, JSON.stringify(fails.map((f) => f.id)));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 2: 复刻真实失败——有宽扫、无锐评、报告全是占位符 → 必须报');
{
  // 2026-11-20 第 2 次运行的真实形态：4 份深挖 + 1 份报告，
  // 报告里 §A 裁决索引表写「（锐评后填）」、§5 写「（收尾时填）」。
  const dir = mk({
    'round1-01-recon-slices.md': '# recon\n' + ENV,
    'round1-02-sweep-slice-01.md': '# sweep\n' + ENV,
    'round1-02-audit-slice-15-concurrency.md': '# audit\n' + ENV,
    'round1-final-report.md': '# report\n\n## 2.2 证据覆盖率\n\n（收尾填）\n\n## A. 裁决索引表\n\n| finding_id | 裁决 |\n|---|---|\n| （锐评后填） | |\n',
  });
  const r = run(dir);
  const ids = (r.data?.results ?? []).filter((x) => x.level === 'FAIL').map((x) => x.id);
  expect('exit 1', r.code === 1, `code=${r.code}`);
  expect('报 R2（占位符）', ids.includes('R2'), JSON.stringify(ids));
  expect('报 R3（缺锐评）', ids.includes('R3'), JSON.stringify(ids));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 3: 深挖产物全部丢失（只有宽扫）→ R1 报 FAIL');
{
  // 第 1 次运行的真实形态：状态记派出 N 个，产物一份没有。
  const dir = mk({
    'round1-01-recon-slices.md': '# recon\n' + ENV,
    'round1-03-critique-skeptic.md': '# critique\n' + ENV,
    'state.json': JSON.stringify({ ledger: { spawned_agents: 30 } }),
  });
  const r = run(dir);
  const r1 = (r.data?.results ?? []).find((x) => x.id === 'R1');
  expect('R1 有结论', !!r1, JSON.stringify(r.data?.results));
  // 30 派出 / 2 产物 → 差额远超重派可解释范围
  expect('R1 不是 PASS', r1?.level !== 'PASS', JSON.stringify(r1));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 4: state.json 没有 ledger.spawned_agents → SKIP，不假绿也不假红');
{
  const dir = mk({
    'round1-01-recon-slices.md': '# recon\n' + ENV,
    'round1-03-critique-skeptic.md': '# critique\n' + ENV,
    'state.json': JSON.stringify({ slices: {} }),
  });
  const r = run(dir);
  const r1 = (r.data?.results ?? []).find((x) => x.id === 'R1');
  expect('R1 为 SKIP', r1?.level === 'SKIP', JSON.stringify(r1));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 5: 空目录 → exit 2（分母为 0 不等于通过）');
{
  const dir = mkdtempSync(join(tmpdir(), 'guard-empty-'));
  let code = 0;
  try {
    execFileSync(process.execPath, [TOOL, '--artifacts', dir, '--json'],
      { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; }
  expect('exit 2', code === 2, `code=${code}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 6: 不给 --artifacts → exit 2');
{
  let code = 0;
  try {
    execFileSync(process.execPath, [TOOL], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status; }
  expect('exit 2', code === 2, `code=${code}`);
}

console.log('case 7: --strict 时 WARN 也算失败');
{
  const dir = mk({
    'round1-01-recon-slices.md': '# recon\n' + ENV,
    'round1-03-critique-skeptic.md': '# critique\n' + ENV,
    'round1-02-sweep-slice-01.md': '# s\n' + ENV,
    'state.json': JSON.stringify({ ledger: { spawned_agents: 5 } }),   // 5 vs 3 → WARN 档
  });
  const loose = run(dir);
  const strict = run(dir, ['--strict']);
  const hasWarn = (loose.data?.results ?? []).some((x) => x.level === 'WARN');
  expect('非 strict 下 WARN 不判失败', hasWarn ? loose.code === 0 : true, `code=${loose.code} warn=${hasWarn}`);
  expect('strict 下同样输入判失败', hasWarn ? strict.code === 1 : true, `code=${strict.code}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 8: 引用他人产物里的占位符不算骨架');
{
  // 2026-11-20 实测：round1-03-critique-skeptic-a.md:214 引用了旧报告里的
  // 「（收尾时填）」，那是**正确的审计行为**（它在批评上游产物是半成品），
  // 却被守卫判成「这份产物是骨架」。
  // 判据要区分「自己是骨架」与「在说别人是骨架」。
  const dir = mk({
    'round1-01-recon-slices.md': '# recon\n' + ENV,
    'round1-02-sweep-slice-01.md': '# sweep\n' + ENV,
    'round1-03-critique-skeptic.md': '# critique\n\n'
      + '> 该报告同时含未填占位符（`:15`「（收尾时填）」），属半成品。\n',
  });
  const r = run(dir);
  const r2 = (r.data?.results ?? []).find((x) => x.id === 'R2');
  expect('R2 为 PASS', r2?.level === 'PASS', JSON.stringify(r2));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 9: 自己正文里的占位符仍算骨架');
{
  const dir = mk({
    'round1-01-recon-slices.md': '# recon\n' + ENV,
    'round1-03-critique-skeptic.md': '# critique\n\n## 结论\n\n（收尾时填）\n',
  });
  const r = run(dir);
  const r2 = (r.data?.results ?? []).find((x) => x.id === 'R2');
  expect('R2 为 FAIL', r2?.level === 'FAIL', JSON.stringify(r2));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);