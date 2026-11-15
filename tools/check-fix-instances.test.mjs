#!/usr/bin/env node
/**
 * check-fix-instances.test.mjs — 修复实例对账器的自测
 *
 * 这个检查器守的是 R5 明确指出的最后一个缺口：
 *
 *   `spawned_fix_agents` 与 `fix_contracts` 都是主Agent自述，
 *   两个自述互相对账不产生外部约束力。
 *
 * 所以用例的重心不在「自述内部是否自洽」，而在**外部基准**：
 *   - 少登记一条 UPHELD → 必须点名那一条（不是「覆盖率 86%」）
 *   - 修了不该修的（DOWNGRADED）→ 必须警告
 *   - 杜撰 id → 必须失败
 *   - 一个实例修多条却不申报 → 必须失败
 *   - 申报了合并但集合不相等 → 必须失败（「有交集」不是合并的理由）
 *   - 账本没记 spawned_fix_agents → 按 0 处理并失败（没记录等于没发生）
 *   - 报告里没有裁决索引表 → exit 2（没有外部基准，一切对账都无效）
 *   - 审计路径 → 跳过（这不是本检查器该管的路径）
 *
 * 最后两组用例直接复刻 hilltop-dsh 那次真实事故的形态：
 * 38 条 UPHELD、只有 6 条进入修复登记——检查器必须点名剩下 32 条。
 *
 * 全部用合成 fixture，不依赖 experiments/ 下的真实数据——
 * 真实数据会随修复漂移，而规则不该随它漂移。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-fix-instances.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

// ── fixture 构造 ──────────────────────────────────────────────────
/** 一条修复登记。target_files 是合并判据的唯一机械依据，所以留在契约上。 */
const contract = (findingId, agentId, extra = {}) => ({
  finding_id: findingId,
  fix_agent_id: agentId,
  registered_at: '2026-11-15T00:00:00Z',
  defect_statement: '当 X 时，Y 会发生，预期是 Z',
  disproof_condition: '运行 node tools/x.test.mjs 应退出 0',
  baseline_result: 'exit=1，断言失败',
  rollback_command: 'git checkout -- src/a.ts',
  test_path: 'tools/x.test.mjs',
  ...extra,
});

/**
 * state.json 构造。
 *   omitSpawned: true → 该字段**整个缺席**（「账本没记」的写法）
 *   spawned: '3'      → 字段在但不是数字（「记错了类型」的写法）
 * 两者都触发 spawned_count_absent：判据是「有没有一个可用的实际计数」，
 * 不是「键存不存在」——字符串 '3' 不能拿来对账，也不能默认它等于 3。
 */
function stateOf({
  pathMode = 'FIX', phase = 'wave4', contracts = [], discipline = [],
  spawned = 0, omitSpawned = false,
} = {}) {
  const budget = { total_cap: 60, spent: 10, reserved_for_downstream: 20 };
  if (!omitSpawned) budget.spawned_fix_agents = spawned;
  return {
    schema_version: 'run-state-v1',
    trace_id: 'trace-test-0001',
    round_id: 'round1',
    path_mode: pathMode,
    phase,
    status: 'RUNNING',
    budget,
    discipline_log: discipline,
    fix_contracts: contracts,
  };
}

/** 合并申报记录（wave4-fix.md:86-98 的格式）。 */
const mergedRecord = (findingIds, sharedTargetFiles) => ({
  kind: 'FIX_INSTANCE_MERGED',
  merged_finding_ids: findingIds,
  reason: 'target_files 完全相等，同一函数同一根因',
  shared_target_files: sharedTargetFiles,
  mechanically_checkable: '两条 finding 的 target_files 排序后逐元素相等',
});

/** 最终报告的「A. 裁决索引表」。rows = [[finding_id, 裁决], ...] */
function reportMd(rows, opts = {}) {
  const heading = opts.heading ?? '## A. 裁决索引表（附加）';
  const header = opts.header ?? ['finding_id', '严重性', '维度', '位置', '裁决', '出处'];
  const lines = [
    '# round1 最终报告',
    '',
    '## 1. 元信息',
    '',
    '| 字段 | 值 |',
    '|---|---|',
    '| 路径模式 | FIX |',
    '',
  ];
  if (heading) {
    lines.push(heading, '');
    if (header) {
      lines.push(`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`);
      for (const [id, verdict, severity = 'HIGH'] of rows) {
        lines.push(`| ${id} | ${severity} | logic | \`src/a.ts:10\` | ${verdict} | \`round1-03-critique-arbiter.md\` |`);
      }
      lines.push('');
    }
  }
  lines.push('## 2. 覆盖说明', '', '正文。', '');
  return lines.join('\n');
}

