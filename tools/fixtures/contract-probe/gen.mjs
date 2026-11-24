import fs from 'node:fs';
import path from 'node:path';

const R = path.resolve(process.argv[2] ?? import.meta.dirname);
const dir = R + '/probe';
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });

const env = (role, payload, over = {}) => ({
  schema_version: 'output-contract-v1',
  agent_id: 'a1',
  role,
  status: 'SUCCESS',
  contract_valid: true,
  artifact_path: 'PLACEHOLDER',
  payload,
  error: null,
  ...over,
});

const auditScope = {
  files_read: ['src/queue.js'],
  files_in_slice: 1,
  shared_dependencies_read: [],
  dimension_checklist: ['条件分支'],
};

const auditFinding = {
  finding_id: 'F1',
  dimension: 'logic',
  severity: 'HIGH',
  evidence: { file: 'src/queue.js', line: 51, quote: 'if (this.#items[i].priority >= this.#items[bestIdx].priority) {' },
  inference: { claim: '破坏 FIFO', basis: '>= 让后入队者胜出', alternatives: ['故意 LIFO'] },
  status: 'CONFIRMED',
};

const goodChecks = {
  identifier_reconcile: { status: 'DONE', note: '对账了 1 个文件的 import 列表，无缺失' },
  self_check_audit: { status: 'DONE', note: '抽验了自检脚本对 FIFO 的断言' },
  runtime_validation: { status: 'DONE', note: '跑了 3 次 enqueue/dequeue 验证顺序' },
};

const auditBase = {
  slice_id: 's1',
  searched_scope: auditScope,
  findings: [auditFinding],
  self_checks: goodChecks,
};

const reconScope = {
  slice_id: 's1',
  files: ['src/a.js'],
  file_count: 1,
  line_count: 100,
  oversized_file: false,
  undersized: true,
  reachability_hint: 'PROD',
  exclusion_report: { excluded_source_like: [], exclusion_dominant: false },
  entry_points: [
    { entry_id: 'e1', kind: 'EXPORTED_SYMBOL', location: 'src/a.js:1', trigger: 't', next_hop: 'n', evidence_quote: 'export function f() {' },
  ],
  entry_points_truncated: false,
  covered_modules: [],
  harness_concurrency_cap: 4,
  root_dir: 'src',
  is_entry_slice: true,
  shared_dependencies: [],
  audit_slices: [{ slice_id: 's1' }],
  slice_count: 1,
  unverified: ['无'],
};

const sweepBase = {
  slice_id: 's1',
  reachability: 'PROD',
  generator_ref: null,
  files_read: ['src/a.js'],
  files_unreadable: [],
  leads: [
    { lead_id: 'l1', suspected_dimension: 'logic', file: 'src/a.js', line: 1, quote: 'x', why_suspicious: 'y', confidence: 'HIGH' },
  ],
  lead_count: 1,
  dimension_histogram: { logic: 1, concurrency: 0, security: 0, 'error-handling': 0, 'data-consistency': 0, contract: 0 },
};

const cases = {};

// ── 顶层信封 ──
cases['A1-good-audit'] = env('audit', auditBase);
cases['A2-missing-artifact'] = env('audit', auditBase, { artifact_path: null });
cases['A3-bad-schema-version'] = env('audit', auditBase, { schema_version: 'output-contract-v0' });
cases['A4-bad-role'] = env('auditor', auditBase);
cases['A5-bad-status'] = env('audit', auditBase, { status: 'DONE' });

// ── recon ──
cases['R1-slice-count-mismatch'] = env('recon', { ...reconScope, slice_count: 2 });
cases['R2-silent-truncation'] = env('recon', { ...reconScope, entry_points_truncated: true, unverified: [] });
cases['R3-entry-no-quote'] = env('recon', {
  ...reconScope,
  entry_points: [{ entry_id: 'e1', kind: 'EXPORTED_SYMBOL', location: 'src/a.js:1', trigger: 't', next_hop: 'n', evidence_quote: '' }],
});

