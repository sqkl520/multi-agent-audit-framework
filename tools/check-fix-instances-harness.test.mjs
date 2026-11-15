#!/usr/bin/env node
/**
 * check-fix-instances-harness.test.mjs — 用合成 dsh session 日志测「账本 vs harness 事实」对账
 *
 * 被测对象：tools/check-fix-instances-harness.mjs（R8 新建）。
 * 它要堵的是 R7 报告的洞 1：
 *
 *   1 个真实 session + 8 个假 fix_agent_id + spawned_fix_agents=8
 *   → stop-hook exit 0，R6 exit 0，全部工具绿。
 *
 * 因为 stop-hook 比的是 distinct(finding_id) 与 spawned，R6 比的是
 * distinct(fix_agent_id) 与 spawned——三个数全是主 Agent 自述，两个自述
 * 互相一致不产生外部约束力。唯一的外部基准是 harness 自己落的 session 日志：
 * 主 session 到底发起过几次 `subagent` 工具调用。
 *
 * ── 测试形态 ───────────────────────────────────────────────────────
 * 沿用仓库既有自测（dsh-session-audit.test.mjs / fix-phase-e2e.test.mjs）：
 *   - 纯 node，无第三方依赖
 *   - execFileSync 调**真实脚本**，不 mock
 *   - fixture 写到 mkdtempSync 临时目录，finally 里删掉
 *   - 合成 session 日志用 zlib.zstdCompressSync 压缩成 session.v4.jsonl.zstd，
 *     与 dsh 落盘格式一致
 *
 * ── 真实数据自证（外部基准）──────────────────────────────────────────
 * 若 <HOME>/.dsh/sessions 存在，额外跑两个真实 session：
 *   - session-a40f0162-…：真实 0 次 subagent、303 次工具调用、196 个 step
 *     （就是 2026-11-15 那次事故的修复 session）
 *   - session-d6a9f092-…：真实 3 次 subagent（审计阶段成功派发的对照）
 * 目录不存在时打印 SKIP，**不计入失败**——日志在别的机器上不该让自测变红。
 *
 * 运行：node tools/check-fix-instances-harness.test.mjs
 * 退出码：0 = 全绿 / 1 = 有失败
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-fix-instances-harness.mjs');
const REAL_ROOT = '<HOME>/.dsh/sessions';
const REAL_A40 = 'session-a40f0162-d036-49ca-8677-efb40f821c06'; // 0 次 subagent / 303 tool calls
const REAL_D6A = 'session-d6a9f092-b6df-4b41-b053-3a2e802e7214'; // 3 次 subagent

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

// ────────────────────────────────────────────────────────────────────
// fixture 构造
// ────────────────────────────────────────────────────────────────────

/** 一个 dsh session 的事件序列。字段位置严格照真实日志：
 *  `session` 事件的 id / delegationDepth / parentSession / cwd 在**顶层**。 */
function sessionEvents({
  id, depth = 0, parent = null, origin = null,
  tools = ['read', 'write', 'grep', 'subagent', 'pwsh'],
  steps = 3, subagentCalls = 0, otherCalls = 0,
}) {
  const ev = [{
    type: 'session', version: 4, id, cwd: 'C:\\ws',
    delegationDepth: depth,
    ...(parent ? { parentSession: parent } : {}),
    ...(origin ? { origin } : {}),
  }];
  // tools === null 表示「日志里没有 request/header」（无法判断能力）
  if (tools) ev.push({ type: 'request/header', data: { header: { tools: tools.map((n) => ({ name: n })) } } });
  for (let i = 1; i <= steps; i++) ev.push({ type: 'step/start', data: { turn: 1, step: i } });
  for (let i = 0; i < subagentCalls; i++) {
    ev.push({
      type: 'tool/call',
      data: {
        turn: 1, step: 1, callId: `call-sub-${i}`, name: 'subagent',
        arguments: JSON.stringify({ description: `子任务 ${i}`, prompt: '只做静态审计' }),
      },
    });
  }
  for (let i = 0; i < otherCalls; i++) {
    ev.push({ type: 'tool/call', data: { turn: 1, step: 1, callId: `call-o-${i}`, name: 'read', arguments: '{}' } });
  }
  return ev;
}

