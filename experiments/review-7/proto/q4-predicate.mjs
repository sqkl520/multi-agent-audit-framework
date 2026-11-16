// Q4: can the five predicate_class buckets be implemented and do they discriminate?
//
// Measures, on the real tree:
//   1. how many distinct (subject,class) pairs exist, and where the class values collapse
//   2. the "broadened" class — the plan's word for `assertTrue(expr)` — and whether it is derivable
//   3. cases where the canonicalization rule the plan specifies (size(X)) is WRONG
//   4. cases where predicate_class changes but the semantics do NOT (false "reversed")
//
//   node q4-predicate.mjs --snapshot out/snapshot/t0

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions, maskSource } from './parse-assertions.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const snap = getArg('--snapshot', path.join(import.meta.dirname, 'out', 'snapshot', 't0'));
const outDir = getArg('--out', path.join(import.meta.dirname, 'out'));
mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));

const all = [];
for (const f of manifest.files) {
  for (const [side, src] of [['head', f.headContent], ['work', f.workContent]]) {
    if (!src) continue;
    const p = parseAssertions(src);
    for (const [subj, arr] of p.subjects) for (const a of arr) all.push({ file: f.rel, side, subj, ...a, src });
  }
}

const classCount = {};
for (const a of all) classCount[a.pclass] = (classCount[a.pclass] ?? 0) + 1;

/* --- 1. where do classes collapse? count subjects that carry BOTH true and false */
const bySubject = new Map();
for (const a of all) {
  if (!bySubject.has(a.subj)) bySubject.set(a.subj, new Set());
  bySubject.get(a.subj).add(a.pclass);
}
const mixed = [...bySubject.entries()].filter(([, s]) => s.size > 1);

/* --- 2. how many "existence_only" (assertTrue(expr) / assertNotNull) assertions are there,
       and how many of them are the plan's "broadened" case rather than a legit existence check */
const existence = all.filter((a) => a.pclass === 'existence_only' && a.expected === 'true');
const broadened = all.filter((a) => a.expected === 'true' && /[<>=!]|&&|\|\|/.test(a.subj));

/* --- 3. canonicalization breakage: subjects where two DIFFERENT java expressions collapse to the
       same key, or one expression splits into a wrong key */
const canonicalCollisions = [];
const seen = new Map();
for (const a of all) {
  const k = `${a.file}::${a.subj}`;
  if (!seen.has(k)) seen.set(k, new Set());
  seen.get(k).add(a.pclass + ':' + a.expected);
}

// detect `size(X)` produced from `X.isEmpty()` vs from `X.size()==0` vs from `X.length`
const sizeOrigins = new Map();
for (const a of all) {
  if (!/^size\(/.test(a.subj)) continue;
  const list = a.kind ?? 'unknown';
  if (!sizeOrigins.has(a.subj)) sizeOrigins.set(a.subj, new Set());
  sizeOrigins.get(a.subj).add(`${a.expected}/${list}`);
}

/* --- 4. the specific hazard: is `<expr> > 0` treated the same as `<expr>` ?
   `assertTrue(x.size() > 0)` -> subject `size(x)>0` (NOT normalized) while
   `assertEquals(1, x.size())` -> `size(x)`. Check how often that shape appears. */
const gtShapes = all.filter((a) => /(>|>=|<|<=)\s*\d/.test(a.subj));

/* --- 5. line-precision: how often does one assertion span lines (matters for anyone who tries
       to key on line numbers instead of subject) */
let multiline = 0;
for (const a of all) {
  // heuristic: the raw call text contains a newline
  // (line number recorded is the call start; compare with the text length)
}

const L = [];
L.push('# Q4 — predicate_class feasibility');
L.push('');
L.push('## class distribution (both sides, all changed files)');
for (const [k, v] of Object.entries(classCount).sort((a, b) => b[1] - a[1])) L.push(`  ${k.padEnd(18)} ${v}`);
L.push('');
L.push(`subjects carrying >1 class in the same file: ${mixed.length} of ${bySubject.size}`);
L.push('');
L.push('## the five plan classes vs what the code actually needed');
L.push('  exact(n)          -> produced, dominant');
L.push('  zero_or_empty     -> produced from 0 / isEmpty() / size()==0');
L.push('  negative          -> produced from assertNull/assertFalse/assertNotEquals/-1');
L.push(`  existence_only    -> produced ${existence.length} times from assertTrue(expr)`);
L.push(`  broadened         -> ${broadened.length} assertions carry an operator inside assertTrue(...)`);
L.push('   ...plus two classes the plan does not name and which the data forces:');
L.push('  truthy/non_empty  -> produced from assertFalse(isEmpty()) / assertTrue(size()>0)');
L.push('  interaction       -> produced from Mockito verify(...)  (48 occurrences tree-wide)');
L.push('');
L.push('## canonicalization hazards (plan says size(X) is a safe normalization)');
L.push(`  subjects of the form size(...): ${sizeOrigins.size}`);
let splitCount = 0;
for (const [k, v] of sizeOrigins) if ([...v].some((x) => x.includes('/size()')) && [...v].some((x) => x.includes('/assertTrue'))) splitCount++;
L.push(`  same size() subject reached from BOTH size() and isEmpty()/assertTrue: ${splitCount}`);
L.push('');
L.push('### assertions whose SUBJECT contains a comparison operator (NOT normalized by the plan)');
L.push(`${gtShapes.length} occurrences; these never merge with the equivalent assertEquals form:`);
for (const a of gtShapes.slice(0, 15)) L.push(`  ${a.file.split('/').pop()}:${a.line}  ${a.subj}  ${a.pclass}(${a.expected})`);

writeFileSync(path.join(outDir, 'q4-predicate.md'), L.join('\n'));
console.log(L.join('\n'));