/**
 * 造一个临时工作区。
 *   state:  对象 → 写 state.json；null → 不写
 *   report: markdown 文本 → 写 final-report.md；null → 不写
 */
function fixture(state, report) {
  const root = mkdtempSync(join(tmpdir(), 'fi-test-'));
  const statePath = join(root, 'state.json');
  const reportPath = join(root, 'final-report.md');
  if (state !== null) {
    writeFileSync(statePath, typeof state === 'string' ? state : JSON.stringify(state, null, 2));
  }
  if (report !== null) writeFileSync(reportPath, report);
  return { root, statePath, reportPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function run(fx, extraArgs = [], opts = {}) {
  const jsonArgs = opts.json === false ? [] : ['--json'];
  const args = [TOOL, '--state', fx.statePath, '--report', fx.reportPath, ...jsonArgs, ...extraArgs];
  try {
    const out = execFileSync(process.execPath, args, { encoding: 'utf8' });
    return { code: 0, stdout: out, data: tryJson(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    return { code: e.status, stdout: out, stderr: e.stderr?.toString() ?? '', data: tryJson(out) };
  }
}

function tryJson(s) {
  const i = s.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

const rules = (r) => (r.data?.problems ?? []).map((p) => p.rule);
const hasRule = (r, rule) => rules(r).includes(rule);
const problemsWith = (r, rule) => (r.data?.problems ?? []).filter((p) => p.rule === rule);
const problemWith = (r, rule) => problemsWith(r, rule)[0];
const hasLevel = (r, rule, level) => (r.data?.problems ?? [])
  .some((p) => p.rule === rule && p.level === level);

console.log('\n=== 修复实例对账器自测 ===\n');

// ── case 1：全部合规 → exit 0 ─────────────────────────────────────
console.log('case 1: 3 条 UPHELD / 3 条登记 / 3 个实例 / spawned=3 → exit 0');
{
  const fx = fixture(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2'), contract('F3', 'fix-3')],
      spawned: 3,
    }),
    reportMd([['F1', 'UPHELD'], ['F2', 'UPHELD'], ['F3', 'UPHELD']]),
  );
  const r = run(fx);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  expect('没有 FAIL', !(r.data?.problems ?? []).some((p) => p.level === 'FAIL'),
    JSON.stringify(r.data?.problems));
  expect('未登记数 = 0', r.data?.totals?.missing === 0, JSON.stringify(r.data?.totals));
  fx.cleanup();
}

// ── case 2：少登记 1 条 → exit 1，且错误消息必须点名那条 id ──────
// 这是最重要的用例：R5 §5.1 的第 2 种绕法（只登记 1 条，stop-hook 判据不触发）。
console.log('case 2: 3 条 UPHELD 只登记 2 条 → exit 1，并点名缺的那条');
{
  const fx = fixture(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2')],
      spawned: 2,
    }),
    reportMd([['F1', 'UPHELD'], ['F2', 'UPHELD'], ['F3', 'UPHELD', 'MEDIUM']]),
  );
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 upheld_without_fix_contract', hasRule(r, 'upheld_without_fix_contract'),
    JSON.stringify(rules(r)));
  const p = problemWith(r, 'upheld_without_fix_contract');
  expect('错误消息点名 F3', /F3/.test(JSON.stringify(p ?? {})), JSON.stringify(p));
  expect('错误消息不点名已登记的 F1', !/\bF1\b/.test(JSON.stringify(p?.msg ?? '')), p?.msg);
  expect('级别永远是 FAIL', p?.level === 'FAIL', p?.level);
  expect('未登记计数 = 1', r.data?.totals?.missing === 1, JSON.stringify(r.data?.totals));
  expect('消息含「外部基准」的说明', /外部基准/.test(JSON.stringify(p ?? {})), p?.msg);
  fx.cleanup();
}

