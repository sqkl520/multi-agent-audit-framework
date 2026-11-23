#!/usr/bin/env node
/**
 * stop-hook.test.mjs — Stop hook 的自测
 *
 * 为什么必须测：这是本框架里**唯一一个由 harness 强制**的机制。
 * 如果它自己错了，要么误拦（正常的回合结束被判违规），要么漏拦（什么都不做）。
 * 而它的失败模式很隐蔽——退出码错了，用户只会觉得「hook 好像没生效」。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'stop-hook.mjs');

// 2026-11-16（R17）：一个真实存在的「被审仓库」临时目录，供 §3.7 第二道闸门
// （check-payload --repo）解析信封里的相对路径。必须定义在文件顶部：
// case 19/20 在 §3.7 段之前就要用，而 `const` 在模块作用域里有 TDZ，
// 定义在后面会在运行时抛 ReferenceError。
//
// 里面的两个文件对应测试信封里的 test_path / red_log_path：
//   red/red.log   修复前为红的日志
//   test/t.mjs    测试文件
//   src/main.js   files_touched[] 里声明的改动文件（R18 起会被 check-payload 校验存在性）
//   src/A.java    同上，writeValidFixArtifact 的默认值
const FIXTURE_REPO = (() => {
  const d = mkdtempSync(join(tmpdir(), 'repo-'));
  mkdirSync(join(d, 'red'), { recursive: true });
  mkdirSync(join(d, 'test'), { recursive: true });
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'red', 'red.log'), 'FAIL: 修复前测试为红\n');
  writeFileSync(join(d, 'test', 't.mjs'), '// 测试\n');
  writeFileSync(join(d, 'src', 'main.js'), '// 合成 fixture：被「改过」的源文件\n');
  writeFileSync(join(d, 'src', 'A.java'), 'class A {}\n');
  return d;
})();

let pass = 0, fail = 0;
let skipped = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

// ── 2026-11-24：慢环境下跳过 spawn 密集用例，但**绝不静默** ──
//
// 实测这台 Windows 机器上**任何进程启动都要 2–3 秒**（`node -e 0` 3.4s、
// `cmd /c echo` 2.9s、`git --version` 2.0s）——典型是杀毒软件实时扫描。
// 本套件要 spawn 上百个进程，同样代码在 CI（Linux）整个套件只要 **17 秒**。
//
// 这不是测试写得慢，是环境慢。让它跑到超时是最差的选择：
// check-all 会卡死十几分钟，而人只会看到「某个套件超时」，不知道发生了什么。
//
// 判据：实测一次 node 进程启动的耗时。超过 1.2s 视为慢环境。
// 慢环境下跳过两批 spawn 密集用例，并把跳过**逐条打印**、
// 计入 `skipped` 计数、写进退出信息——跳过必须在输出里可见，
// 否则就是「声称测过其实没测」，正是这个仓库反复记录的失败形态。
const SPAWN_SLOW = (() => {
  const t0 = Date.now();
  try { spawnSync(process.execPath, ['-e', '0'], { stdio: 'pipe' }); } catch { return false; }
  return Date.now() - t0 > 1200;
})();
// 兼容旧名：下面 R19 那批的判断也用它
const GIT_SLOW = SPAWN_SLOW;

const skipIt = (name, why) => {
  skipped++;
  console.log(`  ⊘ ${name} — 跳过：${why}`);
};

// 返回 { code, err }
function writeState(dir, st){ const f=join(dir,"state.json"); writeFileSync(f, JSON.stringify(st)); return f; }

// 2026-11-15（R15）：§3.7 的空目录判据收紧了。
// 从「空目录 → WARN」改为「空目录 + in_flight 为空 → 拒绝闭合」，
// 因为 R14 发现「把 dir_path 指向一个空目录」是「用一条 WARN 换掉闸门」的另一种写法。
// 所以凡是想要 §3.7 放行的用例，必须真的放一份带信封的产物进去——
// 不能再用空目录「蒙混」过闸门（那正是被堵掉的行为）。
function writeValidFixArtifact(dir, name = 'done-1.md') {
  const env = {
    schema_version: 'output-contract-v1',
    agent_id: 'agent-1', role: 'fix', status: 'SUCCESS',
    contract_valid: true, artifact_path: `${name}`,
    // 2026-11-16（R17）：§3.7 多了第二道闸门（check-payload）。它会真的去
    // existsSync 这两个证据路径，所以不能再写指不到任何文件的占位路径——
    // 否则下面「这是 §3.6 的用例」的断言会因为新闸门而 exit 2，测的东西就变了。
    // 路径相对 FIXTURE_REPO（见下方 §3.7 段），由 locateEvidence 的 --repo 根解析。
    payload: {
      finding_id: 'F1', disposition: 'FIXED',
      test_path: 'test/t.mjs', red_log_path: 'red/red.log',
      files_touched: [{ path: 'src/A.java', change_summary: 'x' }],
    },
    error: null,
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name),
    `# fix 产物\n\n\`\`\`json\n${JSON.stringify(env, null, 2)}\n\`\`\`\n`);
}

// 返回 { code, err }
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
// mkdirSync 已在文件顶部 import（R17 起顶部就需要它来造 FIXTURE_REPO）

function makeFakeDshSession(root, projectDir, sessionId, { subagentCalls, toolCalls = 10, steps = 5, writes = [] }) {
  const dir = join(root, projectDir, sessionId);
  mkdirSync(dir, { recursive: true });
  const events = [
    { type: 'session', version: 4, id: sessionId, cwd: 'D:\\fake', delegationDepth: 0 },
    { type: 'turn/start', data: { turn: 1 } },
    { type: 'request/header', data: { header: { tools: [{ name: 'subagent' }, { name: 'read' }, { name: 'write' }, { name: 'edit' }] } } },
  ];
  for (let i = 0; i < toolCalls; i++) {
    events.push({ type: 'tool/call', data: { turn: 1, step: i + 1, name: 'read', arguments: '{}' } });
  }
  for (let i = 0; i < subagentCalls; i++) {
    events.push({ type: 'tool/call', data: { turn: 1, step: steps, name: 'subagent', arguments: '{}' } });
  }
  // 2026-11-17（R21）：§3.6b 会把 session 里的 write/edit 记录与 files_touched 对账。
  // 想让一个用例**只**测 §3.6，就必须让它的写记录与产物信封里声称的文件对得上，
  // 否则一条与本节无关的 overclaim FAIL 会混进断言里。
  for (const w of writes) {
    events.push({
      type: 'tool/call',
      data: { turn: 1, step: 1, name: 'write', arguments: JSON.stringify({ file_path: w, content: '// x\n' }) },
    });
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
    const ARTIFACT_DIR = join(repo, 'fix-out');
    writeValidFixArtifact(ARTIFACT_DIR);
    const projectDir = '--' + repo.replace(/ /g, '~0020').replace(/[\\/:]+/g, '-')
      .replace(/[^A-Za-z0-9_~-]+/g, '-') + '--';
    makeFakeDshSession(root, projectDir, 'session-fake-0001', {
      subagentCalls: 0,
      // R21：§3.6b 也会看这个 session 的 write 记录。本 case 测的是 §3.6（0 次派发），
      // 所以让写记录与 writeValidFixArtifact 声称的 src/A.java 对得上，不引入第二条 FAIL。
      writes: [join(FIXTURE_REPO, 'src', 'A.java')],
    });
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
      // 2026-11-15（R14）：让 exit 2 的理由只有一个来源（§3.6 的 harness 对账），
      // 否则本 case 会在「账本缺 report.dir_path」上也 exit 2，测的就不再是 §3.6。
      report: { dir_ready: true, dir_path: ARTIFACT_DIR },
      // 2026-11-16（R17）：§3.7 第二道闸门需要被审仓库根来解析证据相对路径。
      // 指向 FIXTURE_REPO（顶部造的真实目录，含 red/red.log 与 test/t.mjs），
      // 否则这条 case 会因为「账本缺 target_repo」而 exit 2，测的就不再是 §3.6。
      target_repo: FIXTURE_REPO,
    };
    // f 的定义在 status 分支之后，这里要用到，提前声明
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
    const ARTIFACT_DIR = join(repo, 'fix-out');
    writeValidFixArtifact(ARTIFACT_DIR);
    const projectDir = '--' + repo.replace(/ /g, '~0020').replace(/[\\/:]+/g, '-')
      .replace(/[^A-Za-z0-9_~-]+/g, '-') + '--';
    makeFakeDshSession(root, projectDir, 'session-good-0002', {
      subagentCalls: 3,
      // R21：同 case 18，让 §3.6b 的写记录与产物声称的文件一致。
      writes: [join(FIXTURE_REPO, 'src', 'A.java')],
    });
    const st = {
      phase: 'wave4', status: 'RUNNING', in_flight: [], path_mode: 'FIX',
      fix_contracts: [
        fixContract({ finding_id: 'F1', fix_agent_id: 'a1' }),
        fixContract({ finding_id: 'F2', fix_agent_id: 'a2' }),
        fixContract({ finding_id: 'F3', fix_agent_id: 'a3' }),
      ],
      budget: { spawned_fix_agents: 3 },
      current_plan: wavePlan('wave4'),
      // 2026-11-15（R14）：wave4 + 契约非空时必须有可推断的产物目录，
      // 否则 §3.7 会拒绝闭合（report_dir_required）。本 case 测的是 §3.6 的 harness 对账，
      // 所以把目录指向一个真实存在但没有产物的空目录（§3.7 只会 WARN「没有对象可查」）。
      report: { dir_ready: true, dir_path: ARTIFACT_DIR },
      // 2026-11-16（R17）：同 case 18，第二道闸门需要被审仓库根。
      target_repo: FIXTURE_REPO,
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
      // 2026-11-15（R14）：同 case 19，本 case 测的是 §3.6 的降级（推断不出 project 目录
      // → 跳过 harness 对账，不拦人），所以要把 §3.7 的输入补齐，否则 exit 2 会来自
      // 「账本缺 report.dir_path」而不是被测的那条路径。
      report: { dir_ready: true, dir_path: join(root, 'repo', 'docs', 'reports', 'round1') },
      // 2026-11-16（R17）：同 case 19，第二道闸门需要被审仓库根。
      target_repo: FIXTURE_REPO,
    };
    mkdirSync(join(root, 'repo', 'docs', 'reports', 'round1'), { recursive: true });
    // R15：空目录 + in_flight 为空 = 拒绝闭合。本 case 要测的是 §3.6 的降级，
    // 所以必须真的放一份带信封的产物，让 §3.7 走「有对象可查」那条路径。
    writeValidFixArtifact(st.report.dir_path);
    const r = runHookWithSessions(st, root);
    expect('退出码 0（环境问题不拦人）', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 300)}`);
    expect('§3.6 不因环境问题拦人（不出 zero_subagent / 对账失败）',
      !/harness 日志对账没能执行/.test(r.err), r.err.slice(0, 400));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 3.7 · 产物信封闸门接到 stop-hook（R13）────────────────────────────
// 这一段存在的理由：R12 §8 洞 B 逐字写下了一个「本轮之后仍然完全可行」的失败场景：
//
//   修复 Agent 写完 6 份 done-*.md，全都没有信封，check-payload 一次没跑。
//   stop-hook 放行（fix_contracts 非空即可）→ 本轮仍然可以闭合。
//
// 3.5/3.6 检查的全是「账本里写了什么」，没有一条检查「产物本身能不能被观测」。
// 没有信封 = check-payload 一条规则都不会跑 = 未交付，但 stop-hook 看不见。
//
// 下面每个用例都必须**真的会拦**或**真的会降级**，而不只是「代码写了」。
import { spawnSync } from 'node:child_process';

// 与 check-fix-artifacts-envelope.mjs 的判据一致：role=fix + payload.disposition
//
// 2026-11-16（R17）：§3.7 接了第二道闸门（check-payload）之后，这条 fixture 必须
// 变成**字段完全合法**的信封。理由：它被用来断言「有信封 → exit 0」，
// 而「有信封但字段错」现在会被拦。若 fixture 只写 schema_version + role + disposition，
// 它会在 check-payload 那里报 missing_top_field / fixed_without_test 之类——
// 于是这条 case 从「测信封闸门」变成了「测第二道闸门」，测的东西变了。
// 完整合法字段见 VALID_FIX_ENV()（在 §3.7 段末尾定义）；这里保留一个字面量版本，
// 因为它在文件里出现得比 VALID_FIX_ENV 早（TDZ）。
const GOOD_ENVELOPE = '\n```json\n'
  + JSON.stringify({
    schema_version: 'output-contract-v1',
    agent_id: 'fx1', role: 'fix', status: 'SUCCESS', contract_valid: true,
    artifact_path: '<OUTDIR>/done-1.md',
    payload: {
      finding_id: 'F1', disposition: 'FIXED',
      test_path: 'test/t.mjs', red_log_path: 'red/red.log',
      files_touched: [{ path: 'src/main.js', change_summary: '改了 X' }],
    },
    error: null,
  })
  + '\n```\n';
const NO_ENVELOPE = '\n# 修复记录\n\n改了三行代码，测试全绿。\n';

function makeArtifactDir(files) {
  const d = mkdtempSync(join(tmpdir(), 'art-'));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), body);
  return d;
}

// 需要读 exit 0 时的 stderr（WARN 走 stderr 但不阻断），execFileSync 拿不到，
// 所以这里用 spawnSync。
function runHookFull(state) {
  const dir = mkdtempSync(join(tmpdir(), 'hook-'));
  const f = join(dir, 'state.json');
  writeFileSync(f, JSON.stringify(state));
  const r = spawnSync('node', [HOOK, '--state', f], { input: '{}', encoding: 'utf8' });
  rmSync(dir, { recursive: true, force: true });
  return { code: r.status ?? 1, err: r.stderr ?? '', out: r.stdout ?? '' };
}

// 除 此之外全部闭合的 wave4 账本：只让 3.7 成为唯一的拦截来源，
// 否则用例可能因为别的问题 exit 2，测不到 3.7。
//
// 2026-11-16（R17）：新增 `target_repo`。原因：§3.7 的第二道闸门（check-payload）
// 需要被审仓库根才能把信封里的相对路径（red_log_path / test_path）解析成绝对路径。
// 不给它，check-payload 会降级成 evidence_existence_unchecked 的 WARN——
// 那正好是 R14 表里口子 3 的形态（「不给 --repo 就降级」）。FIXTURE_REPO
// 见文件顶部：真造的临时仓库，里面有两个证据文件。
const closedWave4 = (artifactDir, over = {}) => ({
  phase: 'wave4', status: 'RUNNING', path_mode: 'FIX', in_flight: [],
  fix_contracts: [fixContract()],
  budget: { spawned_fix_agents: 1 },
  current_plan: wavePlan('wave4'),
  target_repo: FIXTURE_REPO,
  report: {
    dir_ready: true, dir_path: artifactDir,
    final_report_path: join(artifactDir, 'round1-final-report.md'),
  },
  ...over,
});

console.log('case 21: wave4 + 产物目录里 1 份无信封 → 拒绝结束（artifact_without_envelope）');
{
  const d = makeArtifactDir({ 'done-1.md': NO_ENVELOPE });
  try {
    const r = runHookFull(closedWave4(d));
    expect('退出码 2', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 300)}`);
    expect('报 artifact_without_envelope', /artifact_without_envelope/.test(r.err), r.err.slice(0, 400));
    expect('指名道姓点了 done-1.md', /done-1\.md/.test(r.err), r.err.slice(0, 400));
    expect('说明没有信封等于无法被观测', /观测/.test(r.err), r.err.slice(0, 400));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log('case 22: wave4 + 产物目录全部有信封 → 允许结束（exit 0）');
{
  const d = makeArtifactDir({ 'done-1.md': '# 修复\n' + GOOD_ENVELOPE, 'done-3.md': '# 修复\n' + GOOD_ENVELOPE });
  try {
    const r = runHookFull(closedWave4(d));
    expect('退出码 0', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 400)}`);
    expect('不提 artifact_without_envelope', !/artifact_without_envelope/.test(r.err), r.err.slice(0, 300));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log('case 23: wave4 + 契约非空 + 产物目录推断不出来 → exit 2（R14：不再是 WARN）');
{
  // 2026-11-15（R14）改判：本 case 在 R13 断言的是 exit 0 + WARN。
  // 那条断言本身就是在锁住 FIX-R13-report.md §7.2 的口子 1 ——
  // 「不写 report.dir_path/final_report_path 就能用一条 WARN 换掉整道信封闸门」。
  // 留着它绿，等于把要堵的洞写成契约。
  // report 里没有任何目录线索：既没有 dir_path 也没有 final_report_path
  const r = runHookFull({
    ...closedWave4('__unused__'),
    report: { dir_ready: false, dir_path: null, final_report_path: null },
  });
  expect('退出码 2（拒绝闭合）', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 400)}`);
  expect('指出这是账本缺字段，不是环境问题',
    /账本缺字段/.test(r.err), r.err.slice(0, 600));
  expect('点明它等于用省略换掉一道门', /省略/.test(r.err), r.err.slice(0, 600));
}

console.log('case 23b: wave4 + 契约非空 + 目录推断不出 + 审计路径（AUDIT_ONLY）→ 不启用该检查');
{
  const r = runHookFull({
    ...closedWave4('__unused__'),
    path_mode: 'AUDIT_ONLY',
    report: { dir_ready: false, dir_path: null, final_report_path: null },
  });
  expect('退出码 0（判据要求 path_mode=FIX）', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 400)}`);
  expect('不提账本缺字段', !/账本缺字段/.test(r.err), r.err.slice(0, 400));
}

console.log('case 23c: wave4 + fix_contracts 为空 + 目录推断不出 → 3.7 仍降级 WARN（不叠加一条缺字段 FAIL）');
{
  // 注意：这个账本 exit 2 是 §3 的「wave4 交付物缺失」（fix_contracts 为空）造成的，
  // 与 3.7 无关——wave4 的闭合条件本来就要求契约非空，所以这条路在真实运行里
  // 一定已经被前一道门拦住。这里要证明的是：**3.7 不叠加**，它只 WARN，
  // 不会在同一份账本上再报一条「目录推断不出」的 FAIL（那会把报错清单指向
  // 一个此时修不修都无所谓的字段）。
  const r = runHookFull({
    ...closedWave4('__unused__'),
    fix_contracts: [],
    report: { dir_ready: false, dir_path: null, final_report_path: null },
  });
  expect('确有降级 WARN 说明没执行信封检查',
    /本次\*\*没有执行\*\*产物信封检查|没有执行/.test(r.err), r.err.slice(0, 600));
  expect('3.7 不报「账本缺字段」',
    !/账本缺字段/.test(r.err), r.err.slice(0, 600));
  expect('exit 2 的理由是交付物，不是目录',
    /交付物/.test(r.err), r.err.slice(0, 600));
}

console.log('case 23d: wave2a（审计路径）+ 目录推断不出 → exit 0（不启用这个检查）');
{
  const r = runHookFull({
    phase: 'wave2a', status: 'RUNNING', path_mode: 'AUDIT_ONLY', in_flight: [],
    slices: { 'slice-01': { state: 'DONE' } },
    wave2_completed: [{ agent_id: 'a1', final_status: 'SUCCESS' }],
    current_plan: wavePlan('wave2a'),
    report: { dir_ready: false, dir_path: null, final_report_path: null },
  });
  expect('退出码 0', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 400)}`);
  expect('不提账本缺字段', !/账本缺字段/.test(r.err), r.err.slice(0, 400));
}

console.log('case 24: wave4 + legacy_artifacts 豁免了其中一份 → exit 0，但 stderr 留痕');
{
  // 目录里 2 份：一份无信封（历史）已豁免，一份有信封（本轮）。
  // 豁免 1/2 是「少数例外」，不是「整目录豁免」。
  const d = makeArtifactDir({
    'done-1.md': NO_ENVELOPE,
    'done-2.md': '# 修复\n' + GOOD_ENVELOPE,
  });
  try {
    const r = runHookFull(closedWave4(d, { legacy_artifacts: ['done-1.md'] }));
    expect('退出码 0（豁免生效）', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 400)}`);
    expect('WARN 提到 done-1.md', /done-1\.md/.test(r.err), r.err.slice(0, 400));
    expect('写明证据在契约体系之外 / 不可机械复核',
      /契约体系之外|不可机械复核/.test(r.err), r.err.slice(0, 400));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log('case 24b: 目录里只有 1 份且被豁免 → exit 2（1/1 也是全量豁免）');
{
  // 这一条是刻意的严格：单产物目录里豁免了它，等于这一轮没有任何可检查的产物，
  // 而「这一轮没有任何可检查的产物」正是 R12 §八·洞 B 的场景本身。
  const d = makeArtifactDir({ 'done-1.md': NO_ENVELOPE });
  try {
    const r = runHookFull(closedWave4(d, { legacy_artifacts: ['done-1.md'] }));
    expect('退出码 2', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 400)}`);
    expect('报全量豁免', /全量豁免/.test(r.err), r.err.slice(0, 400));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log('case 25: wave4 + legacy_artifacts 覆盖了全部文件 → exit 2（全量豁免=关掉检查）');
{
  const d = makeArtifactDir({ 'done-1.md': NO_ENVELOPE, 'done-3.md': NO_ENVELOPE });
  try {
    const r = runHookFull(closedWave4(d, { legacy_artifacts: ['done-1.md', 'done-3.md'] }));
    expect('退出码 2', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 400)}`);
    expect('报全量豁免', /全量豁免/.test(r.err), r.err.slice(0, 400));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log('case 26: phase=wave2a（审计路径）→ 产物信封检查不启用');
{
  const d = makeArtifactDir({ 'done-1.md': NO_ENVELOPE });
  try {
    const r = runHookFull({
      phase: 'wave2a', status: 'RUNNING', path_mode: 'AUDIT_ONLY', in_flight: [],
      slices: { 'slice-01': { state: 'DONE' } },
      wave2_completed: [{ agent_id: 'a1', final_status: 'SUCCESS' }],
      current_plan: wavePlan('wave2a'),
      report: { dir_ready: true, dir_path: d, final_report_path: join(d, 'x.md') },
    });
    expect('退出码 0', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 400)}`);
    expect('不提产物信封', !/artifact_without_envelope/.test(r.err), r.err.slice(0, 300));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log('case 27: wave4 但 path_mode=AUDIT_ONLY → 产物信封检查不启用（判据要求两者同时成立）');
{
  const d = makeArtifactDir({ 'done-1.md': NO_ENVELOPE });
  try {
    const r = runHookFull(closedWave4(d, { path_mode: 'AUDIT_ONLY' }));
    expect('退出码 0', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 400)}`);
    expect('不提产物信封', !/artifact_without_envelope/.test(r.err), r.err.slice(0, 300));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log('case 28: legacy_artifacts 列了不存在的文件 → WARN 指出豁免条目悬空（不阻断）');
{
  const d = makeArtifactDir({ 'done-1.md': '# 修复\n' + GOOD_ENVELOPE });
  try {
    const r = runHookFull(closedWave4(d, { legacy_artifacts: ['done-99.md'] }));
    expect('退出码 0（悬空豁免不是闭合障碍）', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 400)}`);
    expect('WARN 提到 done-99.md 没匹配到', /done-99\.md/.test(r.err), r.err.slice(0, 400));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log('case 30: 空产物目录 + in_flight 为空 → 拒绝闭合（R15 堵「用空目录换掉闸门」）');
{
  // R14 §6.1 实测的绕过：report.dir_path 写成一个真实存在但没有产物的目录，仍然 exit 0。
  // R14 当时不升 FAIL 的理由是「修复相位允许『产物还没写完』这个中间态」——
  // 但那个理由只在**还有实例在跑**时成立。本 case 与 case 31 分别验证这两侧。
  const d = makeArtifactDir({});
  try {
    const r = runHookFull(closedWave4(d, {}));
    expect('退出码 2（活干完了却一份产物都没有）', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 400)}`);
    expect('说明这不是「还没写完」而是「写完了却什么都没交」',
      /写完了却什么都没交|不是「还没写完」/.test(r.err), r.err.slice(0, 500));
    expect('点明空目录可被用来让闸门失效',
      /空目录|闸门失效/.test(r.err), r.err.slice(0, 500));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log('case 31: 空产物目录 + in_flight 非空 → 底部由 in_flight 判据拦（不是 3.7）');
{
  // 这一条不是测 3.7 的降级，而是记录一个事实：**「空目录 + 还有实例在跑」这个组合没法
  // 单独考察 3.7**——因为既有的 in_flight 判据会先一步拒绝闭合（有实例没到终态就不许结束）。
  // 也就是说 R14 担心的「用空目录换掉闸门」在实践中只有 in_flight 为空时才成立，
  // 而归一化到那个形态之后，case 30 已经覆盖了。
  //
  // 保留本 case 是为了让「3.7 的降级分支在什么条件下可达」这件事在测试里有痕迹：
  // 答案是**只有 in_flight 非空时**，而那时别的判据已经拦住了。
  const d = makeArtifactDir({});
  try {
    const st = closedWave4(d, {});
    st.in_flight = [{ agent_id: 'a1', status: 'RUNNING' }];
    const r = runHookFull(st);
    expect('退出码 2', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 400)}`);
    expect('拦它的是 in_flight 判据，不是 3.7 的空目录判据',
      /在飞|in_flight/.test(r.err) && !/写完了却什么都没交/.test(r.err), r.err.slice(0, 500));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

// ── R17 · §3.7 第二道闸门：check-payload 逐份校验 ────────────────────────
//
// R14 §六的表里，口子 2/3 的「还差什么」都写着同一句话：
//   「stop-hook §3.7 只调 check-fix-artifacts-envelope，不调 check-payload」。
// 前者只问「有没有信封」，不问「信封里的字段对不对」。于是：
//
//   有信封 + schema_version 乱写 → 信封闸门通过 → stop-hook 放行。
//   「格式合规」变成了「内容合规」的替代品。
//
// 下面这几个 case 的关键是 **case 33**：所有字段完全合法的产物必须 exit 0。
// 没有它，这次改动很容易变成「一接上就全红」，然后被人用一条 WARN 关掉。

// 一个字段完全合法的 fix 信封。路径都相对 FIXTURE_REPO：
//   red/red.log   存在
//   test/t.mjs    存在
//   src/main.js   存在（files_touched[]，不过 check-payload 目前不校验它的存在性）
const VALID_FIX_ENV = (over = {}) => ({
  schema_version: 'output-contract-v1',
  agent_id: 'fx1',
  role: 'fix',
  status: 'SUCCESS',
  contract_valid: true,
  artifact_path: '<OUTDIR>/done-1.md',
  payload: {
    finding_id: 'F1',
    disposition: 'FIXED',
    test_path: 'test/t.mjs',
    red_log_path: 'red/red.log',
    files_touched: [{ path: 'src/main.js', change_summary: '改了 X' }],
  },
  error: null,
  ...over,
});

const fixArtifactBody = (env) => `# 修复产物\n\n\`\`\`json\n${JSON.stringify(env, null, 2)}\n\`\`\`\n`;

console.log('case 32 (R17): 有信封但 schema_version 错 → exit 2，消息含 wrong_schema_version');
{
  const d = makeArtifactDir({ 'done-1.md': fixArtifactBody(VALID_FIX_ENV({ schema_version: 'output-contract-v2' })) });
  try {
    const r = runHookFull(closedWave4(d));
    expect('退出码 2', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 400)}`);
    expect('报 wrong_schema_version', /wrong_schema_version/.test(r.err), r.err.slice(0, 600));
    expect('指名是哪份产物', /done-1\.md/.test(r.err), r.err.slice(0, 600));
    expect('指名是哪个字段', /schema_version/.test(r.err), r.err.slice(0, 600));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log('case 33 (R17): 所有字段完全合法 → exit 0（最重要：证明没有误伤）');
{
  const d = makeArtifactDir({ 'done-1.md': fixArtifactBody(VALID_FIX_ENV()) });
  try {
    const r = runHookFull(closedWave4(d));
    expect('退出码 0', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 800)}`);
    expect('没有 check-payload 类错误', !/check-payload/.test(r.err), r.err.slice(0, 600));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log('case 34 (R17): red_log_path 指向不存在的文件 + target_repo 有效 → exit 2，含 red_log_not_found');
{
  const d = makeArtifactDir({
    'done-1.md': fixArtifactBody(VALID_FIX_ENV({
      payload: { ...VALID_FIX_ENV().payload, red_log_path: 'red/DOES_NOT_EXIST.log' },
    })),
  });
  try {
    const r = runHookFull(closedWave4(d));
    expect('退出码 2', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 400)}`);
    expect('报 red_log_not_found', /red_log_not_found/.test(r.err), r.err.slice(0, 800));
    expect('指名是哪份产物', /done-1\.md/.test(r.err), r.err.slice(0, 800));
    expect('不降级成 evidence_existence_unchecked',
      !/evidence_existence_unchecked/.test(r.err), r.err.slice(0, 800));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log('case 35 (R17): target_repo 缺失 → exit 2，说明这是账本问题');
{
  const d = makeArtifactDir({ 'done-1.md': fixArtifactBody(VALID_FIX_ENV()) });
  try {
    const st = closedWave4(d);
    delete st.target_repo;
    const r = runHookFull(st);
    expect('退出码 2', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 400)}`);
    expect('说明缺的是账本字段', /target_repo/.test(r.err), r.err.slice(0, 800));
    expect('点明这是账本问题而不是打包/证据问题',
      /账本/.test(r.err), r.err.slice(0, 800));
    // 关键：不能把它报成「产物不合规」。产物本身是好的，错的是账本没给解析根。
    // 断言要看的是「有没有把产物判红的那个汇总块」，不是消息里有没有提到规则名——
    // 上面那段解释文字本来就要引用 red_log_not_found 说明「为什么必须给 --repo」。
    expect('没有「产物信封字段不合规」的判定块',
      !/份修复产物\*\*信封里的字段不合规\*\*/.test(r.err), r.err.slice(0, 800));
    expect('没有 check-payload 汇总里的 [rule] field：结构',
      !/\[[a-z_]+\]\s*payload\./.test(r.err), r.err.slice(0, 800));
  } finally { rmSync(d, { recursive: true, force: true }); }
}

