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
    checks: [
      'check-state（状态机合法）',
      'check-deliverables（交付物齐全）',
      // 2026-11-20 补：这两个是唯一能拦住「38 条发现只修 6 条、框架全程无工具报错」
      // 的机制（FIX-R1-R18-SUMMARY.md:10 记录的事故）。此前它们**不在任何门上**，
      // check-all 注册的也只是它们的自测。
      //
      // 按需执行：只有在给了 --artifacts+--ledger / --state+--report 时才跑，
      // 否则无法判定「该跑却没跑」——那种情况下宁可显式跳过也不要假装通过。
      'check-disposition-coverage（每条发现是否都被表态过）',
      'check-fix-instances（UPHELD 是否都进入了修复登记）',
      // 2026-11-25 补：check-handoff。
      //
      // `handoff-schema.md` 写了 5 个必填字段（generated_at / packet_digest 允许缺失）、10 种 open_items.kind、conflicts 的
      // 裁决约束，`check-handoff.mjs` 也实现了它们——但全仓库搜下来,
      // **只有它自己的 .test.mjs 会运行它**，四道门里一个都没有。
      // 也就是说这份契约在实际运行中从未被校验过一次。
      //
      // 注：`check-repo.mjs` 的 SKIPPED 里给它的旧理由只说了「需要 packet.json」，
      // **没有**说谁调用（前一轮我在别处写成「那句话是假的」，那句才是假的——
      // 已核对 git 历史，旧理由只是不完整）。
      //
      // 参数缺失时判 FAIL，理由同上面两条：收口门的意义就是「声明 CLOSED 之前必须过」。
      'check-handoff（Resume Packet 结构与裁决约束）',
    ],
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

  // 2026-11-20 补：把两个「发现去向」检查器真正接上收口门。
  //
  // 此前它们**不在任何门上**，check-all 注册的也只是 `.test.mjs` 自测
  //（验证校验器在合成 fixture 上行为正确，与真实产物无关）。
  // 于是框架史上最严重的那次事故——38 条发现只修 6 条、2 条 HIGH 仍在代码里、
  // 框架全程没有任何工具报错（FIX-R1-R18-SUMMARY.md:10）——发生时，
  // 唯一能拦住它的两个检查器一次都没被调用过。
  //
  // 参数缺失时判 FAIL 而不是跳过：收口门的意义就是「声明 CLOSED 之前必须过」。
  // 允许「不给参数就自动跳过」等于给出一条不检查也能收口的路径，
  // 而那正是 stop-hook.mjs 记过的失效形态（豁免数 ≥ 待检数 → 全量豁免 = 关掉检查）。
  const artifactsDir = getArg('--artifacts');
  const ledger = getArg('--ledger');
  if (artifactsDir && ledger) {
    const r = runScript('check-disposition-coverage.mjs', ['--artifacts', artifactsDir, '--ledger', ledger]);
    add('check-disposition-coverage', r.ok, r.out);
  } else {
    add('check-disposition-coverage', false,
      '未提供 --artifacts / --ledger。收口门要求每条发现都被表态过一次——'
      + '不给参数就无法证明，而「无法证明」不得当作「通过」');
  }

  const reportPath = getArg('--report');
  if (state && reportPath) {
    const r = runScript('check-fix-instances.mjs', ['--state', state, '--report', reportPath]);
    add('check-fix-instances', r.ok, r.out);
  } else {
    add('check-fix-instances', false,
      '未提供 --state / --report。收口门要求 UPHELD 的发现都进入修复登记——'
      + '没有最终报告里的裁决索引表，就只能比对主 Agent 的两份自述，而那是已被证明无效的');
  }

  // 2026-11-25 补：check-handoff。
  //
  // 参数缺失时判 FAIL，与上面两条同一条纪律。这是一处刻意的成本选择：
  // 波次闭合本来就是低频事件（一轮最多 5 次），多给一个参数不构成负担，
  // 而「不给参数就跳过」等于给出一条不校验 Resume Packet 也能收口的路径——
  // 那正是这整份契约在实际运行中从未被执行过的原因。
  const packetPath = getArg('--packet');
  if (packetPath) {
    // check-handoff 只接 <packet.json>；路径由这里保证。
    // 包路径可能在调用者的 cwd 下（相对路径），而 runScript 的 cwd 是 tools/。
    // 2026-11-25 锐评实测：给相对路径时门报「文件不存在」。
    // 这里只把 packet 转成绝对路径（不扩大改动面），其余参数的行为维持原样。
    const r = runScript('check-handoff.mjs', [resolve(process.cwd(), packetPath)]);
    add('check-handoff', r.ok, r.out);
  } else {
    add('check-handoff', false,
      '未提供 --packet <Resume Packet 路径>。handoff-schema.md 的必填字段、'
      + '10 种 open_items.kind、conflicts 的裁决约束（UPHELD 必须有 arbiter_artifact_ref）'
      + '都只在这一处被校验——不给包就无法证明它们成立，而「无法证明」不得当作「通过」');
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
    // 2026-11-25：通过项也要带上输出摘要。
    //
    // 原先只在 `!r.ok` 时打印子脚本输出，于是 check-handoff 的 **WARN 全部不可见**：
    // 「某个 open_item 缺 blocking」「有人工阻塞项，本轮只能 PARTIALLY_CLOSED」
    // 「packet_digest 不是 sha256」——这三条提示在唯一被接线的地方等于不存在。
    //
    // 现在：失败时仍打最后 12 行（原有行为）；通过时打**只有 WARN/提示**的那几行
    // （没有就不打），避免把几十行正常输出灌进去。
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name}`);
    const all = r.out.trim().split('\n').map((l) => l.trimEnd());
    if (!r.ok) {
      for (const l of all.filter(Boolean).slice(-12)) console.log(`      ${l}`);
    } else {
      // 提示行：子脚本的警告形态不统一——`! [rule]`（check-gate-doc-sync）、
      // `⚠️  file` + 下一行 `[rule]`（check-handoff）、`· INFO`（check-fix-instances）。
      // 2026-11-25 实测：`⚠️` 是 U+26A0 + 变体选择符，`/⚠\s/` 匹配不到。
      // 所以按「行里有 ⚠」或「行首是 [小写规则名]」两件事判，不依赖分隔符。
      const notes = all.filter((l) => /⚠|^\s*(!|·)\s|^\s*\[[a-z][a-z0-9_]*\]|项警告|warnings?\)/.test(l));
      for (const l of notes.slice(0, 10)) console.log(`      ${l.trim()}`);
      if (notes.length > 10) console.log(`      …（另有 ${notes.length - 10} 条提示）`);
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
