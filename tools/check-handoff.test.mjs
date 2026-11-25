#!/usr/bin/env node
/**
 * check-handoff.test.mjs — 自测 check-handoff.mjs
 *
 * 每条检查项都要有成对用例：正例（合规不能误报）+ 反例（违规必须抓到）。
 * 只测反例的话，一个「什么都报错」的检查器也能全绿。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'check-handoff.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

const DIGEST = 'a'.repeat(64);

/** 一份合规的基线包；各用例在它上面做单点破坏。 */
const base = () => ({
  schema_version: 'handoff-schema-v1',
  round_id: 'round30',
  wave_id: 'wave-2',
  wave_status: 'CLOSED',
  trace_id: 'trace-abc',
  packet_digest: DIGEST,
  open_items: [
    { kind: 'UNRESOLVED_FINDING', artifact_path: 'x.md', summary: 'ok' },
  ],
});

function runOne(obj) {
  const dir = mkdtempSync(join(tmpdir(), 'ho-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(SRC, join(dir, 'tools', 'check-handoff.mjs'));
  const f = join(dir, 'packet.json');
  writeFileSync(f, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
  try {
    const out = execFileSync(process.execPath, [join(dir, 'tools', 'check-handoff.mjs'), f], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────────
console.log('\ncase 1: 合规包 → exit 0（基线，保证后面的反例不是「什么都报」）');
{
  const r = runOne(base());
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('报全部合规', /全部合规/.test(r.out), r.out);
}

console.log('\ncase 2 (H1): 缺 trace_id → missing_field');
{
  const p = base(); delete p.trace_id;
  const r = runOne(p);
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('报 missing_field', /missing_field/.test(r.out), r.out);
  ok('点名 trace_id', /trace_id/.test(r.out), r.out);
}

console.log('\ncase 3 (H1): 缺多个必填 → 逐个点名，不只报第一个');
{
  const p = base(); delete p.schema_version; delete p.round_id; delete p.wave_id;
  const r = runOne(p);
  const n = (r.out.match(/missing_field/g) ?? []).length;
  ok('至少报 3 条', n >= 3, `报了 ${n} 条`);
}

console.log('\ncase 4 (H2): schema_version 写错 → bad_schema_version');
{
  const p = base(); p.schema_version = 'handoff-schema-v2';
  const r = runOne(p);
  ok('exit 1', r.code === 1);
  ok('报 bad_schema_version', /bad_schema_version/.test(r.out), r.out);
}

console.log('\ncase 5 (H3): wave_id 非法 → bad_wave_id');
{
  const p = base(); p.wave_id = 'wave-9';
  const r = runOne(p);
  ok('exit 1', r.code === 1);
  ok('报 bad_wave_id', /bad_wave_id/.test(r.out), r.out);
}

console.log('\ncase 6 (H4): wave_status 非法（含 IN_PROGRESS 这种"看起来合理"的）→ bad_wave_status');
{
  const p = base(); p.wave_status = 'IN_PROGRESS';
  const r = runOne(p);
  ok('exit 1', r.code === 1);
  ok('报 bad_wave_status', /bad_wave_status/.test(r.out), r.out);
}

console.log('\ncase 7 (H5): open_items.kind 非法 → bad_open_item_kind');
{
  const p = base(); p.open_items[0].kind = 'SOMETHING_ELSE';
  const r = runOne(p);
  ok('exit 1', r.code === 1);
  ok('报 bad_open_item_kind', /bad_open_item_kind/.test(r.out), r.out);
}

console.log('\ncase 8 (H5): open_items 缺 kind → missing_open_item_kind');
{
  const p = base(); delete p.open_items[0].kind;
  const r = runOne(p);
  ok('exit 1', r.code === 1);
  ok('报 missing_open_item_kind', /missing_open_item_kind/.test(r.out), r.out);
}

console.log('\ncase 9 (H6): 塞入超长原始正文 → raw_body_in_packet');
{
  const p = base();
  p.open_items[0].summary = 'x'.repeat(3000);
  const r = runOne(p);
  ok('exit 1', r.code === 1);
  ok('报 raw_body_in_packet', /raw_body_in_packet/.test(r.out), r.out);
}

console.log('\ncase 10 (H6): 塞入 findings JSON 片段 → raw_body_in_packet');
{
  const p = base();
  p.open_items[0].note = '这里是原始返回：\n  "findings": [ {"id":"F1"} ]';
  const r = runOne(p);
  ok('exit 1', r.code === 1);
  ok('报 raw_body_in_packet', /raw_body_in_packet/.test(r.out), r.out);
}

console.log('\ncase 11 (H7): round_id 形态不对 → bad_round_id');
{
  const p = base(); p.round_id = '30';
  const r = runOne(p);
  ok('exit 1', r.code === 1);
  ok('报 bad_round_id', /bad_round_id/.test(r.out), r.out);
}

console.log('\ncase 12: 完整的 10 种 kind 全部合法（不能因为闭集写漏而误伤）');
{
  const kinds = ['UNRESOLVED_FINDING', 'EVIDENCE_GAP', 'COVERAGE_GAP', 'REGRESSION_SCAN_REQUIRED',
    'AFFECTED_BY_FIX', 'PERMANENT_FAILURE', 'UNVERIFIED_TARGET', 'DEFERRED_SLICE',
    'HUMAN_DECISION_REQUIRED', 'REVOKED'];
  const p = base();
  p.open_items = kinds.map((k) => ({ kind: k }));
  const r = runOne(p);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
}

console.log('\ncase 13: generated_at 缺失是合法的（契约明写「允许缺失」）');
{
  const p = base();  // base() 本就没有 generated_at
  const r = runOne(p);
  ok('exit 0', r.code === 0, `code=${r.code}`);
}

console.log('\ncase 14: 非 JSON 文件 → json_parse_failed（不是崩溃）');
{
  const r = runOne('{ this is not json');
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('报 json_parse_failed', /json_parse_failed/.test(r.out), r.out);
}

console.log('\ncase 15: 顶层是数组 → not_an_object');
{
  const r = runOne([1, 2, 3]);
  ok('exit 1', r.code === 1);
  ok('报 not_an_object', /not_an_object/.test(r.out), r.out);
}

console.log('\ncase 16: --dir 空目录 → exit 2（分母为 0 不等于通过）');
{
  const dir = mkdtempSync(join(tmpdir(), 'ho-empty-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'empty'), { recursive: true });
  cpSync(SRC, join(dir, 'tools', 'check-handoff.mjs'));
  let code = 0, out = '';
  try {
    out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-handoff.mjs'), '--dir', join(dir, 'empty')], { encoding: 'utf8' });
  } catch (e) { code = e.status ?? 1; out = (e.stdout ?? '') + (e.stderr ?? ''); }
  ok('exit 2', code === 2, `code=${code}`);
  ok('提示分母为 0', /分母为 0/.test(out), out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 17: packet_digest 不是 sha256 → WARN 但不是 ERROR');
{
  const p = base(); p.packet_digest = 'not-a-hash';
  const r = runOne(p);
  ok('exit 0（WARN 不阻断）', r.code === 0, `code=${r.code}`);
  ok('报 digest_not_sha256_hex', /digest_not_sha256_hex/.test(r.out), r.out);
}

// ═══════════════════════════════════════════════════════════════════
// H8–H11（2026-11-25 补）
//
// 这几条此前**完全没有校验**：handoff-schema.md 有 31 条规则、30 条没有机器出口，
// 而 check-handoff 只实现了 7 条，且从没被任何门调用过。
// 每条都要成对：违规必须报，合规必须不误伤。
// ═══════════════════════════════════════════════════════════════════

const withConflicts = (conflicts) => ({ ...base(), conflicts });
const party = (ref = 'a.md') => ({ agent_id: 'x', position: 'TRIGGERABLE', artifact_ref: ref });

console.log('\ncase 18 (H8): 完整合规的 conflicts → 不报');
{
  const r = runOne(withConflicts([
    { conflict_id: 'C1', parties: [party(), party('b.md')], resolution: 'PENDING' },
    { conflict_id: 'C2', parties: [party()], resolution: 'UPHELD', arbiter_artifact_ref: 'arb.md' },
  ]));
  ok('exit 0', r.code === 0, r.out);
  ok('无错误', /全部合规/.test(r.out), r.out);
}

console.log('\ncase 19 (H8): resolution 不在闭集 → 报 bad_resolution');
{
  const r = runOne(withConflicts([{ conflict_id: 'C1', parties: [party()], resolution: 'MAYBE' }]));
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('报 bad_resolution', /bad_resolution/.test(r.out), r.out);
}

console.log('\ncase 20 (H8): UPHELD 却没有 arbiter_artifact_ref → 报（第 4 节硬约束 + §9 步骤 5）');
{
  const r = runOne(withConflicts([{ conflict_id: 'C1', parties: [party()], resolution: 'UPHELD' }]));
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('报 resolved_without_arbiter_ref', /resolved_without_arbiter_ref/.test(r.out), r.out);
}

console.log('\ncase 20b (H8): DOWNGRADED / REVOKED 同样要求 arbiter_artifact_ref');
{
  for (const res of ['DOWNGRADED', 'REVOKED']) {
    const r = runOne(withConflicts([{ conflict_id: 'C1', parties: [party()], resolution: res }]));
    ok(`${res} 缺裁决记录 → 报`, /resolved_without_arbiter_ref/.test(r.out), `${res}: ${r.out}`);
  }
}

console.log('\ncase 21 (H8): parties 条目缺 artifact_ref → 报');
{
  const r = runOne(withConflicts([
    { conflict_id: 'C1', parties: [{ agent_id: 'x', position: 'HOLDS' }], resolution: 'PENDING' },
  ]));
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('报 party_without_artifact_ref', /party_without_artifact_ref/.test(r.out), r.out);
}

console.log('\ncase 21b (H8): parties 为空数组 → WARN 但不判错（契约只约束「每一条」）');
{
  // 2026-11-25 锐评实测：契约写的是「parties 中**每一条**必须携带 artifact_ref」，
  // 空数组是空真——没有条目违反它。上一版判 ERROR 属于「校验器比契约严」。
  const r = runOne(withConflicts([{ conflict_id: 'C1', parties: [], resolution: 'PENDING' }]));
  ok('exit 0（只是 WARN）', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('报 empty_parties', /empty_parties/.test(r.out), r.out);
}

console.log('\ncase 22 (H9): deferred_items 合规 → 不报');
{
  const p = { ...base(), deferred_items: [
    { item_id: 'D1', kind: 'SLICE', reason: 'ADMISSION_CEILING', artifact_ref: null, requires_human_intervention: false },
  ] };
  const r = runOne(p);
  ok('exit 0', r.code === 0, r.out);
}

console.log('\ncase 23 (H9): deferred_items.kind / reason 越界 → 报');
{
  const p = { ...base(), deferred_items: [
    { item_id: 'D1', kind: 'WHATEVER', reason: 'BECAUSE', requires_human_intervention: true },
  ] };
  const r = runOne(p);
  ok('报 bad_deferred_kind', /bad_deferred_kind/.test(r.out), r.out);
  ok('报 bad_deferred_reason', /bad_deferred_reason/.test(r.out), r.out);
}

console.log('\ncase 24 (H9): deferred_items 缺 requires_human_intervention → 报（第 7 节要求报告逐条标注）');
{
  const p = { ...base(), deferred_items: [{ item_id: 'D1', kind: 'SLICE', reason: 'HARNESS_CAP' }] };
  const r = runOne(p);
  ok('报 missing_requires_human_intervention', /missing_requires_human_intervention/.test(r.out), r.out);
}

console.log('\ncase 25 (H10): covered_modules 合规 → 不报');
{
  const p = { ...base(), covered_modules: [
    { module_id: 'src/a', paths: ['src/a/x.js'], round_id: 'round29', audit_verdict: 'SUCCESS', finding_count: 0, upheld_count: 0 },
  ] };
  const r = runOne(p);
  ok('exit 0', r.code === 0, r.out);
}

console.log('\ncase 26 (H10): 契约自己的示例（SUCCESS + upheld_count:2）必须通过');
{
  // 2026-11-25 锐评实测：上一版本在这里加了「SUCCESS + upheld_count>0 自相矛盾」，
  // 而 handoff-schema.md:220-231 的示例 JSON 恰好是 SUCCESS + upheld_count:2。
  // **校验器拒绝了契约自己的示例** —— output-contract/audit.md:180 的形态。
  // 这条用例钉住：契约示例必须永远能过。
  const p = { ...base(), covered_modules: [
    { module_id: 'src/dispatch', paths: ['src/dispatch/pipeline.ts'],
      round_id: 'round29', audit_verdict: 'SUCCESS', finding_count: 3, upheld_count: 2 },
  ] };
  const r = runOne(p);
  ok('exit 0（契约示例不得被拒）', r.code === 0, `code=${r.code}\n${r.out}`);
}

console.log('\ncase 26c (H10): upheld_count 不是整数（"2" / null）→ 报');
{
  for (const bad of ['2', null]) {
    const p = { ...base(), covered_modules: [
      { module_id: 'm', audit_verdict: 'SUCCESS', upheld_count: bad },
    ] };
    const r = runOne(p);
    ok(`upheld_count=${JSON.stringify(bad)} → 报 non_integer_count`,
      /non_integer_count/.test(r.out), r.out);
  }
}

console.log('\ncase 26b (H10): audit_verdict 越界 → 报');
{
  const p = { ...base(), covered_modules: [{ module_id: 'm', audit_verdict: 'PERFECT' }] };
  const r = runOne(p);
  ok('报 bad_audit_verdict', /bad_audit_verdict/.test(r.out), r.out);
}

console.log('\ncase 27 (H11): open_item 缺 blocking → WARN 但不阻断（契约未列为必填）');
{
  // 关键：校验器不得比契约严。契约的第 3 节示例里有 blocking，但正文从没写「必填」。
  const p = base();
  delete p.open_items[0].blocking;
  const r = runOne(p);
  ok('exit 0（只是 WARN）', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('报 missing_blocking', /missing_blocking/.test(r.out), r.out);
}

console.log('\ncase 28 (H11): 人工阻塞类被标 blocking → WARN 提示只能 PARTIALLY_CLOSED');
{
  const p = base();
  p.open_items = [{ kind: 'HUMAN_DECISION_REQUIRED', blocking: true, summary: 'x' }];
  const r = runOne(p);
  ok('exit 0（不是错误）', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('报 human_blocker_present', /human_blocker_present/.test(r.out), r.out);
}

console.log('\ncase 29 (H12): PENDING 冲突 + 对应 open_item 标 blocking → 不得闭合（第 4 节第一条硬约束）');
{
  // 2026-11-25 锐评实测：这是 §4 的**第一条**硬约束，上一版完全没实现，
  // 而文档里还写着「本节的三条硬约束由 H8 实现」——一句假自述。
  const p = {
    ...base(),
    wave_status: 'CLOSED',
    conflicts: [{ conflict_id: 'C1', finding_ref: 'F1', parties: [party()], resolution: 'PENDING' }],
    open_items: [{ kind: 'UNRESOLVED_FINDING', finding_ref: 'F1', blocking: true }],
  };
  const r = runOne(p);
  ok('exit 1', r.code === 1, `code=${r.code}\n${r.out}`);
  ok('报 pending_conflict_blocks_close', /pending_conflict_blocks_close/.test(r.out), r.out);
}

console.log('\ncase 29b (H12): 同一冲突已 UPHELD（有裁决记录）→ 允许闭合');
{
  const p = {
    ...base(),
    wave_status: 'CLOSED',
    conflicts: [{ conflict_id: 'C1', finding_ref: 'F1', parties: [party()], resolution: 'UPHELD', arbiter_artifact_ref: 'a.md' }],
    open_items: [{ kind: 'UNRESOLVED_FINDING', finding_ref: 'F1', blocking: true }],
  };
  const r = runOne(p);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
}

console.log('\ncase 30 (H13): 原始正文塞进 conflicts / closed_waves / deferred_items → 都要报（H6 只覆盖 open_items 是缺口）');
{
  const big = '"evidence": { ' + 'x'.repeat(3000) + ' }';
  const cases = {
    'conflicts[0].resolution_reason': { ...base(), conflicts: [
      { conflict_id: 'C1', parties: [party()], resolution: 'PENDING', resolution_reason: big }] },
    'closed_waves[0].summary': { ...base(), closed_waves: [
      { wave_id: 'wave-1', gate_result: 'PASS', artifact_paths: [], summary: big }] },
    'deferred_items[0].artifact_ref': { ...base(), deferred_items: [
      { item_id: 'D1', kind: 'SLICE', reason: 'HARNESS_CAP', artifact_ref: big, requires_human_intervention: false }] },
  };
  for (const [where, p] of Object.entries(cases)) {
    const r = runOne(p);
    ok(`${where} 塞正文 → 报 raw_body_in_packet`, /raw_body_in_packet/.test(r.out), `${where}: ${r.out.slice(0, 300)}`);
  }
}

console.log('\ncase 31 (H14): closed_waves 的 gate_result 越界 / summary 超预算 → 报（第 2 节）');
{
  const r1 = runOne({ ...base(), closed_waves: [{ wave_id: 'wave-1', gate_result: 'GREAT', artifact_paths: [] }] });
  ok('gate_result 越界 → bad_gate_result', /bad_gate_result/.test(r1.out), r1.out.slice(0, 200));

  const r2 = runOne({ ...base(), closed_waves: [
    { wave_id: 'wave-1', gate_result: 'PASS', artifact_paths: [], summary: 'x'.repeat(500) }] });
  ok('summary 超 400 字符 → summary_over_budget', /summary_over_budget/.test(r2.out), r2.out.slice(0, 200));
}

console.log('\ncase 32 (C2): packet_digest 缺失是合法的（契约明写「允许缺失」）');
{
  // 2026-11-25 锐评实测：上一版把 packet_digest 放进 REQUIRED，而 handoff-schema.md:68
  // 写的是「允许缺失；如果存在但不匹配，拒绝整个包」。接线到 close 门之后，
  // 那是一条「契约允许的包收不了口」的真实路径。
  const p = base();
  delete p.packet_digest;
  const r = runOne(p);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('不报 missing_field(packet_digest)', !/missing_field/.test(r.out), r.out);
}

console.log('\ncase 33 (回归保护): handoff-schema.md 里的 covered_modules 示例必须能过');
{
  // CRITICAL 级的问题能长期存活，是因为 handoff-schema 的 JSON 示例
  // **没有任何工具拿去跑**。这里直接抽契约示例里的 covered_modules，
  // 拼成一个完整包跑一遍——正文与校验器再漂移，这条会红。
  const md = readFileSync(join(HERE, '..', 'framework', 'components', 'handoff-schema.md'), 'utf8');
  const m = md.match(/```json\n(\{[\s\S]*?"covered_modules"[\s\S]*?\})\n```/);
  if (!m) {
    ok('找得到 covered_modules 示例', false, '契约结构变了，先更新这条用例');
  } else {
    let sample = null;
    try { sample = JSON.parse(m[1]); } catch { sample = null; }
    ok('示例是合法 JSON', sample !== null);
    if (sample) {
      const r = runOne({ ...base(), covered_modules: sample.covered_modules });
      ok('契约示例通过校验器（校验器不得比契约严）', r.code === 0, `code=${r.code}\n${r.out}`);
    }
  }
}

console.log('\ncase 34 (验收): 长 arbitration reason 不得被 2000 字符阈值误伤');
{
  // 2026-11-25 验收实测：上一版对整份包所有字符串字段一律 >2000 判 ERROR，
  // 而契约 §4 把 resolution_reason 定义为 string|null（仲裁理由本来就可能长）。
  // 挂在 close 门上就是「arbiter 写了一段长理由的合规包收不了口」。
  const p = { ...base(), conflicts: [{
    conflict_id: 'C1', parties: [party()], resolution: 'UPHELD',
    arbiter_artifact_ref: 'a.md', resolution_reason: '仲'.repeat(2500),
  }] };
  const r = runOne(p);
  ok('exit 0（resolution_reason 是散文，不限长）', r.code === 0, `code=${r.code}\n${r.out.slice(0, 400)}`);
}

console.log('\ncase 35 (验收): PENDING 冲突没 finding_ref → 至少有 WARN（不能静默放行）');
{
  // 代码注释上一版说「关联不上归到一条 WARN」，而代码里没有那条 WARN。
  const p = {
    ...base(),
    wave_status: 'CLOSED',
    conflicts: [{ conflict_id: 'C1', parties: [party()], resolution: 'PENDING' }],
    open_items: [{ kind: 'UNRESOLVED_FINDING', blocking: true }],
  };
  const r = runOne(p);
  ok('报 conflict_not_linked', /conflict_not_linked/.test(r.out), r.out.slice(0, 400));
}

console.log('\ncase 36 (验收): parties 键缺失与 parties: [] 同标准（都是 WARN）');
{
  const a = runOne(withConflicts([{ conflict_id: 'C1', resolution: 'PENDING' }]));
  const b = runOne(withConflicts([{ conflict_id: 'C1', parties: [], resolution: 'PENDING' }]));
  ok('键缺失 → exit 0（WARN）', a.code === 0, `code=${a.code}\n${a.out.slice(0, 300)}`);
  ok('空数组 → exit 0（WARN）', b.code === 0, `code=${b.code}\n${b.out.slice(0, 300)}`);
}

console.log('\ncase 37 (验收): blocking 与 requires_human_intervention 的类型错同标准（都是 WARN）');
{
  const a = runOne({ ...base(), open_items: [{ kind: 'UNRESOLVED_FINDING', blocking: 'yes' }] });
  const b = runOne({ ...base(), deferred_items: [
    { item_id: 'D1', kind: 'SLICE', reason: 'HARNESS_CAP', requires_human_intervention: 'yes' }] });
  ok('blocking 类型错 → exit 0', a.code === 0, `code=${a.code}`);
  ok('requires_human_intervention 类型错 → exit 0', b.code === 0, `code=${b.code}\n${b.out.slice(0, 300)}`);
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);