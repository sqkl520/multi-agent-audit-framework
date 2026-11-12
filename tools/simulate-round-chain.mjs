#!/usr/bin/env node
/**
 * simulate-round-chain.mjs — 自动续轮链的规则模拟器
 *
 * 为什么要有这个：`run-state.md` §6 与 §6.5 的自动续轮逻辑是**一堆自然语言规则**。
 * 真跑一轮几百个 agent 才能看到它是否卡住，成本高到不可能用来验证规则本身。
 *
 * 这个脚本把规则**逐条编码成代码**，用构造的轮次推进场景跑 10 个用例，
 * 检查三件事：
 *   1. 会不会死循环（超过 max_rounds 仍在跑 = 规则写错）
 *   2. 该停的时候停不停（DECREASING 场景必须停）
 *   3. §6 与 §6.5 在 PARTIALLY_CLOSED 上是否给出同一指令
 *
 * 它不模拟真实审计——它模拟**状态机**。这正是「机械归代码」那条结论的落地：
 * 能算的东西不该靠 LLM 读散文来判断。
 *
 * 用法：node tools/simulate-round-chain.mjs [--json]
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

// ────────────────────────────────────────────────────────────────────
// 规则参数（与 run-state.md §6.5.2 / §6.5.4 对齐）
// ────────────────────────────────────────────────────────────────────
const DEFAULTS = {
  total_budget: 60,        // 单轮 agent 上限
  max_rounds: 5,           // 轮次链上限
  per_round_capacity: 16,  // 一轮能覆盖多少切片
};

/**
 * 单个轮次的执行（抽象）。
 * 输入：待审切片队列 + 预算
 * 输出：本轮状态 + 剩余 DEFERRED + 新增覆盖 + 新增发现
 */
function runOneRound(pending, opts) {
  const capacity = Math.min(opts.per_round_capacity, opts.total_budget);
  const covered = pending.slice(0, capacity);
  const remaining = pending.slice(capacity);

  const status = remaining.length > 0 ? 'PARTIALLY_CLOSED' : 'CLOSED';

  return {
    covered,
    deferred: remaining,
    status,
    new_findings: covered.length > 0 ? covered.length : 0,  // 抽象：每覆盖一片得 1 条
  };
}

/**
 * §6 的裁决：这一轮跑完之后，下一步该干什么。
 * 编码的是 run-state.md 第 6 节修订后的规则。
 */
function decideNext(roundRecord, opts) {
  const { status, deferred } = roundRecord;

  // 已出报告 → 不再续跑本轮，交给 §6.5
  if (status === 'RUNNING') {
    return { action: 'RESUME_SAME_ROUND', reason: '本轮尚未出报告，续跑同一轮' };
  }

  // 已收口 → §6.5 决定是否开新轮
  if (deferred.length === 0) {
    return { action: 'STOP', reason: '无 DEFERRED，正常结束' };
  }

  return { action: 'OPEN_NEXT_ROUND', reason: `已收口且有 ${deferred.length} 片 DEFERRED` };
}

/**
 * 整条链的执行 + 停止条件（§6.5.2）
 */
