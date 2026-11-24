import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const R = path.resolve(process.argv[2] ?? import.meta.dirname);
const dir = R + '/probe';
const script = path.join(R, '..', '..', '..', 'tools', 'check-payload.mjs');

// 每个用例：期望通过还是期望被拦，以及期望命中的规则名
const EXPECT = {
  'A1-good-audit': { pass: true, why: '完全合规的对照组' },
  'A2-missing-artifact': { pass: false, rule: 'artifact_path', why: '契约 §1：SUCCESS 时 artifact_path 必填且文件必须存在' },
  'A3-bad-schema-version': { pass: false, rule: 'schema_version', why: '契约 §1：版本必须精确匹配' },
  'A4-bad-role': { pass: false, why: '契约 §1：role 必须是六个角色之一' },
  'A5-bad-status': { pass: false, why: '契约 §1：status 必须四个终态之一' },
  'R1-slice-count-mismatch': { pass: false, why: '契约 §2.1：slice_count 必须等于 len(audit_slices)' },
  'R2-silent-truncation': { pass: false, why: '契约 §2.1：静默截断判 CONTRACT_VIOLATION' },
  'R3-entry-no-quote': { pass: false, why: '契约 §2.1：每个入口点的 evidence_quote 必填' },
  'S1-lead-count-mismatch': { pass: false, why: '契约 §2.2a：lead_count == len(leads)' },
  'S2-histogram-mismatch': { pass: false, why: '契约 §2.2a：histogram 各值之和 == lead_count' },
  'S3-bad-reachability': { pass: false, why: '契约 §2.2a：reachability 是枚举' },
  'S4-empty-leads-OK': { pass: true, why: '契约 §2.2a：sweep 的 leads 允许为空' },
  'U1-empty-findings': { pass: false, why: '契约 §2.2：findings 空数组一律 CONTRACT_VIOLATION' },
  'U2-confirmed-empty-quote': { pass: false, why: '契约 §2.2：CONFIRMED 必须有门 0 级证据' },
  'U3-no-evidence-short-basis': { pass: false, why: '契约 §2.2：NO_EVIDENCE_FOUND 的 basis 少于 15 字' },
  'U4-no-evidence-no-scope': { pass: false, why: '契约 §2.2：NO_EVIDENCE_FOUND 必须有 searched_scope' },
  'U5-skip-no-note': { pass: false, why: '契约 §2.2：SKIPPED 不给 note' },
  'U6-bad-finding-status': { pass: false, why: '契约 §2.2：finding.status 必须是枚举值' },
  'U7-missing-selfchecks': { pass: false, why: '契约 §2.2：self_checks 必填' },
};

const ROLE_OF = {};
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md'))) {
  const txt = fs.readFileSync(path.join(dir, f), 'utf8');
  // \r? 容忍 CRLF：Windows checkout 会把文件写成 \r\n，只写 \n 会静默匹配失败。
  const m = txt.match(/```json\r?\n([\s\S]*?)\r?\n```/);
  if (m) { try { ROLE_OF[f.replace('.md', '')] = JSON.parse(m[1]).role; } catch {} }
}

const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.md')).sort()) {
  const name = f.replace('.md', '');
  const role = ROLE_OF[name] ?? 'audit';
  let out = '', code = 0;
  try {
    out = execFileSync('node', [script, path.join(dir, f), '--role', role], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    out = (e.stdout ?? '') + (e.stderr ?? '');
    code = e.status ?? 1;
  }
  const passed = /✅\s*契约合规/.test(out) || code === 0;
  const rules = [...out.matchAll(/\[([a-z_]+)\]/g)].map((m) => m[1]);
  rows.push({ name, role, passed, rules: [...new Set(rules)], exp: EXPECT[name] });
}

console.log('\n=== 契约判据 vs 校验器实际行为 ===\n');
console.log('用例                        角色   期望   实际   结果   契约依据');
let bad = 0;
for (const r of rows) {
  const exp = r.exp?.pass ? '通过' : '拦截';
  const act = r.passed ? '通过' : '拦截';
  const ok = r.exp?.pass === r.passed;
  if (!ok) bad++;
  console.log(
    `${r.name.padEnd(28)}${r.role.padEnd(7)}${exp.padEnd(7)}${act.padEnd(7)}${ok ? '✓' : '✗ 不符'}  ${r.exp?.why ?? ''}`,
  );
  if (ok && !r.passed) console.log(`${' '.repeat(29)}→ 命中规则: ${r.rules.join(', ') || '(未标规则名)'}`);
  if (!ok) {
    console.log(`${' '.repeat(29)}→ 实际规则: ${r.rules.join(', ') || '(无)'}`);
  }
}

console.log(`\n合计 ${rows.length} 个用例，${rows.length - bad} 个符合契约，${bad} 个不符\n`);
// 2026-11-24：这里此前是 `process.exit(0)`——**永远成功**。
// 后果：CI 上稳定打「17 个符合契约，2 个不符」，check-all 照样全绿，
// 整整一段时间没人知道这份对照表在 Linux 上是红的。
// 根因是探针里写死了 Windows 绝对路径（已在 gen.mjs 修）；
// 但即使根因是夹具问题，「不符」也必须让套件失败——
// 否则这张表只是装饰，和 stop-hook.test.mjs 缺 exit 是同一类缺陷。
process.exit(bad > 0 ? 1 : 0);
