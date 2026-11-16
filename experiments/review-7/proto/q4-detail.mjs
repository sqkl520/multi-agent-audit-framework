// Q4 detail: which predicate_class is hardest, with real examples from the corpus.
//   node q4-detail.mjs

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './parse-assertions.mjs';

const root = import.meta.dirname;
const treeRoot = path.join(root, 'out', 'fulltree');
const outDir = path.join(root, 'out');
const snap = path.join(root, 'out', 'snapshot', 't0');
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (e.name.endsWith('.java')) out.push(p);
  }
  return out;
}

const items = [];
for (const f of walk(path.join(treeRoot, 'src_test'))) {
  const rel = path.relative(treeRoot, f).split(path.sep).join('/');
  const p = parseAssertions(readFileSync(f, 'utf8'));
  for (const [subj, arr] of p.subjects) for (const a of arr) items.push({ rel, subj, ...a });
}

const by = (pred) => items.filter(pred);

/* 1. every class, with a representative assertion */
const samples = {};
for (const it of items) {
  if (!samples[it.pclass]) samples[it.pclass] = [];
  if (samples[it.pclass].length < 4) samples[it.pclass].push(it);
}

/* 2. existence_only: the class that swallows arbitrary predicates.
      Show how many distinct Java expressions collapse into it, and how varied they are. */
const eo = by((x) => x.pclass === 'existence_only');
const eoShapes = new Map();
for (const x of eo) {
  const shape = x.subj.includes('>') || x.subj.includes('<') ? 'comparison'
    : x.subj.includes('&&') || x.subj.includes('||') ? 'boolean-combinator'
      : x.subj.endsWith('()') ? 'method-call'
        : x.subj.includes('"') ? 'literal-laden'
          : /^[A-Za-z_$][\w$]*$/.test(x.subj) ? 'bare-identifier'
            : 'other';
  eoShapes.set(shape, (eoShapes.get(shape) ?? 0) + 1);
}

/* 3. the flat-out hazard: predicate_class is computed from the TEXT of an expression.
      When the expression's text changes but the semantics do not (or vice versa), the class is
      meaningless. Find assertions whose subject is a bare identifier — for those the class says
      nothing about WHAT is being checked. */
const bare = by((x) => /^[A-Za-z_$][\w$]*$/.test(x.subj));
const bareGeneric = new Map();
for (const x of bare) bareGeneric.set(x.subj, (bareGeneric.get(x.subj) ?? 0) + 1);

/* 4. class changed but no weakening: compare across the two sides of the change set for subjects
      whose class differs between HEAD and work while the expected value set is unchanged */
const classFlips = [];
for (const f of manifest.files.filter((x) => x.rel.endsWith('.java') && x.headContent)) {
  const o = parseAssertions(f.headContent), n = parseAssertions(f.workContent);
  for (const [subj, ov] of o.subjects) {
    const nv = n.subjects.get(subj);
    if (!nv) continue;
    const oc = new Set(ov.map((a) => a.pclass)), nc = new Set(nv.map((a) => a.pclass));
    if ([...oc].sort().join() !== [...nc].sort().join()) {
      classFlips.push({ rel: f.rel, subj, old: [...oc], new: [...nc], oldExp: ov.map((a) => a.expected), newExp: nv.map((a) => a.expected) });
    }
  }
}

/* 5. the trap in "assertEquals(-1, ...) is negative": -1 is only "negative" when the field is an
      index/period sentinel. Count how often the literal -1 appears as an expected value and what
      the subject is. */
const minusOne = by((x) => /^-1\b/.test(x.expected));

const L = [];
L.push('# Q4 — predicate_class, measured');
L.push('');
L.push('## class distribution and a sample of each');
const dist = {};
for (const it of items) dist[it.pclass] = (dist[it.pclass] ?? 0) + 1;
for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
  L.push(`\n### ${k}  (${v} assertions, ${(v / items.length * 100).toFixed(1)}%)`);
  for (const s of samples[k] ?? []) L.push(`  ${s.rel.split('/').pop()}:${s.line}  ${s.subj}  -> ${s.pclass}(${s.expected})`);
}
L.push('');
L.push('## hardest class: existence_only');
L.push(`total: ${eo.length} (${(eo.length / items.length * 100).toFixed(1)}% of all assertions)`);
L.push('shapes that all collapse into it:');
for (const [k, v] of [...eoShapes.entries()].sort((a, b) => b[1] - a[1])) L.push(`  ${k.padEnd(20)} ${v}`);
L.push('');
L.push('representative expressions it swallows:');
for (const x of eo.filter((y) => y.subj.includes('>') || y.subj.includes('&&')).slice(0, 10)) L.push(`  ${x.subj}`);
L.push('');
L.push('## class flips across HEAD->work (class changed, value set otherwise stable)');
L.push(`count: ${classFlips.length}`);
for (const c of classFlips) L.push(`  ${c.rel.split('/').pop()} :: ${c.subj}  ${c.old.join('/')} -> ${c.new.join('/')}  (${c.oldExp.join(',')} -> ${c.newExp.join(',')})`);
L.push('');
L.push('## "-1 as negative" — how many assertions depend on that reading');
L.push(`count: ${minusOne.length}`);
for (const x of minusOne.slice(0, 12)) L.push(`  ${x.rel.split('/').pop()}:${x.line}  ${x.subj} = -1`);

writeFileSync(path.join(outDir, 'q4-detail.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'q4-detail.json'), JSON.stringify({ dist, eoShapes: [...eoShapes], classFlips, minusOneCount: minusOne.length, samples }, null, 2));
console.log(L.join('\n'));