console.log('case 36 (R17): 产物数 > 50 → 只查前 50 份并给 WARN（不阻断）');
if (GIT_SLOW) {
  // 这一条要校验 50 份产物，hook 内部对每份 spawn 一次 check-payload。
  // 慢环境下就是 50 × 3s = 150s，必然超时。
  skipIt('case 36 (R17, 50 份上限)', '本机进程启动 >1.2s，这条要 spawn 50 次子进程');
} else {
{
  // 造 51 份：前 50 份合法，第 51 份（按文件名排序靠后）故意违规。
  // 如果上限没生效，第 51 份会被检查到从而 exit 2；上限生效则 exit 0 + WARN。
  // 用 done-XX.md 保证排序稳定（done-051 排在最后）。
  const files = {};
  for (let i = 1; i <= 50; i++) {
    files[`done-${String(i).padStart(2, '0')}.md`] = fixArtifactBody(VALID_FIX_ENV());
  }
  files['done-99.md'] = fixArtifactBody(VALID_FIX_ENV({ schema_version: 'BAD' }));
  const d = makeArtifactDir(files);
  try {
    const r = runHookFull(closedWave4(d));
    expect('退出码 0（第 51 份没被检查）', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 600)}`);
    expect('WARN 说明超过 50 只查了前 50', /50/.test(r.err) && /只检查/.test(r.err),
      r.err.slice(0, 800));
    expect('WARN 提到被跳过的份数', /跳过|未检查|没有检查/.test(r.err), r.err.slice(0, 800));
  } finally { rmSync(d, { recursive: true, force: true }); }
}
}  // ← 关闭 case 36 的慢环境分支



// ── R19 · §3.7.6 files_touched ↔ git status 双向对账 ─────────────────────
//
// R18 §6 的原文（直接采信）：
//   **path existence does not mean the file was changed by this instance.**
//   R18 的 files_touched_not_found 只证明必要条件。仍未被回答的：
//   它到底被改了没有、是不是这一轮改的、改了什么，以及最糟的 **under-reporting**——
//   一个实例改了 10 个文件，只列 1 个存在的，R18 的规则完全绿。
//
// 所以下面的用例不是「再造一条更严的存在性检查」，而是**两个方向**：
//   声称了却没改（overclaimed）  → FAIL
//   改了却没声称（underreported）→ 源码 FAIL / 非源码 WARN
//
// 必须造真 git 仓库：要测的是 `git status --porcelain` 的真实输出。
// 写法参照 verify-postfix-snapshot.test.mjs 的 makeRepo()。

function gitIn(repo, args) {
  return execFileSync('git', ['-c', 'core.autocrlf=false', '-C', repo, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function putFile(repo, rel, body) {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

// 造一个已提交的干净仓库，再按需制造改动。
function makeGitRepo(files) {
  const d = mkdtempSync(join(tmpdir(), 'gitrepo-'));
  for (const [rel, body] of Object.entries(files)) putFile(d, rel, body);
  gitIn(d, ['init', '-q']);
  gitIn(d, ['config', 'user.email', 'r19@test.local']);
  gitIn(d, ['config', 'user.name', 'R19']);
  gitIn(d, ['add', '-A']);
  gitIn(d, ['commit', '-qm', 'init']);
  return d;
}

// 所有 R19 用例共用的仓库底子：两个证据文件 + 三个源文件（都先提交，即「干净」）。
// 注意：证据文件必须在这个仓库里，因为 §3.7.5 的 check-payload 会按 --repo 解析它们；
// 用例只改 target_repo 时，test/t.mjs 与 red/red.log 仍然解析得到。
const R19_REPO_FILES = () => ({
  'red/red.log': 'FAIL: 修复前测试为红\n',
  'test/t.mjs': '// 测试\n',
  'src/A.java': 'class A {}\n',
  'src/B.java': 'class B {}\n',
  'src/C.java': 'class C {}\n',
  'app.log': 'old log\n',
});

// artifacts 落在仓库之外（tmp 目录），否则未跟踪的产物目录会污染 git status。
const r19Artifact = (filesTouched) => {
  const d = mkdtempSync(join(tmpdir(), 'art19-'));
  writeFileSync(join(d, 'done-1.md'), fixArtifactBody(VALID_FIX_ENV({
    payload: { ...VALID_FIX_ENV().payload, files_touched: filesTouched },
  })));
  return d;
};

// ── R19 / R20 / R21：全部依赖真实 git 仓库（每个用例 git init + 多次 status）──
// 慢环境下整段跳过，并逐条说明。
if (GIT_SLOW) {
  for (const n of [37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51]) {
    skipIt(`case ${n} (R19–R21, harness 对账)`, '本机进程启动 >1.2s，这批用例每个要建一个 git 仓库并多次调用 git');
  }
} else {

console.log('case 37 (R19): files_touched 列的文件确实被改了 → exit 0（防误伤）');
{
  const repo = makeGitRepo(R19_REPO_FILES());
  const d = r19Artifact([{ path: 'src/A.java', change_summary: '改了 X' }]);
  try {
    putFile(repo, 'src/A.java', 'class A { int x; }\n');   // 真实改动
    const r = runHookFull(closedWave4(d, { target_repo: repo }));
    expect('退出码 0', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 600)}`);
    expect('不报 overclaimed / underreported',
      !/files_touched_overclaimed|files_touched_underreported/.test(r.err), r.err.slice(0, 600));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(d, { recursive: true, force: true });
  }
}