/** 造一个 sessions root：<root>/<projectDir>/<sessionDir>/session.v4.jsonl.zstd */
function makeRoot(projectDir, sessions) {
  const root = mkdtempSync(join(tmpdir(), 'fix-harness-'));
  for (const s of sessions) {
    const sd = join(root, projectDir, s.dir);
    mkdirSync(sd, { recursive: true });
    const body = s.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    const file = join(sd, 'session.v4.jsonl.zstd');
    writeFileSync(file, zstdCompressSync(Buffer.from(body, 'utf8')));
    if (s.mtime) {
      const t = s.mtime / 1000;
      utimesSync(file, t, t);
      utimesSync(sd, t, t);
    }
  }
  return root;
}

/** state.json 的最小形状（只保留本检查器读的字段）。 */
function stateOf({ ids = [], spawned, contracts } = {}) {
  const cs = contracts ?? ids.map((id, i) => ({
    finding_id: `round3-A::A-0${i + 1}`,
    fix_agent_id: id,
    registered_at: '2026-11-15T10:00:00Z',
    defect_statement: '当 X 时 Y 会发生，预期是 Z',
    target_files: [`src/f${i + 1}.java`],
  }));
  return {
    schema_version: 'run-state-v1',
    trace_id: 'trace-r8-test',
    round_id: 'round1',
    path_mode: 'FIX',
    phase: 'wave4',
    status: 'RUNNING',
    budget: spawned === undefined
      ? { total_cap: 60, spent: 10 }
      : { total_cap: 60, spent: 10, spawned_fix_agents: spawned },
    discipline_log: [],
    fix_contracts: cs,
  };
}

function writeState(marker, st) {
  const dir = mkdtempSync(join(tmpdir(), `fix-harness-state-${marker}-`));
  const p = join(dir, 'state.json');
  writeFileSync(p, JSON.stringify(st, null, 2));
  return { dir, path: p };
}