// ── case 3：修了 DOWNGRADED 的 → WARN，不阻断 ────────────────────
console.log('case 3: 登记的 finding 在裁决表里是 DOWNGRADED → WARN（exit 0）');
{
  const fx = fixture(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2')],
      spawned: 2,
    }),
    reportMd([['F1', 'UPHELD'], ['F2', 'DOWNGRADED']]),
  );
  const r = run(fx);
  expect('退出码 0（警告不阻断）', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  expect('报 fix_contract_not_upheld', hasRule(r, 'fix_contract_not_upheld'), JSON.stringify(rules(r)));
  expect('级别是 WARN', hasLevel(r, 'fix_contract_not_upheld', 'WARN'), JSON.stringify(problemsWith(r, 'fix_contract_not_upheld')));
  expect('消息含「修了不该修的」语义', /DOWNGRADED/.test(JSON.stringify(problemWith(r, 'fix_contract_not_upheld') ?? {})),
    JSON.stringify(problemWith(r, 'fix_contract_not_upheld')));
  fx.cleanup();
}

// ── case 4：修了表里完全没有的 id → FAIL ─────────────────────────
console.log('case 4: 登记的 finding 不在裁决索引表里 → exit 1（杜撰或拼错）');
{
  const fx = fixture(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F9', 'fix-2')],
      spawned: 2,
    }),
    reportMd([['F1', 'UPHELD']]),
  );
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 fix_contract_not_upheld', hasRule(r, 'fix_contract_not_upheld'), JSON.stringify(rules(r)));
  expect('级别是 FAIL', hasLevel(r, 'fix_contract_not_upheld', 'FAIL'),
    JSON.stringify(problemsWith(r, 'fix_contract_not_upheld')));
  expect('点名 F9', /F9/.test(JSON.stringify(problemWith(r, 'fix_contract_not_upheld') ?? {})),
    JSON.stringify(problemWith(r, 'fix_contract_not_upheld')));
  fx.cleanup();
}

// ── case 5：同一 fix_agent_id 承担 2 条但无合并申报 → FAIL ────────
console.log('case 5: 一个实例修 2 条 finding 且无 FIX_INSTANCE_MERGED → exit 1');
{
  const fx = fixture(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-1')],
      spawned: 1,
    }),
    reportMd([['F1', 'UPHELD'], ['F2', 'UPHELD']]),
  );
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 merged_without_record', hasRule(r, 'merged_without_record'), JSON.stringify(rules(r)));
  const p = problemWith(r, 'merged_without_record');
  expect('点名 fix-1', /fix-1/.test(JSON.stringify(p ?? {})), JSON.stringify(p));
  expect('点名两条 finding', /F1/.test(p?.msg ?? '') && /F2/.test(p?.msg ?? ''), p?.msg);
  fx.cleanup();
}

// ── case 6：有合并记录但 merged_finding_ids 不全 → FAIL ──────────
console.log('case 6: 有 FIX_INSTANCE_MERGED 但 merged_finding_ids 少一条 → exit 1');
{
  const fx = fixture(
    stateOf({
      contracts: [
        contract('F1', 'fix-1', { target_files: ['src/a.ts'] }),
        contract('F2', 'fix-1', { target_files: ['src/a.ts'] }),
      ],
      discipline: [mergedRecord(['F1'], ['src/a.ts'])],
      spawned: 1,
    }),
    reportMd([['F1', 'UPHELD'], ['F2', 'UPHELD']]),
  );
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 merged_without_record', hasRule(r, 'merged_without_record'), JSON.stringify(rules(r)));
  expect('消息指出记录与实际集合不一致', /不一致|不完整|对不上/.test(JSON.stringify(problemWith(r, 'merged_without_record') ?? {})),
    JSON.stringify(problemWith(r, 'merged_without_record')));
  expect('没有误报 merge_target_files_mismatch', !hasRule(r, 'merge_target_files_mismatch'),
    JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 7：shared_target_files 只是「有交集」→ FAIL ─────────────
// wave4-fix.md §0.3：集合相等，不是有交集。只重叠一部分时必须分开派发。
console.log('case 7: 合并记录的 shared_target_files 与 target_files 不等（只是有交集）→ exit 1');
{
  const fx = fixture(
    stateOf({
      contracts: [
        contract('F1', 'fix-1', { target_files: ['src/a.ts'] }),
        contract('F2', 'fix-2', { target_files: ['src/a.ts', 'src/b.ts'] }),
      ],
      discipline: [mergedRecord(['F1', 'F2'], ['src/a.ts'])],
      spawned: 2,
    }),
    reportMd([['F1', 'UPHELD'], ['F2', 'UPHELD']]),
  );
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 merge_target_files_mismatch', hasRule(r, 'merge_target_files_mismatch'),
    JSON.stringify(rules(r)));
  const p = problemWith(r, 'merge_target_files_mismatch');
  expect('点名 F2（多出的 src/b.ts）', /F2/.test(JSON.stringify(p ?? {})), JSON.stringify(p));
  expect('消息说明是「相等」而非「有交集」', /交集|相等/.test(p?.msg ?? ''), p?.msg);
  fx.cleanup();
}

// ── case 8：spawned_fix_agents 缺失 → 按 0 处理并 FAIL ───────────
// run-state.md:49「账本没记录等于没发生」，不能给「忘了记账」免罚。
console.log('case 8: budget.spawned_fix_agents 缺失 → exit 1（按 0 处理）');
{
  const fx = fixture(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2')],
      omitSpawned: true,
    }),
    reportMd([['F1', 'UPHELD'], ['F2', 'UPHELD']]),
  );
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 spawned_count_absent', hasRule(r, 'spawned_count_absent'), JSON.stringify(rules(r)));
  expect('级别是 FAIL', hasLevel(r, 'spawned_count_absent', 'FAIL'), JSON.stringify(problemsWith(r, 'spawned_count_absent')));
  expect('说明按 0 处理', /0/.test(problemWith(r, 'spawned_count_absent')?.msg ?? ''),
    problemWith(r, 'spawned_count_absent')?.msg);
  expect('不再重复报 spawned_count_mismatch', !hasRule(r, 'spawned_count_mismatch'),
    JSON.stringify(rules(r)));
  fx.cleanup();
}