console.log('case 38 (R19): files_touched 列了一个存在但没被改的文件 → overclaimed FAIL');
{
  // 关键：src/B.java **存在**（所以 R18 的 files_touched_not_found 全绿），
  // 但 git status 里没有它。这正是 R18 §6 说的「必要条件不等于变更」。
  const repo = makeGitRepo(R19_REPO_FILES());
  const d = r19Artifact([{ path: 'src/B.java', change_summary: '声称改了' }]);
  try {
    const r = runHookFull(closedWave4(d, { target_repo: repo }));
    expect('退出码 2', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 600)}`);
    expect('报 files_touched_overclaimed', /files_touched_overclaimed/.test(r.err), r.err.slice(0, 800));
    expect('指名 src/B.java', /src\/B\.java/.test(r.err), r.err.slice(0, 800));
    expect('说明路径存在不等于被改过', /git status|没有改动|存在/.test(r.err), r.err.slice(0, 800));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(d, { recursive: true, force: true });
  }
}

console.log('case 39 (R19): 仓库里改了源码文件却没登记 → underreported FAIL');
{
  // 「改了 10 个只列 1 个」的最小复现：2 个源码被改，files_touched 只列 1 个。
  const repo = makeGitRepo(R19_REPO_FILES());
  const d = r19Artifact([{ path: 'src/A.java', change_summary: '改了 A' }]);
  try {
    putFile(repo, 'src/A.java', 'class A { int x; }\n');
    putFile(repo, 'src/C.java', 'class C { int y; }\n');   // 未登记
    const r = runHookFull(closedWave4(d, { target_repo: repo }));
    expect('退出码 2', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 600)}`);
    expect('报 files_touched_underreported', /files_touched_underreported/.test(r.err), r.err.slice(0, 800));
    expect('指名 src/C.java', /src\/C\.java/.test(r.err), r.err.slice(0, 800));
    expect('说明是「源码被改却没登记」', /源码|没有登记|未登记/.test(r.err), r.err.slice(0, 800));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(d, { recursive: true, force: true });
  }
}

