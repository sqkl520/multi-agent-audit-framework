// Does a cheap fix raise recall? Rule 1 at "method still exists, subject vanished from it" scope is
// currently WARN-only (assertion_moved_out_of_method) and only fires when the subject survives
// ELSEWHERE in the file. When a test method owns a unique subject, deleting that method already
// hits rule 1 (FAIL) — measured 56%. The gap is methods whose subjects are shared.
//
// This variant tests: does a MULTISET count per (method,subject) catch more, and what does it cost
// in false positives on the real change set?
//
//   node v5-multiset.mjs

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions, maskSource } from './parse-assertions.mjs';
import { detectV4 } from './v4.mjs';

const root = import.meta.dirname;
const snap = path.join(root, 'out', 'snapshot', 't0');
const outDir = path.join(root, 'out');
mkdirSync(outDir, { recursive: true });
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
const files = manifest.files.filter((f) => f.rel.endsWith('.java') && f.rel.includes('src/test') && f.headContent !== null);

function detectV5(oldSrc, newSrc) {
  const findings = detectV4(oldSrc, newSrc).findings.slice();
  const o = parseAssertions(oldSrc), n = parseAssertions(newSrc);
  const nm = new Set(n.methods.keys());

  // per (method, subject) count of assertions and of distinct signatures
  const idx = (p) => {
    const m = new Map();
    for (const [subj, arr] of p.subjects) {
      for (const a of arr) {
        const k = `${a.method}::${subj}`;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(a);
      }
    }
    return m;
  };
  const oi = idx(o), ni = idx(n);
  for (const [k, olds] of oi) {
    const meth = k.slice(0, k.indexOf('::'));
    if (!nm.has(meth)) continue; // method deleted -> rule 1 handles it
    const news = ni.get(k) ?? [];
    if (news.length >= olds.length) continue;
    if (!n.subjects.has(k.slice(k.indexOf('::') + 2))) continue; // rule 1 already fired
    findings.push({
      rule: 'assertion_count_reduced', severity: 'WARN',
      subject: k.slice(k.indexOf('::') + 2), method: meth,
      counts: `${olds.length} -> ${news.length}`,
    });
  }
  return findings;
}

const real = files.map((f) => ({ rel: f.rel, findings: detectV5(f.headContent, f.workContent) }))
  .filter((r) => r.findings.length);

/* leave-one-out recall with V5 */
function testMethods(src) {
  const { code } = maskSource(src);
  const out = [];
  const re = /@(?:Test|ParameterizedTest)\b/g;
  let m;
  while ((m = re.exec(code))) {
    const i = m.index;
    let found = null;
    for (let k = i; k < Math.min(code.length, i + 800); k++) {
      if (code[k] !== '{') continue;
      let p = k - 1;
      while (p > i && /\s/.test(code[p])) p--;
      if (code[p] !== ')') continue;
      let depth = 0, q = p;
      for (; q > i; q--) { if (code[q] === ')') depth++; else if (code[q] === '(') { depth--; if (!depth) break; } }
      if (q <= i) continue;
      let r = q - 1;
      while (r > i && /\s/.test(code[r])) r--;
      const nameEnd = r;
      while (r > i && /[\w$]/.test(code[r])) r--;
      const nm = code.slice(r + 1, nameEnd + 1);
      if (/^[A-Za-z_$][\w$]*$/.test(nm) && !['if', 'for', 'while', 'switch', 'catch', 'try'].includes(nm)) { found = { brace: k, name: nm }; break; }
    }
    if (!found) continue;
    let dd = 0, close = -1;
    for (let k = found.brace; k < code.length; k++) { if (code[k] === '{') dd++; else if (code[k] === '}') { dd--; if (!dd) { close = k; break; } } }
    if (close > 0) out.push({ name: found.name, start: i, end: close + 1 });
    re.lastIndex = close > 0 ? close : i + 5;
  }
  return out;
}

const rows = [];
let total = 0, caughtV4 = 0, caughtV5 = 0;
for (const f of files) {
  const src = f.workContent;
  for (const meth of testMethods(src)) {
    const mutated = src.slice(0, meth.start) + src.slice(meth.end);
    if (mutated === src) continue;
    total++;
    const a = detectV4(f.headContent, mutated).findings.length > 0;
    const b = detectV5(f.headContent, mutated).length > 0;
    if (a) caughtV4++;
    if (b) caughtV5++;
    rows.push({ file: f.rel.split('/').pop(), method: meth.name, v4: a, v5: b });
  }
}

const L = [];
L.push('# v5 (multiset) — does counting assertions per method raise recall?');
L.push('');
L.push(`real change set, findings: V4=${files.reduce((a, f) => a + detectV4(f.headContent, f.workContent).findings.length, 0)}, V5=${files.reduce((a, f) => a + detectV5(f.headContent, f.workContent).length, 0)}`);
for (const r of real) {
  L.push(`\n  ${r.rel.split('/').pop()}`);
  for (const f of r.findings) L.push(`    [${f.severity}] ${f.rule} ${f.subject}${f.method ? ' @' + f.method : ''} ${f.counts ?? ''}`);
}
L.push('');
L.push(`\nleave-one-method-out: ${total} methods`);
L.push(`  V4 caught: ${caughtV4} (${(caughtV4 / total * 100).toFixed(1)}%)`);
L.push(`  V5 caught: ${caughtV5} (${(caughtV5 / total * 100).toFixed(1)}%)`);
const gained = rows.filter((r) => r.v5 && !r.v4);
L.push(`  additionally caught by V5: ${gained.length}`);
for (const g of gained.slice(0, 20)) L.push(`    + ${g.file} :: ${g.method}`);
writeFileSync(path.join(outDir, 'v5-multiset.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'v5-multiset.json'), JSON.stringify({ total, caughtV4, caughtV5, real, rows }, null, 2));
console.log(L.join('\n'));
