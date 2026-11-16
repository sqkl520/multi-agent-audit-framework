// Leave-one-method-out sensitivity: the single most common weakening action is "delete the test
// that would fail". Measure, for every @Test method in every changed test file, whether the gate
// notices its removal. This is the real recall number.
//
//   node q3-leave-one-out.mjs

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

/** find top-level @Test methods: annotations followed by a method decl */
function testMethods(src) {
  const { code } = maskSource(src);
  const out = [];
  const re = /@(?:Test|ParameterizedTest)\b/g;
  let m;
  while ((m = re.exec(code))) {
    // The first '(' after '@Test' belongs to a *later annotation* (@DisplayName("...")).
    // Walk forward from the annotation to the body's '{' and take the LAST identifier that
    // precedes the '(' immediately before that brace sequence — i.e. resolve the signature.
    let i = m.index;
    const brace = (() => {
      // scan forward for a '{' whose preceding token sequence looks like `name(...)` or `name()`
      for (let k = i; k < Math.min(code.length, i + 800); k++) {
        if (code[k] !== '{') continue;
        // look back over the parameter list
        let p = k - 1;
        while (p > i && /\s/.test(code[p])) p--;
        if (code[p] !== ')') continue;
        // find its '('
        let depth = 0, q = p;
        for (; q > i; q--) {
          if (code[q] === ')') depth++;
          else if (code[q] === '(') { depth--; if (!depth) break; }
        }
        if (q <= i) continue;
        // the identifier right before q is the method name
        let r = q - 1;
        while (r > i && /\s/.test(code[r])) r--;
        const nameEnd = r;
        while (r > i && /[\w$]/.test(code[r])) r--;
        const nm = code.slice(r + 1, nameEnd + 1);
        if (/^[A-Za-z_$][\w$]*$/.test(nm) && !['if', 'for', 'while', 'switch', 'catch', 'try'].includes(nm)) {
          return { brace: k, name: nm };
        }
      }
      return null;
    })();
    if (!brace) continue;
    const { brace: braceIdx, name } = brace;
    let dd = 0, close = -1;
    for (let k = braceIdx; k < code.length; k++) {
      if (code[k] === '{') dd++;
      else if (code[k] === '}') { dd--; if (!dd) { close = k; break; } }
    }
    if (close > 0) out.push({ name, start: m.index, end: close + 1 });
    re.lastIndex = close > 0 ? close : m.index + 5;
  }
  return out;
}

const rows = [];
for (const f of files) {
  const src = f.workContent;
  const methods = testMethods(src);
  const fileRows = [];
  for (const meth of methods) {
    const before = src.slice(0, meth.start);
    const after = src.slice(meth.end);
    // also drop a trailing blank line so we do not leave a dangling blank
    const mutated = before + after;
    if (mutated === src) continue;
    const findings = detectV4(f.headContent, mutated).findings;
    const p = parseAssertions(src.slice(meth.start, meth.end));
    fileRows.push({
      method: meth.name,
      assertionsInMethod: p.stats.parsed,
      caught: findings.length > 0,
      findings: findings.map((x) => `${x.rule}:${x.subject}`),
    });
  }
  if (fileRows.length) rows.push({ rel: f.rel, methods: fileRows });
}

const all = rows.flatMap((r) => r.methods.map((m) => ({ ...m, file: r.rel })));
const caught = all.filter((m) => m.caught).length;
const missed = all.length - caught;

// Only methods that actually contain assertions matter (deleting an assertion-free method is
// harmless).
const withAsserts = all.filter((m) => m.assertionsInMethod > 0);
const caughtWithAsserts = withAsserts.filter((m) => m.caught).length;

// Unique-subject methods: those whose subjects appear nowhere else in the file. Those SHOULD be
// caught by rule 1. Anything else is a genuine recall hole.
const byFile = new Map(rows.map((r) => [r.rel, r]));
const uniqueMissed = [];

const L = [];
L.push('# Q3 — leave-one-method-out recall (the "delete the failing test" move)');
L.push('');
L.push(`@Test methods examined           : ${all.length}`);
L.push(`  ...that contain >=1 assertion  : ${withAsserts.length}`);
L.push(`removal reported (any finding)   : ${caught} (${(caught / all.length * 100).toFixed(1)}%)`);
L.push(`removal reported, assertion-bearing only: ${caughtWithAsserts} / ${withAsserts.length} (${(caughtWithAsserts / withAsserts.length * 100).toFixed(1)}%)`);
L.push('');
L.push('## per file');
for (const r of rows) {
  const c = r.methods.filter((m) => m.caught).length;
  L.push(`  ${r.rel.split('/').pop()}: ${c}/${r.methods.length} reported`);
  for (const m of r.methods) {
    const mark = m.caught ? 'HIT ' : 'miss';
    L.push(`    [${mark}] ${m.method}  (asserts=${m.assertionsInMethod})${m.caught ? ' -> ' + m.findings.join(', ') : ''}`);
  }
}
writeFileSync(path.join(outDir, 'q3-leave-one-out.md'), L.join('\n'));
writeFileSync(path.join(outDir, 'q3-leave-one-out.json'), JSON.stringify({ total: all.length, caught, withAsserts: withAsserts.length, caughtWithAsserts, rows }, null, 2));
console.log(L.join('\n'));
