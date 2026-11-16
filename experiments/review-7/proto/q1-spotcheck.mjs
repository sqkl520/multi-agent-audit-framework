// Precision spot-check: print the raw call text next to what the parser extracted, for a
// deterministic sample, so the numbers can be audited by eye.
//   node q1-spotcheck.mjs

import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions, maskSource } from './parse-assertions.mjs';

const root = import.meta.dirname;
const treeRoot = path.join(root, 'out', 'fulltree');
const outDir = path.join(root, 'out');
mkdirSync(outDir, { recursive: true });
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (e.name.endsWith('.java')) out.push(p);
  }
  return out;
}

function rawCalls(src) {
  const { code } = maskSource(src);
  const out = [];
  const re = /(?<![\w$])(assert[A-Z]\w*|fail|verify)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const open = code.indexOf('(', m.index + m[0].length - 1);
    let d = 0, close = -1;
    for (let i = open; i < code.length; i++) { if (code[i] === '(') d++; else if (code[i] === ')') { d--; if (!d) { close = i; break; } } }
    if (close < 0) continue;
    const after = code.slice(close + 1, close + 90).trimStart();
    if (after.startsWith('{') || /^throws\s/.test(after)) continue;
    out.push({ start: m.index, raw: src.slice(m.index, close + 1).replace(/\s+/g, ' ') });
  }
  return out;
}

const files = walk(path.join(treeRoot, 'src_test')).sort();
const rows = [];
// deterministic stride sample across the whole corpus
const step = Math.max(1, Math.floor(files.length / 12));
for (let i = 0; i < files.length; i += step) {
  const f = files[i];
  const rel = path.relative(treeRoot, f).split(path.sep).join('/');
  const src = readFileSync(f, 'utf8');
  const p = parseAssertions(src);
  const all = [];
  for (const [subj, arr] of p.subjects) for (const a of arr) all.push({ subj, ...a });
  all.sort((a, b) => a.line - b.line);
  rows.push({ rel, sample: all.slice(0, 10) });
}

const L = [];
L.push('# parser spot-check (audit these by eye)');
for (const r of rows) {
  L.push(`\n## ${r.rel.split('/').pop()}`);
  for (const a of r.sample) {
    L.push(`  L${a.line}  kind=${a.kind ?? '?'}  subject=${JSON.stringify(a.subj)}  -> ${a.pclass}(${a.expected})`);
  }
}
writeFileSync(path.join(outDir, 'q1-spotcheck.md'), L.join('\n'));
console.log(L.join('\n'));
