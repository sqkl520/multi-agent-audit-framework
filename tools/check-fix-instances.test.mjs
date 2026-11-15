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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
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

/**
 * 最终报告的「A. 裁决索引表」。
 * rows = [[finding_id, 裁决], [finding_id, 裁决, 严重性], [finding_id, 裁决, 严重性, 出处], ...]
 * 第四个元素是「出处」列的原文；不给则用默认的 `round1-03-critique-arbiter.md`。
 * 传 '' 用来构造「出处为空」。
 */
const DEFAULT_REF = '`round1-03-critique-arbiter.md`';

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
      for (const row of rows) {
        const [id, verdict, severity = 'HIGH', ref = DEFAULT_REF] = row;
        lines.push(`| ${id} | ${severity} | logic | \`src/a.ts:10\` | ${verdict} | ${ref} |`);
      }
      lines.push('');
    }
  }
  lines.push('## 2. 覆盖说明', '', '正文。', '');
  return lines.join('\n');
}

/**
 * 一份**合规的 Arbiter 锐评产物**：正文 + 末尾的 JSON 信封（output-contract §0）。
 * critique 契约 2.3：`payload.critique_role = "arbiter"`，
 * `payload.verdicts[] = [{ finding_id, verdict, reason }]`，
 * verdict 取 UPHELD / DOWNGRADED / REVOKED。
 *
 * opts.table=false    不写正文里的裁决表（只剩 JSON 信封）
 * opts.envelope=false 不写 JSON 信封（只剩正文裁决表）
 * 两者都 false → 这份产物解析不出任何裁决，不算锐评产物
 */
function arbiterMd(verdicts, opts = {}) {
  const lines = ['# round1 锐评产物 · arbiter', '', '裁决依据：证据包中的 evidence / inference 结构。'];
  if (opts.table !== false) {
    lines.push('', '| finding_id | 裁决 | 理由 |', '|---|---|---|',
      ...verdicts.map(([id, v]) => `| ${id} | ${v} | 证据满足 evidence-policy 的最低结构要求 |`), '');
  }
  if (opts.envelope !== false) {
    const env = {
      schema_version: 'output-contract-v1',
      agent_id: 'critique-arbiter-1',
      role: 'critique',
      status: 'SUCCESS',
      contract_valid: true,
      artifact_path: 'artifacts/round1-03-critique-arbiter.md',
      payload: {
        critique_role: 'arbiter',
        target_finding_ids: verdicts.map(([id]) => id),
        verdicts: verdicts.map(([id, v]) => ({
          finding_id: id,
          verdict: v,
          reason: '证据满足 evidence-policy 的最低结构要求',
        })),
      },
      error: null,
    };
    lines.push('```json', JSON.stringify(env, null, 2), '```', '');
  }
  return lines.join('\n');
}