console.log('case 40 (R19): 仓库里改了一个非源码文件（.log）没登记 → exit 0 + WARN（不升级）');
{
  // 修复相位里 .log / .md / repair-artifacts/ 这类改动是合法噪音。
  // 无条件升 FAIL 会让每个回合都红，所以这一档必须仍然是 WARN。
  const repo = makeGitRepo(R19_REPO_FILES());
  const d = r19Artifact([{ path: 'src/A.java', change_summary: '改了 A' }]);
  try {
    putFile(repo, 'src/A.java', 'class A { int x; }\n');
    putFile(repo, 'app.log', 'new log line\n');   // 非源码、未登记
    const r = runHookFull(closedWave4(d, { target_repo: repo }));
    expect('退出码 0（不误拦）', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 600)}`);
    expect('仍有 WARN 提到 underreported', /files_touched_underreported/.test(r.err), r.err.slice(0, 800));
    expect('WARN 指名 app.log', /app\.log/.test(r.err), r.err.slice(0, 800));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(d, { recursive: true, force: true });
  }
}

console.log('case 41 (R19): target_repo 缺失 → 跳过双向对账并 WARN（不重复报 FAIL）');
{
  const repo = makeGitRepo(R19_REPO_FILES());
  const d = r19Artifact([{ path: 'src/A.java', change_summary: '改了 A' }]);
  try {
    putFile(repo, 'src/A.java', 'class A { int x; }\n');
    const st = closedWave4(d, { target_repo: repo });
    delete st.target_repo;
    const r = runHookFull(st);
    expect('WARN 说明未做双向对账', /未做双向对账/.test(r.err), r.err.slice(0, 800));
    expect('不报 files_touched_overclaimed', !/files_touched_overclaimed/.test(r.err), r.err.slice(0, 800));
    expect('不报 files_touched_underreported', !/files_touched_underreported/.test(r.err), r.err.slice(0, 800));
    // exit 2 是 §3.7.5 早有的「target_repo 缺失」判据造成的（那不是本段的重复报错），
    // 本段只负责留一条 WARN，且不因缺 target_repo 而多开一枪。
    expect('退出码 2 来自既有的 target_repo 判据', r.code === 2, `实际 ${r.code}`);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(d, { recursive: true, force: true });
  }
}

console.log('case 42 (R19): 有 fix 产物但 claimed 集合为空 + 仓库里有源码改动 → WARN 说明对账没做');
{
  // R19 自证时发现的残余口子（FIX-R19-report.md §4.2c）：
  // 一份 disposition=WONT_FIX 的产物、files_touched 为空数组时，claimed 集合为空，
  // 本段按「没有 claimed 集合可比」直接跳过 —— 于是一个真实源码改动零告警地溜过去。
  // 不能把它升 FAIL（WONT_FIX 轮次里 files_touched 为空是合法的），
  // 但「对账没跑」必须与「对账通过」在日志上可区分。
  const repo = makeGitRepo(R19_REPO_FILES());
  const d = mkdtempSync(join(tmpdir(), 'art19b-'));
  try {
    writeFileSync(join(d, 'done-1.md'), fixArtifactBody(VALID_FIX_ENV({
      payload: {
        finding_id: 'F1', disposition: 'WONT_FIX',
        disposition_reason: '这是一个足够长的理由说明为什么不修这个问题，超过二十个字符。',
        files_touched: [],
      },
    })));
    putFile(repo, 'src/C.java', 'class C { int y; }\n');   // 真实源码改动
    const r = runHookFull(closedWave4(d, { target_repo: repo }));
    expect('退出码 0（WONT_FIX 轮次不阻断）', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 600)}`);
    expect('WARN 说明没有 claimed 集合可比',
      /没有 claimed|未做双向对账|claimed 集合为空/.test(r.err), r.err.slice(0, 800));
    expect('不升成 underreported FAIL', !/files_touched_underreported/.test(r.err), r.err.slice(0, 800));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(d, { recursive: true, force: true });
  }
}

