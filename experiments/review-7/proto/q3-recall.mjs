// Recall check: the Q3 answer "0 extra findings" is only trustworthy if subject-level matching is
// not silently swallowing real changes. So compare against the dumbest possible ground truth:
// a line-level diff of the assertion call texts.
//
//   node q3-recall.mjs --snapshot out/snapshot/t0

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions, maskSource } from './parse-assertions.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const snap = getArg('--snapshot', path.join(import.meta.dirname, 'out', 'snapshot', 't0'));
const outDir = getArg('--out', path.join(import.meta.dirname, 'out'));
mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
const files = manifest.files.filter((f) => f.rel.endsWith('.java') && f.headContent !== null);

// collect the full raw text of every assertion call (whitespace-normalized, literals kept)
function callTexts(src) {
  const { code, lit } = maskSource(src);
  const out = [];
  const re = /(?<![\w$])(assert[A-Z]\w*|fail|verify)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const open = code.indexOf('(', m.index + m[0].length - 1);
    let depth = 0, close = -1;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '(') depth++;
      else if (code[i] === ')') { depth--; if (!depth) { close = i; break; } }
    }
    if (close < 0) continue;
    // skip the method *definition* itself
    const after = code.slice(close + 1, close + 90).trimStart();
    if (after.startsWith('{') || /^throws\s/.test(after)) continue;
    const raw = src.slice(m.index, close + 1).replace(/\s+/g, ' ');
    out.push(raw);
  }
  return out;
}

function multisetDiff(a, b) {
  const na = new Map(), nb = new Map();
  for (const x of a) na.set(x, (na.get(x) ?? 0) + 1);
  for (const x of b) nb.set(x, (nb.get(x) ?? 0) + 1);
  const removed = [], added = [];
  for (const [k, v] of na) { const d = v - (nb.get(k) ?? 0); for (let i = 0; i < d; i++) removed.push(k); }
  for (const [k, v] of nb) { const d = v - (na.get(k) ?? 0); for (let i = 0; i < d; i++) added.push(k); }
  return { removed, added };
}

const rows = [];
for (const f of files) {
  const { removed, added } = multisetDiff(callTexts(f.headContent), callTexts(f.workContent));
  if (!removed.length && !added.length) continue;
  rows.push({ rel: f.rel, removed, added });
}

const L = [];
L.push('# Q3 recall check — line-level ground truth vs subject-level findings');
L.push('');
L.push(`files with ANY textual assertion change: ${rows.length}`);
for (const r of rows) {
  L.push(`\n## ${r.rel.split('/').pop()}  removed=${r.removed.length} added=${r.added.length}`);
  for (const x of r.removed) L.push(`  - ${x.slice(0, 150)}`);
  for (const x of r.added) L.push(`  + ${x.slice(0, 150)}`);
}
const totalRemoved = rows.reduce((a, r) => a + r.removed.length, 0);
const totalAdded = rows.reduce((a, r) => a + r.added.length, 0);
L.push(`\ntotal: removed ${totalRemoved} / added ${totalAdded}`);

// Now: of the removed call texts, how many have a subject that simply vanished (rule 1 should fire)
// vs a subject that survives (rule 2 / silent)?
const classes = { subjectGone: [], subjectAlive: [] };
for (const f of files) {
  const o = parseAssertions(f.headContent), n = parseAssertions(f.workContent);
  for (const subj of o.subjects.keys()) if (!n.subjects.has(subj)) classes.subjectGone.push({ rel: f.rel, subj });
}
L.push(`\nsubjects present in HEAD and absent in work (rule 1 candidates): ${classes.subjectGone.length}`);
for (const c of classes.subjectGone) L.push(`  ${c.rel.split('/').pop()} :: ${c.subj}`);

writeFileSync(path.join(outDir, 'q3-recall.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'q3-recall.json'), JSON.stringify({ rows, subjectGone: classes.subjectGone }, null, 2));
console.log(L.join('\n'));
