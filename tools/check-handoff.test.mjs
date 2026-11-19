#!/usr/bin/env node
/**
 * check-handoff.test.mjs — 自测 check-handoff.mjs
 *
 * 每条检查项都要有成对用例：正例（合规不能误报）+ 反例（违规必须抓到）。
 * 只测反例的话，一个「什么都报错」的检查器也能全绿。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync } from 'node:fs';
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

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);