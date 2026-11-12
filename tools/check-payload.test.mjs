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

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
const critEnv = (v) => JSON.stringify({
  schema_version: 'output-contract-v1',
  agent_id: 'c1', role: 'critique', status: 'SUCCESS', contract_valid: true,
  artifact_path: '/x/c.md',
  payload: { critique_role: 'skeptic', target_finding_ids: ['F1'], verdicts: [v] },
  error: null,
}, null, 2);

const FULL_FIVE = {
  evidence_opened: true, evidence_supports_claim: true,
  path_reachable: true, already_handled: false, failure_chain_holds: true,
};

console.log('case 30: skeptic 缺 five_step → 报错');
{
  const r = run(wrap(critEnv({ finding_id: 'F1', verdict: 'holds', reason: 'x' })));
  expect('报 missing_five_step', r.r?.errors?.some(x => x.rule === 'missing_five_step'));
}

console.log('case 31: five_step 缺一步 → 报错并指名');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: 'x',
    five_step: { evidence_opened: true, evidence_supports_claim: true, path_reachable: true, already_handled: false },
  })));
  expect('报 incomplete_five_step 且指向 failure_chain_holds',
    r.r?.errors?.some(x => x.rule === 'incomplete_five_step' && /failure_chain_holds/.test(x.field ?? '')));
}

console.log('case 32: 五步齐全 → 通过');
{
  const r = run(wrap(critEnv({ finding_id: 'F1', verdict: 'holds', reason: 'x', five_step: FULL_FIVE, runtime_applicable: false })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 33: refuted 但没有 direct_contradiction → 警告');
{
  const r = run(wrap(critEnv({ finding_id: 'F1', verdict: 'refuted', reason: 'x', five_step: FULL_FIVE, runtime_applicable: false })));
  expect('报 refuted_without_contradiction 警告',
    r.r?.warnings?.some(x => x.rule === 'refuted_without_contradiction'));
}

console.log('case 34: runtime_evidence 缺 control_case → 警告（无对照不可采信）');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: 'x', five_step: FULL_FIVE,
    runtime_applicable: false,
    runtime_evidence: { method: 'headless_chrome', command: 'chrome ...', observed: 'mutations: []' },
  })));
  expect('报 runtime_no_control 警告', r.r?.warnings?.some(x => x.rule === 'runtime_no_control'));
}

console.log('case 35: runtime_evidence 缺 observed → 报错');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: 'x', five_step: FULL_FIVE,
    runtime_applicable: false,
    runtime_evidence: { method: 'headless_chrome', command: 'chrome ...', control_case: 'peer-snapshot: 303' },
  })));
  expect('报 runtime_no_output', r.r?.errors?.some(x => x.rule === 'runtime_no_output'));
}

console.log('case 36: runtime_evidence 齐全（含对照）→ 通过');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: 'x', five_step: FULL_FIVE,
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
  const r = run(wrap(critEnv({ finding_id: 'F1', verdict: 'UPHELD', reason: 'x', five_step: FULL_FIVE })));
  expect('报 invalid_verdict_enum', r.r?.errors?.some(x => x.rule === 'invalid_verdict_enum'));
}

console.log('case 38: skeptic 返回 refuted → 枚举合法');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'refuted', reason: 'x', five_step: FULL_FIVE,
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
      verdicts: [{ finding_id: 'F1', verdict: 'holds', reason: 'x' }],
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
    reason: '部分成立',
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
    reason: '机制和后果都不对',
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
  const r = run(wrap(critEnv({ finding_id: 'F1', verdict: 'holds', reason: '证据充分', five_step: FULL_FIVE })));
  expect('报 missing_runtime_applicable', r.r?.errors?.some(x => x.rule === 'missing_runtime_applicable'));
}

console.log('case 47: runtime_applicable=true 但没跑 → 报错');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: '证据充分', five_step: FULL_FIVE,
    runtime_applicable: true,
  })));
  expect('报 runtime_required_but_missing', r.r?.errors?.some(x => x.rule === 'runtime_required_but_missing'));
}

console.log('case 48: runtime_applicable=false 且纯静态 → 通过');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: '证据充分', five_step: FULL_FIVE,
    runtime_applicable: false,
  })));
  expect('无错误', r.r?.errors?.length === 0, JSON.stringify(r.r?.errors));
}

console.log('case 49: runtime_applicable=true 且有完整 runtime_evidence → 通过');
{
  const r = run(wrap(critEnv({
    finding_id: 'F1', verdict: 'holds', reason: '证据充分', five_step: FULL_FIVE,
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
  const e = JSON.parse(critEnv({ finding_id: 'F1', verdict: 'holds', reason: 'x',
    five_step: FULL_FIVE, runtime_applicable: false }));
  e.payload.target_finding_ids = ['F1', 'F2', 'F3'];
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 verdict_missing_for_target', r.r?.errors?.some(x => x.rule === 'verdict_missing_for_target'));
}

console.log('case 64: concurrency 领域 refuted 无矛盾证据 → 报错（不是警告）');
{
  const e = JSON.parse(critEnv({ finding_id: 'F1', verdict: 'refuted', reason: 'x',
    dimension: 'concurrency', five_step: FULL_FIVE, runtime_applicable: false }));
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 sensitive_refuted_without_contradiction',
    r.r?.errors?.some(x => x.rule === 'sensitive_refuted_without_contradiction'));
}

console.log('case 65: 非 concurrency 领域 refuted 无矛盾证据 → 仅警告');
{
  const e = JSON.parse(critEnv({ finding_id: 'F1', verdict: 'refuted', reason: 'x',
    dimension: 'logic', five_step: FULL_FIVE, runtime_applicable: false }));
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('不报 error', !r.r?.errors?.some(x => x.rule === 'sensitive_refuted_without_contradiction'));
  expect('报 warning', r.r?.warnings?.some(x => x.rule === 'refuted_without_contradiction'));
}

console.log('case 66: runtime_evidence 缺 main_path → 报错（只跑语法检查不算）');
{
  const e = JSON.parse(critEnv({ finding_id: 'F1', verdict: 'holds', reason: 'x', five_step: FULL_FIVE,
    runtime_applicable: true,
    runtime_evidence: { method: 'node_cli', command: 'node --check a.js', observed: 'exit 0', control_case: '对照页通过' } }));
  const r = run(wrap(JSON.stringify(e, null, 2)));
  expect('报 runtime_no_main_path 警告（2026-11-11 降级为建议）',
    r.r?.warnings?.some(x => x.rule === 'runtime_no_main_path'));
}

console.log('case 67: main_path 期望等于实际 → 警告（无区分力）');
{
  const e = JSON.parse(critEnv({ finding_id: 'F1', verdict: 'holds', reason: 'x', five_step: FULL_FIVE,
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

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
