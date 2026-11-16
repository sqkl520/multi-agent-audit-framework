// v4: closes the structural hole found in v-hybrid. In the hybrid, rule 2 does
// `if (!news) continue` when the METHOD still exists but the subject vanished from it — which
// silently swallows "assertion removed from this method" (measured: M5, M7, M8 all MISS).
//
// v4 adds: method_exists && subject_absent_in_method && subject_present_elsewhere_in_file
//   -> `assertion_moved_out_of_method` (WARN)
// and keeps the two more severe rules. Measure how many findings that adds on REAL data.
//
//   node v4.mjs --snapshot out/snapshot/t0

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './parse-assertions.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const snap = getArg('--snapshot', path.join(import.meta.dirname, 'out', 'snapshot', 't0'));
const outDir = getArg('--out', path.join(import.meta.dirname, 'out'));
mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));

export function detectV4(oldSrc, newSrc, { reported = false } = {}) {
  const newP = parseAssertions(newSrc);
  const findings = [];
  // test_disabled: EVERY @Disabled / @Ignore disables the test, with or without a reason argument.
  // (The plan's "@Disabled(无参)" restriction is a factual error: @Disabled("reason") is equally
  // disabling in JUnit 5 — value() is an optional reason, not a condition. Verified against the
  // JUnit 5 API docs.) Assumptions.assume* stays excluded: it is a legitimate conditional skip.
  // @DisabledIf* / @EnabledOnOs are conditional and are NOT counted here (they are WARN-only in the
  // spec, matched but reported separately).
  const dis = (s) => (s ?? '').match(/@Disabled\b|@Ignore\b/g)?.length ?? 0;
  if (dis(newSrc) > dis(oldSrc)) {
    findings.push({ rule: 'test_disabled', severity: 'FAIL', subject: '@Disabled/@Ignore' });
  }
  const cond = (s) => (s ?? '').match(/@DisabledIf\w*|@EnabledIf\w*|@EnabledOnOs/g)?.length ?? 0;
  const assume = (s) => (s ?? '').match(/Assumptions\.assume\w+/g)?.length ?? 0;
  if (cond(newSrc) > cond(oldSrc)) findings.push({ rule: 'test_conditionally_disabled', severity: 'WARN', subject: '@DisabledIf/@EnabledIf/@EnabledOnOs' });
  if (assume(newSrc) > assume(oldSrc)) findings.push({ rule: 'test_assumption_added', severity: 'INFO', subject: 'Assumptions.assume*' });
  if (oldSrc === null || oldSrc === '') return { findings, hasOld: false };
  const oldP = parseAssertions(oldSrc);

  const methodBodies = (p) => p.methods; // Map<method, Set<subject>>

  // rule 1: dropped from the whole file
  for (const [subj, olds] of oldP.subjects) {
    if (!newP.subjects.has(subj)) {
      findings.push({ rule: 'assertion_target_dropped', severity: 'FAIL', subject: subj, old: olds.map(f2) });
    }
  }

  // rule 2: same method, same subject, different predicate/expected
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
  const newMethods = new Set(newP.methods.keys());
  const oldMethods = new Set(oldP.methods.keys());

  for (const [k, olds] of oi) {
    const [meth, subj] = [k.slice(0, k.indexOf('::')), k.slice(k.indexOf('::') + 2)];
    const news = ni.get(k);
    if (news) {
      const osig = new Set(olds.map(f2)), nsig = new Set(news.map(f2));
      const lost = [...osig].filter((s) => !nsig.has(s));
      if (lost.length) {
        findings.push({
          rule: reported ? 'assertion_reversed_reported' : 'assertion_reversed_unreported',
          severity: reported ? 'WARN' : 'FAIL',
          subject: subj, method: meth, old: olds.map(f2), new: news.map(f2), lost,
        });
      }
      continue;
    }
    // method still exists, subject still exists somewhere in the file, but not in this method
    if (newMethods.has(meth) && newP.subjects.has(subj)) {
      const elsewhere = (newP.subjects.get(subj) ?? []).map((a) => a.method);
      findings.push({
        rule: 'assertion_moved_out_of_method', severity: 'WARN',
        subject: subj, method: meth, old: olds.map(f2), foundIn: [...new Set(elsewhere)],
      });
    }
    // method renamed or deleted: rule 1 covers real deletion; nothing here
  }
  return { findings, hasOld: true, oldMethods, newMethods };
}
const f2 = (a) => `${a.pclass}(${a.expected})`;

const isMain = process.argv[1] && path.basename(process.argv[1]) === 'v4.mjs';
if (isMain) {
  const results = manifest.files.map((f) => ({ rel: f.rel, ...detectV4(f.headContent, f.workContent) }));
  const all = results.flatMap((r) => r.findings.map((x) => ({ ...x, file: r.rel })));
  const counts = {};
  for (const f of all) counts[f.rule] = (counts[f.rule] ?? 0) + 1;
  const L = [];
  L.push('# v4 on all 43 changed/new test files (real data)');
  L.push(`findings: ${all.length}  ${JSON.stringify(counts)}`);
  const grouped = new Map();
  for (const f of all) {
    const k = `${f.file}::${f.rule}`;
    if (!grouped.has(k)) grouped.set(k, []);
    grouped.get(k).push(f);
  }
  for (const [k, v] of grouped) {
    L.push(`\n## ${k.split('::')[0]}  [${k.split('::')[1]}] ${v.length}`);
    for (const f of v) {
      L.push(`  - ${f.subject}${f.method ? ' @' + f.method : ''}`);
      if (f.old) L.push(`      old: ${f.old.join(' | ')}`);
      if (f.new) L.push(`      new: ${f.new.join(' | ')}`);
      if (f.foundIn) L.push(`      foundIn: ${f.foundIn.join(', ')}`);
    }
  }
  writeFileSync(path.join(outDir, 'v4.md'), L.join('\n'));
  writeFileSync(path.join(outDir, 'v4.json'), JSON.stringify(all, null, 2));
  console.log(L.join('\n'));
}
