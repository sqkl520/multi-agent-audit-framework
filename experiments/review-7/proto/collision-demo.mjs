// Identity-collision demo: subjects that are NOT unique enough to carry a rule.
// The measured cases are the ones the corpus actually produces, not invented ones.
//
//   node collision-demo.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './parse-assertions.mjs';
import { detectV4 } from './v4.mjs';

const root = import.meta.dirname;
const snap = path.join(root, 'out', 'snapshot', 't0');
const outDir = path.join(root, 'out');
mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
const byRel = new Map(manifest.files.map((f) => [f.rel, f]));

const CORRUPT = 'src/test/java/com/hilltopvillage/shop/ShopConfigCorruptFileTest.java';
const src = byRel.get(CORRUPT).workContent;

/* D1: delete the whole "truncation preserves previous config" test. Its two assertThrows share
   subject keys with an earlier test, so nothing should fire. */
const D1 = (s) => {
  const start = s.indexOf('    @Test\n    @DisplayName("F1: parseable truncation at the items: header fails and preserves the last snapshot")');
  const end = s.indexOf('    @Test\n    @DisplayName("F1: explicit empty items mapping', start);
  return s.slice(0, start) + s.slice(end);
};

/* D2: change the expected exception class of one assertThrows */
const D2 = (s) => s.replace('IllegalStateException directFailure = assertThrows(IllegalStateException.class, loader::load,',
  'IllegalStateException directFailure = assertThrows(IllegalArgumentException.class, loader::load,');

/* D3: swap the executable to a no-op (still assertThrows, still same subject key shape) */
const D3 = (s) => s.replace('assertThrows(IllegalStateException.class, shop::reload,', 'assertThrows(IllegalStateException.class, () -> { },');

const cases = [
  { id: 'D1', note: 'delete an entire @Test whose assertThrows subjects also occur in another @Test', apply: D1, expect: 'rule 1 should fire, masked by duplicate subject' },
  { id: 'D2', note: 'change one assertThrows expected class IllegalStateException -> IllegalArgumentException', apply: D2, expect: 'reversed should fire on the SAME subject' },
  { id: 'D3', note: 'assertThrows(..., shop::reload) -> assertThrows(..., () -> {}) — the executable changed', apply: D3, expect: 'rule 1/2 should fire' },
];

const rows = [];
for (const c of cases) {
  const mutated = c.apply(src);
  const applied = mutated !== src;
  const findings = applied ? detectV4(src, mutated).findings : [];
  // what does the subject table look like on each side?
  const before = parseAssertions(src), after = parseAssertions(mutated);
  const throwsBefore = [...before.subjects.keys()].filter((k) => k.startsWith('throws:'));
  const throwsAfter = [...after.subjects.keys()].filter((k) => k.startsWith('throws:'));
  rows.push({ ...c, applied, findings, throwsBefore, throwsAfter });
}

const L = [];
L.push('# identity-collision demos (real files, in-memory edits)');
for (const r of rows) {
  L.push(`\n## ${r.id} — ${r.note}`);
  L.push(`applied: ${r.applied}`);
  L.push(`expectation: ${r.expect}`);
  L.push(`findings: ${r.findings.length}${r.findings.length ? ' -> ' + r.findings.map((f) => `${f.rule} ${f.subject}`).join('; ') : ''}`);
  L.push(`throws-subjects before: ${JSON.stringify(r.throwsBefore)}`);
  L.push(`throws-subjects after : ${JSON.stringify(r.throwsAfter)}`);
  if (r.findings.length) {
    const b = parseAssertions(src), a = parseAssertions(r.applied ? r.apply(src) : src);
    for (const f of r.findings) {
      L.push(`  ${f.subject}: ${JSON.stringify(b.subjects.get(f.subject)?.map((x) => x.expected))} -> ${JSON.stringify(a.subjects.get(f.subject)?.map((x) => x.expected))}`);
    }
  }
}
writeFileSync(path.join(outDir, 'collision-demo.md'), L.join('\n'));
console.log(L.join('\n'));
