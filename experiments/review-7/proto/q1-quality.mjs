// Cross-check the calibration baseline (3 deleted / 58 added assert lines) and measure
// how much of the parse is *semantically* right, not just "a subject was produced".
//
//   node q1-quality.mjs --snapshot out/snapshot/t0

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseAssertions, maskSource } from './parse-assertions.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const snap = getArg('--snapshot', path.join(import.meta.dirname, 'out', 'snapshot', 't0'));
const repo = getArg('--repo', '<TARGET_REPO>');
const outDir = getArg('--out', path.join(import.meta.dirname, 'out'));
mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
const testFiles = manifest.files.filter((f) => f.rel.endsWith('.java'));

/* ------------------------------------------------ 1. baseline cross-check */

// Recompute the ground-truth metric straight from `git diff` on the frozen snapshot.
const changedHead = testFiles.filter((f) => f.headContent !== null);
let del = 0, add = 0;
const delLines = [], addLines = [];
for (const f of changedHead) {
  const d = execFileSync('git', ['-C', repo, 'diff', '-U0', '--', f.rel], { encoding: 'utf8' });
  for (const line of d.split('\n')) {
    if (line.startsWith('-') && !line.startsWith('---') && /^\-\s*(assert|fail|verify)/.test(line)) { del++; delLines.push({ file: f.rel, line: line.slice(1) }); }
    if (line.startsWith('+') && !line.startsWith('+++') && /^\+\s*(assert|fail|verify)/.test(line)) { add++; addLines.push({ file: f.rel, line: line.slice(1) }); }
  }
}

/* ------------------------------------------- 2. parse quality on both sides */

const rejectedSamples = [];
const bucketCount = {};
const allParsed = [];
let stat = { phys: 0, calls: 0, parsed: 0, unparsable: 0, containers: 0, sides: 0 };

function classifyShape(subj) {
  if (/^size\(.*\)$/.test(subj)) return 'sizeForm';
  if (subj.startsWith('throws:')) return 'throws';
  if (subj.startsWith('nothrow:')) return 'nothrow';
  if (/^verify\(/.test(subj)) return 'mockitoVerify';
  if (/^[A-Za-z_$][\w$]*$/.test(subj)) return 'bareIdentifier';
  if (subj.includes('"')) return 'literalCoupled';
  if (/^[\w$.]+(\(\))?(\.[\w$]+(\([^()]*\))?)*$/.test(subj)) return 'dottedPath';
  return 'compositeExpr';
}

for (const f of testFiles) {
  for (const [side, src] of [['old', f.headContent], ['new', f.workContent]]) {
    if (src === null) continue;
    stat.sides++;
    const p = parseAssertions(src);
    stat.phys += p.stats.physicalAssertLines;
    stat.calls += p.stats.callSites;
    stat.parsed += p.stats.parsed;
    stat.unparsable += p.stats.unparsable;
    stat.containers += p.stats.containers;
    for (const [subj, arr] of p.subjects) {
      for (const a of arr) {
        const b = classifyShape(subj);
        bucketCount[b] = (bucketCount[b] ?? 0) + 1;
        allParsed.push({ file: f.rel, side, subj, ...a });
      }
    }
    for (const u of p.unparsable) rejectedSamples.push({ file: f.rel, side, ...u });
  }
}

/* --------------------------- 3. subject collisions: how often is a subject ambiguous */

// Distinct expected signatures per (file, subject). >1 means "same subject pinned to several
// different values", which is where file-level matching loses resolution.
const byFileSubject = new Map();
for (const a of allParsed) {
  const k = `${a.file}::${a.side}::${a.subj}`;
  if (!byFileSubject.has(k)) byFileSubject.set(k, new Set());
  byFileSubject.get(k).add(`${a.pclass}(${a.expected})`);
}
const collisions = [...byFileSubject.entries()].filter(([, v]) => v.size > 1);
const collisionSubjects = [...new Set(collisions.map(([k]) => k.split('::')[2]))];

/* ------------------------------------- 4. bare-identifier / literal coupling risk */

const generic = new Map();
for (const a of allParsed) {
  if (/^[A-Za-z_$][\w$]*$/.test(a.subj)) generic.set(a.subj, (generic.get(a.subj) ?? 0) + 1);
}

const L = [];
L.push('# Q1 — parse quality + baseline cross-check');
L.push('');
L.push('## baseline cross-check (git diff -U0 on the frozen snapshot)');
L.push(`deleted assert lines: ${del}`);
for (const d of delLines) L.push(`  ${d.file.split('/').pop()}: ${d.line.trim().slice(0, 100)}`);
L.push(`added assert lines  : ${add}`);
L.push('');
L.push('## parse census over the 27 changed files, both sides');
L.push(`file-sides parsed          : ${stat.sides}`);
L.push(`physical assert lines      : ${stat.phys}`);
L.push(`assert call sites          : ${stat.calls}`);
L.push(`subjects produced          : ${stat.parsed}`);
L.push(`rejected (unparsable)      : ${stat.unparsable}  (${((stat.unparsable / stat.calls) * 100).toFixed(2)}% of call sites)`);
L.push(`assertAll containers       : ${stat.containers} (recursed into, not counted)`);
L.push('');
L.push('### subject shapes');
for (const [k, v] of Object.entries(bucketCount).sort((a, b) => b[1] - a[1])) {
  L.push(`  ${k.padEnd(16)} ${v}  ${((v / stat.parsed) * 100).toFixed(1)}%`);
}
L.push('');
L.push('### rejected (unparsable) forms, grouped');
const reasons = new Map();
for (const r of rejectedSamples) {
  const key = `${r.fn}: ${r.reason}`;
  reasons.set(key, (reasons.get(key) ?? 0) + 1);
}
for (const [k, v] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) L.push(`  ${v}x  ${k}`);
L.push('');
L.push('### representative rejected samples');
for (const r of rejectedSamples.slice(0, 14)) L.push(`  ${r.file.split('/').pop()}:${r.line}  ${r.text.slice(0, 100)}`);
L.push('');
L.push('## subject collisions (same file+subject pinned to >1 value)');
L.push(`file-subject pairs with >1 signature: ${collisions.length}`);
L.push(`distinct colliding subjects         : ${collisionSubjects.length}`);
for (const [k, v] of collisions.slice(0, 20)) {
  L.push(`  ${k.split('::')[0].split('/').pop()} :: ${k.split('::')[2]}`);
  L.push(`      ${[...v].join('  ')}`);
}
L.push('');
L.push('### top bare-identifier subjects (generic names => cross-method collisions)');
for (const [k, v] of [...generic.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) L.push(`  ${k}: ${v}`);

writeFileSync(path.join(outDir, 'q1-quality.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'q1-parsed.json'), JSON.stringify({ bucketCount, collisions: collisions.map(([k, v]) => ({ k, v: [...v] })), rejectedSamples }, null, 2));
console.log(L.join('\n'));
