// The detector as the plan INTENDS it, which is a hybrid the plan text does not spell out:
//   assertion_target_dropped  -> subject absent from the WHOLE FILE (file scope, so renames are safe)
//   assertion_reversed        -> compare only assertions in the SAME METHOD (method scope, so a
//                                file-wide duplicate of the old value cannot mask a real flip)
// Both single-scope readings were measured first (see variants.mjs): file-only misses both real
// reversals; method-only false-positives on renamed methods. This file is the fair reading.
//
//   node hybrid.mjs --snapshot out/snapshot/t0

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './parse-assertions.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const snap = getArg('--snapshot', path.join(import.meta.dirname, 'out', 'snapshot', 't0'));
const outDir = getArg('--out', path.join(import.meta.dirname, 'out'));
const reported = (getArg('--reported', '') || '').split(',').filter(Boolean); // files with TEST_CONFLICT
mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));

function detect(rel, oldSrc, newSrc) {
  const newP = parseAssertions(newSrc);
  const findings = [];
  const claimed = reported.some((r) => rel.includes(r));

  if (oldSrc !== null) {
    const oldP = parseAssertions(oldSrc);

    // ---- rule 1: dropped, file scope
    for (const [subj, olds] of oldP.subjects) {
      if (!newP.subjects.has(subj)) {
        findings.push({
          rule: 'assertion_target_dropped', severity: 'FAIL', subject: subj,
          oldAssertions: olds.map(o => ({ ...o })), newAssertions: [],
        });
      }
    }

    // ---- rule 2: reversed, method scope
    const idx = (p) => {
      const m = new Map();
      for (const [subj, arr] of p.subjects) for (const a of arr) {
        const k = `${a.method}::${subj}`;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(a);
      }
      return m;
    };
    const oi = idx(oldP), ni = idx(newP);
    for (const [k, olds] of oi) {
      const news = ni.get(k);
      if (!news) continue; // method gone or renamed -> rule 1 already covers real deletions
      const osig = new Set(olds.map((a) => `${a.pclass}(${a.expected})`));
      const nsig = new Set(news.map((a) => `${a.pclass}(${a.expected})`));
      const lost = [...osig].filter((s) => !nsig.has(s));
      if (lost.length) {
        findings.push({
          rule: claimed ? 'assertion_reversed_reported' : 'assertion_reversed_unreported',
          severity: claimed ? 'WARN' : 'FAIL',
          subject: k.split('::')[1], method: k.split('::')[0],
          oldAssertions: olds.map(o => ({ ...o })), newAssertions: news.map(n => ({ ...n })),
          lost, gained: [...nsig].filter((s) => !osig.has(s)),
        });
      }
    }
  }

  // ---- rule: test_disabled
  const cd = (s) => s === null ? 0 : (s.match(/@Disabled\b|\b@Ignore\b|\bit\.skip\s*\(|@pytest\.mark\.skip|\bxfail\b/g) ?? []).length;
  if (cd(newSrc) > cd(oldSrc)) findings.push({ rule: 'test_disabled', severity: 'FAIL' });

  return { rel, findings, stats: { old: oldSrc ? parseAssertions(oldSrc).stats : null, new: newP.stats } };
}

const results = manifest.files.map((f) => detect(f.rel, f.headContent, f.workContent));

const all = results.flatMap((r) => r.findings.map((x) => ({ ...x, file: r.rel })));
const counts = {};
for (const f of all) counts[f.rule] = (counts[f.rule] ?? 0) + 1;

const L = [];
L.push('# hybrid detector (drop=file scope, reversal=method scope) on all 27 changed test files');
L.push(`files: ${results.length}`);
L.push(`findings: ${all.length}  ${JSON.stringify(counts)}`);
L.push('');
for (const r of results) {
  if (!r.findings.length) continue;
  L.push(`\n## ${r.rel}`);
  for (const f of r.findings) {
    L.push(`  - [${f.severity}] ${f.rule}`);
    L.push(`    subject : ${f.subject}`);
    if (f.method) L.push(`    method  : ${f.method}`);
    if (f.oldAssertions?.length) L.push(`    old     : ${f.oldAssertions.map(a => `${a.pclass}(${a.expected}) @L${a.line}`).join(' | ')}`);
    if (f.newAssertions?.length) L.push(`    new     : ${f.newAssertions.map(a => `${a.pclass}(${a.expected}) @L${a.line}`).join(' | ')}`);
    if (f.lost) L.push(`    lost    : ${f.lost.join(', ')}   gained: ${(f.gained ?? []).join(', ') || '-'}`);
  }
}
writeFileSync(path.join(outDir, 'hybrid.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'hybrid.json'), JSON.stringify({ counts, results: all }, null, 2));
console.log(L.join('\n'));