/** 调真实脚本。返回 { code, data, out, err }。 */
function run(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out, err: '', data: safeJson(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    return { code: typeof e.status === 'number' ? e.status : -1, out, err: e.stderr?.toString() ?? '', data: safeJson(out) };
  }
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

const rulesOf = (r, level) => (r.data?.problems ?? [])
  .filter((p) => (level ? p.level === level : true)).map((p) => p.rule);
const hasRule = (r, rule, level) => (r.data?.problems ?? [])
  .some((p) => p.rule === rule && (!level || p.level === level));

// ════════════════════════════════════════════════════════════════════
// A · 配置错误与 harness 探测
// ════════════════════════════════════════════════════════════════════
console.log('\n=== A：配置错误与 harness 探测（不能让工具在「没有日志」时假装绿，也不能在别家 harness 上卡死）===');

{
  const st = writeState('A1', stateOf({ ids: ['fix-1'], spawned: 1 }));

  const missingRoot = run(['--state', st.path, '--sessions', join(st.dir, 'no-such-root'), '--json']);
  expect('A1 [R8] sessions root 不存在 → exit 2', missingRoot.code === 2, `code=${missingRoot.code}`);
  expect('A1 [R8] 报 sessions_root_missing', /sessions_root_missing/.test(missingRoot.err + missingRoot.out));

  const noState = run(['--state', join(st.dir, 'nope.json'), '--sessions', st.dir, '--json']);
  expect('A2 [R8] state.json 不存在 → exit 2', noState.code === 2, `code=${noState.code}`);
  expect('A2 [R8] 报 state_missing', /state_missing/.test(noState.err + noState.out));

  const usage = run(['--json']);
  expect('A3 [R8] 缺必填参数 → exit 2（用法错误，不是通过）', usage.code === 2, `code=${usage.code}`);

  // 空目录 = 不是 dsh（没有 session.v4.jsonl.zstd 任何一份）
  const emptyRoot = mkdtempSync(join(tmpdir(), 'fix-harness-empty-'));
  try {
    const r = run(['--state', st.path, '--sessions', emptyRoot, '--json']);
    expect('A4 [R8] 无 dsh 格式日志 → exit 0（unsupported_harness 不能卡死别家 harness）', r.code === 0, `code=${r.code}`);
    expect('A4 [R8] 报 unsupported_harness WARN', hasRule(r, 'unsupported_harness', 'WARN'), JSON.stringify(rulesOf(r)));
    expect('A4 [R8] 同时把退出码写进 JSON（exitCode 0）', r.data?.exitCode === 0);
    expect('A4 [R8] 不会因为「没证据」判 FAIL', (r.data?.problems ?? []).every((p) => p.level !== 'FAIL'));
  } finally { rmSync(emptyRoot, { recursive: true, force: true }); }

  const bogus = run(['--state', st.path, '--sessions', st.dir, '--session-id', 'session-deadbeef-0000-0000-0000-000000000000', '--json']);
  expect('A5 [R8] 指定 session 找不到 → exit 2', bogus.code === 2, `code=${bogus.code}`);
  expect('A5 [R8] 报 session_not_found', /session_not_found/.test(bogus.err + bogus.out));

  rmSync(st.dir, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════════
// B · 核心：账本声称的实例数 vs 真实 subagent 调用数
// ════════════════════════════════════════════════════════════════════
console.log('\n=== B：核心对账（洞 1 的形状：1 个真实 session + 8 个假 fix_agent_id）===');

{
  // B1 洞 1 的最小形状：真实 1 次 subagent，账本 8 个 id。
  // spawned 故意写 1，让「rule 5」不触发——这样能证明 rule 3 是独立生效的，
  // 不是被 spawned 数字顺带满足的。
  const root = makeRoot('--D-Tmp-hole1--', [{
    dir: 'session-aaaaaaaa-1111-2222-3333-444444444444',
    events: sessionEvents({
      id: 'session-aaaaaaaa-1111-2222-3333-444444444444',
      subagentCalls: 1, otherCalls: 40, steps: 20,
    }),
  }]);
  const st = writeState('B1', stateOf({ ids: Array.from({ length: 8 }, (_, i) => `fake-agent-${i + 1}`), spawned: 1 }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('B1 [R8] 8 个 id vs 1 次真实 subagent → exit 1', r.code === 1, `code=${r.code}`);
    expect('B1 [R8] 报 claimed_agents_exceed_real_subagents（FAIL）', hasRule(r, 'claimed_agents_exceed_real_subagents', 'FAIL'), JSON.stringify(rulesOf(r)));
    const msg = (r.data?.problems ?? []).find((p) => p.rule === 'claimed_agents_exceed_real_subagents')?.message ?? '';
    expect('B1 [R8] 消息写明「账本声称派发了 8 个修复实例」', /账本声称派发了 8 个修复实例/.test(msg), msg.slice(0, 120));
    expect('B1 [R8] 消息写明「只发起了 1 次 subagent 调用」', /只发起了 1 次 subagent 调用/.test(msg));
    expect('B1 [R8] 消息写明「这 8 个 id 里有 7 个没有对应的真实派发」', /这 8 个 id 里有 7 个没有对应的真实派发/.test(msg));
    expect('B1 [R8] 消息点明「session 日志是外部事实」', /session 日志是外部事实/.test(msg));
    expect('B1 [R8] spawned=1 与真实 1 次一致 → 不触发 rule 5', !hasRule(r, 'spawned_count_exceeds_real'), JSON.stringify(rulesOf(r)));
    expect('B1 [R8] JSON 里 realSubagentCalls 精确为 1', r.data?.realSubagentCalls === 1, String(r.data?.realSubagentCalls));
    expect('B1 [R8] JSON 里 claimedAgents 精确为 8', r.data?.claimedAgents === 8, String(r.data?.claimedAgents));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); }
}

{
  // B1b 真实洞 1 的完整写法：spawned 也写 8 → rule 3 与 rule 5 同时响
  const root = makeRoot('--D-Tmp-hole1b--', [{
    dir: 'session-bbbbbbbb-1111-2222-3333-444444444444',
    events: sessionEvents({ id: 'session-bbbbbbbb-1111-2222-3333-444444444444', subagentCalls: 1, otherCalls: 10, steps: 6 }),
  }]);
  const st = writeState('B1b', stateOf({ ids: Array.from({ length: 8 }, (_, i) => `fake-agent-${i + 1}`), spawned: 8 }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('B1b [R8] spawned=8 + 真实 1 次 → exit 1', r.code === 1, `code=${r.code}`);
    expect('B1b [R8] rule 3 与 rule 5 同时报出', hasRule(r, 'claimed_agents_exceed_real_subagents', 'FAIL') && hasRule(r, 'spawned_count_exceeds_real', 'FAIL'), JSON.stringify(rulesOf(r)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); }
}

{
  // B2 最关键：0 次 subagent + 5 个 id。这就是 2026-11-15 那次事故的形状。
  const id = 'session-cccccccc-1111-2222-3333-444444444444';
  const root = makeRoot('--D-Tmp-zero--', [{
    dir: id,
    events: sessionEvents({ id, subagentCalls: 0, otherCalls: 303, steps: 196 }),
  }]);
  const st = writeState('B2', stateOf({ ids: Array.from({ length: 5 }, (_, i) => `fake-agent-${i + 1}`), spawned: 5 }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('B2 [R8] 0 次 subagent + 5 个 id → exit 1', r.code === 1, `code=${r.code}`);
    expect('B2 [R8] 报 zero_subagent_but_multiple_agents（FAIL）', hasRule(r, 'zero_subagent_but_multiple_agents', 'FAIL'), JSON.stringify(rulesOf(r)));
    const msg = (r.data?.problems ?? []).find((p) => p.rule === 'zero_subagent_but_multiple_agents')?.message ?? '';
    expect('B2 [R8] 消息点名这是「与 2026-11-15 那次真实事故完全同形」', /与 2026-11-15 那次真实事故完全同形/.test(msg), msg.slice(0, 160));
    expect('B2 [R8] 消息引用事故基线「303 次工具调用、196 个 step、0 次 subagent」', /303 次工具调用、196 个 step、0 次 subagent/.test(msg));
    expect('B2 [R8] 消息带上本 session 的实测数字', /本 session 实测：303 次工具调用、196 个 step、0 次 subagent/.test(msg));
    expect('B2 [R8] JSON 里 realSubagentCalls 为 0 / realToolCalls 303 / realSteps 196',
      r.data?.realSubagentCalls === 0 && r.data?.realToolCalls === 303 && r.data?.realSteps === 196,
      JSON.stringify({ s: r.data?.realSubagentCalls, t: r.data?.realToolCalls, st: r.data?.realSteps }));
    expect('B2 [R8] 0 次场景下 rule 3 不再重复报（避免一个成因报两条）', !hasRule(r, 'claimed_agents_exceed_real_subagents'), JSON.stringify(rulesOf(r)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); }
}

{
  // B3 真派发了 5 个实例 → 必须放行（否则这个检查器会把正常流程判红）
  const id = 'session-dddddddd-1111-2222-3333-444444444444';
  const children = Array.from({ length: 5 }, (_, i) => {
    const cid = `dddddddd-child-${i}`;
    return { dir: cid, events: sessionEvents({ id: cid, depth: 1, parent: id, origin: 'subagent', subagentCalls: 0, otherCalls: 3 }) };
  });
  const root = makeRoot('--D-Tmp-green--', [
    { dir: id, events: sessionEvents({ id, subagentCalls: 5, otherCalls: 30, steps: 12 }) },
    ...children,
  ]);
  const st = writeState('B3', stateOf({ ids: ['fix-a', 'fix-b', 'fix-c', 'fix-d', 'fix-e'], spawned: 5 }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('B3 [R8] 5 次真实 subagent + 5 个 id + spawned=5 → exit 0', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('B3 [R8] 没有任何 FAIL', (r.data?.problems ?? []).every((p) => p.level !== 'FAIL'), JSON.stringify(rulesOf(r, 'FAIL')));
    expect('B3 [R8] 子 session 数正确反映为 5', r.data?.childSessions === 5, String(r.data?.childSessions));
    expect('B3 [R8] 不报 child_sessions_missing', !hasRule(r, 'child_sessions_missing'));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); }
}

{
  // B4 spawned 记多：真实 3 次，账本写 8
  const id = 'session-eeeeeeee-1111-2222-3333-444444444444';
  const root = makeRoot('--D-Tmp-spawn--', [{
    dir: id, events: sessionEvents({ id, subagentCalls: 3, otherCalls: 8, steps: 5 }),
  }]);
  const st = writeState('B4', stateOf({ ids: ['fix-a', 'fix-b', 'fix-c'], spawned: 8 }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('B4 [R8] spawned=8 但真实只有 3 次 → exit 1', r.code === 1, `code=${r.code}`);
    expect('B4 [R8] 报 spawned_count_exceeds_real（FAIL）', hasRule(r, 'spawned_count_exceeds_real', 'FAIL'), JSON.stringify(rulesOf(r)));
    expect('B4 [R8] 3 个 id ≤ 3 次真实 → 不报 rule 3', !hasRule(r, 'claimed_agents_exceed_real_subagents'));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); }
}

{
  // B5 真实调用多于账本（重试/多轮）不判 FAIL，但要留下可见记录
  const id = 'session-ffffffff-1111-2222-3333-444444444444';
  const root = makeRoot('--D-Tmp-more--', [{
    dir: id, events: sessionEvents({ id, subagentCalls: 6, otherCalls: 5, steps: 4 }),
  }]);
  const st = writeState('B5', stateOf({ ids: ['fix-a', 'fix-b', 'fix-c', 'fix-d'], spawned: 4 }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('B5 [R8] 真实 6 次 > 账本 4 个 → exit 0（多派发不是违规）', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r, 'FAIL'))}`);
    expect('B5 [R8] 记一条 more_real_dispatches_than_claimed INFO',
      (r.data?.infos ?? []).some((i) => i.rule === 'more_real_dispatches_than_claimed')
      || hasRule(r, 'more_real_dispatches_than_claimed'), JSON.stringify(r.data?.infos ?? []));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); }
}

{
  // B6 边界：只有 1 条契约、0 次真实派发。规则 3 的字面要求仍判 FAIL（账本比事实多 1），
  // 但要给一条可操作提示——因为最常见成因是「一条缺陷主 Agent 自己改了」，不是造假。
  const id = 'session-20000000-0000-0000-0000-000000000001';
  const root = makeRoot('--D-Tmp-single--', [{
    dir: id, events: sessionEvents({ id, subagentCalls: 0, otherCalls: 50, steps: 10 }),
  }]);
  const st = writeState('B6', stateOf({ ids: ['fix-session-1'], spawned: 1 }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('B6 [R8] 1 条契约 + 0 次派发 → exit 1（账本比事实多）', r.code === 1, `code=${r.code}`);
    expect('B6 [R8] 报规则 3（claimed_agents_exceed_real_subagents）', hasRule(r, 'claimed_agents_exceed_real_subagents', 'FAIL'), JSON.stringify(rulesOf(r)));
    expect('B6 [R8] 附带 single_contract_without_dispatch 提示（可操作，不是纯阻断）', hasRule(r, 'single_contract_without_dispatch', 'WARN'), JSON.stringify(rulesOf(r)));
    expect('B6 [R8] 提示里给了「记 0 + discipline_log 申报」的出路', /discipline_log/.test((r.data?.problems ?? []).find((p) => p.rule === 'single_contract_without_dispatch')?.message ?? ''));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); }
}

// ════════════════════════════════════════════════════════════════════
// C · 三条 WARN 与合法降级
// ════════════════════════════════════════════════════════════════════
console.log('\n=== C：WARN 类规则（必须可见，但不能单独把流程卡死）===');

{
  // C1 harness 没有 subagent 能力 → 合法降级：不能判 FAIL
  const id = 'session-11112222-3333-4444-5555-666666666666';
  const root = makeRoot('--D-Tmp-nosub--', [{
    dir: id,
    events: sessionEvents({ id, tools: ['read', 'write', 'grep', 'pwsh'], subagentCalls: 0, otherCalls: 12, steps: 6 }),
  }]);
  const st = writeState('C1', stateOf({ ids: Array.from({ length: 5 }, (_, i) => `fake-agent-${i + 1}`), spawned: 5 }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('C1 [R8] 工具集无 subagent → exit 0（合法降级，不阻断）', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r, 'FAIL'))}`);
    expect('C1 [R8] 报 no_subagent_capability（WARN）', hasRule(r, 'no_subagent_capability', 'WARN'), JSON.stringify(rulesOf(r)));
    expect('C1 [R8] rule 4 被降级为 WARN 但仍可见', hasRule(r, 'zero_subagent_but_multiple_agents', 'WARN'), JSON.stringify(rulesOf(r)));
    expect('C1 [R8] 降级后没有任何 FAIL', (r.data?.problems ?? []).every((p) => p.level !== 'FAIL'));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); }
}

{
  // C2 真实调用 3 次，但只找到 1 个子 session（可能被归档/清理）→ WARN
  const id = 'session-77778888-9999-aaaa-bbbb-cccccccccccc';
  const child = 'child-archived-1';
  const root = makeRoot('--D-Tmp-child--', [
    { dir: id, events: sessionEvents({ id, subagentCalls: 3, otherCalls: 9, steps: 7 }) },
    { dir: child, events: sessionEvents({ id: child, depth: 1, parent: id, origin: 'subagent', otherCalls: 2 }) },
  ]);
  const st = writeState('C2', stateOf({ ids: ['fix-a', 'fix-b', 'fix-c'], spawned: 3 }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('C2 [R8] 3 次调用只找到 1 个子 session → exit 0（不能单独判 FAIL）', r.code === 0, `code=${r.code}`);
    expect('C2 [R8] 报 child_sessions_missing（WARN）', hasRule(r, 'child_sessions_missing', 'WARN'), JSON.stringify(rulesOf(r)));
    expect('C2 [R8] JSON 里真实调用数仍记为 3', r.data?.realSubagentCalls === 3, String(r.data?.realSubagentCalls));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); }
}

{
  // C3 fix_agent_id 长得像 session id，但 sessions root 下不存在 → WARN
  const id = 'session-ddddeeee-ffff-0000-1111-222222222222';
  const ghost = 'session-99999999-8888-7777-6666-555555555555';
  const root = makeRoot('--D-Tmp-ghost--', [{
    dir: id, events: sessionEvents({ id, subagentCalls: 1, otherCalls: 4, steps: 3 }),
  }]);
  const st = writeState('C3', stateOf({ ids: [ghost], spawned: 1 }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('C3 [R8] 伪造 session id 形状的 fix_agent_id → exit 0', r.code === 0, `code=${r.code}`);
    expect('C3 [R8] 报 session_id_mismatch（WARN）', hasRule(r, 'session_id_mismatch', 'WARN'), JSON.stringify(rulesOf(r)));
    expect('C3 [R8] 消息点名那个不存在的 id', ((r.data?.problems ?? []).find((p) => p.rule === 'session_id_mismatch')?.message ?? '').includes(ghost));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); }
}

{
  // C4 fix_agent_id 就是真实存在的子 session id → 不报 session_id_mismatch
  const id = 'session-aaaa1111-bbbb-2222-cccc-333333333333';
  const realChild = 'aaaa1111-bbbb-2222-cccc-333333333333';
  const root = makeRoot('--D-Tmp-realchild--', [
    { dir: id, events: sessionEvents({ id, subagentCalls: 1, otherCalls: 4, steps: 3 }) },
    { dir: realChild, events: sessionEvents({ id: realChild, depth: 1, parent: id, origin: 'subagent', otherCalls: 2 }) },
  ]);
  const st = writeState('C4', stateOf({ ids: [realChild], spawned: 1 }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('C4 [R8] fix_agent_id 是真实子 session id → exit 0', r.code === 0, `code=${r.code}`);
    expect('C4 [R8] 不报 session_id_mismatch', !hasRule(r, 'session_id_mismatch'), JSON.stringify(rulesOf(r)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); }
}

// ════════════════════════════════════════════════════════════════════
// D · 主 session 的推断
// ════════════════════════════════════════════════════════════════════
console.log('\n=== D：省略 --session-id 时的推断（取该 project 下最新顶层 session）===');

{
  const oldId = 'session-0000aaaa-0000-0000-0000-000000000001';
  const newId = 'session-0000aaaa-0000-0000-0000-000000000002';
  const root = makeRoot('--D-Tmp-infer--', [
    { dir: oldId, events: sessionEvents({ id: oldId, subagentCalls: 1, otherCalls: 2, steps: 2 }), mtime: Date.now() - 3600_000 },
    { dir: newId, events: sessionEvents({ id: newId, subagentCalls: 2, otherCalls: 2, steps: 2 }), mtime: Date.now() },
  ]);
  const st = writeState('D1', stateOf({ ids: ['fix-a', 'fix-b'], spawned: 2 }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--project-dir', '--D-Tmp-infer--', '--json']);
    expect('D1 [R8] 省略 --session-id → 选中最新顶层 session', r.data?.session?.id === newId, `got=${r.data?.session?.id}`);
    expect('D1 [R8] 该 session 真实 2 次 subagent → exit 0', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r, 'FAIL'))}`);

    const r2 = run(['--state', st.path, '--sessions', root, '--json']);
    expect('D2 [R8] 只有一个 project 目录时自动识别（不需要 --project-dir）', r2.data?.session?.id === newId, `got=${r2.data?.session?.id}`);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); }
}

{
  const childOnly = '11112222-0000-0000-0000-000000000009';
  const root = makeRoot('--D-Tmp-childrenonly--', [{
    dir: childOnly, events: sessionEvents({ id: childOnly, depth: 1, parent: 'session-gone', origin: 'subagent', otherCalls: 2 }),
  }]);
  const st = writeState('D3', stateOf({ ids: ['fix-a'], spawned: 1 }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('D3 [R8] project 下只有子 session（无顶层）→ exit 2', r.code === 2, `code=${r.code}`);
    expect('D3 [R8] 报 session_not_found 并说明原因', /session_not_found/.test(r.err + r.out));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); }
}

// ════════════════════════════════════════════════════════════════════
// E · 真实数据自证（日志在别的机器上不存在时 SKIP，不算失败）
// ════════════════════════════════════════════════════════════════════
console.log('\n=== E：真实 dsh session 自证（外部基准）===');

if (!existsSync(REAL_ROOT)) {
  console.log(`  SKIP: ${REAL_ROOT} 不存在——真实 session 日志不在这台机器上，按降级处理（不计失败）`);
} else {
  {
    // a40f0162：303 次工具调用 / 196 step / 0 次 subagent，就是那次事故的修复 session
    const st = writeState('E1', stateOf({
      ids: Array.from({ length: 8 }, (_, i) => `fake-agent-${i + 1}`), spawned: 8,
    }));
    try {
      const r = run(['--state', st.path, '--sessions', REAL_ROOT, '--session-id', REAL_A40, '--json']);
      expect('E1 [real/a40f0162] 能定位到该 session', r.data?.session?.id === REAL_A40, String(r.data?.session?.id ?? r.err.slice(0, 120)));
      expect('E1 [real] 真实 subagent 调用数 = 0', r.data?.realSubagentCalls === 0, String(r.data?.realSubagentCalls));
      expect('E1 [real] 真实工具调用数 = 303', r.data?.realToolCalls === 303, String(r.data?.realToolCalls));
      expect('E1 [real] 真实 step 数 = 196', r.data?.realSteps === 196, String(r.data?.realSteps));
      expect('E1 [real] 8 个假 id 被核心规则拦下（exit 1）',
        (hasRule(r, 'zero_subagent_but_multiple_agents', 'FAIL')
          || hasRule(r, 'claimed_agents_exceed_real_subagents', 'FAIL')) && r.code === 1,
        `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
      expect('E1 [real] 0 次 subagent → 报 rule 4（比 rule 3 更精确）', hasRule(r, 'zero_subagent_but_multiple_agents', 'FAIL'), JSON.stringify(rulesOf(r)));
      expect('E1 [real] spawned=8 同时触发 rule 5', hasRule(r, 'spawned_count_exceeds_real', 'FAIL'), JSON.stringify(rulesOf(r)));
      const msg = (r.data?.problems ?? []).find((p) => p.rule === 'zero_subagent_but_multiple_agents')?.message ?? '';
      expect('E1 [real] 报告里能引用真实的 303 次工具调用 / 196 step',
        /303 次工具调用/.test(msg) && /196 个 step/.test(msg), msg.slice(0, 200));
      console.log(`    → a40f0162: subagent=0 toolCalls=${r.data?.realToolCalls} steps=${r.data?.realSteps} exit=${r.code} rules=${JSON.stringify(rulesOf(r))}`);
    } finally { rmSync(st.dir, { recursive: true, force: true }); }
  }

  {
    // d6a9f092：审计阶段真实 3 次 subagent，账本也记 3 → 必须放行
    const st = writeState('E2', stateOf({ ids: ['audit-a', 'audit-b', 'audit-c'], spawned: 3 }));
    try {
      const r = run(['--state', st.path, '--sessions', REAL_ROOT, '--session-id', REAL_D6A, '--json']);
      expect('E2 [real/d6a9f092] 能定位到该 session', r.data?.session?.id === REAL_D6A, String(r.data?.session?.id ?? r.err.slice(0, 120)));
      expect('E2 [real] 真实 subagent 调用数 = 3', r.data?.realSubagentCalls === 3, String(r.data?.realSubagentCalls));
      expect('E2 [real] 3 次真实派发 + 3 个 id + spawned=3 → exit 0', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
      expect('E2 [real] 找到 3 个子 session（parentSession 反查）', r.data?.childSessions === 3, String(r.data?.childSessions));
      expect('E2 [real] 无 FAIL', (r.data?.problems ?? []).every((p) => p.level !== 'FAIL'), JSON.stringify(rulesOf(r, 'FAIL')));
      console.log(`    → d6a9f092: subagent=${r.data?.realSubagentCalls} children=${r.data?.childSessions} exit=${r.code} rules=${JSON.stringify(rulesOf(r))}`);
    } finally { rmSync(st.dir, { recursive: true, force: true }); }
  }
}

// ════════════════════════════════════════════════════════════════════
console.log(`\n合计: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