// ── sweep ──
cases['S1-lead-count-mismatch'] = env('sweep', { ...sweepBase, lead_count: 5 });
cases['S2-histogram-mismatch'] = env('sweep', {
  ...sweepBase,
  dimension_histogram: { logic: 3, concurrency: 0, security: 0, 'error-handling': 0, 'data-consistency': 0, contract: 0 },
});
cases['S3-bad-reachability'] = env('sweep', { ...sweepBase, reachability: 'MAYBE' });
cases['S4-empty-leads-OK'] = env('sweep', {
  ...sweepBase,
  leads: [],
  lead_count: 0,
  dimension_histogram: { logic: 0, concurrency: 0, security: 0, 'error-handling': 0, 'data-consistency': 0, contract: 0 },
});

// ── audit ──
cases['U1-empty-findings'] = env('audit', { ...auditBase, findings: [] });
cases['U2-confirmed-empty-quote'] = env('audit', {
  ...auditBase,
  findings: [{ ...auditFinding, evidence: { file: 'src/queue.js', line: 51, quote: '' } }],
});
cases['U3-no-evidence-short-basis'] = env('audit', {
  ...auditBase,
  findings: [
    {
      finding_id: 'F1', dimension: 'security', severity: 'LOW',
      evidence: { file: 'src/queue.js', line: 1, quote: '// src/queue.js' },
      inference: { claim: '没问题', basis: '读完了', alternatives: [] },
      status: 'NO_EVIDENCE_FOUND',
    },
  ],
});
cases['U4-no-evidence-no-scope'] = env('audit', {
  ...auditBase,
  searched_scope: { ...auditScope, files_read: [], dimension_checklist: [] },
  findings: [
    {
      finding_id: 'F1', dimension: 'security', severity: 'LOW',
      evidence: { file: 'src/queue.js', line: 1, quote: '// src/queue.js' },
      inference: { claim: '没问题', basis: '逐行读完 9 个文件并 grep 了 12 个模式，未发现门 0 可用证据', alternatives: [] },
      status: 'NO_EVIDENCE_FOUND',
    },
  ],
});
cases['U5-skip-no-note'] = env('audit', {
  ...auditBase,
  self_checks: { ...goodChecks, runtime_validation: { status: 'SKIPPED', note: '' } },
});
cases['U6-bad-finding-status'] = env('audit', {
  ...auditBase,
  findings: [{ ...auditFinding, status: 'TOTALLY_FINE' }],
});
cases['U7-missing-selfchecks'] = env('audit', { slice_id: 's1', searched_scope: auditScope, findings: [auditFinding] });

for (const [name, obj] of Object.entries(cases)) {
  const file = `${dir}/${name}.md`;
  // 2026-11-24：原先写的是绝对路径 `file`，于是每份探针都固化了
  // **建库那台机器**的盘符（D:\Projects\...）。换到 Linux 上，
  // check-payload 解析不到文件 → artifact_not_found → A1「完全合规的对照组」
  // 与 S4「sweep 的 leads 允许为空」被判拦截，CI 上稳定「17 通过 / 2 不符」，
  // 而 Windows 本机是 19/19 —— 同一份夹具在不同机器上结论相反。
  //
  // 契约 §1 允许「仓库外绝对路径 **或** <OUTDIR> 相对路径」，相对路径按
  // 产物自身所在目录解析，所以写文件名即可。
  if (obj.artifact_path === 'PLACEHOLDER') obj.artifact_path = `${name}.md`;
  fs.writeFileSync(file, '# 报告\n\n正文\n\n```json\n' + JSON.stringify(obj, null, 2) + '\n```\n');
}

console.log(`生成 ${Object.keys(cases).length} 个探针产物`);
for (const name of Object.keys(cases)) {
  const role = cases[name].role;
  console.log(`  ${name}\t${role}`);
}
