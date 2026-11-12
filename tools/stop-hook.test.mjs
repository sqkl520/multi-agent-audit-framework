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

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
