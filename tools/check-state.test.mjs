#!/usr/bin/env node
/**
 * check-state.test.mjs — state.json 校验器自测
 *
 * 这些用例全部来自真实出过的问题：
 *   - IN_PROGRESS 停在 round31
 *   - FAILED 没有 failure 诊断（2026-11-05）
 *   - SKELETON_ONLY 改名后 schema 没同步（2026-11-09）
 *   - DONE 但没有产物路径（我自己写的 state.json 就有）
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-state.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

function run(state) {
  const dir = mkdtempSync(join(tmpdir(), 'cs-'));
  const f = join(dir, 'state.json');
  writeFileSync(f, JSON.stringify(state, null, 2));
  try {
    const out = execFileSync('node', [SCRIPT, f, '--json'], { encoding: 'utf8' });
    return { code: 0, r: JSON.parse(out) };
  } catch (e) {
    try { return { code: e.status ?? 1, r: JSON.parse(e.stdout) }; }
    catch { return { code: e.status ?? 1, r: null }; }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const base = (over = {}) => ({
  schema_version: 'run-state-v1',
  trace_id: 't1',
  round_id: 'round1',
  path_mode: 'AUDIT_ONLY',
  phase: 'report',
  status: 'PARTIALLY_CLOSED',
  slices: {},
  ...over,
});

const has = (r, rule) => (r.r?.errors ?? []).some(e => e.rule === rule);

console.log('\n=== state.json 校验器自测 ===\n');

console.log('case 1: 最小合规状态 → 通过');
{
  const r = run(base());
  expect('退出码 0', r.code === 0, `got ${r.code}`);
  expect('无错误', (r.r?.errors ?? []).length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 2: IN_PROGRESS（round31 的死法）→ 报错');
{
  const r = run(base({ status: 'IN_PROGRESS' }));
  expect('报 invalid_enum 或 deprecated_status',
    has(r, 'invalid_enum') || has(r, 'deprecated_status'));
}

console.log('case 3: 缺顶层字段 → 报错');
{
  const s = base();
  delete s.trace_id;
  const r = run(s);
  expect('报 missing_top_field', has(r, 'missing_top_field'));
}

console.log('case 4: FAILED 但没有 failure 诊断 → 报错');
{
  const r = run(base({ slices: { 'slice-01': { state: 'FAILED' } } }));
  expect('报 missing_failure_diagnosis', has(r, 'missing_failure_diagnosis'));
}

console.log('case 5: 用已废弃的 SCRIPT_TIMEOUT → 报错并提示改名');
{
  const r = run(base({
    slices: { 'slice-01': { state: 'FAILED', failure: { error_type: 'SCRIPT_TIMEOUT' } } },
  }));
  const e = (r.r?.errors ?? []).find(x => x.rule === 'deprecated_enum');
  expect('报 deprecated_enum', !!e);
  expect('提示改为 SKELETON_ONLY', /SKELETON_ONLY/.test(e?.msg ?? ''));
}

console.log('case 6: SKELETON_ONLY（新名字）→ 合规');
{
  const r = run(base({
    slices: { 'slice-01': { state: 'FAILED',
      failure: { error_type: 'SKELETON_ONLY', artifact_bytes: 44 } } },
  }));
  expect('无 deprecated 错误', !has(r, 'deprecated_enum'));
  expect('无 invalid_enum', !has(r, 'invalid_enum'));
}

console.log('case 7: DONE 但没有产物路径 → 报错');
{
  const r = run(base({ slices: { 'slice-01': { state: 'DONE' } } }));
  expect('报 done_without_artifact', has(r, 'done_without_artifact'));
}

console.log('case 8: DONE 且有产物路径 → 合规');
{
  const r = run(base({
    slices: { 'slice-01': { state: 'DONE', artifact_paths: ['/x/y.md'] } },
  }));
  expect('无 done_without_artifact', !has(r, 'done_without_artifact'));
}

console.log('case 9: attempt=0 → 报错（第一次尝试应是 1）');
{
  const r = run(base({ slices: { 'slice-01': { state: 'PENDING', attempt: 0 } } }));
  expect('报 invalid_attempt', has(r, 'invalid_attempt'));
}

console.log('case 10: budget 超支 → 报错');
{
  const r = run(base({ budget: { total_cap: 10, spent: 15 } }));
  expect('报 over_budget', has(r, 'over_budget'));
}

console.log('case 11: CLOSED 但没有报告路径 → 报错');
{
  const r = run(base({ status: 'CLOSED' }));
  expect('报 closed_without_report', has(r, 'closed_without_report'));
}

console.log('case 12: CLOSED 且有报告 → 合规');
{
  const r = run(base({
    status: 'CLOSED',
    report: { final_report_path: '/x/report.md', is_complete: true },
  }));
  expect('无 closed_without_report', !has(r, 'closed_without_report'));
}

console.log('case 13: CLOSED 但 is_complete=false → 报错（自相矛盾）');
{
  const r = run(base({
    status: 'CLOSED',
    report: { final_report_path: '/x/r.md', is_complete: false },
  }));
  expect('报 closed_but_incomplete', has(r, 'closed_but_incomplete'));
}

console.log('case 14: phase=closed 但 status=RUNNING → 报错');
{
  const r = run(base({ phase: 'closed', status: 'RUNNING' }));
  expect('报 phase_status_mismatch', has(r, 'phase_status_mismatch'));
}

console.log('case 15: 切片 state 非法枚举 → 报错');
{
  const r = run(base({ slices: { 'slice-01': { state: 'FINISHED' } } }));
  expect('报 invalid_enum', has(r, 'invalid_enum'));
}

// ── fix_contracts（2026-11-09 新增）──
console.log('case 19: fix_contracts 字段齐全 → 通过');
{
  const r = run(base({
    fix_contracts: [{
      finding_id: 'F1', fix_agent_id: 'fx1', registered_at: '2026-11-09T10:00:00Z',
      defect_statement: '当 X 时 Y 发生，预期 Z',
      disproof_condition: 'node check.mjs 应红',
      baseline_result: 'exit 1: assertion failed at line 12',
      rollback_command: 'git checkout -- a.js',
      test_path: 'tests/a.test.js',
    }],
  }));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 20: fix_contract 缺 rollback_command → 报错');
{
  const r = run(base({
    fix_contracts: [{
      finding_id: 'F1', fix_agent_id: 'fx1', registered_at: '2026-11-09T10:00:00Z',
      defect_statement: 'x', disproof_condition: 'y',
      baseline_result: 'ok', test_path: 't.js',
    }],
  }));
  expect('报 fix_contract_incomplete',
    r.r?.errors?.some(x => x.rule === 'fix_contract_incomplete' && /rollback_command/.test(x.field ?? '')));
}

console.log('case 21: 既无 baseline_result 也未声明 unverified → 报错');
{
  const r = run(base({
    fix_contracts: [{
      finding_id: 'F1', fix_agent_id: 'fx1', registered_at: '2026-11-09T10:00:00Z',
      defect_statement: 'x', disproof_condition: 'y',
      rollback_command: 'git checkout -- a.js', test_path: 't.js',
    }],
  }));
  expect('报 baseline_not_recorded', r.r?.errors?.some(x => x.rule === 'baseline_not_recorded'));
}

console.log('case 22: 无 baseline_result 但声明 baseline_unverified=true → 通过');
{
  const r = run(base({
    fix_contracts: [{
      finding_id: 'F1', fix_agent_id: 'fx1', registered_at: '2026-11-09T10:00:00Z',
      defect_statement: 'x', disproof_condition: 'y',
      baseline_result: null, baseline_unverified: true,
      rollback_command: 'git checkout -- a.js', test_path: 't.js',
    }],
  }));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 23: 执行相位无 current_plan → 报错（§0.8.4）');
{
  const r = run(base({ phase: 'wave2a', status: 'RUNNING' }));
  expect('报 missing_plan_in_execution_phase',
    r.r?.errors?.some(x => x.rule === 'missing_plan_in_execution_phase'));
}

console.log('case 24: current_plan 缺 exit_condition → 报错');
{
  const r = run(base({ phase: 'wave2a', status: 'RUNNING',
    current_plan: { phase: 'wave2a', steps: [{ action: 'a', done_when: 'b' }] } }));
  expect('报 plan_without_exit_condition',
    r.r?.errors?.some(x => x.rule === 'plan_without_exit_condition'));
}

console.log('case 25: 计划步骤缺 done_when → 报错');
{
  const r = run(base({ phase: 'wave2a', status: 'RUNNING',
    current_plan: { phase: 'wave2a', steps: [{ action: '派 16 个 agent' }],
      exit_condition: '全部终态' } }));
  expect('报 plan_step_without_done_when',
    r.r?.errors?.some(x => x.rule === 'plan_step_without_done_when'));
}

console.log('case 26: 完整计划 → 通过');
{
  const r = run(base({ phase: 'wave2a', status: 'RUNNING',
    current_plan: { phase: 'wave2a',
      steps: [{ action: '派宽扫', done_when: '全部终态' },
              { action: '派深挖', done_when: '预算内派完' }],
      exit_condition: '账本更新完' } }));
  expect('无 current_plan 相关错误',
    !r.r?.errors?.some(x => /plan/i.test(x.rule ?? '')));
}

console.log('case 27: 计划超过 12 步 → 警告（过细会损害质量）');
{
  const steps = Array.from({length: 15}, (_, i) => ({ action: '步骤' + i, done_when: 'done' }));
  const r = run(base({ phase: 'wave2a', status: 'RUNNING',
    current_plan: { phase: 'wave2a', steps, exit_condition: 'x' } }));
  expect('报 plan_too_granular 警告',
    r.r?.warnings?.some(x => x.rule === 'plan_too_granular'));
}

console.log('case 28: 计划 5 步 → 无过细警告');
{
  const steps = Array.from({length: 5}, (_, i) => ({ action: '阶段' + i, done_when: 'done' }));
  const r = run(base({ phase: 'wave2a', status: 'RUNNING',
    current_plan: { phase: 'wave2a', steps, exit_condition: 'x' } }));
  expect('无 plan_too_granular',
    !r.r?.warnings?.some(x => x.rule === 'plan_too_granular'));
}

// ── wave4 / wave5：FIX 路径此前没有相位值（2026-11-15 R1 新增）──
// 诊断证据（experiments/hilltop-dsh/DIAG-FINAL.md 三·4）：
//   `path_mode` 枚举有 FIX，`phase` 枚举没有对应值 → 修复相位不被任何门控覆盖。
// 下面这些用例在改代码之前应当全部失败（wave4/wave5 被判 invalid_enum）。
const fc = (over = {}) => ({
  finding_id: 'F1', fix_agent_id: 'fx1', registered_at: '2026-11-15T10:00:00Z',
  defect_statement: '当 X 时 Y 发生，预期 Z',
  disproof_condition: 'node t.mjs 应红',
  baseline_result: 'exit 1: assertion failed',
  rollback_command: 'git checkout -- a.js',
  test_path: 't.mjs',
  ...over,
});
const donePlan = (phase) => ({
  phase, steps: [{ action: '修 F1', done_when: 'F1 的 disproof_condition 转绿' }],
  exit_condition: '全部契约都有终态', current_step: 2,
});
// 2026-11-15（R14）：FIX + 有契约时目录字段是条件必填（report_dir_required），
// 「应当完全合规」的样本必须带上它，否则它测的是别的东西。
const fixReport = { dir_path: '/x/artifacts' };
// 2026-11-16（R16a）：同理，target_repo 在 FIX + wave4/wave5 + 有契约时条件必填
// （target_repo_required），且要求是一个真实存在的目录。HERE（tools/）测试时必然存在。
const fixTargetRepo = HERE;

console.log('case 29: phase=wave4 / wave5 不再被判 invalid_enum');
{
  for (const ph of ['wave4', 'wave5']) {
    const r = run(base({
      path_mode: 'FIX', phase: ph, status: 'RUNNING',
      fix_contracts: [fc()], current_plan: donePlan(ph),
      // 2026-11-15（R14）：FIX + 有契约时目录字段是条件必填（report_dir_required），
      // 所以这个「应当完全合规」的样本必须带上它，否则它测的是别的东西。
      // 2026-11-16（R16a）：target_repo 同理（target_repo_required）。
      report: fixReport, target_repo: fixTargetRepo,
    }));
    expect(`${ph} 不报 phase invalid_enum`,
      !(r.r?.errors ?? []).some(x => x.rule === 'invalid_enum' && x.field === 'phase'),
      JSON.stringify(r.r?.errors));
    expect(`${ph} 整体无错误`, (r.r?.errors ?? []).length === 0, JSON.stringify(r.r?.errors));
  }
}

console.log('case 30: path_mode=FIX + phase=wave4 但完全没有 fix_contracts → 报错');
{
  const r = run(base({ path_mode: 'FIX', phase: 'wave4', status: 'RUNNING',
    current_plan: donePlan('wave4') }));
  expect('报 fix_contracts_required',
    (r.r?.errors ?? []).some(x => x.rule === 'fix_contracts_required'),
    JSON.stringify(r.r?.errors));
}

console.log('case 31: path_mode=FIX + phase=wave4 但 fix_contracts 为空数组 → 报错');
{
  const r = run(base({ path_mode: 'FIX', phase: 'wave4', status: 'RUNNING',
    fix_contracts: [], current_plan: donePlan('wave4') }));
  expect('报 fix_contracts_required',
    (r.r?.errors ?? []).some(x => x.rule === 'fix_contracts_required'),
    JSON.stringify(r.r?.errors));
}

console.log('case 32: path_mode=FIX + phase=wave5 且契约齐备 → 合规');
{
  const r = run(base({ path_mode: 'FIX', phase: 'wave5', status: 'RUNNING',
    fix_contracts: [fc({ verdict: 'PASS', verified_at: '2026-11-15T12:00:00Z' })],
    current_plan: donePlan('wave5'),
    report: fixReport, target_repo: fixTargetRepo }));
  expect('无错误', (r.r?.errors ?? []).length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 33: 非 FIX 路径（AUDIT_ONLY）缺 fix_contracts 仍然合法');
{
  const r = run(base({ path_mode: 'AUDIT_ONLY', phase: 'wave4', status: 'RUNNING',
    current_plan: donePlan('wave4') }));
  expect('不报 fix_contracts_required',
    !(r.r?.errors ?? []).some(x => x.rule === 'fix_contracts_required'),
    JSON.stringify(r.r?.errors));
  expect('无错误', (r.r?.errors ?? []).length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 34: wave5 的 verdict 拼错（PASSED）→ 报错而非静默放行');
{
  const r = run(base({ path_mode: 'FIX', phase: 'wave5', status: 'RUNNING',
    fix_contracts: [fc({ verdict: 'PASSED', verified_at: '2026-11-15T12:00:00Z' })],
    current_plan: donePlan('wave5') }));
  expect('报 invalid_verify_verdict',
    (r.r?.errors ?? []).some(x => x.rule === 'invalid_verify_verdict'),
    JSON.stringify(r.r?.errors));
}

console.log('case 35: wave4/wave5 与 wave2a 一样要求 current_plan（两份相位清单必须同步）');
{
  for (const ph of ['wave4', 'wave5']) {
    const r = run(base({
      path_mode: 'FIX', phase: ph, status: 'RUNNING', fix_contracts: [fc()],
    }));
    expect(`${ph} 缺 current_plan → 报 missing_plan_in_execution_phase`,
      (r.r?.errors ?? []).some(x => x.rule === 'missing_plan_in_execution_phase'),
      JSON.stringify(r.r?.errors));
  }
}

// ── report.dir_path 条件必填（2026-11-15 R14 新增）──────────────────────
console.log('case 36: FIX + wave4 + 有契约但两个目录字段都没写 → 报 report_dir_required');
{
  const r = run(base({
    path_mode: 'FIX', phase: 'wave4', status: 'RUNNING',
    fix_contracts: [fc(), fc({ finding_id: 'F2' })],
    current_plan: donePlan('wave4'),
  }));
  const e = (r.r?.errors ?? []).find(x => x.rule === 'report_dir_required');
  expect('报 report_dir_required', !!e, JSON.stringify(r.r?.errors));
  expect('字段指向 report.dir_path', e?.field === 'report.dir_path', e?.field);
  expect('说明不是格式问题，而是闸门推断不出目录',
    /不是格式问题/.test(e?.msg ?? '') && /推断/.test(e?.msg ?? ''), e?.msg);
  expect('点明「等于用省略换掉一道门」',
    /省略换掉一道门/.test(e?.msg ?? ''), e?.msg);
}

console.log('case 37: FIX + wave4 + 只有 final_report_path → 通过');
{
  const r = run(base({
    path_mode: 'FIX', phase: 'wave4', status: 'RUNNING',
    fix_contracts: [fc()], current_plan: donePlan('wave4'),
    report: { dir_ready: true, dir_path: null, final_report_path: '/x/artifacts/r.md' },
    target_repo: fixTargetRepo,
  }));
  expect('不报 report_dir_required',
    !(r.r?.errors ?? []).some(x => x.rule === 'report_dir_required'),
    JSON.stringify(r.r?.errors));
  expect('无错误', (r.r?.errors ?? []).length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 38: FIX + wave4 + 两个都有 → 通过');
{
  const r = run(base({
    path_mode: 'FIX', phase: 'wave4', status: 'RUNNING',
    fix_contracts: [fc()], current_plan: donePlan('wave4'),
    report: { dir_ready: true, dir_path: '/x/artifacts',
      final_report_path: '/x/artifacts/r.md' },
    target_repo: fixTargetRepo,
  }));
  expect('无错误', (r.r?.errors ?? []).length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 39: AUDIT_ONLY + wave4 + 无 report → 通过（不误伤审计路径）');
{
  const r = run(base({
    path_mode: 'AUDIT_ONLY', phase: 'wave4', status: 'RUNNING',
    current_plan: donePlan('wave4'),
  }));
  expect('不报 report_dir_required',
    !(r.r?.errors ?? []).some(x => x.rule === 'report_dir_required'),
    JSON.stringify(r.r?.errors));
  expect('无错误', (r.r?.errors ?? []).length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 40: FIX + wave1（未到修复相位）+ 无 report → 通过');
{
  const r = run(base({
    path_mode: 'FIX', phase: 'wave1', status: 'RUNNING',
  }));
  expect('不报 report_dir_required',
    !(r.r?.errors ?? []).some(x => x.rule === 'report_dir_required'),
    JSON.stringify(r.r?.errors));
}

console.log('case 41: FIX + wave4 + fix_contracts 为空 → 报 fix_contracts_required，不报 report_dir_required');
{
  // 没有可验收的修复时，产物目录对信封检查也没有意义——两条规则不得同时开火，
  // 否则报错清单会指向一个此时修不修都无所谓的字段。
  const r = run(base({
    path_mode: 'FIX', phase: 'wave4', status: 'RUNNING',
    fix_contracts: [], current_plan: donePlan('wave4'),
  }));
  expect('报 fix_contracts_required',
    (r.r?.errors ?? []).some(x => x.rule === 'fix_contracts_required'),
    JSON.stringify(r.r?.errors));
  expect('不报 report_dir_required',
    !(r.r?.errors ?? []).some(x => x.rule === 'report_dir_required'),
    JSON.stringify(r.r?.errors));
}

// ── target_repo 条件必填（2026-11-16 R16a 新增）──────────────────────────
// 为什么需要它：check-payload.mjs 的 red_log_not_found / test_path_not_found
// 要把信封里的相对路径解析成绝对路径才能 existsSync，而这一步需要 --repo <被审仓库根>。
// 此前 state.json 没有任何字段记录被审仓库在哪，于是「忘了传 --repo」时
// 这两条规则整档降级成 evidence_existence_unchecked WARN——检查被跳过，而不是不通过。
console.log('case 42: FIX + wave4 + 有契约但完全没有 target_repo → 报 target_repo_required');
{
  const r = run(base({
    path_mode: 'FIX', phase: 'wave4', status: 'RUNNING',
    fix_contracts: [fc(), fc({ finding_id: 'F2' })],
    current_plan: donePlan('wave4'),
    report: fixReport,
  }));
  const e = (r.r?.errors ?? []).find(x => x.rule === 'target_repo_required');
  expect('报 target_repo_required', !!e, JSON.stringify(r.r?.errors));
  expect('字段指向 target_repo', e?.field === 'target_repo', e?.field);
}

console.log('case 43: FIX + wave4 + target_repo 指向不存在的路径 → 报错（不是字符串非空就算数）');
{
  const r = run(base({
    path_mode: 'FIX', phase: 'wave4', status: 'RUNNING',
    fix_contracts: [fc()], current_plan: donePlan('wave4'), report: fixReport,
    target_repo: join(tmpdir(), 'definitely-not-here-r16a', 'no-such-repo'),
  }));
  const e = (r.r?.errors ?? []).find(x => x.rule === 'target_repo_required');
  expect('报 target_repo_required', !!e, JSON.stringify(r.r?.errors));
  expect('消息点明「不是字符串非空就算数」',
    /不是字符串非空就算数/.test(e?.msg ?? ''), e?.msg);
}

console.log('case 44: FIX + wave4 + target_repo 指向真实存在的目录 → 通过');
{
  const r = run(base({
    path_mode: 'FIX', phase: 'wave4', status: 'RUNNING',
    fix_contracts: [fc()], current_plan: donePlan('wave4'), report: fixReport,
    target_repo: HERE, // tools/ 目录，测试时必然存在
  }));
  expect('不报 target_repo_required',
    !(r.r?.errors ?? []).some(x => x.rule === 'target_repo_required'),
    JSON.stringify(r.r?.errors));
  expect('无错误', (r.r?.errors ?? []).length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 45: AUDIT_ONLY + wave4 + 无 target_repo → 通过（不误伤审计路径）');
{
  const r = run(base({
    path_mode: 'AUDIT_ONLY', phase: 'wave4', status: 'RUNNING',
    current_plan: donePlan('wave4'),
  }));
  expect('不报 target_repo_required',
    !(r.r?.errors ?? []).some(x => x.rule === 'target_repo_required'),
    JSON.stringify(r.r?.errors));
  expect('无错误', (r.r?.errors ?? []).length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 46: FIX + wave4 + fix_contracts 为空 → 不报 target_repo_required（与 case 41 同一条纪律）');
{
  const r = run(base({
    path_mode: 'FIX', phase: 'wave4', status: 'RUNNING',
    fix_contracts: [], current_plan: donePlan('wave4'),
  }));
  expect('不报 target_repo_required',
    !(r.r?.errors ?? []).some(x => x.rule === 'target_repo_required'),
    JSON.stringify(r.r?.errors));
}

// ── 退出码契约 ──
//
// 2026-11-21 变异测试发现：把 check-state.mjs 里的 `process.exit(1)` 改成
// `process.exit(0)` 后，**全部自测仍然通过**——因为这里从来没有断言过 code。
//
// 这不是某一个分支的盲区，是整个"失败要以非零退出"的契约没被验证。
// 而 CI、gate.mjs、以及所有下游都是靠退出码判断成败的：
// 它会变成"报了错但所有人都以为过了"。
console.log('退出码：有错误时必须 exit 1');
{
  const r = run({
    schema_version: 'run-state-v1', trace_id: 't', round_id: 1,
    // 故意缺 path_mode / phase / status / slices
  });
  expect('exit 1（不是 0）', r.code === 1, `code=${r.code}`);
  expect('确实报了错', (r.r?.errors ?? []).length > 0, JSON.stringify(r.r?.errors));
}

console.log('退出码：完全合法时必须 exit 0');
{
  const r = run({
    schema_version: 'run-state-v1', trace_id: 't', round_id: 1,
    path_mode: 'AUDIT_ONLY', phase: 'wave1', status: 'RUNNING', slices: {},
  });
  expect('exit 0（不是 1）', r.code === 0, `code=${r.code}, errors=${JSON.stringify(r.r?.errors)}`);
}

console.log('退出码：JSON 解析失败时必须 exit 1');
{
  // 2026-11-21 变异测试第二轮：把 check-state.mjs:42 的 `process.exit(1)`
  // 改成 `process.exit(0)` 后自测仍然全过。
  //
  // 原因：那条 exit(1) 只在 **JSON 解析失败** 时触发，
  // 而之前的测试全都传合法 JSON。这是「畸形输入」这条路径从未被走过。
  //
  // 后果很直接：产物是坏 JSON 时，校验器打出 "JSON 解析失败"
  // 却以 0 退出——CI 与 gate.mjs 全靠退出码判断，于是坏事变成绿灯。
  const dir = mkdtempSync(join(tmpdir(), 'cs-badjson-'));
  const f = join(dir, 'state.json');
  writeFileSync(f, '{ this is not json');
  let code = 0;
  try {
    execFileSync('node', [SCRIPT, f, '--json'], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) { code = e.status ?? 1; }
  expect('exit 1（不是 0）', code === 1, `code=${code}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
