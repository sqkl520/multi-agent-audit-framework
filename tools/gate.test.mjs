#!/usr/bin/env node
/**
 * gate.test.mjs — 门禁系统自测
 *
 * 为什么必须测：门禁是「绕不过去的关口」，如果它自己失灵，
 * 整个 L2 契约层就是装饰。而本框架已经出过三次「检查器假绿」：
 *   - L9 把 T2 改成 2 仍报通过
 *   - L1 的「不得」豁免漏报
 *   - 文档里两个矛盾的 §7.1
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const GATE = join(HERE, 'gate.mjs');
let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};
;

function run(args) {
  try {
    const out = execFileSync('node', [GATE, ...args, '--json'], { encoding: 'utf8', cwd: HERE });
    return { code: 0, r: JSON.parse(out) };
  } catch (e) {
    try { return { code: e.status ?? 1, r: JSON.parse(e.stdout) }; }
    catch { return { code: e.status ?? 1, r: null, raw: (e.stdout ?? '') + (e.stderr ?? '') }; }
  }
}

const goodArtifact = (path) => [
  '# 宽扫',
  '',
  '```json',
  JSON.stringify({
    schema_version: 'output-contract-v1',
    agent_id: 'a1', role: 'sweep', status: 'SUCCESS',
    contract_valid: true, artifact_path: path,
    payload: {
      slice_id: 'slice-01', reachability: 'PROD', files_read: ['a.js'],
      leads: [{ lead_id: 'L1' }], lead_count: 1,
    },
    error: null,
  }, null, 2),
  '```',
].join('\n');

const BAD_ARTIFACT = '# 宽扫\n\n找到了 3 条线索。\n';

const GOOD_STATE = {
  schema_version: 'run-state-v1', trace_id: 't', round_id: 'round1',
  path_mode: 'AUDIT_ONLY', phase: 'report', status: 'PARTIALLY_CLOSED',
  slices: { 'slice-01': { state: 'DONE', artifact_paths: ['/x/y.md'] } },
};

console.log('\n=== 门禁系统自测 ===\n');

console.log('case 1: --list 列出全部四道门');
{
  try {
    const out = execFileSync('node', [GATE, '--list', '--json'], { encoding: 'utf8' });
    const g = JSON.parse(out);
    expect('有 dispatch 门', !!g.dispatch);
    expect('有 accept 门', !!g.accept);
    expect('有 close 门', !!g.close);
    expect('有 release 门', !!g.release);
  } catch (e) {
    expect('--list 可执行', false, e.message.split('\n')[0]);
  }
}

console.log('case 2: accept 门 —— 合规产物放行');
{
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  const f = join(dir, 'a.md');
  writeFileSync(f, goodArtifact(f));
  const r = run(['--gate', 'accept', '--artifact', f, '--role', 'sweep']);
  expect('放行', r.r?.passed === true, JSON.stringify(r.r?.results?.map(x => x.name + ':' + x.ok)));
  expect('退出码 0', r.code === 0);
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 3: accept 门 —— 无 JSON 信封必须拒绝');
{
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  const f = join(dir, 'b.md');
  writeFileSync(f, BAD_ARTIFACT);
  const r = run(['--gate', 'accept', '--artifact', f, '--role', 'sweep']);
  expect('拒绝', r.r?.passed === false);
  expect('退出码 1', r.code === 1);
  expect('报出 check-payload 失败',
    r.r?.results?.some(x => x.name === 'check-payload' && !x.ok));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 4: accept 门 —— role 不匹配必须拒绝');
{
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  const f = join(dir, 'c.md');
  writeFileSync(f, goodArtifact(f));
  const r = run(['--gate', 'accept', '--artifact', f, '--role', 'audit']);
  expect('拒绝', r.r?.passed === false, 'role=sweep 的产物不该过 audit 门');
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 5: close 门 —— 缺发现去向证据必须拒绝（2026-11-20 收紧）');
{
  // 原来这条期望「合规 state + 交付物」就放行。2026-11-20 起收口门还要
  // check-disposition-coverage 与 check-fix-instances —— 它们是唯一能拦住
  // 「38 条发现只修 6 条、框架全程无工具报错」的机制，此前不在任何门上。
  //
  // 不给 --artifacts/--ledger/--report 时判 FAIL 而不是跳过：允许「不给参数就
  // 自动通过」等于给出一条不检查也能收口的路径。
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(GOOD_STATE));
  writeFileSync(join(dir, 'round1-final-report.md'),
    '# r\n\n## 0. 一句话结论\nx\n\n## 1. 元信息\n\n## 2. 覆盖说明\n3/8 = 37.5%\n\n证据覆盖率 = 42 / 80 = 52.5%\n\n## 3. 发现汇总\n\n## 4. 失败与未闭合\n\n## 5. 零写入自证\n\n## 6. 下一步\n');
  writeFileSync(join(dir, 'round1-ledger.md'),
    '# l\n\n## 1. 切片状态表\n\n## 2. 预算\n\n## 3. 失败分类\n\n## 4. 裁量日志\n');
  const r = run(['--gate', 'close', '--state', join(dir, 'state.json'), '--round-dir', dir]);
  expect('拒绝（缺发现去向证据）', r.r?.passed === false,
    JSON.stringify(r.r?.results?.map(x => x.name + ':' + x.ok)));
  const names = (r.r?.results ?? []).map((x) => x.name);
  expect('确实执行了 check-disposition-coverage', names.includes('check-disposition-coverage'), JSON.stringify(names));
  expect('确实执行了 check-fix-instances', names.includes('check-fix-instances'), JSON.stringify(names));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 5b: close 门 —— 「无法证明」不得当作「通过」必须说明理由');{
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(GOOD_STATE));
  const r = run(['--gate', 'close', '--state', join(dir, 'state.json'), '--round-dir', dir]);
  const cov = (r.r?.results ?? []).find((x) => x.name === 'check-disposition-coverage');
  expect('失败信息说明缺参数', /未提供 --artifacts/.test(cov?.out ?? ''), cov?.out?.slice(0, 200));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 6: close 门 —— 缺交付物必须拒绝');
{
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(GOOD_STATE));
  const r = run(['--gate', 'close', '--state', join(dir, 'state.json'), '--round-dir', dir]);
  expect('拒绝', r.r?.passed === false);
  expect('报出 check-deliverables 失败',
    r.r?.results?.some(x => x.name === 'check-deliverables' && !x.ok));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 7: close 门 —— 非法 state 必须拒绝');
{
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  writeFileSync(join(dir, 'state.json'),
    JSON.stringify({ ...GOOD_STATE, status: 'IN_PROGRESS' }));
  writeFileSync(join(dir, 'round1-final-report.md'), '# r\n');
  writeFileSync(join(dir, 'round1-ledger.md'), '# l\n');
  const r = run(['--gate', 'close', '--state', join(dir, 'state.json'), '--round-dir', dir]);
  expect('拒绝', r.r?.passed === false, 'IN_PROGRESS 不是合法终态');
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 8: dispatch 门 —— 无 payload 必须拒绝（不能「不知道就放行」）');
{
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  const l = join(dir, 'L.json');
  const r = run(['--gate', 'dispatch', '--ledger', l]);
  expect('拒绝', r.r?.passed === false, '缺 payload 时不得默认放行');
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 9: dispatch 门 —— 新任务放行');
{
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  const p = join(dir, 'p.json');
  writeFileSync(p, JSON.stringify({ task: 'sweep-01' }));
  const r = run(['--gate', 'dispatch', '--payload', p, '--ledger', join(dir, 'L.json')]);
  expect('放行', r.r?.passed === true,
    JSON.stringify(r.r?.results?.map(x => x.name + ':' + x.ok)));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 10: release 门 —— 会跑 lint-autonomy');
{
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(GOOD_STATE));
  const r = run(['--gate', 'release', '--state', join(dir, 'state.json')]);
  expect('包含 lint-autonomy 检查',
    r.r?.results?.some(x => x.name === 'lint-autonomy'), JSON.stringify(r.r?.results?.map(x => x.name)));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 11: 非法的 --gate 值 → 用法错误退出码 2');
{
  try {
    execFileSync('node', [GATE, '--gate', 'nonexistent'], { encoding: 'utf8', stdio: 'pipe' });
    expect('应报用法错误', false);
  } catch (e) {
    expect('退出码 2', e.status === 2, `got ${e.status}`);
  }
}

console.log('case 13: close 门 —— 缺 --packet 必须拒绝（check-handoff 的唯一入口，2026-11-25 接线）');
{
  // 背景：`check-handoff.mjs` 此前**不在任何门上**，只被自己的 .test.mjs 跑过。
  // 这条用例钉住：close 门现在真的会跑它，且缺参数时不得当作通过。
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(GOOD_STATE));
  const r = run(['--gate', 'close', '--state', join(dir, 'state.json'), '--round-dir', dir]);
  const names = (r.r?.results ?? []).map((x) => x.name);
  const hs = (r.r?.results ?? []).find((x) => x.name === 'check-handoff');
  expect('拒绝', r.r?.passed === false);
  expect('确实执行了 check-handoff', names.includes('check-handoff'), JSON.stringify(names));
  expect('失败信息说明缺 --packet', /未提供 --packet/.test(hs?.out ?? ''), hs?.out?.slice(0, 200));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 14: close 门 —— 给了不合规的 --packet → 拒绝，并点名 check-handoff');
{
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(GOOD_STATE));
  const bad = join(dir, 'packet.json');
  // 缺必填字段 + wave_id 越界
  writeFileSync(bad, JSON.stringify({ schema_version: 'handoff-schema-v1', wave_id: 'wave-9' }, null, 2));
  const r = run(['--gate', 'close', '--state', join(dir, 'state.json'), '--round-dir', dir, '--packet', bad]);
  const hs = (r.r?.results ?? []).find((x) => x.name === 'check-handoff');
  expect('拒绝', r.r?.passed === false);
  expect('check-handoff 判失败', hs?.ok === false, JSON.stringify(hs?.out?.slice(0, 200)));
  expect('报出具体规则', /missing_field|bad_wave_id/.test(hs?.out ?? ''), hs?.out?.slice(0, 300));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 15: close 门 —— 合规的 --packet 不再因为 handoff 失败（其余项仍可能失败）');
{
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(GOOD_STATE));
  const good = join(dir, 'packet.json');
  writeFileSync(good, JSON.stringify({
    schema_version: 'handoff-schema-v1', round_id: 'round1', wave_id: 'wave-2',
    wave_status: 'CLOSED', trace_id: 't', packet_digest: 'a'.repeat(64),
    open_items: [{ kind: 'UNRESOLVED_FINDING', blocking: true, artifact_ref: 'x.md' }],
  }, null, 2));
  const r = run(['--gate', 'close', '--state', join(dir, 'state.json'), '--round-dir', dir, '--packet', good]);
  const hs = (r.r?.results ?? []).find((x) => x.name === 'check-handoff');
  expect('check-handoff 通过', hs?.ok === true, JSON.stringify(hs?.out?.slice(0, 200)));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 16: close 门 —— 通过项里的 WARN 必须可见（否则「只提示」等于不存在）');
{
  // 2026-11-25 锐评实测：gate 只在 !ok 时打印子脚本输出，于是 check-handoff 的
  // WARN 在唯一被接线的地方全部不可见——「有人工阻塞项，本轮只能 PARTIALLY_CLOSED」
  // 这句提示经 gate 调用后一个字符都看不到。
  const dir = mkdtempSync(join(tmpdir(), 'g-'));
  writeFileSync(join(dir, 'state.json'), JSON.stringify(GOOD_STATE));
  const p = join(dir, 'packet.json');
  writeFileSync(p, JSON.stringify({
    schema_version: 'handoff-schema-v1', round_id: 'round1', wave_id: 'wave-2',
    wave_status: 'CLOSED', trace_id: 't', packet_digest: 'a'.repeat(64),
    open_items: [{ kind: 'HUMAN_DECISION_REQUIRED', blocking: true, summary: 'x' }],
  }, null, 2));
  // 用人读输出而不是 --json：要测的正是「打印了什么」
  let out = '';
  try {
    out = execFileSync('node', [GATE, '--gate', 'close', '--state', join(dir, 'state.json'),
      '--round-dir', dir, '--packet', p], { encoding: 'utf8', cwd: HERE, stdio: 'pipe' });
  } catch (e) { out = (e.stdout ?? '') + (e.stderr ?? ''); }
  expect('提示行可见（human_blocker_present）', /human_blocker_present/.test(out), out.slice(-600));
  expect('汇总行可见（1 项警告）', /项警告/.test(out), out.slice(-300));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
