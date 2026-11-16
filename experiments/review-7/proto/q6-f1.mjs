// Q6: can this algorithm catch "only test the easiest-to-pass form" (finding F1)?
//
// The gate compares assertion SUBJECTS across two versions of a FILE. F1 is not a delta at all: it
// is "the test that exists pins less than the javadoc claims". So the question is whether any
// addition-shaped evidence can trip it.
//
// Controls, so the answer is not just "the gate found nothing":
//   E1  add a weak test to a NEW file (no baseline)                         -> expect no report
//   E2  same, with an "exhaustive" claim in the name                        -> expect no report
//   E3  DELETE the strong test, add a weak one, in a NEW file               -> expect no report
//   E4  same weakening in a file with a HEAD baseline, method unchanged     -> expect report
//   E5  same weakening in a file with a HEAD baseline, method RENAMED       -> ? (rename blind spot)
//   E6  the real F1 file: does anything in ShopConfigCorruptFileTest look like a regression against
//       the OTHER new tests in the same commit? (i.e. is there any intra-commit signal at all)
//
//   node q6-f1.mjs --snapshot out/snapshot/t0

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { detectV4 } from './v4.mjs';
import { parseAssertions } from './parse-assertions.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const snap = getArg('--snapshot', path.join(import.meta.dirname, 'out', 'snapshot', 't0'));
const outDir = getArg('--out', path.join(import.meta.dirname, 'out'));
mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
const byRel = new Map(manifest.files.map((f) => [f.rel, f]));

const CORRUPT = 'src/test/java/com/hilltopvillage/shop/ShopConfigCorruptFileTest.java';
const LOADER = 'src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java';
const PRICE = 'assertEquals(1, config.getItems().get(0).getPrice(),\n                    "缺键时 price 必须取既有默认值 1");';
const WEAK = '// weakened to a mere existence check\n            assertNotNull(config.getItems().get(0), "item exists");';

const E = [
  {
    id: 'E1', file: CORRUPT, baseline: 'none',
    what: 'append a test that only pins the already-passing single truncation point',
    apply: (s) => s.replace(/\}\s*$/, `
    @Test
    @DisplayName("F1: truncation at the items header is caught (regression)")
    void truncationIsCaught() throws IOException {
        TestPaths.write(shopFile, TRUNCATED_AT_ITEMS);
        assertThrows(IllegalStateException.class, loader::load,
                "Truncation at the items header must not load as an empty shop");
    }
}
`),
  },
  {
    id: 'E2', file: CORRUPT, baseline: 'none',
    what: 'same single-variant test but the name claims exhaustive coverage',
    apply: (s) => s.replace(/\}\s*$/, `
    @Test
    @DisplayName("F1: ALL truncation points are rejected (exhaustive)")
    void everyTruncationPointIsRejected() throws IOException {
        TestPaths.write(shopFile, TRUNCATED_AT_ITEMS);
        assertThrows(IllegalStateException.class, loader::load,
                "Any truncation of shop.yml must fail loudly; this single fixture proves it");
    }
}
`),
  },
  {
    id: 'E3', file: CORRUPT, baseline: 'none',
    what: 'delete the multi-assertion truncation test, put a one-line weak one in its place',
    apply: (s) => {
      const start = s.indexOf('    @Test\n    @DisplayName("F1: parseable truncation at the items: header fails and preserves the last snapshot")');
      const end = s.indexOf('    @Test\n    @DisplayName("F1: explicit empty items mapping', start);
      return s.slice(0, start) + `    @Test
    @DisplayName("F1: truncation is handled")
    void truncationIsHandled() throws IOException {
        TestPaths.write(shopFile, TRUNCATED_AT_ITEMS);
        assertThrows(IllegalStateException.class, loader::load, "must fail");
    }

` + s.slice(end);
    },
  },
  {
    id: 'E4', file: LOADER, baseline: 'head',
    what: 'replace assertEquals(1, price) with assertNotNull(item) — method name unchanged',
    apply: (s) => s
      .replace('void missingPriceDefaultsToOneWithWarning() throws IOException {', 'void missingPriceDefaultsToOne() throws IOException {')
      .replace(PRICE, WEAK),
  },
  {
    id: 'E5', file: LOADER, baseline: 'head',
    what: 'same weakening but the fixer also renamed the method (the real calibration shape)',
    apply: (s) => s.replace(PRICE, WEAK),
  },
  {
    id: 'E6', file: LOADER, baseline: 'round2',
    what: 'same weakening measured against the CURRENT work tree (stable method name)',
    apply: (s) => s.replace(PRICE, WEAK),
  },
];