// ── R20 · §3.7.6 的修复基线（fix_baseline）─────────────────────────────
//
// R19 §(a) 原文（直接采信）：
//   **基线问题：`git status` 在修复前就是脏的。** `git status` 报的是「相对于 HEAD
//   的差异」，**不是「这一轮改了什么」**。真实场景里被审仓库常常一开始就是脏的。
//   后果是**双向都失真**：
//     overclaimed 侧：实例没改 src/B.java，但它在修复前就已是 M → actual 里有它
//                      → 声称它不算 overclaim → **假阴性**。
//     underreported 侧：实例改的是 src/A.java，但仓库里另有一堆本轮之前的改动
//                      → 全部算成 under-reported → **假阳性**。
//
// 所以下面的 A/B 对照是核心：**同样的仓库状态，有基线 vs 没基线，结论必须不同**。
// 没有 B，A 可能只是「碰巧绿」；没有 A，B 只是重复 case 39。

const shaOf = (repo) => gitIn(repo, ['rev-parse', 'HEAD']).trim();

// 把「修复前就脏」的状态写进账本。captured_at 固定值：测试不依赖当前时钟。
const baselineOf = (repo, dirtyPaths) => ({
  captured_at: '2026-11-16T00:00:00Z',
  head: shaOf(repo),
  dirty_paths: dirtyPaths,
});

