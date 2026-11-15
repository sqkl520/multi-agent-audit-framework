#!/usr/bin/env node
/**
 * stop-hook.test.mjs — Stop hook 的自测
 *
 * 为什么必须测：这是本框架里**唯一一个由 harness 强制**的机制。
 * 如果它自己错了，要么误拦（正常的回合结束被判违规），要么漏拦（什么都不做）。
 * 而它的失败模式很隐蔽——退出码错了，用户只会觉得「hook 好像没生效」。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'stop-hook.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

// 返回 { code, err }
function writeState(dir, st){ const f=join(dir,"state.json"); writeFileSync(f, JSON.stringify(st)); return f; }

function runHook(state, stdin = '{}') {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  const f = join(dir, 'state.json');
  if (state !== null) writeFileSync(f, JSON.stringify(state));
  try {
    const out = execFileSync('node', [HOOK, '--state', f], {
      input: stdin, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, err: e.stderr ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n=== stop-hook 自测 ===\n');

console.log('case 1: 执行相位无 current_plan → 退出码 2');
{
  const r = runHook({ phase: 'wave2a', status: 'RUNNING', slices: {}, in_flight: [] });
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('错误信息提到 current_plan', /current_plan/.test(r.err), r.err.slice(0, 200));
}

console.log('case 2: current_plan 缺 exit_condition → 退出码 2');
{
  const r = runHook({
    phase: 'wave2a', status: 'RUNNING', slices: {}, in_flight: [],
    current_plan: { phase: 'wave2a', steps: [{ action: 'a', done_when: 'b' }] },
  });
  expect('退出码 2', r.code === 2);
  expect('提到 exit_condition', /exit_condition/.test(r.err));
}

console.log('case 3: 有计划但有 agent 在飞 → 退出码 2');
{
  const r = runHook({
    phase: 'wave2a', status: 'RUNNING', slices: {}, in_flight: [{ agent_id: 'a1' }],
    current_plan: {
      phase: 'wave2a', steps: [{ action: 'a', done_when: 'b' }],
      exit_condition: '全部终态', current_step: 1,
    },
  });
  expect('退出码 2', r.code === 2);
  expect('提到在飞 agent', /在飞/.test(r.err));
}

console.log('case 4: 相位声明完成但报告未落盘 → 退出码 2');
{
  const r = runHook({ phase: 'report', status: 'RUNNING', slices: { s1: {} }, in_flight: [], report: { final_report_path: null } });
  expect('退出码 2', r.code === 2);
  expect('提到交付物', /交付物/.test(r.err));
}

console.log('case 5: 完全闭合 → 退出码 0（不能误拦）');
{
  const r = runHook({ phase: 'closed', status: 'CLOSED', slices: { s1: {} }, in_flight: [], report: { final_report_path: '/x' } });
  expect('退出码 0', r.code === 0, `实际 ${r.code}，stderr：${r.err.slice(0, 200)}`);
}

console.log('case 6: stop_hook_active=true → 退出码 0（防死循环，官方要求）');
{
  const r = runHook({ phase: 'wave2a', status: 'RUNNING', slices: {}, in_flight: [] }, '{"stop_hook_active":true}');
  expect('退出码 0', r.code === 0, '已经在 hook 续跑中时不应再拦');
}

console.log('case 7: state.json 不存在 → 退出码 0（宁可不拦，不要误拦）');
{
  const r = runHook(null);
  expect('退出码 0', r.code === 0);
}

console.log('case 8: state.json 损坏 → 退出码 0（同上）');
{
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  const f = join(dir, 'bad.json');
  writeFileSync(f, '{ not valid json');
  try {
    execFileSync('node', [HOOK, '--state', f], { input: '{}', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    expect('退出码 0', true);
  } catch (e) {
    expect('退出码 0', (e.status ?? 1) === 0, `实际 ${e.status}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('case 9: in_flight 里的 agent 产物已落盘 → 提示「账本没跟上」而非「还在飞」');
{
  // 2026-11-12 真实事故：主 Agent 连续 35 分钟说某 agent「还在跑」，
  // 而它的产物早已写完。判据必须是「产物存在吗」，不是「数组里还有没有」。
  const dir = mkdtempSync(join(tmpdir(), 'hook9-'));
  const art = join(dir, 'round1-02-audit-slice-01-logic.md');
  writeFileSync(art, '# 报告\n\n正文\n');
  const state = {
    phase: 'wave2b',
    in_flight: [{ agent_id: 'a1', artifact_path: art }],
  };
  try {
    execFileSync('node', [HOOK, '--state', writeState(dir, state)], {
      input: '{}', encoding: 'utf8', stdio: ['pipe','pipe','pipe'],
    });
    expect('应当拒绝结束（退出码 2）', false, '实际放行了');
  } catch (e) {
    const err = e.stderr ?? '';
    expect('拒绝结束', (e.status ?? 1) === 2, '实际 ' + e.status);
    expect('说是账本没跟上，不是说还在飞', /账本没跟/.test(err), err.slice(0,120));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log('case 10: in_flight 里的 agent 产物不存在 → 仍然判「还在飞」');
{
  const dir = mkdtempSync(join(tmpdir(), 'hook10-'));
  const state = {
    phase: 'wave2b',
    in_flight: [{ agent_id: 'a2', artifact_path: join(dir, 'nope.md') }],
  };
  try {
    execFileSync('node', [HOOK, '--state', writeState(dir, state)], {
      input: '{}', encoding: 'utf8', stdio: ['pipe','pipe','pipe'],
    });
    expect('应当拒绝结束', false, '实际放行了');
  } catch (e) {
    const err = e.stderr ?? '';
    expect('拒绝结束', (e.status ?? 1) === 2, '实际 ' + e.status);
    expect('说的是还在飞', /在飞/.test(err), err.slice(0,120));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

// ── wave4 / wave5：修复与验收相位必须被门控（2026-11-15 R1 新增）──
// 诊断证据（experiments/hilltop-dsh/DIAG-FINAL.md 三·4）：
//   相位白名单只有 wave2a/wave2b/wave3 → 修复阶段 stop-hook 完全不触发，
//   框架唯一的强制手段失效，只剩它自己判为「弱」的提示词那一层。
const fixContract = (over = {}) => ({
  finding_id: 'F1', fix_agent_id: 'fx1', registered_at: '2026-11-15T10:00:00Z',
  defect_statement: '当 X 时 Y 发生，预期 Z',
  disproof_condition: 'node t.mjs 应红',
  baseline_result: 'exit 1',
  rollback_command: 'git checkout -- a.js',
  test_path: 't.mjs',
  ...over,
});
const wavePlan = (phase) => ({
  phase, steps: [{ action: '修 F1', done_when: 'disproof_condition 转绿' }],
  exit_condition: '全部契约有终态', current_step: 2,
});

console.log('case 11: 回归 — wave2a 相位闭合 → 退出码 0（白名单改动不得误伤）');
{
  const r = runHook({
    phase: 'wave2a', status: 'RUNNING', in_flight: [],
    wave2_completed: [{ agent_id: 'a1', final_status: 'SUCCESS' }],
    current_plan: wavePlan('wave2a'),
  });
  expect('退出码 0', r.code === 0, `实际 ${r.code}，stderr：${r.err.slice(0, 200)}`);
}

console.log('case 12: phase=wave4 无 current_plan → 拒绝结束（exit 2）');
{
  const r = runHook({
    phase: 'wave4', status: 'RUNNING', in_flight: [],
    fix_contracts: [fixContract()], spawned_fix_agents: 1,
  });
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('提到 current_plan', /current_plan/.test(r.err), r.err.slice(0, 200));
}

console.log('case 13: phase=wave4 多条 finding 但只派 1 个实例 → 拒绝结束（串行即违规）');
{
  const r = runHook({
    phase: 'wave4', status: 'RUNNING', in_flight: [],
    fix_contracts: [fixContract({ finding_id: 'F1' }), fixContract({ finding_id: 'F2' })],
    spawned_fix_agents: 1,
    current_plan: wavePlan('wave4'),
  });
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('理由提到面板下限', /面板下限/.test(r.err), r.err.slice(0, 300));
  expect('理由提到串行', /串行/.test(r.err), r.err.slice(0, 300));
}

console.log('case 14: phase=wave4 多条 finding 且按条派发 → 不得误拦（exit 0）');
{
  const r = runHook({
    phase: 'wave4', status: 'RUNNING', in_flight: [],
    fix_contracts: [fixContract({ finding_id: 'F1' }), fixContract({ finding_id: 'F2' })],
    spawned_fix_agents: 2,
    current_plan: wavePlan('wave4'),
  });
  expect('退出码 0', r.code === 0, `实际 ${r.code}，stderr：${r.err.slice(0, 300)}`);
}

console.log('case 15: phase=wave4 无 fix_contracts → 拒绝结束（交付物缺失）');
{
  const r = runHook({
    phase: 'wave4', status: 'RUNNING', in_flight: [], spawned_fix_agents: 0,
    current_plan: wavePlan('wave4'),
  });
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('提到交付物', /交付物/.test(r.err), r.err.slice(0, 200));
}

console.log('case 16: phase=wave5 每条契约都有裁决 → 允许结束（exit 0）');
{
  const r = runHook({
    phase: 'wave5', status: 'RUNNING', in_flight: [],
    fix_contracts: [
      fixContract({ finding_id: 'F1', verdict: 'PASS', verified_at: '2026-11-15T12:00:00Z' }),
      fixContract({ finding_id: 'F2', verdict: 'FAIL', verified_at: '2026-11-15T12:05:00Z' }),
    ],
    spawned_fix_agents: 2,
    current_plan: wavePlan('wave5'),
  });
  expect('退出码 0', r.code === 0, `实际 ${r.code}，stderr：${r.err.slice(0, 300)}`);
}

console.log('case 17: phase=wave5 有契约没有裁决 → 拒绝结束（exit 2）');
{
  const r = runHook({
    phase: 'wave5', status: 'RUNNING', in_flight: [],
    fix_contracts: [
      fixContract({ finding_id: 'F1', verdict: 'PASS', verified_at: '2026-11-15T12:00:00Z' }),
      fixContract({ finding_id: 'F2' }),
    ],
    spawned_fix_agents: 2,
    current_plan: wavePlan('wave5'),
  });
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('提到验收裁决', /裁决|verdict/.test(r.err), r.err.slice(0, 300));
}

// ── 3.6 · harness 外部基准对账（R8 集成）──────────────────────────────
// 这一段存在的理由：R7 实测出「洞 1」——8 条发现登记成 8 个假 fix_agent_id、
// spawned=8、实际 1 个 session 做完，3.5 的三条判据全放行（数字全来自 state.json）。
// 3.6 引入 harness 的 session 日志作为外部基准。下面的用例证明它**真的会拦**，
// 而不只是「代码写了」。
import { zstdCompressSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';

function makeFakeDshSession(root, projectDir, sessionId, { subagentCalls, toolCalls = 10, steps = 5 }) {
  const dir = join(root, projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const events = [
    { type: 'session', version: 4, id: sessionId, cwd: 'D:\\fake', delegationDepth: 0 },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'request/header', data: { header: { tools: [{ name: 'subagent' }, { name: 'read' }] } } },
  ];
  for (let i = 0; i < toolCalls; i++) {
    events.push({ type: 'tool/call', data: { turn: 1, step: i + 1, name: 'read', arguments: '{}' } });
  }
  for (let i = 0; i < subagentCalls; i++) {
    events.push({ type: 'tool/call', data: { turn: 1, step: steps, name: 'subagent', arguments: '{}' } });
  }
  for (let i = 0; i < steps; i++) events.push({ type: 'step/end', data: { turn: 1, step: i + 1 } });
  const z = zstdCompressSync(Buffer.from(events.map((e) => JSON.stringify(e)).join('\n') + '\n'));
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), z);
  return dir;
}

function runHookWithSessions(state, sessionsRoot) {
  const dir = mkdtempSync(join(tmpdir(), 'hook-hs-'));
  const f = join(dir, 'state.json');
  writeFileSync(f, JSON.stringify(state));
  try {
    const out = execFileSync('node', [HOOK, '--state', f], {
      input: '{}', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, DSH_SESSIONS_ROOT: sessionsRoot },
    });
    return { code: 0, err: '' };
  } catch (e) {
    return { code: e.status ?? 1, err: e.stderr ?? '', stdout: e.stdout ?? '' };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log('case 18: 洞 1 重演 —— 3 个假 fix_agent_id 但 harness 记录 0 次 subagent → 拒绝结束');
{
  const root = mkdtempSync(join(tmpdir(), 'sess-'));
  try {
    // state.json 放在 <tmp>/<projectDir上级>/docs/reports/round1/ 让推断能命中
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'docs', 'reports', 'round1'), { recursive: true });
    const projectDir = '--' + repo.replace(/ /g, '~0020').replace(/[\\/:]+/g, '-')
      .replace(/[^A-Za-z0-9_~-]+/g, '-') + '--';
    makeFakeDshSession(root, projectDir, 'session-fake-0001', { subagentCalls: 0 });
    const st = {
      phase: 'wave4', status: 'RUNNING', in_flight: [],
      path_mode: 'FIX',
      fix_contracts: [
        fixContract({ finding_id: 'F1', fix_agent_id: 'fake-1' }),
        fixContract({ finding_id: 'F2', fix_agent_id: 'fake-2' }),
        fixContract({ finding_id: 'F3', fix_agent_id: 'fake-3' }),
      ],
      budget: { spawned_fix_agents: 3 },
      current_plan: wavePlan('wave4'),
    };
    const f = join(repo, 'docs', 'reports', 'round1', 'state.json');
    writeFileSync(f, JSON.stringify(st));
    let r;
    try {
      execFileSync('node', [HOOK, '--state', f], {
        input: '{}', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DSH_SESSIONS_ROOT: root },
      });
      r = { code: 0, err: '' };
    } catch (e) { r = { code: e.status ?? 1, err: e.stderr ?? '' }; }
    expect('退出码 2', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 300)}`);
    expect('报 zero_subagent_but_multiple_agents',
      /zero_subagent_but_multiple_agents/.test(r.err), r.err.slice(0, 400));
    expect('错误消息引用外部事实而非账本',
      /session 日志|外部事实/.test(r.err), r.err.slice(0, 400));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 19: 真派了 3 次 subagent + 3 个 id + spawned=3 → 放行（exit 0）');
{
  const root = mkdtempSync(join(tmpdir(), 'sess-'));
  try {
    const repo = join(root, 'repo');
    mkdirSync(join(repo, 'docs', 'reports', 'round1'), { recursive: true });
    const projectDir = '--' + repo.replace(/ /g, '~0020').replace(/[\\/:]+/g, '-')
      .replace(/[^A-Za-z0-9_~-]+/g, '-') + '--';
    makeFakeDshSession(root, projectDir, 'session-good-0002', { subagentCalls: 3 });
    const st = {
      phase: 'wave4', status: 'RUNNING', in_flight: [], path_mode: 'FIX',
      fix_contracts: [
        fixContract({ finding_id: 'F1', fix_agent_id: 'a1' }),
        fixContract({ finding_id: 'F2', fix_agent_id: 'a2' }),
        fixContract({ finding_id: 'F3', fix_agent_id: 'a3' }),
      ],
      budget: { spawned_fix_agents: 3 },
      current_plan: wavePlan('wave4'),
    };
    const f = join(repo, 'docs', 'reports', 'round1', 'state.json');
    writeFileSync(f, JSON.stringify(st));
    let r;
    try {
      execFileSync('node', [HOOK, '--state', f], {
        input: '{}', encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, DSH_SESSIONS_ROOT: root },
      });
      r = { code: 0, err: '' };
    } catch (e) { r = { code: e.status ?? 1, err: e.stderr ?? '' }; }
    expect('退出码 0（不误拦）', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 300)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 20: 推断不出 project 目录时静默跳过，不误拦（降级纪律）');
{
  const root = mkdtempSync(join(tmpdir(), 'sess-'));
  try {
    // sessions root 存在但没有任何匹配的 project 目录
    mkdirSync(join(root, '--unrelated-project--', 'session-x'), { recursive: true });
    const st = {
      phase: 'wave4', status: 'RUNNING', in_flight: [], path_mode: 'FIX',
      fix_contracts: [
        fixContract({ finding_id: 'F1', fix_agent_id: 'a1' }),
        fixContract({ finding_id: 'F2', fix_agent_id: 'a2' }),
      ],
      budget: { spawned_fix_agents: 2 },
      current_plan: wavePlan('wave4'),
    };
    const r = runHookWithSessions(st, root);
    expect('退出码 0（环境问题不拦人）', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 300)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