const rows = [];
for (const e of E) {
  const f = byRel.get(e.file);
  const base = f.workContent;
  const mutated = e.apply(base);
  if (mutated === base) { rows.push({ ...e, error: 'injection did not apply' }); continue; }
  // baseline 'none' is a real state, not an error: a NEW file has no HEAD blob, so rule 1 and rule 2
  // have nothing to compare against. Model it as an empty old side rather than skipping the case.
  const baseSrc = e.baseline === 'none' ? '' : e.baseline === 'head' ? f.headContent : f.workContent;
  if (baseSrc === null) { rows.push({ ...e, error: 'no baseline' }); continue; }
  const { findings } = detectV4(baseSrc, mutated);
  const pb = parseAssertions(base), pa = parseAssertions(mutated);
  rows.push({
    ...e, findings, reported: findings.length > 0,
    stats: {
      assertions: `${pb.stats.parsed} -> ${pa.stats.parsed}`,
      distinctSubjects: `${pb.stats.distinctSubjects} -> ${pa.stats.distinctSubjects}`,
    },
  });
}

/* E7: is there ANY assertion in the 20 new test files that pins the general property F1 needs?
   Count: for each new file, how many assertions are inside a loop / parameterized source. */
const loopPinned = [];
for (const f of manifest.files) {
  if (f.headContent !== null || f.workContent === null) continue;
  const src = f.workContent;
  const hasLoop = /for\s*\(/.test(src);
  const loopAsserts = [...src.matchAll(/for\s*\([^)]*\)\s*\{[\s\S]{0,600}?(assert\w+\s*\()/g)].length;
  const csv = /@CsvSource|@MethodSource|@ParameterizedTest/.test(src);
  loopPinned.push({ file: f.rel, hasLoop, loopAsserts, parameterized: csv });
}

const L = [];
L.push('# Q6 — can the gate catch "only the easiest form passes"?');
L.push('');
L.push('| exp | what | baseline | reported | assertions | distinct subjects |');
L.push('|---|---|---|---|---|---|');
for (const r of rows) {
  L.push(`| ${r.id} | ${r.what} | ${r.baseline} | ${r.error ? 'ERROR ' + r.error : r.reported} | ${r.stats?.assertions ?? '-'} | ${r.stats?.distinctSubjects ?? '-'} |`);
}
L.push('');
for (const r of rows) {
  L.push(`\n## ${r.id} — ${r.what}`);
  L.push(`file: ${r.file.split('/').pop()}   baseline: ${r.baseline}`);
  if (r.error) { L.push(`ERROR: ${r.error}`); continue; }
  if (!r.findings.length) L.push('  NO FINDINGS');
  for (const f of r.findings) L.push(`  [${f.severity}] ${f.rule}  ${f.subject}${f.method ? ' @' + f.method : ''}${f.lost ? '  ' + JSON.stringify(f.lost) + ' -> ' + JSON.stringify(f.new) : ''}`);
}
L.push('\n## E7 — do the 20 new test files pin anything with a loop / parameterized source?');
const withLoop = loopPinned.filter((x) => x.hasLoop);
const withParam = loopPinned.filter((x) => x.parameterized);
L.push(`new files: ${loopPinned.length}; contain a for-loop: ${withLoop.length}; parameterized: ${withParam.length}`);
for (const x of withLoop) L.push(`  loop: ${x.file.split('/').pop()}  asserts-in-loop≈${x.loopAsserts}`);
for (const x of withParam) L.push(`  param: ${x.file.split('/').pop()}`);

writeFileSync(path.join(outDir, 'q6-f1.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'q6-f1.json'), JSON.stringify({ rows, loopPinned }, null, 2));
console.log(L.join('\n'));