console.log('case 8b: spawned_fix_agents 是字符串 "2" → 与缺失同判（不是数字就不能对账）');
{
  const fx = fixture(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2')],
      spawned: '2',
    }),
    reportMd([['F1', 'UPHELD'], ['F2', 'UPHELD']]),
  );
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 spawned_count_absent', hasRule(r, 'spawned_count_absent'), JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 9：spawned 与实际 distinct 实例数不符 → FAIL ────────────
console.log('case 9: spawned_fix_agents=3 但只有 2 个 fix_agent_id → exit 1');
{
  const fx = fixture(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2')],
      spawned: 3,
    }),
    reportMd([['F1', 'UPHELD'], ['F2', 'UPHELD']]),
  );
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 spawned_count_mismatch', hasRule(r, 'spawned_count_mismatch'), JSON.stringify(rules(r)));
  expect('没有报 spawned_count_absent', !hasRule(r, 'spawned_count_absent'), JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 10：审计路径 → 跳过，exit 0 ─────────────────────────────
console.log('case 10: path_mode=AUDIT_ONLY → 跳过全部检查，exit 0');
{
  const fx = fixture(
    stateOf({ pathMode: 'AUDIT_ONLY', phase: 'wave3', contracts: [], spawned: 0 }),
    reportMd([['F1', 'UPHELD'], ['F2', 'UPHELD'], ['F3', 'UPHELD']]),
  );
  const r = run(fx);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  expect('没有任何问题', (r.data?.problems ?? []).length === 0, JSON.stringify(r.data?.problems));
  expect('记录了跳过原因', r.data?.skipped === 'not_fix_path', JSON.stringify(r.data?.skipped));
  fx.cleanup();
}

// ── case 11：报告里找不到裁决索引表 → exit 2 ─────────────────────
// 没有外部基准时，任何「一致」都是自述内部的一致。
console.log('case 11: 报告里没有裁决索引表 → exit 2');
{
  const fx = fixture(
    stateOf({ contracts: [contract('F1', 'fix-1')], spawned: 1 }),
    '# 报告\n\n## 1. 元信息\n\n正文，没有表。\n\n## 2. 覆盖说明\n\n正文。\n',
  );
  const r = run(fx);
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('报 report_unparsable', hasRule(r, 'report_unparsable'), JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 12/13/14：配置错误三连 ──────────────────────────────────
console.log('case 12: state.json 不存在 → exit 2');
{
  const fx = fixture(null, reportMd([['F1', 'UPHELD']]));
  const r = run(fx);
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('报 state_missing', hasRule(r, 'state_missing'), JSON.stringify(rules(r)));
  fx.cleanup();
}

console.log('case 13: state.json 不是合法 JSON → exit 2');
{
  const fx = fixture('{ "path_mode": "FIX", ', reportMd([['F1', 'UPHELD']]));
  const r = run(fx);
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('报 state_invalid', hasRule(r, 'state_invalid'), JSON.stringify(rules(r)));
  fx.cleanup();
}

console.log('case 14: 最终报告不存在 → exit 2');
{
  const fx = fixture(
    stateOf({ contracts: [contract('F1', 'fix-1')], spawned: 1 }),
    null,
  );
  const r = run(fx);
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('报 report_missing', hasRule(r, 'report_missing'), JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 15：--strict 把 DOWNGRADED 警告升级为 FAIL ──────────────
console.log('case 15: --strict 下「修了 DOWNGRADED」→ exit 1');
{
  const fx = fixture(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2')],
      spawned: 2,
    }),
    reportMd([['F1', 'UPHELD'], ['F2', 'REJECTED']]),
  );
  const r = run(fx, ['--strict']);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('fix_contract_not_upheld 升级为 FAIL', hasLevel(r, 'fix_contract_not_upheld', 'FAIL'),
    JSON.stringify(problemsWith(r, 'fix_contract_not_upheld')));
  fx.cleanup();
}

// ── case 16：模板占位行 `| ... |` 不得被当成一条 finding ─────────
// final-report.md:87 的模板本身就有 `| ... | HIGH | ...` 这一行。
console.log('case 16: 裁决索引表里的模板占位行被忽略');
{
  const fx = fixture(
    stateOf({ contracts: [contract('F1', 'fix-1')], spawned: 1 }),
    reportMd([['...', 'UPHELD'], ['F1', 'UPHELD'], ['…', 'UPHELD'], ['—', '']]),
  );
  const r = run(fx);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  expect('解析到 1 条真实行', r.data?.totals?.reportRows === 1, String(r.data?.totals?.reportRows));
  fx.cleanup();
}

// ── case 17：真实事故形态（38 条 UPHELD / 6 条登记）──────────────
// experiments/hilltop-dsh：38 条发现、7 份产物、全部契约合规、最后只修了 6 条。
// 那次没有任何工具报错。这条用例要求检查器点名剩下 32 条。
console.log('case 17: 真实事故形态 —— 38 条 UPHELD，只登记 6 条 → 点名 32 条');
{
  const allIds = [
    'round1-core::F1', 'round1-core::F2', 'round1-core::F3',
    'round2-ai::R2-AI-001', 'round2-ai::R2-AI-002', 'round2-ai::R2-AI-003',
    'round2-ai::R2-AI-004', 'round2-ai::R2-AI-005',
    'round2-arena::F1', 'round2-arena::F2', 'round2-arena::F3', 'round2-arena::F4',
    'round2-mechanics::F1', 'round2-mechanics::F2', 'round2-mechanics::F3',
    'round2-mechanics::F4', 'round2-mechanics::F5',
    'round3-A::A-01', 'round3-A::A-02', 'round3-A::A-03', 'round3-A::A-04',
    'round3-A::A-05', 'round3-A::A-06', 'round3-A::A-07',
    'round3-B::B-01', 'round3-B::B-02', 'round3-B::B-03', 'round3-B::B-04',
    'round3-B::B-05', 'round3-B::B-06', 'round3-B::B-07',
    'round3-C::F1', 'round3-C::F2', 'round3-C::F3', 'round3-C::F4',
    'round3-C::F5', 'round3-C::F6', 'round3-C::F7',
  ];
  // disposition-ledger-example.md 里真实标了 FIXED 的 6 条
  const fixed = [
    'round1-core::F2', 'round2-ai::R2-AI-001', 'round2-ai::R2-AI-002',
    'round2-mechanics::F1', 'round2-mechanics::F2', 'round3-B::B-01',
  ];
  const fx = fixture(
    stateOf({
      contracts: fixed.map((id, i) => contract(id, `fix-${i + 1}`)),
      spawned: 6,
    }),
    reportMd(allIds.map((id) => [id, 'UPHELD'])),
  );
  const r = run(fx);
  expect('38 条全部解析到', r.data?.totals?.upheld === 38, JSON.stringify(r.data?.totals));
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('未登记 = 32', r.data?.totals?.missing === 32, JSON.stringify(r.data?.totals));
  const p = problemWith(r, 'upheld_without_fix_contract');
  expect('点名 round3-C::F7（一条从未进入任务书的 LOW）', /round3-C::F7/.test(JSON.stringify(p ?? {})),
    JSON.stringify(p)?.slice(0, 400));
  expect('点名 round2-mechanics::F3（HIGH）', /round2-mechanics::F3/.test(JSON.stringify(p ?? {})),
    JSON.stringify(p)?.slice(0, 400));
  expect('不点名已登记的 6 条', !/round1-core::F2/.test(p?.msg ?? ''), p?.msg?.slice(0, 400));
  expect('消息写明 N=32', /32/.test(p?.msg ?? ''), p?.msg?.slice(0, 400));
  fx.cleanup();
}

// ── case 18：phase 不在修复相位 → WARN（可能还没到）─────────────
console.log('case 18: path_mode=FIX 但 phase=wave3 → WARN（exit 0）');
{
  const fx = fixture(
    stateOf({ phase: 'wave3', contracts: [contract('F1', 'fix-1')], spawned: 1 }),
    reportMd([['F1', 'UPHELD']]),
  );
  const r = run(fx);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  expect('报 phase_not_wave4_or_wave5', hasRule(r, 'phase_not_wave4_or_wave5'), JSON.stringify(rules(r)));
  expect('级别是 WARN', hasLevel(r, 'phase_not_wave4_or_wave5', 'WARN'),
    JSON.stringify(problemsWith(r, 'phase_not_wave4_or_wave5')));
  fx.cleanup();
}

// ── case 19：人类可读输出样式与其他校验器一致 ──────────────────
console.log('case 19: 默认输出含 ✗ / 合计，且给出 UPHELD 与未登记计数');
{
  const fx = fixture(
    stateOf({ contracts: [contract('F1', 'fix-1')], spawned: 1 }),
    reportMd([['F1', 'UPHELD'], ['F2', 'UPHELD']]),
  );
  const r = run(fx, [], { json: false });
  expect('含 ✗', /✗/.test(r.stdout), r.stdout.slice(0, 300));
  expect('含 合计', /合计/.test(r.stdout), r.stdout.slice(-300));
  expect('含 UPHELD 计数', /UPHELD/.test(r.stdout), r.stdout.slice(0, 600));
  expect('含未登记计数', /未登记/.test(r.stdout), r.stdout.slice(0, 800));
  fx.cleanup();
}

// ── case 20：--help 自述用法与规则 ─────────────────────────────
console.log('case 20: --help 说明参数、10 条规则与退出码');
{
  try {
    const out = execFileSync(process.execPath, [TOOL, '--help'], { encoding: 'utf8' });
    expect('含 --state 与 --report', /--state/.test(out) && /--report/.test(out));
    expect('含核心规则名', /upheld_without_fix_contract/.test(out), out.slice(0, 300));
    expect('含 FIX_INSTANCE_MERGED', /FIX_INSTANCE_MERGED/.test(out));
    expect('含退出码说明', /exit 2|退出码/.test(out));
  } catch (e) {
    expect('--help exit 0', false, `实际 ${e.status}`);
  }
}

// ── case 21：合规的合并 → exit 0（要求不是不可能满足的）──────────
// 与 case 5/6/7 同一组 fixture 形态，只把申报写对。
// 没有这条，前三组用例只是在说「合并永远报错」——那会让人直接不申报合并。
console.log('case 21: 申报完整 + target_files 相等的合并 → exit 0');
{
  const fx = fixture(
    stateOf({
      contracts: [
        contract('F1', 'fix-1', { target_files: ['src/a.ts'] }),
        contract('F2', 'fix-1', { target_files: ['src/a.ts'] }),
      ],
      discipline: [mergedRecord(['F1', 'F2'], ['src/a.ts'])],
      spawned: 1,
    }),
    reportMd([['F1', 'UPHELD'], ['F2', 'UPHELD']]),
  );
  const r = run(fx);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('没有 FAIL', !(r.data?.problems ?? []).some((p) => p.level === 'FAIL'),
    JSON.stringify(r.data?.problems));
  expect('合并申报被识别', r.data?.totals?.merges === 1, JSON.stringify(r.data?.totals));
  fx.cleanup();
}

// ── case 22：0 条 UPHELD + 0 条 fix_contract → 合法，exit 0 ───────
// 任务书「关键设计问题」的第 2 半：没有要修的东西时，空是对的。
// 若这里判红，那么「全部 DOWNGRADED/REJECTED」的轮次将无法交付。
console.log('case 22: 裁决表 0 条 UPHELD 且 fix_contracts 为空 → exit 0（没有要修的东西）');
{
  const fx = fixture(
    stateOf({ contracts: [], spawned: 0 }),
    reportMd([['F1', 'DOWNGRADED'], ['F2', 'REJECTED']]),
  );
  const r = run(fx);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('UPHELD 计数 0', r.data?.totals?.upheld === 0, JSON.stringify(r.data?.totals));
  expect('未登记 0', r.data?.totals?.missing === 0, JSON.stringify(r.data?.totals));
  expect('没有 FAIL', !(r.data?.problems ?? []).some((p) => p.level === 'FAIL'),
    JSON.stringify(r.data?.problems));
  fx.cleanup();
}

// ── case 23：0 条 UPHELD + 3 条 fix_contract（裁决表里有这几行）────
// 「同一侧为空」的对称检查：只查 ⊇ 会漏掉「登记了一堆非 UPHELD 的修复」。
// 级别按任务书的严重度表：在表里但裁决不是 UPHELD → WARN（可能只是裁决表没同步），
// 所以这里是 exit 0，但 3 条都必须被点名。
console.log('case 23: 0 条 UPHELD + 3 条 fix_contract 且裁决表里有这几行 → 3 条 WARN');
{
  const fx = fixture(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2'), contract('F3', 'fix-3')],
      spawned: 3,
    }),
    reportMd([['F1', 'DOWNGRADED'], ['F2', 'REJECTED'], ['F3', 'WONT_FIX']]),
  );
  const r = run(fx);
  expect('退出码 0（3 条都是 WARN，不阻断）', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  expect('3 条都报 fix_contract_not_upheld', problemsWith(r, 'fix_contract_not_upheld').length === 3,
    JSON.stringify(problemsWith(r, 'fix_contract_not_upheld')));
  expect('全部是 WARN 级', problemsWith(r, 'fix_contract_not_upheld').every((p) => p.level === 'WARN'),
    JSON.stringify(problemsWith(r, 'fix_contract_not_upheld').map((p) => p.level)));
  expect('没有误报 upheld_without_fix_contract', !hasRule(r, 'upheld_without_fix_contract'),
    JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 23b：0 条 UPHELD + 3 条 fix_contract（表里根本没有这些 id）──
// 这才是设计问题里「规则 5 全部 FAIL」的那一半：登记侧凭空多出 3 条。
console.log('case 23b: 0 条 UPHELD + 3 条 fix_contract 且表里没有这些 id → 3 条 FAIL');
{
  const fx = fixture(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2'), contract('F3', 'fix-3')],
      spawned: 3,
    }),
    reportMd([['X-01', 'DOWNGRADED']]),
  );
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('3 条都报 fix_contract_not_upheld', problemsWith(r, 'fix_contract_not_upheld').length === 3,
    JSON.stringify(problemsWith(r, 'fix_contract_not_upheld')));
  expect('全部是 FAIL 级', problemsWith(r, 'fix_contract_not_upheld').every((p) => p.level === 'FAIL'),
    JSON.stringify(problemsWith(r, 'fix_contract_not_upheld').map((p) => p.level)));
  fx.cleanup();
}

// ── case 23c：裁决表存在但一行数据都没有 → exit 0 ────────────────
// 表头在、数据行为空。这不是「解析失败」，是「这一轮确实没有发现」。
console.log('case 23c: 裁决索引表存在但 0 行数据 → exit 0');
{
  const fx = fixture(
    stateOf({ contracts: [], spawned: 0 }),
    [
      '# 报告', '',
      '## A. 裁决索引表（附加）', '',
      '| finding_id | 严重性 | 位置 | 裁决 | 出处 |', '|---|---|---|---|---|', '',
      '## 2. 覆盖说明', '', '正文。', '',
    ].join('\n'),
  );
  const r = run(fx);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  expect('解析到 0 行', r.data?.totals?.reportRows === 0, JSON.stringify(r.data?.totals));
  fx.cleanup();
}

// ── case 24：fix_contracts 为空 + 5 条 UPHELD → 5 条未登记 ───────
// 「一条都没派发」不是「没东西可修」。两个空数组看起来一样，
// 但裁决表里有 5 条 UPHELD 时它们的意思完全不同。
console.log('case 24: fix_contracts 为空 + 5 条 UPHELD → exit 1，缺口 5 条');
{
  const ids = ['F1', 'F2', 'F3', 'F4', 'F5'];
  const fx = fixture(
    stateOf({ contracts: [], spawned: 0 }),
    reportMd(ids.map((id) => [id, 'UPHELD'])),
  );
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('缺口 = 5', r.data?.totals?.missing === 5, JSON.stringify(r.data?.totals));
  expect('点名全部 5 条', ids.every((id) => new RegExp(`\\b${id}\\b`).test(problemWith(r, 'upheld_without_fix_contract')?.msg ?? '')),
    problemWith(r, 'upheld_without_fix_contract')?.msg);
  fx.cleanup();
}

// ── case 25：只有 finding_id 没有裁决列 → exit 2 ────────────────
// 「有张表」不等于「有裁决索引表」。报告里还有元信息表、覆盖率表、缺陷族表。
console.log('case 25: 表里有 finding_id 但没有裁决列 → exit 2（不能拿别的表顶替）');
{
  const fx = fixture(
    stateOf({ contracts: [contract('F1', 'fix-1')], spawned: 1 }),
    [
      '# 报告', '',
      '## 5. 缺陷族', '',
      '| finding_id | 严重性 | 位置 |', '|---|---|---|',
      '| F1 | HIGH | `src/a.ts:10` |', '',
    ].join('\n'),
  );
  const r = run(fx);
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('报 report_unparsable', hasRule(r, 'report_unparsable'), JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 26：围栏里贴的示例裁决表不得被当成真实数据 ──────────────
// final-report.md 的模板片段本身就带一张示例表（含 `| ... |`）。
// 不跳过围栏会凭空多出一条 id 叫 "..." 的 UPHELD。
console.log('case 26: 围栏代码块里的示例裁决表被忽略');
{
  const fx = fixture(
    stateOf({ contracts: [contract('F1', 'fix-1')], spawned: 1 }),
    [
      '# 报告', '',
      '## A. 裁决索引表（附加）', '',
      '| finding_id | 严重性 | 位置 | 裁决 | 出处 |', '|---|---|---|---|---|',
      '| F1 | HIGH | `src/a.ts:10` | UPHELD | `arbiter.md` |', '',
      '下面是格式示例，不是数据：', '',
      '```markdown',
      '| finding_id | 严重性 | 位置 | 裁决 | 出处 |', '|---|---|---|---|---|',
      '| F9 | HIGH | `x:1` | UPHELD | `y.md` |',
      '```', '',
    ].join('\n'),
  );
  const r = run(fx);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('F9 未被当成 UPHELD', r.data?.totals?.upheld === 1, JSON.stringify(r.data?.totals));
  fx.cleanup();
}

// ── case 27：核心规则不受 --strict 影响（它是唯一的硬判据）──────────
// 任务书：「规则 4 永远 FAIL，不受 --strict 影响——这是核心」。
// 若 --strict 的语义被理解成「不开就宽松」，这条会被误当成可选项。
// 它没有 WARN 形态：判据来自外部文件，不是主Agent能自证的。
console.log('case 27: upheld_without_fix_contract 在 --strict 与否都是 FAIL');
{
  const build = () => fixture(
    stateOf({ contracts: [contract('F1', 'fix-1')], spawned: 1 }),
    reportMd([['F1', 'UPHELD'], ['F2', 'UPHELD']]),
  );

  const plain = build();
  const r1 = run(plain);
  expect('默认模式：级别 FAIL', hasLevel(r1, 'upheld_without_fix_contract', 'FAIL'),
    JSON.stringify(problemsWith(r1, 'upheld_without_fix_contract')));
  expect('默认模式：exit 1', r1.code === 1, `实际 ${r1.code}`);
  plain.cleanup();

  const strict = build();
  const r2 = run(strict, ['--strict']);
  expect('--strict 模式：级别仍是 FAIL', hasLevel(r2, 'upheld_without_fix_contract', 'FAIL'),
    JSON.stringify(problemsWith(r2, 'upheld_without_fix_contract')));
  expect('--strict 模式：exit 1', r2.code === 1, `实际 ${r2.code}`);
  strict.cleanup();
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