console.log('case 43 (R20-A): 有基线，基线里已脏的文件不触发 underreported → exit 0');
{
  // 场景：仓库里 src/pre-existing.java 在修复**之前**就已经是 M（不是本轮改的）。
  //       本轮只改了 src/A.java，产物也只登记了它。
  // 没有基线时：pre-existing 会落进 actual - claimed → 假阳性 FAIL。
  // 有基线时：它被 baseline 减掉 → 剩下 A.java == claimed → exit 0。
  const repo = makeGitRepo({ ...R19_REPO_FILES(), 'src/pre-existing.java': 'class P {}\n' });
  const d = r19Artifact([{ path: 'src/A.java', change_summary: '改了 A' }]);
  try {
    putFile(repo, 'src/pre-existing.java', 'class P { int legacy; }\n');  // 修复前就脏
    const bl = baselineOf(repo, ['src/pre-existing.java']);
    putFile(repo, 'src/A.java', 'class A { int x; }\n');                   // 本轮修复
    const r = runHookFull(closedWave4(d, { target_repo: repo, fix_baseline: bl }));
    expect('退出码 0', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 800)}`);
    expect('不报 files_touched_underreported', !/files_touched_underreported/.test(r.err),
      r.err.slice(0, 800));
    expect('不报 files_touched_overclaimed', !/files_touched_overclaimed/.test(r.err),
      r.err.slice(0, 800));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(d, { recursive: true, force: true });
  }
}

console.log('case 44 (R20-B): 同样的仓库状态但没有 fix_baseline → underreported FAIL（对照）');
{
  // 与 case 43 **逐字相同的仓库状态**，唯一差别是账本里没有 fix_baseline。
  // 期望：pre-existing.java 被算成「改了没登记」→ FAIL。
  // 这条与 43 的差别就是基线的全部价值；如果 44 也绿，说明基线没起作用。
  const repo = makeGitRepo({ ...R19_REPO_FILES(), 'src/pre-existing.java': 'class P {}\n' });
  const d = r19Artifact([{ path: 'src/A.java', change_summary: '改了 A' }]);
  try {
    putFile(repo, 'src/pre-existing.java', 'class P { int legacy; }\n');
    putFile(repo, 'src/A.java', 'class A { int x; }\n');
    const r = runHookFull(closedWave4(d, { target_repo: repo }));   // 没有 baseline
    expect('退出码 2', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 800)}`);
    expect('报 files_touched_underreported', /files_touched_underreported/.test(r.err),
      r.err.slice(0, 800));
    expect('指名 src/pre-existing.java（这就是假阳性）', /src\/pre-existing\.java/.test(r.err),
      r.err.slice(0, 800));
    expect('WARN 说明没有基线、对账基于相对 HEAD 的差异',
      /基线/.test(r.err) && /HEAD|相对/.test(r.err), r.err.slice(0, 1200));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(d, { recursive: true, force: true });
  }
}