/** 一份**审计**产物（role=audit）：有 JSON 信封，但里面是 `findings[]`，没有裁决。 */
function auditMd(ids) {
  const env = {
    schema_version: 'output-contract-v1',
    agent_id: 'audit-1',
    role: 'audit',
    status: 'SUCCESS',
    contract_valid: true,
    artifact_path: 'artifacts/round1-02-audit-slice-01-logic.md',
    payload: {
      findings: ids.map((id) => ({ finding_id: id, severity: 'HIGH', status: 'CONFIRMED' })),
    },
    error: null,
  };
  return ['# round1 审计产物', '', '正文。', '', '```json', JSON.stringify(env, null, 2), '```', ''].join('\n');
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

/**
 * 锐评产物工作区：report 同目录下多一个 artifacts/ 放锐评产物。
 *   artifacts: { '文件名': 文本 }；传 {} 且 makeDir=false → 目录都不建
 * 返回的对象带 artifactsDir，调用方自己拼 `--artifacts-dir`。
 */
function fixtureWithArtifacts(state, report, artifacts = {}, { makeDir = true } = {}) {
  const fx = fixture(state, report);
  const artifactsDir = join(fx.root, 'artifacts');
  if (makeDir) {
    mkdirSync(artifactsDir, { recursive: true });
    for (const [name, text] of Object.entries(artifacts)) {
      const p = join(artifactsDir, name);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    }
  }
  return { ...fx, artifactsDir, cleanup: () => rmSync(fx.root, { recursive: true, force: true }) };
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

// ══════════════════════════════════════════════════════════════════
// R10 · 洞 3：裁决索引表由主 Agent 自己写，可以全填 DOWNGRADED
//
// R7 §4 的实测：
//   HOLE-3 裁决表自填 DOWNGRADED + fix_contracts 空 -> R6 exit 0 | upheld 0 | rules []
//
// 根因：R6 把 final-report.md 当**外部基准**，但那份报告在流程上仍由主 Agent 落盘。
// 修法：裁决索引表每一行都有「出处」列，指向锐评相位的 Arbiter 产物。
// 不看裁决表说什么，看**出处的文件里说了什么**——那才是外部基准的外部基准。
//
// 以下用例先证明洞 3 会被抓，再证明降级路径不会把流程卡死。
// ══════════════════════════════════════════════════════════════════

// ── case 28（核心）：索引表说 DOWNGRADED，Arbiter 产物说 UPHELD ────
// 这就是洞 3 的复现：8 条 HIGH 全改成 DOWNGRADED，upheld 集合变空，missing=0。
// 若只验索引表内部一致性，这里会 exit 0 —— 那正是洞 3。
console.log('case 28: 索引表填 DOWNGRADED 但 Arbiter 产物说 UPHELD → verdict_mismatch_with_source');
{
  const highs = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'];
  const fx = fixtureWithArtifacts(
    stateOf({ contracts: [], spawned: 0 }),          // fix_contracts 空 = 洞 3 的另一半
    reportMd(highs.map((id) => [id, 'DOWNGRADED'])), // 主 Agent 自填：全部降级
    { 'round1-03-critique-arbiter.md': arbiterMd(highs.map((id) => [id, 'UPHELD'])) }, // 真相：全部维持
  );
  const r = run(fx, ['--artifacts-dir', fx.artifactsDir]);
  expect('退出码 1（不能因为改裁决表就变绿）', r.code === 1, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('报 verdict_mismatch_with_source', hasRule(r, 'verdict_mismatch_with_source'),
    JSON.stringify(rules(r)));
  expect('级别是 FAIL', hasLevel(r, 'verdict_mismatch_with_source', 'FAIL'),
    JSON.stringify(problemsWith(r, 'verdict_mismatch_with_source')));
  const p = problemWith(r, 'verdict_mismatch_with_source');
  expect('点名 F1（逐条，不是「有 N 条不一致」）', /\bF1\b/.test(p?.msg ?? ''), p?.msg?.slice(0, 400));
  expect('消息写明索引表 DOWNGRADED / 出处 UPHELD',
    /DOWNGRADED/.test(p?.msg ?? '') && /UPHELD/.test(p?.msg ?? ''), p?.msg?.slice(0, 400));
  expect('8 条全部逐条报出', problemsWith(r, 'verdict_mismatch_with_source').length === 8,
    String(problemsWith(r, 'verdict_mismatch_with_source').length));
  expect('交叉校验处于 ENABLED（产物存在）', r.data?.totals?.crosscheck === 'ENABLED',
    JSON.stringify(r.data?.totals));
  expect('upheld 计数仍是 0（和 R7 实测一致）', r.data?.totals?.upheld === 0,
    JSON.stringify(r.data?.totals));
  fx.cleanup();
}

// ── case 29：索引表与 Arbiter 产物一致 → 通过 ────────────────────
// 只加「会红」的判据会让人以为这套规则不可能满足。
console.log('case 29: 索引表 UPHELD，Arbiter 产物也 UPHELD → exit 0');
{
  const fx = fixtureWithArtifacts(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2')],
      spawned: 2,
    }),
    reportMd([['F1', 'UPHELD'], ['F2', 'UPHELD']]),
    { 'round1-03-critique-arbiter.md': arbiterMd([['F1', 'UPHELD'], ['F2', 'UPHELD']]) },
  );
  const r = run(fx, ['--artifacts-dir', fx.artifactsDir]);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('没有 FAIL', !(r.data?.problems ?? []).some((x) => x.level === 'FAIL'),
    JSON.stringify(r.data?.problems));
  expect('交叉校验处于 ENABLED', r.data?.totals?.crosscheck === 'ENABLED',
    JSON.stringify(r.data?.totals));
  expect('交叉校验行数 2', r.data?.totals?.verdictRefs === 2, JSON.stringify(r.data?.totals));
  fx.cleanup();
}

// ── case 29b：DOWNGRADED 全填且 Arbiter 也判 DOWNGRADED → 合法 ───
// 洞 3 的修法不能顺手把「真的全部降级」的轮次判死。
console.log('case 29b: 索引表 DOWNGRADED，Arbiter 也 DOWNGRADED，fix_contracts 空 → exit 0（合法轮次）');
{
  const fx = fixtureWithArtifacts(
    stateOf({ contracts: [], spawned: 0 }),
    reportMd([['F1', 'DOWNGRADED'], ['F2', 'REVOKED']]),
    { 'round1-03-critique-arbiter.md': arbiterMd([['F1', 'DOWNGRADED'], ['F2', 'REVOKED']]) },
  );
  const r = run(fx, ['--artifacts-dir', fx.artifactsDir]);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('没有 verdict_mismatch_with_source', !hasRule(r, 'verdict_mismatch_with_source'),
    JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 30：出处指向不存在的文件 → verdict_ref_not_found ─────────
console.log('case 30: 出处指向 artifacts-dir 下不存在的文件 → verdict_ref_not_found（FAIL）');
{
  const fx = fixtureWithArtifacts(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2')],
      spawned: 2,
    }),
    reportMd([
      ['F1', 'UPHELD', 'HIGH', '`round1-03-critique-arbiter.md`'],   // 存在
      ['F2', 'UPHELD', 'HIGH', '`round1-03-critique-nonexistent.md`'], // 不存在
    ]),
    { 'round1-03-critique-arbiter.md': arbiterMd([['F1', 'UPHELD'], ['F2', 'UPHELD']]) },
  );
  const r = run(fx, ['--artifacts-dir', fx.artifactsDir]);
  expect('退出码 1', r.code === 1, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('报 verdict_ref_not_found', hasRule(r, 'verdict_ref_not_found'), JSON.stringify(rules(r)));
  expect('级别是 FAIL', hasLevel(r, 'verdict_ref_not_found', 'FAIL'),
    JSON.stringify(problemsWith(r, 'verdict_ref_not_found')));
  const p = problemWith(r, 'verdict_ref_not_found');
  expect('消息里带原样的出处路径', /round1-03-critique-nonexistent\.md/.test(p?.msg ?? ''),
    p?.msg?.slice(0, 400));
  expect('只点名 F2 一行', problemsWith(r, 'verdict_ref_not_found').length === 1,
    String(problemsWith(r, 'verdict_ref_not_found').length));
  fx.cleanup();
}

// ── case 31：出处为空 → verdict_ref_missing ──────────────────────
console.log('case 31: 出处列为空 → verdict_ref_missing（FAIL，不受降级影响）');
{
  const fx = fixtureWithArtifacts(
    stateOf({ contracts: [contract('F1', 'fix-1')], spawned: 1 }),
    reportMd([['F1', 'UPHELD', 'HIGH', ''], ['F2', 'UPHELD', 'HIGH', '（见上文）']]),
    { 'round1-03-critique-arbiter.md': arbiterMd([['F1', 'UPHELD'], ['F2', 'UPHELD']]) },
  );
  const r = run(fx, ['--artifacts-dir', fx.artifactsDir]);
  expect('退出码 1', r.code === 1, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('报 verdict_ref_missing', hasRule(r, 'verdict_ref_missing'), JSON.stringify(rules(r)));
  expect('两条都报（空 + 非路径占位符）',
    problemsWith(r, 'verdict_ref_missing').length === 2,
    String(problemsWith(r, 'verdict_ref_missing').length));
  expect('级别是 FAIL', hasLevel(r, 'verdict_ref_missing', 'FAIL'),
    JSON.stringify(problemsWith(r, 'verdict_ref_missing')));
  fx.cleanup();
}

// ── case 31b：整列都没有「出处」→ verdict_ref_missing（不是 not_found）──
// 病因不同：整列缺失是「报告结构不合铁律」，写了个不存在的文件是「出处悬空」。
// 混报会让人去翻文件系统，而真正该改的是报告模板。
console.log('case 31b: 裁决索引表整列没有「出处」→ verdict_ref_missing（FAIL）');
{
  const fx = fixtureWithArtifacts(
    stateOf({ contracts: [], spawned: 0 }),
    [
      '# 报告', '',
      '## A. 裁决索引表（附加）', '',
      '| finding_id | 严重性 | 位置 | 裁决 |', '|---|---|---|---|',
      '| F1 | HIGH | `src/a.ts:10` | DOWNGRADED |', '',
    ].join('\n'),
    {},
  );
  const r = run(fx, ['--artifacts-dir', fx.artifactsDir]);
  expect('退出码 1', r.code === 1, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('报 verdict_ref_missing', hasRule(r, 'verdict_ref_missing'), JSON.stringify(rules(r)));
  expect('不报 verdict_ref_not_found', !hasRule(r, 'verdict_ref_not_found'), JSON.stringify(rules(r)));
  expect('totals 里记录 hasRefColumn=false', r.data?.totals?.hasRefColumn === false,
    JSON.stringify(r.data?.totals));
  fx.cleanup();
}

// ── case 32：出处文件在，但里面没有这条 finding → source_missing
console.log('case 32: 出处文件存在但里面没有该 finding_id → verdict_source_missing_finding（FAIL）');
{
  const fx = fixtureWithArtifacts(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2')],
      spawned: 2,
    }),
    reportMd([
      ['F1', 'UPHELD', 'HIGH', '`round1-03-critique-arbiter.md`'],
      ['F2', 'UPHELD', 'HIGH', '`round1-02-audit-slice-01-logic.md`'], // 审计产物：有 findings，无裁决
    ]),
    {
      'round1-03-critique-arbiter.md': arbiterMd([['F1', 'UPHELD']]),
      'round1-02-audit-slice-01-logic.md': auditMd(['F2']),
    },
  );
  const r = run(fx, ['--artifacts-dir', fx.artifactsDir]);
  expect('退出码 1', r.code === 1, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('报 verdict_source_missing_finding', hasRule(r, 'verdict_source_missing_finding'),
    JSON.stringify(rules(r)));
  const p = problemWith(r, 'verdict_source_missing_finding');
  expect('级别是 FAIL', p?.level === 'FAIL', p?.level);
  expect('点名 F2', /\bF2\b/.test(p?.msg ?? ''), p?.msg?.slice(0, 400));
  fx.cleanup();
}

// ── case 33：--artifacts-dir 不存在 → 降级 WARN，exit 0 ──────────
// 与 R8 的 unsupported_harness 同一纪律：不能因为产物目录缺失就把流程卡死。
console.log('case 33: --artifacts-dir 不存在 → 交叉校验降级为 WARN，exit 0');
{
  const fx = fixtureWithArtifacts(
    stateOf({ contracts: [], spawned: 0 }),
    reportMd([['F1', 'DOWNGRADED']]),
    {},
    { makeDir: false },
  );
  const r = run(fx, ['--artifacts-dir', join(fx.root, 'no-such-dir')]);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('交叉校验处于 DEGRADED', r.data?.totals?.crosscheck === 'DEGRADED',
    JSON.stringify(r.data?.totals));
  expect('报交叉校验降级规则（WARN）', hasLevel(r, 'verdict_crosscheck_degraded', 'WARN'),
    JSON.stringify(problemsWith(r, 'verdict_crosscheck_degraded')));
  expect('消息写明「退化为只验索引表内部一致性」',
    /只验索引表内部一致性/.test(problemWith(r, 'verdict_crosscheck_degraded')?.msg ?? ''),
    problemWith(r, 'verdict_crosscheck_degraded')?.msg?.slice(0, 400));
  expect('不报 verdict_ref_not_found 的 FAIL', !hasLevel(r, 'verdict_ref_not_found', 'FAIL'),
    JSON.stringify(problemsWith(r, 'verdict_ref_not_found')));
  fx.cleanup();
}

// ── case 33b：--artifacts-dir 存在但为空 → 同样降级 ──────────────
console.log('case 33b: --artifacts-dir 是空目录 → 交叉校验降级为 WARN，exit 0');
{
  const fx = fixtureWithArtifacts(
    stateOf({ contracts: [], spawned: 0 }),
    reportMd([['F1', 'DOWNGRADED']]),
    {},
  );
  const r = run(fx, ['--artifacts-dir', fx.artifactsDir]);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('交叉校验处于 DEGRADED', r.data?.totals?.crosscheck === 'DEGRADED',
    JSON.stringify(r.data?.totals));
  fx.cleanup();
}

// ── case 33c：出处为空在降级模式下**仍是 FAIL** ─────────────────
// 降级只豁免「无法核实」，不豁免「根本没写要核实什么」。
console.log('case 33c: 降级模式下「出处」为空仍是 FAIL（降级不豁免索引表自身的完整性）');
{
  const fx = fixtureWithArtifacts(
    stateOf({ contracts: [], spawned: 0 }),
    reportMd([['F1', 'DOWNGRADED', 'HIGH', '']]),
    {},
    { makeDir: false },
  );
  const r = run(fx, ['--artifacts-dir', join(fx.root, 'no-such-dir')]);
  expect('退出码 1', r.code === 1, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('报 verdict_ref_missing', hasRule(r, 'verdict_ref_missing'), JSON.stringify(rules(r)));
  expect('级别是 FAIL', hasLevel(r, 'verdict_ref_missing', 'FAIL'),
    JSON.stringify(problemsWith(r, 'verdict_ref_missing')));
  fx.cleanup();
}

// ── case 34：出处的解析容错（反引号 / ./ / round{N} 占位符）──────
// final-report.md:87 的模板写的是 `round{N}-03-critique-arbiter.md`——
// 带花括号占位符和反引号。若解析器只认字面路径，真实报告会全部报 not_found。
console.log('case 34: 出处带反引号 / ./ 前缀 / round{N} 占位符 → 都能解析到同一个文件');
{
  const fx = fixtureWithArtifacts(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2'), contract('F3', 'fix-3')],
      spawned: 3,
    }),
    reportMd([
      ['F1', 'UPHELD', 'HIGH', '`round1-03-critique-arbiter.md`'],
      ['F2', 'UPHELD', 'HIGH', './round1-03-critique-arbiter.md'],
      ['F3', 'UPHELD', 'HIGH', '`round{N}-03-critique-arbiter.md`'],
    ]),
    { 'round1-03-critique-arbiter.md': arbiterMd([['F1', 'UPHELD'], ['F2', 'UPHELD'], ['F3', 'UPHELD']]) },
  );
  const r = run(fx, ['--artifacts-dir', fx.artifactsDir]);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('三种写法都解析成功', r.data?.totals?.verdictRefs === 3, JSON.stringify(r.data?.totals));
  expect('没有 verdict_ref_not_found', !hasRule(r, 'verdict_ref_not_found'), JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 35：Arbiter 产物只有正文裁决表（无 JSON 信封）也能读 ───
// output-contract §0 要求 JSON 信封，但真实产物可能只有表。
// 读不到就报 source_missing_finding 会把「格式退化」误判成「结论被篡改」。
console.log('case 35: Arbiter 产物没有 JSON 信封、只有正文裁决表 → 仍能交叉校验');
{
  const fx = fixtureWithArtifacts(
    stateOf({
      contracts: [contract('F1', 'fix-1'), contract('F2', 'fix-2')],
      spawned: 2,
    }),
    reportMd([['F1', 'UPHELD'], ['F2', 'DOWNGRADED']]),
    { 'round1-03-critique-arbiter.md': arbiterMd([['F1', 'UPHELD'], ['F2', 'UPHELD']], { envelope: false }) },
  );
  const r = run(fx, ['--artifacts-dir', fx.artifactsDir]);
  expect('退出码 1', r.code === 1, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('仍报 verdict_mismatch_with_source', hasRule(r, 'verdict_mismatch_with_source'),
    JSON.stringify(rules(r)));
  expect('点名 F2', /\bF2\b/.test(problemWith(r, 'verdict_mismatch_with_source')?.msg ?? ''),
    problemWith(r, 'verdict_mismatch_with_source')?.msg?.slice(0, 400));
  fx.cleanup();
}

// ── case 36：审计产物不得被当成裁决来源（role 不是 critique）──────
// 拿一份审计产物当出处，等于「用自己的发现证明自己的裁决」——它没有裁决。
// 关键：此时产物目录**不空**（有审计产物），所以交叉校验不能降级成 WARN。
// 降级判据若写成「没有能读出裁决的产物」，这条绕法就成立——
// 把出处全指向审计产物即可让整轮只报一条 WARN。
console.log('case 36: 出处指向审计产物（无 verdicts）→ verdict_source_missing_finding');
{
  const fx = fixtureWithArtifacts(
    stateOf({ contracts: [], spawned: 0 }),
    reportMd([['F1', 'DOWNGRADED', 'HIGH', '`round1-02-audit-slice-01-logic.md`']]),
    {
      'round1-02-audit-slice-01-logic.md': auditMd(['F1']),
      'round1-03-critique-arbiter.md': arbiterMd([['F1', 'UPHELD']]),
    },
  );
  const r = run(fx, ['--artifacts-dir', fx.artifactsDir]);
  expect('退出码 1', r.code === 1, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('报 verdict_source_missing_finding', hasRule(r, 'verdict_source_missing_finding'),
    JSON.stringify(rules(r)));
  expect('交叉校验仍是 ENABLED（产物目录非空）', r.data?.totals?.crosscheck === 'ENABLED',
    JSON.stringify(r.data?.totals));
  expect('没有降级成 WARN', !hasRule(r, 'verdict_crosscheck_degraded'), JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 36b：只有审计产物的目录也不得让整轮降级 ─────────────────
// 这是 case 36 的整轮版：目录里 7 份审计产物，一行裁决都核对不到。
// 若降级判据是「没有可读裁决的产物」，整个洞 3 就被「指错产物」绕过了。
console.log('case 36b: 产物目录只有审计产物 → 不降级，逐行报 source_missing');
{
  const fx = fixtureWithArtifacts(
    stateOf({ contracts: [], spawned: 0 }),
    reportMd([
      ['F1', 'DOWNGRADED', 'HIGH', '`round1-02-audit-slice-01-logic.md`'],
      ['F2', 'DOWNGRADED', 'HIGH', '`round1-02-audit-slice-02-logic.md`'],
    ]),
    {
      'round1-02-audit-slice-01-logic.md': auditMd(['F1']),
      'round1-02-audit-slice-02-logic.md': auditMd(['F2']),
    },
  );
  const r = run(fx, ['--artifacts-dir', fx.artifactsDir]);
  expect('退出码 1', r.code === 1, `实际 ${r.code} / ${r.stdout.slice(-500)}`);
  expect('交叉校验 ENABLED', r.data?.totals?.crosscheck === 'ENABLED', JSON.stringify(r.data?.totals));
  expect('2 行都报 verdict_source_missing_finding',
    problemsWith(r, 'verdict_source_missing_finding').length === 2,
    String(problemsWith(r, 'verdict_source_missing_finding').length));
  expect('不报降级 WARN', !hasRule(r, 'verdict_crosscheck_degraded'), JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 37：--help 必须自述新参数与新规则 ──────────────────────
console.log('case 37: --help 说明 --artifacts-dir 与三条新规则');
{
  try {
    const out = execFileSync(process.execPath, [TOOL, '--help'], { encoding: 'utf8' });
    expect('含 --artifacts-dir', /--artifacts-dir/.test(out), out.slice(0, 400));
    expect('含 verdict_ref_missing', /verdict_ref_missing/.test(out));
    expect('含 verdict_ref_not_found', /verdict_ref_not_found/.test(out));
    expect('含 verdict_mismatch_with_source', /verdict_mismatch_with_source/.test(out));
    expect('含 verdict_source_missing_finding', /verdict_source_missing_finding/.test(out));
  } catch (e) {
    expect('--help exit 0', false, `实际 ${e.status}`);
  }
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
