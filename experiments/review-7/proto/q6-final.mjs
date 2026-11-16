// Q6 final: the F1 shape, stated as precisely as the gate would ever see it.
// F1 = "the fixer added a test that only pins the ONE form that already passes, and the javadoc
// claims the general property". Measure whether ANY rule can see it.
//
//   node q6-final.mjs

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
const base = byRel.get(CORRUPT).workContent;

// The actual F1 story: the fix covers truncation-at-items-header. There are ~192 other truncation
// points (finding-F1.md). A test that pins only the one covered point, and whose name/javadoc
// claims the general property, is exactly what F1 was.
const F1_TEST = `
    @Test
    @DisplayName("F1: every truncation of shop.yml is rejected (exhaustive over all 192 cut points)")
    void allTruncationPointsAreRejected() throws IOException {
        // only the items-header cut is exercised; asserting the general name from one sample is F1
        TestPaths.write(shopFile, TRUNCATED_AT_ITEMS);
        assertThrows(IllegalStateException.class, loader::load,
                "any truncation must fail; this single fixture is the proof");
    }
`;

const cases = [
  {
    id: 'Q6-a',
    what: 'append the F1 test to an existing NEW file (no HEAD blob)',
    apply: (s) => s.replace(/\}\s*$/, F1_TEST + '}\n'),
    baseline: '',
  },
  {
    id: 'Q6-b',
    what: 'append the F1 test AND delete nothing (control: is a pure +addition ever visible?)',
    apply: (s) => s.replace(/\}\s*$/, F1_TEST + '}\n'),
    baseline: null, // use HEAD (null -> no baseline because file is new)
  },
  {
    id: 'Q6-c',
    what: 'the same F1 text appended to a file that DOES have a HEAD blob (ConfigManagerTest)',
    file: 'src/test/java/com/hilltopvillage/config/ConfigManagerTest.java',
    apply: (s) => s.replace(/\}\s*$/, `
    @Test
    @DisplayName("config: every unknown key is rejected (exhaustive)")
    void allUnknownKeysAreRejected() {
        assertFalse(config.hasUnsavedChanges(), "only one key shape is exercised here");
    }
}
`),
    baseline: 'head',
  },
];

const rows = [];
for (const c of cases) {
  const file = c.file ?? CORRUPT;
  const f = byRel.get(file);
  const before = f.workContent;
  const mutated = c.apply(before);
  if (mutated === before) { rows.push({ ...c, file, error: 'not applied' }); continue; }
  const baseSrc = c.baseline === 'head' ? f.headContent : c.baseline === '' ? '' : f.headContent;
  const { findings } = detectV4(baseSrc, mutated);
  const pb = parseAssertions(before), pa = parseAssertions(mutated);
  rows.push({
    ...c, file,
    findings, reported: findings.length > 0,
    assertions: `${pb.stats.parsed} -> ${pa.stats.parsed}`,
    subjects: `${pb.stats.distinctSubjects} -> ${pa.stats.distinctSubjects}`,
  });
}

/* Also: is there ANY signal in the repo that the fix covers 1 of 192 truncation points?
   Count how many distinct truncation points any test exercises. */
let cutPoints = 0;
for (const f of manifest.files) {
  if (!f.workContent) continue;
  const n = (f.workContent.match(/substring\(0,\s*(?:cut|i|len|idx)/g) ?? []).length;
  cutPoints += n;
}
const truncatedFixture = (base.match(/TRUNCATED_AT_ITEMS/g) ?? []).length;

const L = [];
L.push('# Q6 — final: can anything catch F1 ("only the easiest form passes")?');
L.push('');
for (const r of rows) {
  L.push(`\n## ${r.id} — ${r.what}`);
  L.push(`file: ${r.file.split('/').pop()}   assertions ${r.assertions ?? '-'}   subjects ${r.subjects ?? '-'}`);
  if (r.error) { L.push(`ERROR ${r.error}`); continue; }
  L.push(`reported: ${r.reported}`);
  for (const f of r.findings) L.push(`  [${f.severity}] ${f.rule} ${f.subject}`);
  if (!r.findings.length) L.push('  NO FINDINGS');
}
L.push('');
L.push('## corpus evidence for the F1 property itself');
L.push(`tests that iterate over cut points (substring(0, cut/i/len/idx)): ${cutPoints}`);
L.push(`references to the single TRUNCATED_AT_ITEMS fixture in ShopConfigCorruptFileTest: ${truncatedFixture}`);
L.push('The gate has no access to "how many truncation points exist", so it cannot compare 1 against 192.');

writeFileSync(path.join(outDir, 'q6-final.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'q6-final.json'), JSON.stringify({ rows, cutPoints, truncatedFixture }, null, 2));
console.log(L.join('\n'));