console.log('case 45 (R20-C): 有基线，产物声称「修复前就脏、本轮没动」的文件 → overclaimed FAIL');
{
  // R19 说的**假阴性**：pre-existing.java 在 actual(HEAD 口径) 里，所以旧判据认为
  // 「声称它 OK」。它其实不是这一轮改的——这正是 R18 §6 的
  // 「path existence does not mean the file was changed by this instance」
  // 在「改动」层面的同一句话。有基线后 actual 里没有它 → overclaimed。
  const repo = makeGitRepo({ ...R19_REPO_FILES(), 'src/pre-existing.java': 'class P {}\n' });
  const d = r19Artifact([{ path: 'src/pre-existing.java', change_summary: '声称本轮改了' }]);
  try {
    putFile(repo, 'src/pre-existing.java', 'class P { int legacy; }\n');  // 修复前就脏
    const bl = baselineOf(repo, ['src/pre-existing.java']);
    const r = runHookFull(closedWave4(d, { target_repo: repo, fix_baseline: bl }));
    expect('退出码 2', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 800)}`);
    expect('报 files_touched_overclaimed', /files_touched_overclaimed/.test(r.err),
      r.err.slice(0, 800));
    expect('指名 src/pre-existing.java', /src\/pre-existing\.java/.test(r.err), r.err.slice(0, 800));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(d, { recursive: true, force: true });
  }
}

console.log('case 46 (R20-D): 基线里脏、现在干净（被还原）→ WARN 提到 restored');
{
  // 「修复前脏、现在不脏」只有两种解释：被还原了，或者被 stash/checkout 掉了。
  // 两种都值得看一眼（R19 前有一轮真的把本轮改动 checkout 掉过，见 CHECKOUT-INCIDENT.md）。
  // 但它**不是违规**：合法的还原是修复流程的一部分（rollback_command 就是干这个的），
  // 所以只能 WARN，不能 FAIL。
  const repo = makeGitRepo({ ...R19_REPO_FILES(), 'src/old.java': 'class Old {}\n' });
  const d = r19Artifact([{ path: 'src/A.java', change_summary: '改了 A' }]);
  try {
    putFile(repo, 'src/old.java', 'class Old { int dirty; }\n');   // 修复前脏
    const bl = baselineOf(repo, ['src/old.java']);
    gitIn(repo, ['checkout', '--', 'src/old.java']);               // 现在干净了
    putFile(repo, 'src/A.java', 'class A { int x; }\n');
    const r = runHookFull(closedWave4(d, { target_repo: repo, fix_baseline: bl }));
    expect('退出码 0（还原不是违规，不阻断）', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 800)}`);
    expect('WARN 提到 restored / 被还原', /restored|被还原|还原/.test(r.err), r.err.slice(0, 1200));
    expect('WARN 指名 src/old.java', /src\/old\.java/.test(r.err), r.err.slice(0, 1200));
    expect('提示可能是 stash/checkout/误操作',
      /stash|checkout|误操作/.test(r.err), r.err.slice(0, 1200));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(d, { recursive: true, force: true });
  }
}

