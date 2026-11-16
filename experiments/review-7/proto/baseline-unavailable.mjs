// The "new file" blind spot must be LOUD, not silent. Measure what the report looks like when the
// detector is required to emit `assertion_baseline_unavailable` per added test file (WARN), and
// count how much of the change set that covers.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './parse-assertions.mjs';

const root = import.meta.dirname;
const manifest = JSON.parse(readFileSync(path.join(root, 'out', 'snapshot', 't0', 'manifest.json'), 'utf8'));
const added = manifest.files.filter((f) => f.rel.endsWith('.java') && f.rel.includes('src/test') && f.headContent === null);

let asserts = 0, subjects = 0;
const rows = [];
for (const f of added) {
  const p = parseAssertions(f.workContent);
  asserts += p.stats.parsed;
  subjects += p.stats.distinctSubjects;
  rows.push({ rel: f.rel, asserts: p.stats.parsed, subjects: p.stats.distinctSubjects, bytes: f.workContent.length });
}
console.log(`added test files: ${added.length}`);
console.log(`assertions in them: ${asserts}`);
console.log(`distinct subjects : ${subjects}`);
console.log(`zero-assertion files: ${rows.filter((r) => r.asserts === 0).length}`);
for (const r of rows.sort((a,b)=>a.asserts-b.asserts)) {
  console.log(`  ${String(r.asserts).padStart(3)} asserts  ${r.rel.split('/').pop()}`);
}
// What fraction of the change set's assertion surface is uninspectable?
const all = manifest.files.filter((f) => f.rel.endsWith('.java') && f.rel.includes('src/test'));
let totalAsserts = 0;
for (const f of all) totalAsserts += parseAssertions(f.workContent).stats.parsed;
console.log(`\nall changed test files: ${all.length}, assertions total ${totalAsserts}`);
console.log(`uninspectable share: ${asserts}/${totalAsserts} = ${(asserts/totalAsserts*100).toFixed(1)}%`);
console.log(`files uninspectable: ${added.length}/${all.length} = ${(added.length/all.length*100).toFixed(1)}%`);
