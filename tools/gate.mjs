#!/usr/bin/env node
/**
 * gate.mjs — 统一门禁入口（L2 契约层第 3 项）
 *
 * 为什么需要它（对比 dsh-superagent 后的结论）：
 *
 *   参考项目把「accept 必须有 worktree_name」做成**工具调用失败**——
 *   它不是一个「记得要跑」的脚本，而是**调用链上绕不过去的一环**。
 *
 *   我们之前有 13 个检查器，全部是「记得要手动跑」的独立脚本。
 *   2026-11-09 的红队报告直接指出：`check-all.mjs` 报全绿，不代表框架没问题，
 *   只代表**那 6 个脚本没报错**。
 *
 *   这个文件把检查按「生命周期阶段」组织成 4 道门。
 *   每道门返回明确的**放行 / 拒绝**，以及拒绝时该做什么。
 *
 * 用法：
 *   node gate.mjs --gate dispatch --payload <payload.json> --ledger <attempt.json>
 *   node gate.mjs --gate accept   --artifact <产物.md> --role sweep
 *   node gate.mjs --gate close    --state <state.json> --round-dir <dir>
 *   node gate.mjs --gate release  --state <state.json>
 *   node gate.mjs --list
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const jsonOut = process.argv.includes('--json');
const getArg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : null; };
const hasFlag = (n) => process.argv.includes(n);

// ────────────────────────────────────────────────────────────────────
// 门定义
// ────────────────────────────────────────────────────────────────────
const GATES = {
  dispatch: {
    name: '派发门',
    when: '每次派发子 Agent 之前',
    checks: ['attempt-ledger（这个任务还能不能派）', 'state.json schema（账本本身是否合法）'],
    onFail: '不得派发。按提示修正后再试。',
  },
  accept: {
    name: '准入闸',
    when: '每次收到子 Agent 返回后',
    checks: ['check-payload（契约合规）', 'verify-artifacts（门 0 回显真实性）'],
    onFail: '判 CONTRACT_VIOLATION，按 attempt 策略重派。**不得进下游**。',
  },
  close: {
    name: '收口门',
    when: '声明本轮 CLOSED 之前',
    checks: ['check-state（状态机合法）', 'check-deliverables（交付物齐全）'],
    onFail: '不得写 CLOSED，只能 PARTIALLY_CLOSED 或 BLOCKED。',
  },
  release: {
    name: '发布门',
    when: '生成最终报告之后、交给用户之前',
    checks: ['check-state（状态自洽）', 'lint-autonomy（框架规则未被改坏）'],
    onFail: '报告不得交付。框架自身有问题，先修框架。',
  },
};

function runScript(script, args) {
  const p = join(HERE, script);
  if (!existsSync(p)) return { ok: false, name: script, out: `脚本缺失: ${script}` };
  try {
    const out = execFileSync('node', [p, ...args], { encoding: 'utf8', cwd: HERE });
    return { ok: true, name: script, out };
  } catch (e) {
    const out = (e.stdout ?? '') + (e.stderr ?? '');
    return { ok: false, name: script, out };
  }
}

// ────────────────────────────────────────────────────────────────────
// --list
// ────────────────────────────────────────────────────────────────────
if (hasFlag('--list')) {
  if (jsonOut) {
    console.log(JSON.stringify(GATES, null, 2));
  } else {
    console.log('\n=== 门禁一览 ===\n');
    for (const [k, g] of Object.entries(GATES)) {
      console.log(`  --gate ${k}   ${g.name}`);
      console.log(`     何时: ${g.when}`);
      console.log(`     检查: ${g.checks.join(' / ')}`);
      console.log(`     失败: ${g.onFail}\n`);
    }
  }
  process.exit(0);
}

// ────────────────────────────────────────────────────────────────────
const gate = getArg('--gate');
if (!gate || !GATES[gate]) {
  console.error(`用法: node gate.mjs --gate <${Object.keys(GATES).join('|')}> [选项]`);
  console.error('       node gate.mjs --list');
  process.exit(2);
}

const results = [];
const add = (name, ok, out) => results.push({ name, ok, out });

// ────────────────────────────────────────────────────────────────────
// dispatch 门
// ────────────────────────────────────────────────────────────────────
if (gate === 'dispatch') {
  const payload = getArg('--payload');
  const ledger = getArg('--ledger');
  const state = getArg('--state');

  if (payload && ledger) {
    const r = runScript('attempt-ledger.mjs',
      ['--ledger', ledger, '--payload', payload, '--max', getArg('--max') ?? '3']);
    add('attempt-ledger', r.ok, r.out);
  } else {
    add('attempt-ledger', false, '未提供 --payload / --ledger，无法判定该不该派');
  }
  if (state) {
    const r = runScript('check-state.mjs', [state]);
    add('check-state', r.ok, r.out);
  }
}

// ────────────────────────────────────────────────────────────────────
// accept 门
// ────────────────────────────────────────────────────────────────────
if (gate === 'accept') {
  const artifact = getArg('--artifact');
  const role = getArg('--role');
  if (!artifact) {
    add('check-payload', false, '未提供 --artifact');
  } else {
    const args = [artifact];
    if (role) args.push('--role', role);
    const r = runScript('check-payload.mjs', args);
    add('check-payload', r.ok, r.out);
  }
  // 门 0 回显校验是可选的（需要 --repo）
  const repo = getArg('--repo');
  if (repo && artifact) {
    const dir = dirname(resolve(artifact));
    const r = runScript('verify-artifacts.mjs', ['--repo', repo, '--artifacts', dir]);
    add('verify-artifacts', r.ok, r.out);
  }
}

// ────────────────────────────────────────────────────────────────────
// close 门
// ────────────────────────────────────────────────────────────────────
if (gate === 'close') {
  const state = getArg('--state');
  const roundDir = getArg('--round-dir');
  if (state) {
    const r = runScript('check-state.mjs', [state]);
    add('check-state', r.ok, r.out);
  } else {
    add('check-state', false, '未提供 --state');
  }
  if (roundDir) {
    const r = runScript('check-deliverables.mjs', ['--round-dir', roundDir]);
    add('check-deliverables', r.ok, r.out);
  } else {
    add('check-deliverables', false, '未提供 --round-dir');
  }
}

// ────────────────────────────────────────────────────────────────────
// release 门
// ────────────────────────────────────────────────────────────────────
if (gate === 'release') {
  const state = getArg('--state');
  if (state) {
    const r = runScript('check-state.mjs', [state]);
    add('check-state', r.ok, r.out);
  }
  const r = runScript('lint-autonomy.mjs', []);
  add('lint-autonomy', r.ok, r.out);
}

// ────────────────────────────────────────────────────────────────────
// 输出
// ────────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
const passed = failed.length === 0;

if (jsonOut) {
  console.log(JSON.stringify({ gate, passed, results }, null, 2));
} else {
  const g = GATES[gate];
  console.log(`\n═══ ${g.name} (--gate ${gate}) ═══\n`);
  console.log(`  时机: ${g.when}\n`);

  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
    if (!r.ok) {
      const lines = r.out.trim().split('\n').filter(Boolean).slice(-12);
      for (const l of lines) console.log(`      ${l}`);
    }
  }

  console.log();
  if (passed) {
    console.log(`  ✅ 放行\n`);
  } else {
    console.log(`  ⛔ 拒绝 —— ${g.onFail}\n`);
  }
}

process.exit(passed ? 0 : 1);