console.log('case 47 (R20-E): fix_baseline 格式非法（dirty_paths 不是数组）→ WARN 并降级，不崩溃');
{
  // 格式错的基线不能被当成「空基线」静默吞掉——那比没有基线更糟：
  // 主 Agent 以为自己在提供基线，而对账实际按「相对 HEAD」跑，且毫无提示。
  const repo = makeGitRepo(R19_REPO_FILES());
  const d = r19Artifact([{ path: 'src/A.java', change_summary: '改了 A' }]);
  try {
    putFile(repo, 'src/A.java', 'class A { int x; }\n');
    const r = runHookFull(closedWave4(d, {
      target_repo: repo,
      fix_baseline: { captured_at: '2026-11-16T00:00:00Z', dirty_paths: 'src/x.java' },
    }));
    expect('不崩溃（退出码 0，且不是 1/其他）', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 800)}`);
    expect('WARN 指出 fix_baseline 格式非法',
      /fix_baseline/.test(r.err) && /格式|非法|数组/.test(r.err), r.err.slice(0, 1200));
    expect('WARN 说明已降级',
      /降级|按「?相对 HEAD」?|没有基线/.test(r.err), r.err.slice(0, 1200));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(d, { recursive: true, force: true });
  }
}

console.log('case 48 (R20-F): 基线之后 HEAD 变了（中途 commit）→ WARN 说明口径已不确定');
{
  // R20 写完后实测发现的边界：基线记 src/A.java 脏，实例改完 A.java 并 commit。
  // 于是 git status 变干净 → A.java 落进 restored，同时又从 actual 消失
  // → 产物声称改了它却被判 overclaimed。**两个都是假警报**。
  //
  // 不能因此关掉判据（commit 修复是合法做法），但必须把「HEAD 变了」说出来——
  // 上面一切结论都建立在那个已经不确定的差值上。这是 head 字段唯一的判据价值。
  const repo = makeGitRepo(R19_REPO_FILES());
  const d = r19Artifact([{ path: 'src/A.java', change_summary: '改了 A' }]);
  try {
    putFile(repo, 'src/A.java', 'class A { int pre; }\n');       // 修复前就脏
    const bl = baselineOf(repo, ['src/A.java']);
    putFile(repo, 'src/A.java', 'class A { int x; }\n');          // 本轮修复
    gitIn(repo, ['add', '-A']);
    gitIn(repo, ['commit', '-qm', 'fix committed mid-round']);    // 中途 commit → HEAD 变了
    const r = runHookFull(closedWave4(d, { target_repo: repo, fix_baseline: bl }));
    expect('WARN 说明基线与现在的 HEAD 不一致',
      /HEAD 不一致/.test(r.err), r.err.slice(0, 1600));
    expect('WARN 说明后果（会被误判成 restored / overclaimed）',
      /overclaimed|被还原/.test(r.err), r.err.slice(0, 1600));
    expect('WARN 给出补法（重抓基线）', /重抓基线|更新 fix_baseline/.test(r.err), r.err.slice(0, 1600));
    expect('WARN 带溯源', /captured_at=/.test(r.err), r.err.slice(0, 1600));
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(d, { recursive: true, force: true });
  }
}

// ── 3.6b · files_touched ↔ harness write/edit 记录（R21 集成）──────────────
// 这一段存在的理由（R20 §三点原文）：
//   「下一个层次必须换观测面（harness 记录 tool call 与文件写入），
//     而不是继续往 state.json 加字段——每个新字段都是一个新省略点。」
//
// §3.6 用 harness 日志回答「派发了几次」，看的是 subagent 调用；
// §3.7.6（R19/R20）用 `git status` 回答「文件改了没有」，那是**状态**，
// 修复前就脏的文件能两个方向都蒙混。§3.6b 看的是 write/edit 的 file_path——**动作**。
//
// 与 R12/R13 反复批评的「接上了但没接在门上」直接对应：这里必须 **exit 2**，
// 不能只 WARN。否则就是把检查跑通、输出写好，然后不改变任何结果。

/** 造一个 dsh root，project 目录按 stop-hook 的编码规则从 repo 路径推出。 */
function dshRootFor(repo, sessionId, opts) {
  const root = mkdtempSync(join(tmpdir(), 'sess-r21-'));
  const projectDir = '--' + repo.replace(/ /g, '~0020').replace(/[\\/:]+/g, '-')
    .replace(/[^A-Za-z0-9_~-]+/g, '-') + '--';
  makeFakeDshSession(root, projectDir, sessionId, opts);
  return root;
}

console.log('case 49 (R21-A): files_touched 声称的文件 harness 从没写过 → 拒绝闭合（exit 2）');
{
  // 这是 R19 的 overclaimed 抓不到的形状：文件在仓库里**存在**（R18 的存在性检查绿），
  // `git status` 里它也**可能已经脏**（R19/R20 会说「改过」），
  // 但 harness 的 write/edit 记录里根本没有它。
  const repo = mkdtempSync(join(tmpdir(), 'r21-repo-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'A.java'), 'class A {}\n');
  let root = null;
  try {
    root = dshRootFor(repo, 'session-r21-a', {
      subagentCalls: 1,
      // 只写了 B.java，而产物声称改的是 A.java
      writes: [join(repo, 'src', 'B.java')],
    });
    const d = makeArtifactDir({ 'done-1.md': '# 修复\n\n```json\n' + JSON.stringify({
      schema_version: 'output-contract-v1', agent_id: 'fx1', role: 'fix', status: 'SUCCESS',
      contract_valid: true, artifact_path: 'done-1.md',
      payload: {
        finding_id: 'F1', disposition: 'FIXED',
        test_path: join(repo, 'src', 'A.java'), red_log_path: join(repo, 'src', 'A.java'),
        files_touched: [{ path: 'src/A.java', change_summary: '改了 A' }],
      },
      error: null,
    }, null, 2) + '\n```\n' });
    const r = runHookWithSessions(closedWave4(d, { target_repo: repo, budget: { spawned_fix_agents: 1 } }), root);
    expect('退出码 2（必须真的挡住闭合）', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 600)}`);
    expect('报 files_touched_overclaimed_by_harness',
      /files_touched_overclaimed_by_harness/.test(r.err), r.err.slice(0, 800));
    expect('说明判据是 write/edit 记录而不是 git status',
      /write\/edit|git status/.test(r.err), r.err.slice(0, 1200));
    rmSync(d, { recursive: true, force: true });
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log('case 50 (R21-B): harness 写了源码但没登记 → 拒绝闭合（exit 2）');
{
  const repo = mkdtempSync(join(tmpdir(), 'r21-repo-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'A.java'), 'class A {}\n');
  let root = null;
  try {
    root = dshRootFor(repo, 'session-r21-b', {
      subagentCalls: 1,
      writes: [join(repo, 'src', 'A.java'), join(repo, 'src', 'Sneaky.java')],
    });
    const d = makeArtifactDir({ 'done-1.md': '# 修复\n\n```json\n' + JSON.stringify({
      schema_version: 'output-contract-v1', agent_id: 'fx1', role: 'fix', status: 'SUCCESS',
      contract_valid: true, artifact_path: 'done-1.md',
      payload: {
        finding_id: 'F1', disposition: 'FIXED',
        test_path: join(repo, 'src', 'A.java'), red_log_path: join(repo, 'src', 'A.java'),
        files_touched: [{ path: 'src/A.java', change_summary: '改了 A' }],
      },
      error: null,
    }, null, 2) + '\n```\n' });
    const r = runHookWithSessions(closedWave4(d, { target_repo: repo, budget: { spawned_fix_agents: 1 } }), root);
    expect('退出码 2', r.code === 2, `实际 ${r.code}：${r.err.slice(0, 600)}`);
    expect('报 files_touched_underreported_by_harness',
      /files_touched_underreported_by_harness/.test(r.err), r.err.slice(0, 800));
    expect('点名 Sneaky.java', /Sneaky\.java/.test(r.err), r.err.slice(0, 1200));
    rmSync(d, { recursive: true, force: true });
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

console.log('case 51 (R21-C): 声称 == 实际 → 放行（这条闸门不能误拦正常回合）');
{
  const repo = mkdtempSync(join(tmpdir(), 'r21-repo-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'A.java'), 'class A {}\n');
  let root = null;
  try {
    root = dshRootFor(repo, 'session-r21-c', {
      subagentCalls: 1,
      writes: [join(repo, 'src', 'A.java')],
    });
    const d = makeArtifactDir({ 'done-1.md': '# 修复\n\n```json\n' + JSON.stringify({
      schema_version: 'output-contract-v1', agent_id: 'fx1', role: 'fix', status: 'SUCCESS',
      contract_valid: true, artifact_path: 'done-1.md',
      payload: {
        finding_id: 'F1', disposition: 'FIXED',
        test_path: join(repo, 'src', 'A.java'), red_log_path: join(repo, 'src', 'A.java'),
        files_touched: [{ path: 'src/A.java', change_summary: '改了 A' }],
      },
      error: null,
    }, null, 2) + '\n```\n' });
    const r = runHookWithSessions(closedWave4(d, { target_repo: repo, budget: { spawned_fix_agents: 1 } }), root);
    expect('退出码 0', r.code === 0, `实际 ${r.code}：${r.err.slice(0, 800)}`);
    expect('不退化成 overclaimed / underreported',
      !/files_touched_overclaimed_by_harness|files_touched_underreported_by_harness/.test(r.err),
      r.err.slice(0, 800));
    rmSync(d, { recursive: true, force: true });
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

}  // ← 关闭 GIT_SLOW 的 else 分支

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败${skipped ? ` / ${skipped} 跳过` : ''} ===
`);
if (skipped > 0) {
  console.log(`\n⚠️  本机进程启动过慢（阈值 1.2s），${skipped} 条用例被跳过。`);
  console.log('   这不是「通过」。CI（Linux）会完整跑这批，本地慢环境请以 CI 为准。');
  console.log('   若要让本地也跑全：把仓库放在杀毒软件白名单目录，或用 WSL。');
}
// 2026-11-24：跳过总数有上限。环境慢可以解释少量跳过，
// 但如果**过半**用例都没跑，这个套件已经名存实亡——必须报错，
// 否则「大部分没测」会以绿色出现在 check-all 里。
const SKIP_LIMIT = 30;
if (skipped > SKIP_LIMIT) {
  console.log(`\n✗ 跳过 ${skipped} 条，超过上限 ${SKIP_LIMIT} 条——这个套件已经不构成有效覆盖。`);
  process.exit(1);
}

// 2026-11-21 修：这个套件此前**没有 process.exit()**。
//
// 后果极严重：无论多少条断言失败，进程都以 0 退出，
// 于是 check-all 永远判它通过、CI 永远绿。
//
// 是变异测试暴露的：把 stop-hook.mjs 的核心闸门
// `if (problems.length > 0)` 改成 `> 999999` 后，自测打印
// 「67 通过 / 66 失败」，但 `execFileSync` 认为它成功了。
//
// 换句话说：**这个套件从写下的那天起就没红过。**
process.exit(fail > 0 ? 1 : 0);