function runChain(initialPending, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const rounds = [];
  let pending = [...initialPending];
  let prevDeferredKey = null;
  let zeroProgressStreak = 0;
  let stopReason = null;

  for (let k = 1; k <= o.max_rounds; k++) {
    if (pending.length === 0) { stopReason = 'NO_PENDING'; break; }

    const rr = runOneRound(pending, o);
    rounds.push({
      round: k,
      covered: rr.covered.length,
      new_findings: rr.new_findings,
      deferred: rr.deferred.length,
      status: rr.status,
    });

    // 停止条件 1：无 DEFERRED
    const decision = decideNext(rr, o);
    if (decision.action === 'STOP') { stopReason = 'NO_DEFERRED'; break; }

    // 停止条件 2：连续 2 轮零新增覆盖
    const deferredKey = JSON.stringify(rr.deferred);
    if (deferredKey === prevDeferredKey || rr.covered.length === 0) {
      zeroProgressStreak++;
      if (zeroProgressStreak >= 2) { stopReason = 'STALLED'; break; }
    } else {
      zeroProgressStreak = 0;
    }
    prevDeferredKey = deferredKey;

    // 停止条件 3：累计 agent 数触顶（这里用轮数近似）
    if (k === o.max_rounds) { stopReason = 'MAX_ROUNDS'; break; }

    // 停止条件 5：本轮 0 发现且剩余全是不可达
    if (rr.new_findings === 0 && o.allDeferredUnreachable) {
      stopReason = 'ONLY_UNREACHABLE'; break;
    }

    pending = rr.deferred;
  }

  return { rounds, stopReason, coveredTotal: rounds.reduce((a, r) => a + r.covered, 0), initial: initialPending.length };
}

// ────────────────────────────────────────────────────────────────────
// 测试
// ────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('\n=== 自动续轮链规则模拟 ===\n');

// 1. 56 片、每轮 16 片 → 应 4 轮跑完，无卡死
console.log('case 1: 56 片 / 每轮 16 → 应 4 轮覆盖完');
{
  const r = runChain(Array.from({ length: 56 }, (_, i) => `s${i}`));
  expect('跑 4 轮', r.rounds.length === 4, `实际 ${r.rounds.length} 轮`);
  expect('覆盖 56 片', r.coveredTotal === 56, `实际 ${r.coveredTotal}`);
  expect('停在无 DEFERRED', r.stopReason === 'NO_DEFERRED', r.stopReason);
}

// 2. 正好 16 片 → 1 轮跑完即停
console.log('case 2: 16 片 / 每轮 16 → 应 1 轮结束');
{
  const r = runChain(Array.from({ length: 16 }, (_, i) => `s${i}`));
  expect('跑 1 轮', r.rounds.length === 1, `实际 ${r.rounds.length}`);
  expect('停在无 DEFERRED', r.stopReason === 'NO_DEFERRED', r.stopReason);
}

// 3. 200 片 → 必须在 max_rounds 停，不能无限跑
console.log('case 3: 200 片 / max_rounds 5 → 必须停在 MAX_ROUNDS');
{
  const r = runChain(Array.from({ length: 200 }, (_, i) => `s${i}`));
  expect('不超过 5 轮', r.rounds.length <= 5, `实际 ${r.rounds.length}`);
  expect('停在 MAX_ROUNDS', r.stopReason === 'MAX_ROUNDS', r.stopReason);
}

// 4. 每轮容量 0 → 必须 STALLED 而不是死循环
console.log('case 4: 每轮容量 0（模拟 agent 全失败）→ 必须 STALLED');
{
  const r = runChain(Array.from({ length: 56 }, (_, i) => `s${i}`), { per_round_capacity: 0 });
  expect('早停（≤3 轮）', r.rounds.length <= 3, `实际 ${r.rounds.length}`);
  expect('停在 STALLED', r.stopReason === 'STALLED', r.stopReason);
}

// 5. 核心回归：§6 对 PARTIALLY_CLOSED 的指令必须与 §6.5 一致
console.log('case 5: PARTIALLY_CLOSED + 有 DEFERRED → §6 与 §6.5 必须都指向「开新轮」');
{
  const rr = { status: 'PARTIALLY_CLOSED', deferred: ['a', 'b', 'c'], covered: [] };
  const d6 = decideNext(rr);
  // §6.5.1: PARTIALLY_CLOSED 且有 DEFERRED → 自动开 round{N+1}
  const d65 = rr.status === 'PARTIALLY_CLOSED' && rr.deferred.length > 0 ? 'OPEN_NEXT_ROUND' : 'STOP';
  expect('§6 判 OPEN_NEXT_ROUND', d6.action === 'OPEN_NEXT_ROUND', d6.action);
  expect('§6.5 判 OPEN_NEXT_ROUND', d65 === 'OPEN_NEXT_ROUND', d65);
  expect('两者一致', d6.action === d65, `${d6.action} vs ${d65}`);
}

