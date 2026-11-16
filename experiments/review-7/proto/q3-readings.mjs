// The plan's rule text is underdetermined. "predicate_class 变档" can mean at least three things.
// This measures all three on the real change set, because the plan CLAIMS sites 1/2 hit
// "reversed" — and the strictest reading does not do that. Only the looser readings do.
//
//   R-a  strict   : some (class,expected) signature present in HEAD is absent in work
//   R-b  classSet : the SET of predicate classes for that subject changed in any way
//   R-c  widening : a strictly weaker class appeared that was not there before
//
//   node q3-readings.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './parse-assertions.mjs';

const root = import.meta.dirname;
const snap = path.join(root, 'out', 'snapshot', 't0');
const outDir = path.join(root, 'out');
mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
const files = manifest.files.filter((f) => f.rel.endsWith('.java') && f.rel.includes('src/test') && f.headContent !== null);

const RANK = { exact: 0, exact_existence: 0, interaction: 0, zero_or_empty: 1, negative: 1, non_empty: 1, existence_only: 3 };

function detectOld(oldSrc, newSrc, mode) {
  const o = parseAssertions(oldSrc), n = parseAssertions(newSrc);
  const out = [];
  for (const [subj, olds] of o.subjects) {
    const news = n.subjects.get(subj);
    if (!news) { out.push({ rule: 'dropped', subject: subj }); continue; }
    const osig = new Set(olds.map((a) => `${a.pclass}(${a.expected})`));
    const nsig = new Set(news.map((a) => `${a.pclass}(${a.expected})`));
    const oc = new Set(olds.map((a) => a.pclass)), nc = new Set(news.map((a) => a.pclass));

    if (mode === 'strict') {
      const lost = [...osig].filter((x) => !nsig.has(x));
      if (lost.length) out.push({ rule: 'reversed', subject: subj, lost });
    } else if (mode === 'classSet') {
      const changed = [...oc].sort().join() !== [...nc].sort().join();
      if (changed) out.push({ rule: 'reversed', subject: subj, oldClasses: [...oc], newClasses: [...nc] });
    } else if (mode === 'widening') {
      const omax = Math.max(...[...oc].map((c) => RANK[c] ?? 2));
      const nmax = Math.max(...[...nc].map((c) => RANK[c] ?? 2));
      if (nmax > omax) out.push({ rule: 'reversed', subject: subj, oldClasses: [...oc], newClasses: [...nc] });
    }
  }
  return out;
}

const res = {};
for (const mode of ['strict', 'classSet', 'widening']) {
  const all = files.flatMap((f) => detectOld(f.headContent, f.workContent, mode).map((x) => ({ ...x, file: f.rel })));
  res[mode] = all;
}

const CAL = [
  { file: 'TabListManagerTest.java', subject: 'field("refreshTask")', truth: 'legit' },
  { file: 'TabListManagerTest.java', subject: 'field("scheduledPeriod")', truth: 'legit' },
  { file: 'ShopConfigLoaderTest.java', subject: 'config.getItems().get(0).getPrice()', truth: 'FALSE POSITIVE if hit' },
];

const L = [];
L.push('# Q2/Q3 — three readings of "predicate_class 变档", all measured');
L.push('');
L.push('The plan claims sites 1 and 2 will each hit `assertion_reversed_reported`.');
L.push('That claim is TRUE only under the looser readings. Measured:');
L.push('');
for (const [mode, all] of Object.entries(res)) {
  L.push(`\n## reading: ${mode}  -> ${all.length} findings`);
  for (const c of CAL) {
    const hit = all.filter((f) => f.file.endsWith(c.file) && f.subject === c.subject);
    L.push(`  calibration ${c.subject} : ${hit.length ? 'HIT (' + hit.map((h) => h.rule).join(',') + ')' : 'no hit'}   [${c.truth}]`);
  }
  const extra = all.filter((f) => !CAL.some((c) => f.file.endsWith(c.file) && f.subject === c.subject));
  L.push(`  findings NOT on the calibration sites: ${extra.length}`);
  const byFile = new Map();
  for (const f of extra) { const k = f.file.split('/').pop(); byFile.set(k, (byFile.get(k) ?? 0) + 1); }
  for (const [k, v] of byFile) L.push(`    ${k}: ${v}`);
  for (const f of extra.slice(0, 25)) {
    L.push(`    - ${f.file.split('/').pop()} :: ${f.subject}  ${f.oldClasses ? f.oldClasses.join('/') + ' -> ' + f.newClasses.join('/') : JSON.stringify(f.lost)}`);
  }
}
writeFileSync(path.join(outDir, 'q3-readings.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'q3-readings.json'), JSON.stringify(res, null, 2));
console.log(L.join('\n'));
