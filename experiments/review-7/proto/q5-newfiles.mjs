// Q5: what happens to the 19 new test files (no HEAD blob)?
//   - literally: which rules can fire at all on them
//   - the consequence: can a fixer hide a weakening by putting the assertion in a NEW file?
//   - and the reverse hazard: assertions moved from an old file into a new file look "dropped"
//
//   node q5-newfiles.mjs --snapshot out/snapshot/t0

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './parse-assertions.mjs';
import { detectV4 } from './v4.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const snap = getArg('--snapshot', path.join(import.meta.dirname, 'out', 'snapshot', 't0'));
const outDir = getArg('--out', path.join(import.meta.dirname, 'out'));
mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));

const added = manifest.files.filter((f) => f.headContent === null && f.rel.endsWith('.java'));
const modified = manifest.files.filter((f) => f.headContent !== null && f.rel.endsWith('.java'));

let addedAsserts = 0, addedSubjects = 0, addedFiles = 0, addedNoAssert = [];
const addedSubjectSets = new Map();
for (const f of added) {
  addedFiles++;
  const p = parseAssertions(f.workContent);
  addedAsserts += p.stats.parsed;
  addedSubjects += p.stats.distinctSubjects;
  addedSubjectSets.set(f.rel, new Set([...p.subjects.keys()]));
  if (p.stats.parsed === 0) addedNoAssert.push(f.rel);
}

// what does the detector report on each new file? (only test_disabled can fire)
const newFileFindings = added.map((f) => ({ rel: f.rel, ...detectV4('', f.workContent) }));

/* ---- cross-file subject overlap: does any subject in a new file also exist in a modified file?
   This is the "moved to another file" case the plan treats as dropped. */
const modSubjects = new Map();
for (const f of modified) {
  const p = parseAssertions(f.workContent);
  for (const k of p.subjects.keys()) {
    if (!modSubjects.has(k)) modSubjects.set(k, new Set());
    modSubjects.get(k).add(f.rel);
  }
}
const overlap = [];
for (const [rel, subs] of addedSubjectSets) {
  for (const s of subs) if (modSubjects.has(s)) overlap.push({ rel, subj: s, alsoIn: [...modSubjects.get(s)] });
}

/* ---- the hide-move scenario: delete a strong assertion from a modified file and re-add it,
   weakened, in a new file. Rule 1 fires on the modified file (good), but can the weakeened
   version in the new file be judged? */
const HIDE = {
  fromFile: 'src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java',
  toFile: 'src/test/java/com/hilltopvillage/shop/ShopConfigPriceValidationTest.java',
};
const fromF = manifest.files.find((f) => f.rel === HIDE.fromFile);
const toF = manifest.files.find((f) => f.rel === HIDE.toFile);
const strong = 'assertEquals(1, config.getItems().get(0).getPrice(),\n                    "缺键时 price 必须取既有默认值 1");';
const weakenedFile = fromF.workContent.replace(strong, '// moved to ShopConfigPriceValidationTest\n');
const strongFile = HIDE.fromFile;
const hideFindingsA = detectV4(fromF.headContent, weakenedFile).findings;

const L = [];
L.push('# Q5 — the 19 new test files');
L.push('');
L.push(`new test files: ${addedFiles}`);
L.push(`assertions in them: ${addedAsserts}`);
L.push(`distinct subjects in them: ${addedSubjects}`);
L.push(`files with ZERO assertions: ${addedNoAssert.length}`);
for (const f of addedNoAssert) L.push(`  - ${f.split('/').pop()}`);
L.push('');
L.push('## what the detector reports on each new file (old side = empty)');
const reported = newFileFindings.filter((r) => r.findings.length);
L.push(`files with >=1 finding: ${reported.length} of ${addedFiles}`);
for (const r of newFileFindings) {
  L.push(`  ${r.rel.split('/').pop().padEnd(46)} findings=${r.findings.length}  (subjects=${parseAssertions(added.find((a) => a.rel === r.rel).workContent).stats.distinctSubjects})`);
}
L.push('');
L.push('## cross-file subject overlap (new file subject also present in a modified file)');
L.push(`pairs: ${overlap.length}`);
for (const o of overlap.slice(0, 15)) L.push(`  ${o.rel.split('/').pop()} :: ${o.subj}  also in ${o.alsoIn.map((x) => x.split('/').pop()).join(',')}`);
L.push('');
L.push('## the "move a weakened assertion into a new file" scenario');
L.push(`deleted strong assertion from ${HIDE.fromFile.split('/').pop()}:`);
L.push(`  ${strong.trim()}`);
L.push(`findings on that file: ${hideFindingsA.length}`);
for (const f of hideFindingsA) L.push(`  [${f.severity}] ${f.rule} ${f.subject}`);
L.push('  (the new file that now holds the weakened version contributes nothing: no HEAD blob)');

writeFileSync(path.join(outDir, 'q5-newfiles.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'q5-newfiles.json'), JSON.stringify({ addedFiles, addedAsserts, addedSubjects, addedNoAssert, overlap, hideFindingsA }, null, 2));
console.log(L.join('\n'));