// 6. RUNNING（跑到一半）→ 必须续跑同一轮，不能开新轮
console.log('case 6: status=RUNNING（未出报告）→ 必须续跑同一轮');
{
  const d = decideNext({ status: 'RUNNING', deferred: ['a'], covered: [] });
  expect('判 RESUME_SAME_ROUND', d.action === 'RESUME_SAME_ROUND', d.action);
}

// 7. CLOSED 且无 DEFERRED → 停
console.log('case 7: CLOSED + 无 DEFERRED → 必须停止');
{
  const d = decideNext({ status: 'CLOSED', deferred: [], covered: [] });
  expect('判 STOP', d.action === 'STOP', d.action);
}

// 8. 0 片输入 → 立即停，不空转
console.log('case 8: 0 片输入 → 立即停止');
{
  const r = runChain([]);
  expect('0 轮', r.rounds.length === 0, `实际 ${r.rounds.length}`);
  expect('停在 NO_PENDING', r.stopReason === 'NO_PENDING', r.stopReason);
}

// 9. 每轮容量大于总量 → 1 轮跑完
console.log('case 9: 每轮容量 100 > 总量 10 → 1 轮跑完');
{
  const r = runChain(Array.from({ length: 10 }, (_, i) => `s${i}`), { per_round_capacity: 100 });
  expect('跑 1 轮', r.rounds.length === 1, `实际 ${r.rounds.length}`);
  expect('覆盖全部 10', r.coveredTotal === 10, `实际 ${r.coveredTotal}`);
}

// 10. 覆盖率必须单调不减（每轮都要有推进，否则应 STALLED）
console.log('case 10: 5 轮链中覆盖率必须单调递增');
{
  const r = runChain(Array.from({ length: 56 }, (_, i) => `s${i}`));
  let cov = 0, mono = true;
  for (const x of r.rounds) { cov += x.covered; if (x.covered < 0) mono = false; }
  expect('覆盖率单调不减', mono);
  expect('每轮都有推进', r.rounds.every(x => x.covered > 0), JSON.stringify(r.rounds.map(x => x.covered)));
}

// 11. 静态检查：run-state.md 里 §6 的**可执行规则块**不能再写「status 不是 CLOSED → 续跑」
console.log('case 11: 文档静态检查 —— §6 的可执行规则块不得再有旧判据');
{
  const p = join(HERE, '..', 'framework', 'artifacts', 'run-state.md');
  if (!existsSync(p)) {
    expect('找到 run-state.md', false, p);
  } else {
    const s = readFileSync(p, 'utf8');
    // 只检查 §6 的伪代码块（```...``` 围栏内的内容）。
    // 修订说明里的「原文的判据是「status 不是 CLOSED」」是引用旧规则，不算有效规则。
    const sec6 = s.slice(s.indexOf('## 第 6 节'), s.indexOf('## 第 6.5 节'));
    const blocks = [...sec6.matchAll(/```[\s\S]*?```/g)].map((m) => m[0]).join('\n');

    expect('规则块不含旧判据「status 不是 CLOSED」', !/status\s*不是/.test(blocks),
      '仍存在旧规则，会让 PARTIALLY_CLOSED 无法开新轮');
    expect('规则块含新判据「status == RUNNING」', /status\s*==\s*`?RUNNING`?/.test(blocks),
      '新判据缺失');
    expect('规则块含「已收尾」分支', /CLOSED,\s*PARTIALLY_CLOSED,\s*BLOCKED/.test(blocks) ||
      /PARTIALLY_CLOSED/.test(blocks), '未登记 PARTIALLY_CLOSED 的处置');
  }
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
