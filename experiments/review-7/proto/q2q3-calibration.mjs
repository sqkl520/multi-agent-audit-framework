// Q2 + Q3: the three calibration sites, then every finding on the whole change set,
// each labelled true/false positive with the reason.
//
//   node q2q3-calibration.mjs --snapshot out/snapshot/t0

import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './parse-assertions.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const snap = getArg('--snapshot', path.join(import.meta.dirname, 'out', 'snapshot', 't0'));
const outDir = getArg('--out', path.join(import.meta.dirname, 'out'));
mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
const files = manifest.files.filter((f) => f.rel.endsWith('.java'));

/* ------------------------------------------------------- the three readings */

// R1 = plan literal: subject present anywhere in the file, same signature anywhere in the file
function detectFileScope(oldSrc, newSrc) {
  if (oldSrc === null) return [];
  const o = parseAssertions(oldSrc), n = parseAssertions(newSrc);
  const out = [];
  for (const [subj, olds] of o.subjects) {
    const news = n.subjects.get(subj);
    if (!news) { out.push({ rule: 'assertion_target_dropped', severity: 'FAIL', subject: subj, old: olds.map(f2) }); continue; }
    const osig = new Set(olds.map(f2)), nsig = new Set(news.map(f2));
    const lost = [...osig].filter((x) => !nsig.has(x));
    if (lost.length) out.push({ rule: 'assertion_reversed_unreported', severity: 'FAIL', subject: subj, old: olds.map(f2), new: news.map(f2), lost });
  }
  return out;
}

// R2 = method scope for the reversal comparison only
function detectHybrid(oldSrc, newSrc) {
  if (oldSrc === null) return [];
  const o = parseAssertions(oldSrc), n = parseAssertions(newSrc);
  const out = [];
  for (const [subj, olds] of o.subjects) {
    if (!n.subjects.has(subj)) out.push({ rule: 'assertion_target_dropped', severity: 'FAIL', subject: subj, old: olds.map(f2) });
  }
  const idx = (p) => {
    const m = new Map();
    for (const [subj, arr] of p.subjects) for (const a of arr) {
      const k = `${a.method}::${subj}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(a);
    }
    return m;
  };
  const oi = idx(o), ni = idx(n);
  for (const [k, olds] of oi) {
    const news = ni.get(k);
    if (!news) continue;
    const osig = new Set(olds.map(f2)), nsig = new Set(news.map(f2));
    const lost = [...osig].filter((x) => !nsig.has(x));
    if (lost.length) out.push({ rule: 'assertion_reversed_unreported', severity: 'FAIL', subject: k.split('::')[1], method: k.split('::')[0], old: olds.map(f2), new: news.map(f2), lost });
  }
  return out;
}
const f2 = (a) => `${a.pclass}(${a.expected})`;

const run = (fn) => files.map((f) => ({ rel: f.rel, hasOld: f.headContent !== null, findings: fn(f.headContent, f.workContent) }));

/* ----------------------------------------------------------------- Q2 sites */

const CAL = [
  {
    n: 1, file: 'src/test/java/com/hilltopvillage/mechanics/TabListManagerTest.java',
    method: 'refreshFailureIsContained', subject: 'field("refreshTask")',
    what: 'assertNull(field("refreshTask")) -> assertSame(before, field("refreshTask"))',
    truth: 'legit reversal (encoded premise was disproved by decompilation)',
    expect: 'should hit reversed',
  },
  {
    n: 2, file: 'src/test/java/com/hilltopvillage/mechanics/TabListManagerTest.java',
    method: 'refreshFailureIsContained', subject: 'field("scheduledPeriod")',
    what: 'assertEquals(-1, field("scheduledPeriod")) -> assertEquals(20, ...)',
    truth: 'legit reversal (same root cause)',
    expect: 'should hit reversed',
  },
  {
    n: 3, file: 'src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java',
    method: 'missingPriceDefaultsToOne -> missingPriceDefaultsToOneWithWarning',
    subject: 'config.getItems().get(0).getPrice()',
    what: 'method renamed, original assertEquals(1, ...getPrice()) kept verbatim, 3 added',
    truth: 'FALSE POSITIVE if flagged',
    expect: 'must NOT hit',
  },
];

const r1 = run(detectFileScope);
const r2 = run(detectHybrid);
const r2m = new Map(r2.flatMap((r) => r.findings.map((f) => [`${r.rel}::${f.subject}::${f.method ?? ''}`, f])));

const calRows = [];
for (const c of CAL) {
  const hitR1 = r1.find((r) => r.rel === c.file)?.findings.filter((f) => f.subject === c.subject) ?? [];
  const hitR2 = r2.find((r) => r.rel === c.file)?.findings.filter((f) => f.subject === c.subject && (!c.method.includes('->') ? f.method === c.method : true)) ?? [];
  calRows.push({ ...c, r1: hitR1, r2: hitR2 });
}

/* ---------------------------------------------------------------------- Q3 */

function describe(r, f) {
  // judgement, by hand, of each finding
  return f;
}

const L = [];
L.push('# Q2 / Q3 — the three calibration sites, then every finding');
L.push('');
L.push('## Q2 — the three calibration deletions');
L.push('');
for (const c of calRows) {
  L.push(`### site ${c.n}: ${c.file.split('/').pop()} / ${c.method}`);
  L.push(`  change : ${c.what}`);
  L.push(`  truth  : ${c.truth}`);
  L.push(`  expected by plan: ${c.expect}`);
  L.push(`  plan-literal (file scope) : ${c.r1.length ? c.r1.map((x) => `${x.rule} lost=${JSON.stringify(x.lost)}`).join('; ') : 'NO HIT'}`);
  L.push(`  corrected (method scope)  : ${c.r2.length ? c.r2.map((x) => `${x.rule} lost=${JSON.stringify(x.lost)} gained=${JSON.stringify(x.new)}`).join('; ') : 'NO HIT'}`);
  L.push('');
}

const total1 = r1.reduce((a, r) => a + r.findings.length, 0);
const total2 = r2.reduce((a, r) => a + r.findings.length, 0);
L.push(`## Q3 — all findings on the change set`);
L.push(`plan-literal (file scope): ${total1} findings`);
L.push(`corrected (method scope) : ${total2} findings`);
for (const [name, res] of [['plan-literal', r1], ['corrected', r2]]) {
  L.push(`\n### ${name}`);
  const withF = res.filter((r) => r.findings.length);
  if (!withF.length) L.push('  (none)');
  for (const r of withF) {
    L.push(`\n  ${r.rel.split('/').pop()}`);
    for (const f of r.findings) {
      L.push(`    [${f.severity}] ${f.rule}  ${f.subject}${f.method ? ' @' + f.method : ''}`);
      if (f.old) L.push(`        old=${JSON.stringify(f.old)}`);
      if (f.new) L.push(`        new=${JSON.stringify(f.new)}`);
      if (f.lost) L.push(`        lost=${JSON.stringify(f.lost)}`);
    }
  }
}

writeFileSync(path.join(outDir, 'q2q3.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'q2q3.json'), JSON.stringify({ calRows: calRows.map((c) => ({ ...c })), r1: r1.filter((r) => r.findings.length), r2: r2.filter((r) => r.findings.length) }, null, 2));
console.log(L.join('\n'));
