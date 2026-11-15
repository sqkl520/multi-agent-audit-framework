#!/usr/bin/env node
/**
 * check-payload.test.mjs — 契约准入检查器的自测
 *
 * 为什么专门测：这是「事前门」，如果它自己失灵，整个 L2 契约层就是装饰。
 * 而本框架已经出过三次「检查器看起来在工作实际挡不住」的事：
 *   - L9 把 T2 改成 2 仍报通过
 *   - L1 的「不得」豁免让「不得擅自行动，请等待用户决定」过关
 *   - 文档里两个矛盾的 §7.1 无人发现
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-payload.mjs');
let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};
;

function run(content, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-test-'));
  const f = join(dir, 'artifact.md');
  writeFileSync(f, content);
  // 2026-11-10：check-payload 现在校验 artifact_path 的真实存在性。
  // 测试里为了方便，把信封中出现的形如 /x/... 的伪路径改成真实的临时文件，
  // 避免每个用例都得手动造文件。需要测「文件不存在」时用 runRaw。
  const fixed = content.replace(
    /"artifact_path":\s*"(\/[^"]*)"/g,
    (_m, _p) => `"artifact_path": ${JSON.stringify(f)}`,
  );
  if (fixed !== content) writeFileSync(f, fixed);
  try {
    const out = execFileSync('node', [SCRIPT, f, '--json', ...extraArgs], { encoding: 'utf8' });
    return { code: 0, r: JSON.parse(out) };
  } catch (e) {
    try { return { code: e.status ?? 1, r: JSON.parse(e.stdout) }; }
    catch { return { code: e.status ?? 1, r: null, raw: e.stdout }; }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 不改写 artifact_path 的版本，用于测「文件不存在」的情形
function runRaw(content, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-test-'));
  const f = join(dir, 'artifact.md');
  writeFileSync(f, content);
  try {
    const out = execFileSync('node', [SCRIPT, f, '--json', ...extraArgs], { encoding: 'utf8' });
    return { code: 0, r: JSON.parse(out) };
  } catch (e) {
    try { return { code: e.status ?? 1, r: JSON.parse(e.stdout) }; }
    catch { return { code: e.status ?? 1, r: null, raw: e.stdout }; }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const env = (over = {}) => JSON.stringify({
  schema_version: 'output-contract-v1',
  agent_id: 'a1',
  role: 'sweep',
  status: 'SUCCESS',
  contract_valid: true,
  artifact_path: '/x/y.md',
  payload: {
    slice_id: 'slice-01',
    reachability: 'PROD',
    files_read: ['a.js'],
    leads: [{ lead_id: 'L1' }],
    lead_count: 1,
  },
  error: null,
  ...over,
}, null, 2);

const wrap = (j) => '# 产物\n\n```json\n' + j + '\n```\n';

console.log('\n=== 契约准入检查器自测 ===\n');

console.log('case 1: 合规的 sweep 信封 → 通过');
{
  const r = run(wrap(env()));
  expect('退出码 0', r.code === 0, `got ${r.code}`);
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 2: 没有 json 块（真实产物的 100% 情况）→ 报错');
{
  const r = run('# 宽扫结果\n\n找到了 3 条线索。\n');
  expect('退出码 1', r.code === 1, `got ${r.code}`);
  expect('报 no_json_envelope', r.r?.errors?.some(e => e.rule === 'no_json_envelope'));
  expect('给出修法', r.r?.errors?.[0]?.fix?.length > 0);
}

console.log('case 3: JSON 语法错误 → 报错');
{
  const r = run('# x\n\n```json\n{ "role": "sweep", BROKEN }\n```\n');
  expect('报 json_parse_failed', r.r?.errors?.some(e => e.rule === 'json_parse_failed'));
}

console.log('case 4: 缺顶层字段 → 报错');
{
  const e = JSON.parse(env());
  delete e.agent_id;
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 missing_top_field', r.r?.errors?.some(e2 => e2.rule === 'missing_top_field' && e2.field === 'agent_id'));
}

console.log('case 5: schema_version 错误 → 报错');
{
  const e = JSON.parse(env());
  e.schema_version = 'output-contract-v2';
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 wrong_schema_version', r.r?.errors?.some(x => x.rule === 'wrong_schema_version'));
}

console.log('case 6: role 非法 → 报错');
{
  const e = JSON.parse(env());
  e.role = 'supervisor';
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 invalid_role', r.r?.errors?.some(x => x.rule === 'invalid_role'));
}

console.log('case 7: --role 不匹配 → 报错');
{
  const r = run(wrap(env()), ['--role', 'audit']);
  expect('报 role_mismatch', r.r?.errors?.some(x => x.rule === 'role_mismatch'));
}

console.log('case 8: lead_count 与实际不符 → 报错');
{
  const e = JSON.parse(env());
  e.payload.lead_count = 5;
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 count_mismatch', r.r?.errors?.some(x => x.rule === 'count_mismatch'));
}

console.log('case 9: SUCCESS 但缺 artifact_path → 报错');
{
  const e = JSON.parse(env());
  delete e.artifact_path;
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 missing_artifact_path', r.r?.errors?.some(x => x.rule === 'missing_artifact_path'));
}

console.log('case 10: 非 SUCCESS 时缺 artifact_path → 不报错');
{
  const e = JSON.parse(env());
  delete e.artifact_path;
  e.status = 'RETRYABLE_FAILURE';
  e.error = { error_type: 'Timeout', message: 'x' };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('不报 missing_artifact_path', !r.r?.errors?.some(x => x.rule === 'missing_artifact_path'));
}

console.log('case 11: sweep 缺 leads → 报错');
{
  const e = JSON.parse(env());
  delete e.payload.leads;
  delete e.payload.lead_count;
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 missing_role_field', r.r?.errors?.some(x => x.rule === 'missing_role_field'));
}

console.log('case 12: planner 的 member_count 不符 → 报错');
{
  const j = JSON.stringify({
    schema_version: 'output-contract-v1', agent_id: 'p1', role: 'planner',
    status: 'SUCCESS', contract_valid: true, artifact_path: '/x',
    payload: {
      tier: 'T2', score: 3,
      score_breakdown: { K1: 1, K2: 1, K3: 1 },
      members: [{ role: 'execute', count: 1 }], member_count: 9,
    }, error: null,
  }, null, 2);
  const r = run(wrap(j));
  expect('报 count_mismatch', r.r?.errors?.some(x => x.rule === 'count_mismatch'));
}

console.log('case 13: 多个 json 块 → 只警告不报错');
{
  const r = run(wrap(env()) + '\n```json\n{}\n```\n');
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
  expect('有警告', (r.r?.warnings?.length ?? 0) > 0);
}

// ── audit self_checks（2026-11-09 新增：三项必做必须有承载字段）──
const auditEnv = (sc) => JSON.stringify({
  schema_version: 'output-contract-v1',
  agent_id: 'a1', role: 'audit', status: 'SUCCESS', contract_valid: true,
  artifact_path: '/x/a.md',
  payload: {
    slice_id: 'slice-01',
    // 2026-11-10：NO_EVIDENCE_FOUND 现在必须带 searched_scope 与实质 basis，
    // 否则「什么都不做」就能通过准入（红队 A1）。辅助函数给合规的默认值。
    searched_scope: {
      files_read: ['a.js'],
      files_in_slice: 1,
      dimension_checklist: ['条件分支'],
    },
    findings: [{
      finding_id: 'f1',
      status: 'NO_EVIDENCE_FOUND',
      evidence: { file: null, line: null, quote: null },
      inference: {
        claim: '本切片未发现满足门 0 的问题',
        basis: '已读取全部切片文件，检查了条件分支与循环边界，未发现可用证据',
        alternatives: [],
      },
    }],
    ...(sc === undefined ? {} : { self_checks: sc }),
  },
  error: null,
}, null, 2);

console.log('case 14: audit 缺 self_checks → 报错（不能静默不做三项必做）');
{
  const r = run(wrap(auditEnv()));
  expect('报 missing_role_field', r.r?.errors?.some(x => x.rule === 'missing_role_field' && /self_checks/.test(x.field ?? '')));
}

console.log('case 15: audit self_checks 缺某一项 → 报错并指名');
{
  const r = run(wrap(auditEnv({
    identifier_reconcile: { status: 'DONE' },
    self_check_audit: { status: 'DONE' },
  })));
  expect('报 missing_self_check 且指向 runtime_validation',
    r.r?.errors?.some(x => x.rule === 'missing_self_check' && /runtime_validation/.test(x.field ?? '')));
}

console.log('case 16: audit self_checks 三项齐全且 DONE → 通过');
{
  const r = run(wrap(auditEnv({
    identifier_reconcile: { status: 'DONE' },
    self_check_audit: { status: 'DONE' },
    runtime_validation: { status: 'DONE' },
  })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 17: SKIPPED 但没有具体理由 → 报错（静默跳过 == 没做）');
{
  const r = run(wrap(auditEnv({
    identifier_reconcile: { status: 'SKIPPED' },
    self_check_audit: { status: 'DONE' },
    runtime_validation: { status: 'DONE' },
  })));
  expect('报 self_check_no_reason', r.r?.errors?.some(x => x.rule === 'self_check_no_reason'));
}

console.log('case 18: SKIPPED 且理由太短（<10 字）→ 报错');
{
  const r = run(wrap(auditEnv({
    identifier_reconcile: { status: 'SKIPPED', note: '无' },
    self_check_audit: { status: 'DONE' },
    runtime_validation: { status: 'DONE' },
  })));
  expect('报 self_check_no_reason', r.r?.errors?.some(x => x.rule === 'self_check_no_reason'));
}

console.log('case 19: NOT_APPLICABLE 且有理由 → 通过');
{
  const r = run(wrap(auditEnv({
    identifier_reconcile: { status: 'NOT_APPLICABLE', note: '纯文档仓库，无 CSS 变量 / DOM id / 状态类需对账' },
    self_check_audit: { status: 'NOT_APPLICABLE', note: '项目未自带任何 check-*.mjs 或 verify*.mjs 脚本' },
    runtime_validation: { status: 'NOT_APPLICABLE', note: '本项目无可执行代码，无 HTTP 服务可起' },
  })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 20: 自检 status 非法值 → 报错');
{
  const r = run(wrap(auditEnv({
    identifier_reconcile: { status: 'YES' },
    self_check_audit: { status: 'DONE' },
    runtime_validation: { status: 'DONE' },
  })));
  expect('报 invalid_self_check_status', r.r?.errors?.some(x => x.rule === 'invalid_self_check_status'));
}

console.log('case 21: 支持字符串简写形式（"DONE" 而非对象）');
{
  const r = run(wrap(auditEnv({
    identifier_reconcile: 'DONE',
    self_check_audit: 'DONE',
    runtime_validation: 'DONE',
  })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

// ── recon 入口点与切片独立性（2026-11-09 新增）──
const reconEnv = (over = {}) => JSON.stringify({
  schema_version: 'output-contract-v1',
  agent_id: 'r1', role: 'recon', status: 'SUCCESS', contract_valid: true,
  artifact_path: '/x/r.md',
  payload: {
    slice_count: 1,
    audit_slices: [{ slice_id: 'slice-01', files: ['a.js'], file_count: 1 }],
    entry_points: [{ entry_id: 'e1', kind: 'CLI', location: 'a.js:1', evidence_quote: '#!/usr/bin/env node' }],
    unverified: [],
    ...over,
  },
  error: null,
}, null, 2);

console.log('case 22: recon 缺 entry_points → 报错');
{
  const e = JSON.parse(reconEnv()); delete e.payload.entry_points;
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 missing_role_field', r.r?.errors?.some(x => x.rule === 'missing_role_field' && /entry_points/.test(x.field ?? '')));
}

console.log('case 23: entry_points 写成字符串数组（旧契约的错误形态）→ 报错');
{
  const r = run(wrap(reconEnv({ entry_points: ['a.js:1', 'b.js:9'] })));
  expect('报 entry_point_not_object', r.r?.errors?.some(x => x.rule === 'entry_point_not_object'));
}

console.log('case 24: 入口点缺 evidence_quote → 报错（门 0 不通过）');
{
  const r = run(wrap(reconEnv({ entry_points: [{ entry_id: 'e1', location: 'a.js:1' }] })));
  expect('报 missing_entry_point_field', r.r?.errors?.some(x => x.rule === 'missing_entry_point_field' && /evidence_quote/.test(x.field ?? '')));
}

console.log('case 25: 两个切片 files 相交 → 报错');
{
  const r = run(wrap(reconEnv({
    slice_count: 2,
    audit_slices: [
      { slice_id: 'slice-01', files: ['a.js', 'b.js'] },
      { slice_id: 'slice-02', files: ['b.js', 'c.js'] },
    ],
  })));
  expect('报 slice_overlap', r.r?.errors?.some(x => x.rule === 'slice_overlap'));
}

console.log('case 26: 同一文件既在 files 又在 shared_dependencies → 报错');
{
  const r = run(wrap(reconEnv({
    audit_slices: [{ slice_id: 'slice-01', files: ['a.js'], shared_dependencies: ['a.js'] }],
  })));
  expect('报 shared_in_files', r.r?.errors?.some(x => x.rule === 'shared_in_files'));
}

console.log('case 27: entry_points_truncated=true 但 unverified 没说明 → 报错');
{
  const r = run(wrap(reconEnv({ entry_points_truncated: true })));
  expect('报 silent_truncation', r.r?.errors?.some(x => x.rule === 'silent_truncation'));
}

console.log('case 28: entry_points_truncated=true 且 unverified 说明了 → 通过');
{
  const r = run(wrap(reconEnv({
    entry_points_truncated: true,
    unverified: [{ target: 'entry_points', reason: 'CLI 入口共 37 个，已截断为每类前 5 个' }],
  })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 29: 完整合规的 recon → 通过');
{
  const r = run(wrap(reconEnv()));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

// ── critique：五步测试与运行时证据（2026-11-10 新增）──
// 2026-11-14：discipline_audit 成为 skeptic 的必填项（契约 §2.3 早有规定，
// 但校验器此前没实现）。这个 fixture 是全文件所有 critique 用例的公共构造，
// 所以在这里补一次，而不是在 6 个用例里各补一遍。
const critEnv = (v) => JSON.stringify({
  schema_version: 'output-contract-v1',
  agent_id: 'c1', role: 'critique', status: 'SUCCESS', contract_valid: true,
  artifact_path: '/x/c.md',
  payload: {
    critique_role: 'skeptic',
    target_finding_ids: ['F1'],
    discipline_audit: {
      performed: true, log_entries_checked: 1, dispatch_records_checked: 1,
      undeclared_discretions: [], mechanical_check_failures: [], l0_violations: [],
    },
    verdicts: [v],
  },
  error: null,
}, null, 2);

const FULL_FIVE = {
  evidence_opened: true, evidence_supports_claim: true,
  path_reachable: true, already_handled: false, failure_chain_holds: true,
};

console.log('case 30: skeptic 缺 five_step → 报错');
{
  const r = run(wrap(critEnv({ finding_id: 'F1', verdict: 'holds', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理" })));
  expect('报 missing_five_step', r.r?.errors?.some(x => x.rule === 'missing_five_step'));
}

console.log('case 31: five_step 缺一步 → 报错并指名');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理",
    five_step: { evidence_opened: true, evidence_supports_claim: true, path_reachable: true, already_handled: false },
  })));
  expect('报 incomplete_five_step 且指向 failure_chain_holds',
    r.r?.errors?.some(x => x.rule === 'incomplete_five_step' && /failure_chain_holds/.test(x.field ?? '')));
}

console.log('case 32: 五步齐全 → 通过');
{
  const r = run(wrap(critEnv({ finding_id: 'F1', verdict: 'holds', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理", five_step: FULL_FIVE, runtime_applicable: false })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 33: refuted 但没有 direct_contradiction → 警告');
{
  const r = run(wrap(critEnv({ finding_id: 'F1', verdict: 'refuted', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理", five_step: FULL_FIVE, runtime_applicable: false })));
  expect('报 refuted_without_contradiction 警告',
    r.r?.warnings?.some(x => x.rule === 'refuted_without_contradiction'));
}

console.log('case 34: runtime_evidence 缺 control_case → 警告（无对照不可采信）');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理", five_step: FULL_FIVE,
    runtime_applicable: false,
    runtime_evidence: { method: 'headless_chrome', command: 'chrome ...', observed: 'mutations: []' },
  })));
  expect('报 runtime_no_control 警告', r.r?.warnings?.some(x => x.rule === 'runtime_no_control'));
}

console.log('case 35: runtime_evidence 缺 observed → 报错');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理", five_step: FULL_FIVE,
    runtime_applicable: false,
    runtime_evidence: { method: 'headless_chrome', command: 'chrome ...', control_case: 'peer-snapshot: 303' },
  })));
  expect('报 runtime_no_output', r.r?.errors?.some(x => x.rule === 'runtime_no_output'));
}

console.log('case 36: runtime_evidence 齐全（含对照）→ 通过');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理", five_step: FULL_FIVE,
    runtime_applicable: false,
    runtime_evidence: {
      method: 'headless_chrome', command: 'chrome --headless ...',
      observed: 'clicksAtButton: 1, mutations: []',
      main_path: { expected: '返回 3 个结果', observed: '返回 []' },
      control_case: 'peer-snapshot/index.html 同探针测得 mutationCount: 303',
    },
  })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 37: skeptic 返回 arbiter 的枚举值 → 报错');
{
  const r = run(wrap(critEnv({ finding_id: 'F1', verdict: 'UPHELD', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理", five_step: FULL_FIVE })));
  expect('报 invalid_verdict_enum', r.r?.errors?.some(x => x.rule === 'invalid_verdict_enum'));
}

console.log('case 38: skeptic 返回 refuted → 枚举合法');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'refuted', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理", five_step: FULL_FIVE,
    direct_contradiction: 'a.js:3 const x = 1;',
  })));
  expect('无 invalid_verdict_enum', !r.r?.errors?.some(x => x.rule === 'invalid_verdict_enum'));
}

console.log('case 39: devils_advocate 填了 verdicts → 报错（越界）');
{
  const j = JSON.stringify({
    schema_version: 'output-contract-v1', agent_id: 'd1', role: 'critique',
    status: 'SUCCESS', contract_valid: true, artifact_path: '/x',
    payload: {
      critique_role: 'devils_advocate',
      target_finding_ids: [],
      verdicts: [{ finding_id: 'F1', verdict: 'holds', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理" }],
      coverage_gaps: [],
    }, error: null,
  }, null, 2);
  const r = run(wrap(j));
  expect('报 devils_advocate_has_verdicts', r.r?.errors?.some(x => x.rule === 'devils_advocate_has_verdicts'));
}

console.log('case 40: 子主张齐全且区分机制/后果 → 通过');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', five_step: FULL_FIVE,
    runtime_applicable: false,
    reason: '机制成立，但后果方向相反（fail-closed 而非放行）',
    sub_claims: [
      { claim: '第29行有空catch', verdict: 'holds', evidence_ref: 'inspect.mjs:29' },
      { claim: '导致权限放行', verdict: 'refuted', direct_contradiction: 'allow 仅抑制 finding' },
    ],
  })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 41: 子主张自定义枚举 → 报错');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', five_step: FULL_FIVE,
    runtime_applicable: false,
    reason: '机制成立',
    sub_claims: [{ claim: 'x', verdict: 'UPHELD_ON_MECHANISM' }],
  })));
  expect('报 invalid_sub_verdict', r.r?.errors?.some(x => x.rule === 'invalid_sub_verdict'));
}

console.log('case 42: 同时有 holds 和 refuted 子主张但 reason 不区分 → 报错');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', five_step: FULL_FIVE,
    runtime_applicable: false,
    reason: '总体判定成立，其中一部分子主张需要单独给出结论才算完整',
    sub_claims: [
      { claim: 'a', verdict: 'holds' },
      { claim: 'b', verdict: 'refuted', direct_contradiction: 'x' },
    ],
  })));
  expect('报 mixed_sub_claims_unexplained', r.r?.errors?.some(x => x.rule === 'mixed_sub_claims_unexplained'));
}

console.log('case 43: 子主张 refuted 但既无矛盾也无理由 → 报错');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'refuted', five_step: FULL_FIVE,
    reason: '机制和后果都不成立，调用链在第 3 步就断了且无人调用该路径',
    sub_claims: [{ claim: 'a', verdict: 'refuted' }],
  })));
  expect('报 sub_refuted_without_basis', r.r?.errors?.some(x => x.rule === 'sub_refuted_without_basis'));
}

console.log('case 44: holds 但 reason 否定危害却没拆 sub_claims → 报错');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', five_step: FULL_FIVE,
    runtime_applicable: false,
    reason: '机制成立，但后果方向相反，实际是 fail-closed 不是放行',
  })));
  expect('报 missing_sub_claims', r.r?.errors?.some(x => x.rule === 'missing_sub_claims'));
}

console.log('case 45: holds 且 reason 无危害否定、无 sub_claims → 通过（正常全对）');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', five_step: FULL_FIVE,
    runtime_applicable: false,
    reason: '证据充分，路径可达，调用链完整闭合',
  })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 46: 缺 runtime_applicable → 报错');
{
  const r = run(wrap(critEnv({ finding_id: 'F1', verdict: 'holds', reason: '证据充分，路径可达，调用链完整闭合', five_step: FULL_FIVE })));
  expect('报 missing_runtime_applicable', r.r?.errors?.some(x => x.rule === 'missing_runtime_applicable'));
}

console.log('case 47: runtime_applicable=true 但没跑 → 报错');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: '证据充分，路径可达，调用链完整闭合', five_step: FULL_FIVE,
    runtime_applicable: true,
  })));
  expect('报 runtime_required_but_missing', r.r?.errors?.some(x => x.rule === 'runtime_required_but_missing'));
}

console.log('case 48: runtime_applicable=false 且纯静态 → 通过');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: '证据充分，路径可达，调用链完整闭合', five_step: FULL_FIVE,
    runtime_applicable: false,
  })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 49: runtime_applicable=true 且有完整 runtime_evidence → 通过');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: '证据充分，路径可达，调用链完整闭合', five_step: FULL_FIVE,
    runtime_applicable: true,
    runtime_evidence: {
      method: 'headless_chrome', command: 'chrome --headless ...',
      observed: 'clicksAtButton: 1, mutations: []',
      main_path: { expected: '返回 3 个结果', observed: '返回 []' },
      control_case: 'peer-snapshot 同探针测得 mutationCount: 303',
    },
  })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 50: lead 的 confidence 拼错 → 报错');
{
  const e = JSON.parse(env());
  e.payload.leads = [{ lead_id: 'L1', confidence: 'VERY_HIGH' }];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 invalid_enum_value', r.r?.errors?.some(x => x.rule === 'invalid_enum_value' && /confidence/.test(x.field ?? '')));
}

console.log('case 51: suspected_dimension 拼错 → 报错');
{
  const e = JSON.parse(env());
  e.payload.leads = [{ lead_id: 'L1', suspected_dimension: 'performence', confidence: 'HIGH' }];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 invalid_enum_value 且指向 suspected_dimension', r.r?.errors?.some(x => x.rule === 'invalid_enum_value' && /suspected_dimension/.test(x.field ?? '')));
}

console.log('case 52: 枚举全部正确 → 通过');
{
  const e = JSON.parse(env());
  e.payload.leads = [{ lead_id: 'L1', suspected_dimension: 'logic', confidence: 'HIGH' }];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('无 invalid_enum_value', !r.r?.errors?.some(x => x.rule === 'invalid_enum_value'), JSON.stringify(r.r?.errors));
}

console.log('case 53: NO_EVIDENCE_FOUND 但无 searched_scope → 报错（A1 攻击）');
{
  const e = JSON.parse(auditEnv({ identifier_reconcile:{status:'DONE'}, self_check_audit:{status:'DONE'}, runtime_validation:{status:'DONE'} }));
  delete e.payload.searched_scope;   // 显式移除，模拟攻击者不写搜索范围
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 no_evidence_without_scope', r.r?.errors?.some(x => x.rule === 'no_evidence_without_scope'));
}

console.log('case 54: basis 只有空话 → 报错');
{
  const e = JSON.parse(auditEnv({ identifier_reconcile:{status:'DONE'}, self_check_audit:{status:'DONE'}, runtime_validation:{status:'DONE'} }));
  e.payload.findings = [{ finding_id:'f1', status:'NO_EVIDENCE_FOUND',
    evidence:{file:null,line:null,quote:null},
    inference:{claim:'no problem', basis:'looked', alternatives:[]} }];
  e.payload.searched_scope = { files_read:['a.js'], dimension_checklist:['分支'] };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 vacuous_basis', r.r?.errors?.some(x => x.rule === 'vacuous_basis'));
}

console.log('case 55: NO_EVIDENCE_FOUND + 完整 searched_scope + 实质 basis → 通过');
{
  const e = JSON.parse(auditEnv({ identifier_reconcile:{status:'DONE'}, self_check_audit:{status:'DONE'}, runtime_validation:{status:'DONE'} }));
  e.payload.findings = [{ finding_id:'f1', status:'NO_EVIDENCE_FOUND',
    evidence:{file:null,line:null,quote:null},
    inference:{claim:'no problem',
      basis:'已逐行读取全部 7 个切片文件，grep 了 12 个模式（条件分支/循环边界/返回值语义/异常路径），未发现门 0 可用证据',
      alternatives:[]} }];
  e.payload.searched_scope = { files_read:['a.js','b.js'], files_in_slice:2, dimension_checklist:['分支','边界'] };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 56: findings[].status 任意字符串 → 报错');
{
  const e = JSON.parse(auditEnv());
  e.payload.findings = [{ finding_id:'f1', status:'TOTALLY_FINE_TRUST_ME' }];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 invalid_finding_status', r.r?.errors?.some(x => x.rule === 'invalid_finding_status'));
}

console.log('case 57: CONFIRMED 但 evidence 全 null → 报错');
{
  const e = JSON.parse(auditEnv());
  e.payload.findings = [{ finding_id:'f1', dimension:'logic', severity:'HIGH',
    evidence:{file:null,line:null,quote:null},
    inference:{claim:'c',basis:'b',alternatives:['x','y']}, status:'CONFIRMED' }];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 confirmed_without_evidence', r.r?.errors?.some(x => x.rule === 'confirmed_without_evidence'));
}

console.log('case 58: CONFIRMED 但 severity 为空 → 报错');
{
  const e = JSON.parse(auditEnv());
  e.payload.findings = [{ finding_id:'f1', dimension:'logic', severity:null,
    evidence:{file:'a.js',line:1,quote:'x'},
    inference:{claim:'c',basis:'b',alternatives:['x','y']}, status:'CONFIRMED' }];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 confirmed_without_severity', r.r?.errors?.some(x => x.rule === 'confirmed_without_severity'));
}

console.log('case 59: sweep 的 reachability 乱写 → 报错（蓝队 A2）');
{
  const e = JSON.parse(env()); e.payload.reachability = 'TOTALLY_IGNORE_ME';
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 invalid_enum_value', r.r?.errors?.some(x => x.rule === 'invalid_enum_value' && /reachability/.test(x.field ?? '')));
}

console.log('case 60: reachability=ENTRY 合法（契约曾漏了这个值）');
{
  const e = JSON.parse(env()); e.payload.reachability = 'ENTRY';
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('无 invalid_enum_value', !r.r?.errors?.some(x => x.rule === 'invalid_enum_value'));
}

console.log('case 61: GENERATED 但无 generator_ref → 报错（蓝队 A3）');
{
  const e = JSON.parse(env()); e.payload.reachability = 'GENERATED';
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 generated_without_generator_ref', r.r?.errors?.some(x => x.rule === 'generated_without_generator_ref'));
}

console.log('case 62: GENERATED + generator_ref → 通过');
{
  const e = JSON.parse(env()); e.payload.reachability = 'GENERATED';
  e.payload.generator_ref = 'prototypes/_build/fetch-fonts.mjs';
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 63: verdicts 未覆盖全部 target → 报错（蓝队 A12）');
{
  const e = JSON.parse(critEnv({ finding_id: 'F1', verdict: 'holds', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理",
    five_step: FULL_FIVE, runtime_applicable: false }));
  e.payload.target_finding_ids = ['F1', 'F2', 'F3'];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 verdict_missing_for_target', r.r?.errors?.some(x => x.rule === 'verdict_missing_for_target'));
}

console.log('case 64: concurrency 领域 refuted 无矛盾证据 → 报错（不是警告）');
{
  const e = JSON.parse(critEnv({ finding_id: 'F1', verdict: 'refuted', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理",
    dimension: 'concurrency', five_step: FULL_FIVE, runtime_applicable: false }));
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 sensitive_refuted_without_contradiction',
    r.r?.errors?.some(x => x.rule === 'sensitive_refuted_without_contradiction'));
}

console.log('case 65: 非 concurrency 领域 refuted 无矛盾证据 → 仅警告');
{
  const e = JSON.parse(critEnv({ finding_id: 'F1', verdict: 'refuted', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理",
    dimension: 'logic', five_step: FULL_FIVE, runtime_applicable: false }));
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('不报 error', !r.r?.errors?.some(x => x.rule === 'sensitive_refuted_without_contradiction'));
  expect('报 warning', r.r?.warnings?.some(x => x.rule === 'refuted_without_contradiction'));
}

console.log('case 66: runtime_evidence 缺 main_path → 报错（只跑语法检查不算）');
{
  const e = JSON.parse(critEnv({ finding_id: 'F1', verdict: 'holds', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理", five_step: FULL_FIVE,
    runtime_applicable: true,
    runtime_evidence: { method: 'node_cli', command: 'node --check a.js', observed: 'exit 0', control_case: '对照页通过' } }));
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 runtime_no_main_path 警告（2026-11-11 降级为建议）',
    r.r?.warnings?.some(x => x.rule === 'runtime_no_main_path'));
}

console.log('case 67: main_path 期望等于实际 → 警告（无区分力）');
{
  const e = JSON.parse(critEnv({ finding_id: 'F1', verdict: 'holds', reason: "独立复现确认：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理", five_step: FULL_FIVE,
    runtime_applicable: true,
    runtime_evidence: { method: 'node_cli', command: 'node a.js', observed: 'exit 0',
      main_path: { expected: 'exit 0', observed: 'exit 0' }, control_case: '对照通过' } }));
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 runtime_main_path_trivial 警告', r.r?.warnings?.some(x => x.rule === 'runtime_main_path_trivial'));
}

console.log('case 68: CONFIRMED 但 quote 是空字符串 → 报错（2026-11-12 红队实测）');
{
  // 实测：quote:"" + basis:"looked" 的 CONFIRMED 曾拿到「✅ 契约合规」。
  // 根因是判据写成 `ev.quote != null`——空字符串不是 null，于是放行。
  // 「有证据」和「有一个空的证据字段」必须能区分开。
  const e = JSON.parse(auditEnv());
  e.payload.findings = [{ finding_id:'f1', dimension:'logic', severity:'HIGH',
    evidence:{file:'a.js',line:1,quote:''},
    inference:{claim:'有问题',basis:'looked',alternatives:[]}, status:'CONFIRMED' }];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 confirmed_without_evidence', r.r?.errors?.some(x => x.rule === 'confirmed_without_evidence'),
    JSON.stringify(r.r?.errors));
}

console.log('case 69: CONFIRMED 但 quote 只有空白 → 报错');
{
  const e = JSON.parse(auditEnv());
  e.payload.findings = [{ finding_id:'f1', dimension:'logic', severity:'HIGH',
    evidence:{file:'a.js',line:1,quote:'   \n  '},
    inference:{claim:'c',basis:'b',alternatives:[]}, status:'CONFIRMED' }];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 confirmed_without_evidence', r.r?.errors?.some(x => x.rule === 'confirmed_without_evidence'));
}

console.log('case 70: findings 是空数组 → 报错（契约 §2.2 明文要求）');
{
  // 实测：findings: [] 曾拿到「✅ 契约合规」。
  // 契约原文：「空数组一律视为 CONTRACT_VIOLATION，因为"没查"和"查了没发现"在契约上必须可区分」。
  const e = JSON.parse(auditEnv());
  e.payload.findings = [];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 empty_findings', r.r?.errors?.some(x => x.rule === 'empty_findings'),
    JSON.stringify(r.r?.errors));
}

console.log('case 71: sweep 的 dimension_histogram 之和 != leads.length → 报错（契约 §2.2a）');
{
  // 2026-11-12 逐条核对契约判据时实测：这条契约明文写着「不一致即 CONTRACT_VIOLATION」，
  // 但校验器从未检查过。直方图是覆盖率记账的唯一来源，对不上等于覆盖率可以随手编。
  const e = JSON.parse(env());
  e.payload.dimension_histogram = {
    logic: 3, concurrency: 0, security: 0, 'error-handling': 0, 'data-consistency': 0, contract: 0,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 histogram_mismatch', r.r?.errors?.some((x) => x.rule === 'histogram_mismatch'),
    JSON.stringify(r.r?.errors));
}

console.log('case 72: sweep 的 dimension_histogram 之和 == leads.length → 通过');
{
  const e = JSON.parse(env());
  e.payload.dimension_histogram = {
    logic: 1, concurrency: 0, security: 0, 'error-handling': 0, 'data-consistency': 0, contract: 0,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('无 histogram_mismatch', !r.r?.errors?.some((x) => x.rule === 'histogram_mismatch'));
}

console.log('case 73: CRITICAL 但无调用链 / 无可复现触发条件 → 报错（wave2-audit §3.3）');
{
  // 实测：4 个 agent 里有 3 个把「escapeHtml 顺序错」标成 CRITICAL，
  // 但只给了静态推断，没有调用链，也没有可复现的触发条件。
  // §3.3 明文要求这时最高只能标 HIGH，但从未被机械校验。
  const e = JSON.parse(auditEnv());
  e.payload.findings = [{
    finding_id: 'f1', dimension: 'security', severity: 'CRITICAL',
    evidence: { file: 'a.js', line: 1, quote: 'const escaped = escapeHtml(raw)' },
    inference: { claim: '转义顺序有问题', basis: '看起来会二次转义', alternatives: ['可能是有意的'] },
    status: 'CONFIRMED',
  }];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 critical_without_call_chain',
    r.r?.errors?.some(x => x.rule === 'critical_without_call_chain'),
    JSON.stringify(r.r?.errors?.map(x=>x.rule)));
}

console.log('case 74: CRITICAL 且有可复现触发条件 → 通过');
{
  const e = JSON.parse(auditEnv());
  e.payload.findings = [{
    finding_id: 'f1', dimension: 'security', severity: 'CRITICAL',
    evidence: { file: 'a.js', line: 1, quote: 'const escaped = escapeHtml(raw)' },
    inference: {
      claim: '转义顺序错了，会导致二次编码',
      basis: '输入 <b> 返回 &amp;lt;b&amp;gt;，本应返回 &lt;b&gt; —— 可复现',
      alternatives: [],
    },
    status: 'CONFIRMED',
  }];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('不报 critical_without_call_chain',
    !r.r?.errors?.some(x => x.rule === 'critical_without_call_chain'),
    JSON.stringify(r.r?.errors?.map(x=>x.rule)));
}

console.log('case 75: CRITICAL 且有调用链证据 → 通过');
{
  const e = JSON.parse(auditEnv());
  e.payload.findings = [{
    finding_id: 'f1', dimension: 'security', severity: 'CRITICAL',
    evidence: { file: 'a.js', line: 1, quote: 'const escaped = escapeHtml(raw)' },
    inference: {
      claim: 'XSS',
      basis: '调用链：renderListView() → compile() → renderBlock() → renderInline() → 未转义拼接',
      alternatives: [],
    },
    status: 'CONFIRMED',
  }];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('不报 critical_without_call_chain',
    !r.r?.errors?.some(x => x.rule === 'critical_without_call_chain'),
    JSON.stringify(r.r?.errors?.map(x=>x.rule)));
}

// ── 2026-11-14：verdict=FAIL 的条件必填（契约 §2.5 明文，此前校验器完全不查）──
console.log('case 76: verify verdict=FAIL 但缺 failure_category → 必须报错');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'v1', role: 'verify',
    status: 'SUCCESS', contract_valid: true, artifact_path: 'x.md',
    payload: { finding_id: 'F1', verdict: 'FAIL' }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)), ['--no-exists']);
  expect('报 missing_failure_category',
    r.r?.errors?.some(x => x.rule === 'missing_failure_category'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
  expect('报 missing_failure_trigger',
    r.r?.errors?.some(x => x.rule === 'missing_failure_trigger'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 77: verify verdict=FAIL 且归因/触发条件齐全 → 通过');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'v1', role: 'verify',
    status: 'SUCCESS', contract_valid: true, artifact_path: 'x.md',
    payload: {
      finding_id: 'F1', verdict: 'FAIL',
      failure_category: 'FIX_INCOMPLETE',
      failure_trigger: '把 src/store.js:57 改回旧实现后重跑 test/persist.test.js，观察到 EBUSY',
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)), ['--no-exists']);
  expect('不报 failure 相关错误',
    !r.r?.errors?.some(x => /failure_category|failure_trigger/.test(x.rule)),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 78: verify 的 failure_category 用了闭集外的值 → 必须报错');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'v1', role: 'verify',
    status: 'SUCCESS', contract_valid: true, artifact_path: 'x.md',
    payload: {
      finding_id: 'F1', verdict: 'FAIL',
      failure_category: 'WHATEVER',
      failure_trigger: '某条可复现描述',
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)), ['--no-exists']);
  expect('报 invalid_failure_category',
    r.r?.errors?.some(x => x.rule === 'invalid_failure_category'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 79: verdict=PASS 时不要求 failure_category（不能过度执法）');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'v1', role: 'verify',
    status: 'SUCCESS', contract_valid: true, artifact_path: 'x.md',
    payload: { finding_id: 'F1', verdict: 'PASS' }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)), ['--no-exists']);
  expect('PASS 不报 failure_category',
    !r.r?.errors?.some(x => x.rule === 'missing_failure_category'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

// ── 2026-11-14：契约写法 vs wrapper 写法的 members 结构（曾互斥，导致照契约写必失败）──
console.log('case 80: members 逐个列出（契约 §2.0 写法，无 count）→ 每项按 1 计，必须通过');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'planner',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/p.md',
    payload: {
      tier: 'T2', score: 21, score_breakdown: { a: 21 },
      members: [
        { agent_id: 'm1', role: 'execute', depends_on: [], note: 'x' },
        { agent_id: 'm2', role: 'critique', depends_on: ['m1'], note: 'y' },
      ],
      member_count: 2,
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('契约写法通过', r.r?.ok === true, JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 81: members 按职能聚合（wrapper §5 写法，有 count）→ 必须通过');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'planner',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/p.md',
    payload: {
      tier: 'T2', score: 21, score_breakdown: { a: 21 },
      members: [
        { role: 'execute', count: 6, scope: '宽扫' },
        { role: 'critique', count: 3, scope: '锐评' },
      ],
      member_count: 9,
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('wrapper 写法通过', r.r?.ok === true, JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 82: member_count 算错（两种写法都要报）→ 必须报 count_mismatch');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'planner',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/p.md',
    payload: {
      tier: 'T2', score: 21, score_breakdown: { a: 21 },
      members: [{ agent_id: 'm1', role: 'execute', depends_on: [], note: 'x' }],
      member_count: 5,
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 count_mismatch',
    r.r?.errors?.some(x => x.rule === 'count_mismatch'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 83: 成员既无 agent_id 也无 role → 必须报 member_unidentifiable');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'planner',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/p.md',
    payload: {
      tier: 'T2', score: 21, score_breakdown: { a: 21 },
      members: [{ note: '没有身份信息' }],
      member_count: 1,
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 member_unidentifiable',
    r.r?.errors?.some(x => x.rule === 'member_unidentifiable'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

// ── 2026-11-14：信封定位（此前固定取第一个 json 块，惩罚认真写正文的 agent）──
console.log('case 84: 正文里有示例 json 块、真信封在末尾 → 必须找到真信封、通过');
{
  const real = JSON.stringify({
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'planner',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/p.md',
    payload: {
      tier: 'T2', score: 21, score_breakdown: { a: 21 },
      members: [{ agent_id: 'm1', role: 'execute', depends_on: [], note: 'x' }],
      member_count: 1,
    }, error: null,
  }, null, 2);
  const doc = '# 分析\n\n举例一：\n\n```json\n{"示例": 1}\n```\n\n举例二：\n\n```json\n{"示例": 2}\n```\n\n# 信封\n\n```json\n' + real + '\n```\n';
  const r = run(doc);
  expect('正文示例不干扰信封定位', r.r?.ok === true,
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

// ── 2026-11-14：<OUTDIR> 占位（契约 §1 明确允许，但校验器此前不认）──
console.log('case 85: artifact_path 用 <OUTDIR> 占位 → 通过但给 WARN（静态无法验证）');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'planner',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/round1-00-plan.md',
    payload: {
      tier: 'T2', score: 21, score_breakdown: { a: 21 },
      members: [{ agent_id: 'm1', role: 'execute', depends_on: [], note: 'x' }],
      member_count: 1,
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('不报 artifact_not_found',
    !r.r?.errors?.some(x => x.rule === 'artifact_not_found'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
  expect('给 artifact_outdir_placeholder 警告',
    r.r?.warnings?.some(x => x.rule === 'artifact_outdir_placeholder'),
    JSON.stringify(r.r?.warnings?.map(x => x.rule)));
}

console.log('case 86: 真实路径不存在仍必须报错（<OUTDIR> 的放行不能变成普遍放水）');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'planner',
    status: 'SUCCESS', contract_valid: true, artifact_path: 'D:/绝对不存在的路径/x.md',
    payload: {
      tier: 'T2', score: 21, score_breakdown: { a: 21 },
      members: [{ agent_id: 'm1', role: 'execute', depends_on: [], note: 'x' }],
      member_count: 1,
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 artifact_not_found',
    r.r?.errors?.some(x => x.rule === 'artifact_not_found'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

// ── 2026-11-14：findings 内部结构（此前完全不查，导致错误示例能过校验）──
console.log('case 87: finding 用 "id" 而非 "finding_id" → 必须报 wrong_field_name');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'audit',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/a.md',
    payload: {
      findings: [{
        id: 'F1', dimension: 'logic', severity: 'HIGH',
        evidence: { file: 'a.js', line: 1, quote: 'x' },
        inference: { claim: 'c', basis: 'b', alternatives: ['a1', 'a2'] },
        status: 'CONFIRMED',
      }],
      self_checks: {
        identifier_reconcile: { status: 'DONE', note: 'x' },
        self_check_audit: { status: 'DONE', note: 'y' },
        runtime_validation: { status: 'DONE', note: 'z' },
      },
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 wrong_field_name', r.r?.errors?.some(x => x.rule === 'wrong_field_name'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 88: finding 缺 status → 必须报 missing_finding_status（此前省略即跳过）');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'audit',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/a.md',
    payload: {
      findings: [{
        finding_id: 'F1', dimension: 'logic', severity: 'HIGH',
        evidence: { file: 'a.js', line: 1, quote: 'x' },
        inference: { claim: 'c', basis: 'b', alternatives: ['a1', 'a2'] },
      }],
      self_checks: {
        identifier_reconcile: { status: 'DONE', note: 'x' },
        self_check_audit: { status: 'DONE', note: 'y' },
        runtime_validation: { status: 'DONE', note: 'z' },
      },
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 missing_finding_status',
    r.r?.errors?.some(x => x.rule === 'missing_finding_status'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 89: evidence 写成数组（契约要求对象）→ 必须报 evidence_wrong_shape');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'audit',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/a.md',
    payload: {
      findings: [{
        finding_id: 'F1', dimension: 'logic', severity: 'HIGH',
        evidence: [{ file: 'a.js', line: 1, quote: 'x' }],
        inference: { claim: 'c', basis: 'b', alternatives: ['a1', 'a2'] },
        status: 'CONFIRMED',
      }],
      self_checks: {
        identifier_reconcile: { status: 'DONE', note: 'x' },
        self_check_audit: { status: 'DONE', note: 'y' },
        runtime_validation: { status: 'DONE', note: 'z' },
      },
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 evidence_wrong_shape',
    r.r?.errors?.some(x => x.rule === 'evidence_wrong_shape'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 90: inference 写成字符串 → 必须报 inference_wrong_shape（否则 CRITICAL 检查静默失效）');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'audit',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/a.md',
    payload: {
      findings: [{
        finding_id: 'F1', dimension: 'logic', severity: 'CRITICAL',
        evidence: { file: 'a.js', line: 1, quote: 'x' },
        inference: '这是一段字符串而不是对象',
        status: 'CONFIRMED',
      }],
      self_checks: {
        identifier_reconcile: { status: 'DONE', note: 'x' },
        self_check_audit: { status: 'DONE', note: 'y' },
        runtime_validation: { status: 'DONE', note: 'z' },
      },
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 inference_wrong_shape',
    r.r?.errors?.some(x => x.rule === 'inference_wrong_shape'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

// ── 2026-11-14：critique 的 discipline_audit 角色分支（契约 §2.3 早有，校验器没实现）──
console.log('case 91: skeptic 缺 discipline_audit → 必须报错（契约：全部 verdicts 作废）');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'c1', role: 'critique',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/c.md',
    payload: { critique_role: 'skeptic', verdicts: [] }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 missing_discipline_audit',
    r.r?.errors?.some(x => x.rule === 'missing_discipline_audit'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 92: devils_advocate 返回 discipline_audit → 必须报越界');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'c1', role: 'critique',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/c.md',
    payload: {
      critique_role: 'devils_advocate', verdicts: [],
      discipline_audit: { performed: true },
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 discipline_audit_out_of_role',
    r.r?.errors?.some(x => x.rule === 'discipline_audit_out_of_role'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

// ── 2026-11-14：verify.verdict 枚举 + role 原型链崩溃 ──
console.log('case 93: verdict="fail"（小写）→ 必须报 invalid_verify_verdict（否则 FAIL 检查被跳过）');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'v1', role: 'verify',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/v.md',
    payload: { finding_id: 'F1', verdict: 'fail' }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 invalid_verify_verdict',
    r.r?.errors?.some(x => x.rule === 'invalid_verify_verdict'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 94: role 取原型链键（__proto__）→ 必须正常报违规，不许崩溃');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: '__proto__',
    status: 'SUCCESS', contract_valid: true, payload: {}, error: null,
  };
  let crashed = false;
  let r2 = null;
  try { r2 = run(wrap(JSON.stringify(e, null, 2))); } catch { crashed = true; }
  expect('不崩溃', !crashed);
  expect('报 invalid_role', r2?.r?.errors?.some(x => x.rule === 'invalid_role'),
    JSON.stringify(r2?.r?.errors?.map(x => x.rule)));
}

// ── 2026-11-14：coverage_gaps 闭集 + DA 四个扫描布尔（此前零校验）──
console.log('case 95: coverage_gaps.kind 用闭集外的值 → 必须报 invalid_coverage_kind');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'd1', role: 'critique',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/d.md',
    payload: {
      critique_role: 'devils_advocate', verdicts: [],
      slice_scan_performed: true, file_scan_performed: true,
      dimension_scan_performed: true, entry_scan_performed: true,
      coverage_gaps: [{ gap_id: 'G1', kind: 'TOTALLY_MADE_UP', target: 'x', recommended_action: 'y' }],
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 invalid_coverage_kind',
    r.r?.errors?.some(x => x.rule === 'invalid_coverage_kind'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 96: devils_advocate 缺四个扫描布尔 → 每条都要报 missing_scan_flag');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'd1', role: 'critique',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/d.md',
    payload: { critique_role: 'devils_advocate', verdicts: [], coverage_gaps: [] },
    error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  const hits = (r.r?.errors ?? []).filter(x => x.rule === 'missing_scan_flag');
  expect('报 4 条 missing_scan_flag', hits.length === 4, `实际 ${hits.length}`);
}

console.log('case 97: devils_advocate 四个扫描布尔齐全 → 不报 missing_scan_flag');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'd1', role: 'critique',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/d.md',
    payload: {
      critique_role: 'devils_advocate', verdicts: [], coverage_gaps: [],
      slice_scan_performed: true, file_scan_performed: true,
      dimension_scan_performed: true, entry_scan_performed: true,
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('不报 missing_scan_flag',
    !r.r?.errors?.some(x => x.rule === 'missing_scan_flag'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 98: 扫描布尔写成 "true" 字符串（不是真布尔）→ 必须报错（防字符串冒充）');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'd1', role: 'critique',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/d.md',
    payload: {
      critique_role: 'devils_advocate', verdicts: [], coverage_gaps: [],
      slice_scan_performed: 'true', file_scan_performed: true,
      dimension_scan_performed: true, entry_scan_performed: true,
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('字符串 "true" 不算通过',
    r.r?.errors?.some(x => x.rule === 'missing_scan_flag'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 99: artifact_path 不是字符串 → 必须报 artifact_path_wrong_type');
{
  // 2026-11-14 红队实测：存在性检查此前整个包在 `else if (typeof === 'string')` 里，
  // 于是对象/数字/数组/布尔全部跳过检查，拿到「✅ 契约合规」。
  // 而契约 §1 要求 SUCCESS 时 artifact_path 必须是路径字符串。
  const BAD = [
    { label: '对象', v: { path: 'x' } },
    { label: '数字', v: 12345 },
    { label: '数组', v: ['x'] },
    { label: '布尔', v: true },
  ];
  const missed = [];
  for (const c of BAD) {
    const e = {
      schema_version: 'output-contract-v1', agent_id: 'a1', role: 'fix',
      status: 'SUCCESS', contract_valid: true, artifact_path: c.v,
      payload: {
        files_touched: [{ path: 'a.js', lines_added: 1, lines_removed: 0 }],
        verification_commands: [{ command: 'x', exit_code: 0 }],
        affected_issues: ['F1'], residual_risks: [],
      }, error: null,
    };
    const r = run(wrap(JSON.stringify(e, null, 2)));
    if (!r.r?.errors?.some((x) => x.rule === 'artifact_path_wrong_type')) missed.push(c.label);
  }
  expect('四种非字符串全部被抓', missed.length === 0, `绕过: ${missed.join(' / ')}`);
}

console.log('case 100: artifact_path 是合法字符串路径 → 不得误报 wrong_type');
{
  const e = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'fix',
    status: 'SUCCESS', contract_valid: true, artifact_path: '<OUTDIR>/x.md',
    payload: {
      files_touched: [{ path: 'a.js', lines_added: 1, lines_removed: 0 }],
      verification_commands: [{ command: 'x', exit_code: 0 }],
      affected_issues: ['F1'], residual_risks: [],
    }, error: null,
  };
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('不报 wrong_type',
    !r.r?.errors?.some((x) => x.rule === 'artifact_path_wrong_type'),
    JSON.stringify(r.r?.errors?.map((x) => x.rule)));
}

// ── 2026-11-15：fix 的 disposition 契约（防止「发现静默蒸发」）──
// 实测背景：38 条发现只修了 6 条，31 条从未进入任何任务书，没有任何工具报错。
// 还有一条 finding 含 3 个子主张，任务书只覆盖 1 个，另外 2 个静默消失
// （其中 1 个后来靠巧合才被捞回来）。
// 根因：fix 的契约只有 files_touched，框架要求「每条发现被锐评攻击一次」，
// 却不要求「每条发现被修复或明确暂缓一次」。
const fixEnv = (over = {}) => JSON.stringify({
  schema_version: 'output-contract-v1',
  agent_id: 'fix-1', role: 'fix', status: 'SUCCESS', contract_valid: true,
  artifact_path: '<OUTDIR>/fix.md',
  payload: {
    finding_id: 'F1',
    disposition: 'FIXED',
    test_path: 'test/persist.test.js',
    red_log_path: 'experiments/round1/red-F1.log',
    files_touched: [{ path: 'src/store.js', change_summary: '捕获 renameSync 异常并上抛' }],
    verification_commands: [{ command: 'node --test test/persist.test.js', result: 'passed' }],
    affected_issues: [],
    residual_risks: [],
    ...over,
  },
  error: null,
}, null, 2);

console.log('case 101: 完整合规的 fix 产物（FIXED + test_path + target/ 外的红测日志）→ 通过');
{
  const r = run(wrap(fixEnv()));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 102: fix 缺 disposition → 必须报 missing_disposition');
{
  const e = JSON.parse(fixEnv());
  delete e.payload.disposition;
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 missing_disposition',
    r.r?.errors?.some(x => x.rule === 'missing_disposition'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 103: FIXED 但没有 test_path → 必须报 fixed_without_test');
{
  const e = JSON.parse(fixEnv());
  delete e.payload.test_path;
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 fixed_without_test',
    r.r?.errors?.some(x => x.rule === 'fixed_without_test'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 104: FIXED 但没有 red_log_path → 必须报 fixed_without_red_log');
{
  const e = JSON.parse(fixEnv());
  delete e.payload.red_log_path;
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 fixed_without_red_log',
    r.r?.errors?.some(x => x.rule === 'fixed_without_red_log'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 105: red_log_path 指向 target/ → 必须报 red_log_in_target（真实教训：被 mvn clean 删光）');
{
  // 实测：红测日志放在 target/ 下，被 mvn clean 整个删掉，验收证据不可复核。
  // 三种写法都要抓：相对、带 ./ 前缀、Windows 反斜杠。
  const paths = ['target/red-F1.log', './target/logs/red.log', 'D:/proj/myapp/target/red.log', 'target\\red.log'];
  const missed = [];
  for (const p of paths) {
    const r = run(wrap(fixEnv({ red_log_path: p })));
    if (!r.r?.errors?.some(x => x.rule === 'red_log_in_target')) missed.push(p);
  }
  expect('四种 target/ 写法全部被抓', missed.length === 0, `绕过: ${missed.join(' / ')}`);
}

console.log('case 106: WONT_FIX 但 disposition_reason 太短 → 必须报 wont_fix_without_reason');
{
  // JSON.stringify 会丢掉值为 undefined 的键，所以这里传 undefined 即等于「不写」。
  const r = run(wrap(fixEnv({
    disposition: 'WONT_FIX', disposition_reason: '不修',
    test_path: undefined, red_log_path: undefined,
  })));
  expect('报 wont_fix_without_reason',
    r.r?.errors?.some(x => x.rule === 'wont_fix_without_reason'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 107: WONT_FIX 且理由充分（≥20 字）→ 通过');
{
  const r = run(wrap(fixEnv({
    disposition: 'WONT_FIX',
    disposition_reason: '该分支是协议规定的 fail-closed 设计：拒写优于写坏，重试由上层调度器负责，不应在此处吞异常',
    test_path: undefined, red_log_path: undefined,
  })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 108: DEFERRED 但没有 next_round → 必须报 deferred_without_trigger');
{
  const r = run(wrap(fixEnv({
    disposition: 'DEFERRED',
    disposition_reason: '该修复需要先改造存储层的重试协议，本轮不具备前置条件',
    next_round: undefined, test_path: undefined, red_log_path: undefined,
  })));
  expect('报 deferred_without_trigger',
    r.r?.errors?.some(x => x.rule === 'deferred_without_trigger'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 109: DEFERRED 且给出 next_round → 通过');
{
  const r = run(wrap(fixEnv({
    disposition: 'DEFERRED',
    disposition_reason: '该修复需要先改造存储层的重试协议，本轮不具备前置条件',
    next_round: 'round2-存储层重试协议落地后',
    test_path: undefined, red_log_path: undefined,
  })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 110: NEW_FINDING 显式标记 → 通过（不算未处置）');
{
  const r = run(wrap(fixEnv({
    disposition: 'NEW_FINDING',
    disposition_reason: '修复过程中发现同文件内还有一处在 catch 里吞掉异常，不在原清单里',
    test_path: undefined, red_log_path: undefined,
  })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 110b: DEFERRED 但没写 disposition_reason → 必须报 deferred_without_reason');
{
  // 契约 §2.4 把 disposition_reason 列为 WONT_FIX / DEFERRED 的条件必填。
  // 只对 WONT_FIX 强制等于「文档写了、校验器没执行」——本仓库反复出现的那类缺陷。
  const r = run(wrap(fixEnv({
    disposition: 'DEFERRED',
    next_round: 'round2 存储层重试协议落地后',
    test_path: undefined, red_log_path: undefined,
  })));
  expect('报 deferred_without_reason',
    r.r?.errors?.some(x => x.rule === 'deferred_without_reason'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 111: disposition 用了枚举外的值 → 必须报 invalid_disposition');
{
  const r = run(wrap(fixEnv({ disposition: 'MAYBE_FIXED' })));
  expect('报 invalid_disposition',
    r.r?.errors?.some(x => x.rule === 'invalid_disposition'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 112: 同一产物里 finding_id 重复 → 必须报 duplicate_finding_id');
{
  // 实测：把 7 条 finding 的 id 改成完全相同，校验器仍报「✅ 契约合规」。
  // id 重复意味着下游锐评/验收/回填全部挂错条目——7 条发现只剩 1 条能被引用。
  const e = JSON.parse(auditEnv({
    identifier_reconcile: { status: 'DONE' },
    self_check_audit: { status: 'DONE' },
    runtime_validation: { status: 'DONE' },
  }));
  e.payload.findings = Array.from({ length: 7 }, () => ({
    finding_id: 'F1',
    status: 'NO_EVIDENCE_FOUND',
    evidence: { file: null, line: null, quote: null },
    inference: {
      claim: '本切片未发现满足门 0 的问题',
      basis: '已读取全部切片文件，检查了条件分支与循环边界，未发现可用证据',
      alternatives: [],
    },
  }));
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 duplicate_finding_id',
    r.r?.errors?.some(x => x.rule === 'duplicate_finding_id'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 113: finding_id 不重复 → 不报 duplicate_finding_id');
{
  const e = JSON.parse(auditEnv({
    identifier_reconcile: { status: 'DONE' },
    self_check_audit: { status: 'DONE' },
    runtime_validation: { status: 'DONE' },
  }));
  e.payload.findings = ['F1', 'F2', 'F3'].map((id) => ({
    finding_id: id,
    status: 'NO_EVIDENCE_FOUND',
    evidence: { file: null, line: null, quote: null },
    inference: {
      claim: '本切片未发现满足门 0 的问题',
      basis: '已读取全部切片文件，检查了条件分支与循环边界，未发现可用证据',
      alternatives: [],
    },
  }));
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('不报 duplicate_finding_id',
    !r.r?.errors?.some(x => x.rule === 'duplicate_finding_id'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 114: 派发清单里有 3 条，只处置了 1 条 → 必须报 disposition_missing_for_target');
{
  const e = JSON.parse(fixEnv());
  e.payload.target_finding_ids = ['F1', 'F2', 'F3'];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 disposition_missing_for_target',
    r.r?.errors?.some(x => x.rule === 'disposition_missing_for_target'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
}

console.log('case 115: dispositions[] 逐条覆盖全部 target → 通过（多发现形态）');
{
  const e = JSON.parse(fixEnv());
  delete e.payload.disposition;
  delete e.payload.test_path;
  delete e.payload.red_log_path;
  e.payload.target_finding_ids = ['F1', 'F2'];
  e.payload.dispositions = [
    { finding_id: 'F1', disposition: 'FIXED', test_path: 'test/p1.test.js', red_log_path: 'experiments/round1/red-F1.log' },
    { finding_id: 'F2', disposition: 'DEFERRED', disposition_reason: '依赖 F1 的存储层改造先落地，本轮无法独立验证', next_round: 'round2' },
  ];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 116: 非 fix 角色不得被要求 disposition（不能过度执法）');
{
  const r = run(wrap(auditEnv({
    identifier_reconcile: { status: 'DONE' },
    self_check_audit: { status: 'DONE' },
    runtime_validation: { status: 'DONE' },
  })));
  expect('audit 产物不报 missing_disposition',
    !r.r?.errors?.some(x => x.rule === 'missing_disposition'),
    JSON.stringify(r.r?.errors?.map(x => x.rule)));
  const s = run(wrap(env()));
  expect('sweep 产物不报 missing_disposition',
    !s.r?.errors?.some(x => x.rule === 'missing_disposition'),
    JSON.stringify(s.r?.errors?.map(x => x.rule)));
}

// ── 2026-11-15 夜（R11）：证据存在性检查 ──
// 洞 4（R7 实测）：red_log 指向不存在的文件（target/ 外）→ exit 0 / rules []
//                test_path 指向不存在的文件            → exit 0 / rules []
//                red_log_path 写成 red.log（无目录）   → exit 0 / rules []
// 即：`red_log_in_target` 只校验**路径形状**（正则 (^|/)target/），从不 existsSync。
// 「路径不指向 target/」证明的是「证据不会被构建清理」，不是「证据曾经存在过」。
// 同形事故：验收引用的三个「修复前是红的」日志全被 mvn clean 删掉，验收记录却写「证据存在且内容可信」。
//
// 用例需要在产物目录里真建文件、并显式传 --artifact-dir / --repo。
function runIn({ content, args = [], files = {}, cwd = null }) {
  const dir = mkdtempSync(join(tmpdir(), 'cp-evi-'));
  const art = join(dir, 'artifact.md');
  writeFileSync(art, content);
  for (const [rel, body] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  try {
    const out = execFileSync('node', [SCRIPT, art, '--json', ...args],
      { encoding: 'utf8', cwd: cwd ?? dir });
    return { code: 0, r: JSON.parse(out), dir };
  } catch (e) {
    try { return { code: e.status ?? 1, r: JSON.parse(e.stdout), dir }; }
    catch { return { code: e.status ?? 1, r: null, raw: e.stdout, dir }; }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const hasRule = (r, rule) => !!r.r?.errors?.some((x) => x.rule === rule);
const hasWarn = (r, rule) => !!r.r?.warnings?.some((x) => x.rule === rule);

console.log('case 117: FIXED + red_log_path/test_path 都指向真实存在的文件 → 通过（不误杀）');
{
  const r = runIn({
    content: wrap(fixEnv({
      red_log_path: 'red/F1.log',
      test_path: 'test/persist.test.js',
    })),
    files: { 'red/F1.log': 'FAIL 1 test\n', 'test/persist.test.js': '// red before fix\n' },
    args: ['--artifact-dir', '.'],
  });
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
  expect('不报 red_log_not_found', !hasRule(r, 'red_log_not_found'));
  expect('不报 test_path_not_found', !hasRule(r, 'test_path_not_found'));
}

console.log('case 118: FIXED + red_log_path 指向不存在的文件 → 必须 FAIL red_log_not_found');
{
  // 洞 4 的核心：路径形状完全合法（不在 target/ 下），但文件从来没生成过。
  const r = runIn({
    content: wrap(fixEnv({
      red_log_path: 'experiments/round1/red-F1.log',
      test_path: 'test/persist.test.js',
    })),
    files: { 'test/persist.test.js': '// exists\n' },
    args: ['--artifact-dir', '.'],
  });
  expect('退出码 1', r.code === 1, `got ${r.code}`);
  expect('报 red_log_not_found', hasRule(r, 'red_log_not_found'),
    JSON.stringify(r.r?.errors?.map((x) => x.rule)));
  const msg = r.r?.errors?.find((x) => x.rule === 'red_log_not_found')?.msg ?? '';
  expect('消息列出试过的解析路径', /试过|tried/.test(msg) && /red-F1\.log/.test(msg), msg);
  expect('消息点明「路径形状对了不代表文件存在过」', /形状/.test(msg), msg);
}

console.log('case 119: FIXED + red_log_path 是裸文件名 red.log → WARN red_log_no_directory（不是 FAIL）');
{
  // 裸文件名无法判断落在哪个目录，但有些环境里产物和日志就是并排的——
  // 所以这里只警告，不阻断。
  const r = runIn({
    content: wrap(fixEnv({ red_log_path: 'red.log', test_path: 'test/persist.test.js' })),
    files: { 'red.log': 'FAIL\n', 'test/persist.test.js': '// exists\n' },
    args: ['--artifact-dir', '.'],
  });
  expect('报 red_log_no_directory 警告', hasWarn(r, 'red_log_no_directory'),
    JSON.stringify(r.r?.warnings?.map((x) => x.rule)));
  expect('不因裸文件名 FAIL', !hasRule(r, 'red_log_no_directory'),
    JSON.stringify(r.r?.errors?.map((x) => x.rule)));
  expect('裸文件名且文件确实存在时不报 red_log_not_found', !hasRule(r, 'red_log_not_found'));
}

console.log('case 120: FIXED + test_path 指向存在的文件 → 通过');
{
  const r = runIn({
    content: wrap(fixEnv({ test_path: 'test/persist.test.js', red_log_path: 'red/F1.log' })),
    files: { 'test/persist.test.js': '// exists\n', 'red/F1.log': 'FAIL\n' },
    args: ['--artifact-dir', '.'],
  });
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 121: FIXED + test_path 指向不存在的文件 → 必须 FAIL test_path_not_found');
{
  const r = runIn({
    content: wrap(fixEnv({ test_path: 'test/does-not-exist.test.js', red_log_path: 'red/F1.log' })),
    files: { 'red/F1.log': 'FAIL\n' },
    args: ['--artifact-dir', '.'],
  });
  expect('退出码 1', r.code === 1, `got ${r.code}`);
  expect('报 test_path_not_found', hasRule(r, 'test_path_not_found'),
    JSON.stringify(r.r?.errors?.map((x) => x.rule)));
}

console.log('case 122: FIXED + test_path 是「需新建」→ 跳过存在性检查并 WARN');
{
  // wave4-fix.md 的契约允许「如果不存在，写明『需新建』」，
  // 所以占位值不能被当成本不存在的路径判死。
  const r = runIn({
    content: wrap(fixEnv({ test_path: '需新建', red_log_path: 'red/F1.log' })),
    files: { 'red/F1.log': 'FAIL\n' },
    args: ['--artifact-dir', '.'],
  });
  expect('不报 test_path_not_found', !hasRule(r, 'test_path_not_found'),
    JSON.stringify(r.r?.errors?.map((x) => x.rule)));
  expect('报 test_path_placeholder 警告', hasWarn(r, 'test_path_placeholder'),
    JSON.stringify(r.r?.warnings?.map((x) => x.rule)));
  expect('整体无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 122b: test_path 写成「需新建 + 说明」→ 仍按占位跳过');
{
  // wave4-fix.md:169 的原文是「如果不存在，写明『需新建』」，
  // 真实产物往往补一句说明（「需新建 覆盖恢复量测试」），不能因此判死。
  for (const v of ['需新建 覆盖恢复量测试', 'TODO: 等上游 API 稳定后补', '待创建（依赖 F2）']) {
    const r = runIn({
      content: wrap(fixEnv({ test_path: v, red_log_path: 'red/F1.log' })),
      files: { 'red/F1.log': 'FAIL\n' },
      args: ['--artifact-dir', '.'],
    });
    expect(`占位值「${v}」不报 test_path_not_found`, !hasRule(r, 'test_path_not_found'),
      JSON.stringify(r.r?.errors?.map((x) => x.rule)));
  }
}
// 注：占位值不得反过来成为「永远跳过」的后门——只有占位词本身才跳过，
// 一个普通文件名仍然要过存在性检查（case 121 已覆盖）。

console.log('case 123: 不给 --repo 也不给 --artifact-dir + 路径不存在 → WARN 而非 FAIL（降级纪律）');
{
  // 与 R8 的 unsupported_harness、R10 的 --artifacts-dir 缺失同一纪律：
  // 需要外部目录的参数缺失时不能把流程卡死。
  const r = runIn({
    content: wrap(fixEnv({
      red_log_path: 'experiments/round1/red-F1.log',
      test_path: 'test/nowhere.test.js',
    })),
    // 注意：fixture 里确实没有这些文件，但调用方没给任何根，故不可判定
  });
  expect('退出码 0', r.code === 0, `got ${r.code}`);
  expect('不报 red_log_not_found',
    !r.r?.errors?.some((x) => x.rule === 'red_log_not_found'),
    JSON.stringify(r.r?.errors?.map((x) => x.rule)));
  expect('不报 test_path_not_found',
    !r.r?.errors?.some((x) => x.rule === 'test_path_not_found'),
    JSON.stringify(r.r?.errors?.map((x) => x.rule)));
  expect('报 evidence_existence_unchecked 降级警告',
    hasWarn(r, 'evidence_existence_unchecked'),
    JSON.stringify(r.r?.warnings?.map((x) => x.rule)));
  const msg = r.r?.warnings?.find((x) => x.rule === 'evidence_existence_unchecked')?.msg ?? '';
  expect('警告写明未提供 --repo/--artifact-dir', /--repo/.test(msg) && /--artifact-dir/.test(msg), msg);
}

console.log('case 124: --repo 解析相对路径（日志只在仓库根下存在）→ 通过');
{
  // 产物在 A 目录、被审仓库在 B 目录：先按 artifact-dir 拼（不存在），
  // 再按 --repo 拼（存在）→ 必须通过。
  const r = runIn({
    content: wrap(fixEnv({ red_log_path: 'experiments/round1/red-F1.log', test_path: 'test/p1.test.js' })),
    files: {
      'repo/experiments/round1/red-F1.log': 'FAIL\n',
      'repo/test/p1.test.js': '// exists\n',
    },
    args: ['--artifact-dir', '.', '--repo', 'repo'],
  });
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
  expect('不报 evidence_existence_unchecked',
    !hasWarn(r, 'evidence_existence_unchecked'),
    JSON.stringify(r.r?.warnings?.map((x) => x.rule)));
}

console.log('case 124c: --artifact-dir 优先于 --repo（两处同名文件，取 artifact-dir 那份）');
{
  // 解析顺序是契约的一部分：先 artifact-dir、再 repo、再 cwd。
  // 这里文件只存在于 artifact-dir 一侧；--repo 指向的目录是空的。
  // 若顺序反了（先 repo），就会误判为不存在。
  const r = runIn({
    content: wrap(fixEnv({
      red_log_path: 'logs/red.log',
      test_path: '需新建',
    })),
    files: { 'logs/red.log': 'FAIL\n' },   // 相对 artifact-dir
    args: ['--artifact-dir', '.', '--repo', 'repo'],
  });
  expect('artifact-dir 命中即通过', !hasRule(r, 'red_log_not_found'),
    JSON.stringify(r.r?.errors?.map((x) => x.rule)));
}

console.log('case 124b: 绝对路径不依赖任何根即可判定（存在 → 通过）');
{
  const dir = mkdtempSync(join(tmpdir(), 'cp-abs-'));
  const absLog = join(dir, 'abs-red.log');
  writeFileSync(absLog, 'FAIL\n');
  try {
    const r = runIn({
      content: wrap(fixEnv({
        red_log_path: absLog,
        test_path: '需新建',
      })),
      args: ['--artifact-dir', '.'],
    });
    expect('绝对路径存在时不报 red_log_not_found', !hasRule(r, 'red_log_not_found'),
      JSON.stringify(r.r?.errors?.map((x) => x.rule)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('case 125: 回归 —— target/ 的 4 种写法仍然报 red_log_in_target（给出根时同样成立）');
{
  const paths = ['target/red-F1.log', './target/logs/red.log', 'D:/proj/myapp/target/red.log', 'target\\red.log'];
  const missed = [];
  for (const p of paths) {
    const r = runIn({
      content: wrap(fixEnv({ red_log_path: p, test_path: 'test/p1.test.js' })),
      files: { 'test/p1.test.js': '// exists\n' },
      args: ['--artifact-dir', '.'],
    });
    if (!hasRule(r, 'red_log_in_target')) missed.push(p);
  }
  expect('四种 target/ 写法全部被抓', missed.length === 0, `绕过: ${missed.join(' / ')}`);
}

console.log('case 126: 真实事故的完整形态 —— target/ 日志已不存在 → 同时报 in_target 与 not_found');
{
  // experiments/hilltop-dsh/repair/SUMMARY.md / ACCEPTANCE-ROUND1.md 引用的
  // target/config7-red.log、target/config7-infinity-red.log、target/repair1-red.log
  // 已被 mvn clean 删光（磁盘上实际只剩 target/{classes,surefire-reports,...}）。
  const r = runIn({
    content: wrap(fixEnv({
      red_log_path: 'target/repair1-red.log',
      test_path: 'src/test/java/Repair1Test.java',
    })),
    files: { 'src/test/java/Repair1Test.java': 'class Repair1Test {}\n' },
    args: ['--artifact-dir', '.'],
  });
  expect('报 red_log_in_target', hasRule(r, 'red_log_in_target'));
  expect('同时报 red_log_not_found（文件已被清理）', hasRule(r, 'red_log_not_found'),
    JSON.stringify(r.r?.errors?.map((x) => x.rule)));
}

console.log('case 127: 证据已存在但路径落在 target/ → 有根时仍只报 in_target，不报 not_found');
{
  // 证明两条规则判的是两件不同的事：形状 vs 存在。
  const r = runIn({
    content: wrap(fixEnv({ red_log_path: 'target/red-F1.log', test_path: 'test/p1.test.js' })),
    files: { 'target/red-F1.log': 'FAIL\n', 'test/p1.test.js': '// exists\n' },
    args: ['--artifact-dir', '.'],
  });
  expect('报 red_log_in_target', hasRule(r, 'red_log_in_target'));
  expect('不报 red_log_not_found', !hasRule(r, 'red_log_not_found'),
    JSON.stringify(r.r?.errors?.map((x) => x.rule)));
}

console.log('case 128: 非 FIXED 的 disposition 不因 test_path 不存在而 FAIL（不能过度执法）');
{
  const r = runIn({
    content: wrap(fixEnv({
      disposition: 'WONT_FIX',
      disposition_reason: '该分支是协议规定的 fail-closed 设计：拒写优于写坏，重试由上层调度器负责，不应在此处吞异常',
      test_path: 'test/never-created.test.js',
      red_log_path: undefined,
    })),
    args: ['--artifact-dir', '.'],
  });
  expect('不报 test_path_not_found', !hasRule(r, 'test_path_not_found'),
    JSON.stringify(r.r?.errors?.map((x) => x.rule)));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
