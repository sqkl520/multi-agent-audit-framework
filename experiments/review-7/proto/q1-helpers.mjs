// The unparsable bucket is dominated by calls to LOCAL helpers (assertOk / assertSuspect / ...).
// The plan's answer is "assertion_unparsable -> WARN, strong gate disabled for that file".
// Measure what that costs: those helpers ARE the assertions. Count what lives inside them.
//
//   node q1-helpers.mjs --snapshot out/snapshot/t0

import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions, maskSource } from './parse-assertions.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const snap = getArg('--snapshot', path.join(import.meta.dirname, 'out', 'snapshot', 't0'));
const outDir = getArg('--out', path.join(import.meta.dirname, 'out'));
mkdirSync(outDir, { recursive: true });

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (e.name.endsWith('.java')) out.push(p);
  }
  return out;
}
const treeRoot = path.join(import.meta.dirname, 'out', 'fulltree');
const workFiles = walk(path.join(treeRoot, 'src_test'));

function methodBodies(src) {
  const { code } = maskSource(src);
  const out = [];
  const re = /(?<![\w$])(?:private|protected|public|static|final|\s)*[\w$.<>\[\], ?]+\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:throws[^{]*)?\{/g;
  let m;
  while ((m = re.exec(code))) {
    const open = code.indexOf('{', m.index + m[0].length - 1);
    let d = 0, close = -1;
    for (let i = open; i < code.length; i++) {
      if (code[i] === '{') d++;
      else if (code[i] === '}') { d--; if (!d) { close = i; break; } }
    }
    if (close > 0) out.push({ name: m[1], body: src.slice(open, close + 1), start: m.index });
  }
  return out;
}

const rows = [];
for (const f of workFiles) {
  const src = readFileSync(f, 'utf8');
  const p = parseAssertions(src);
  const helperNames = [...new Set(p.unparsable.map((u) => u.fn))].filter((n) => n !== 'fail');
  if (!helperNames.length) continue;
  const bodies = methodBodies(src);
  const info = [];
  for (const h of helperNames) {
    const def = bodies.find((b) => b.name === h);
    if (!def) { info.push({ helper: h, definedHere: false, calls: p.unparsable.filter((u) => u.fn === h).length, assertsInside: null }); continue; }
    const inner = parseAssertions(def.body);
    info.push({
      helper: h, definedHere: true,
      calls: p.unparsable.filter((u) => u.fn === h).length,
      assertsInside: inner.stats.parsed,
      subjectsInside: [...inner.subjects.keys()].slice(0, 6),
    });
  }
  rows.push({ file: path.relative(path.join(snap, 'work'), f).split(path.sep).join('/'), info });
}

const L = [];
L.push('# Q1 — what the "unparsable" bucket really is');
L.push('');
L.push('Every unparsable call in the tree is either `fail(...)` or a call to a LOCAL helper');
L.push('(a `private void assertXxx(...)` in the same test class). The plan maps these to');
L.push('`assertion_unparsable -> WARN` and "strong gate disabled for that file".');
L.push('The cost of that decision, measured:');
L.push('');
for (const r of rows) {
  L.push(`\n## ${r.file.split('/').pop()}`);
  for (const i of r.info) {
    L.push(`  ${i.helper}: called ${i.calls}x` + (i.definedHere
      ? `, body contains ${i.assertsInside} assertion(s) -> ${JSON.stringify(i.subjectsInside)}`
      : `, DEFINED IN ANOTHER FILE (inherited/imported) -> body invisible to this file's parse`));
  }
}
const definedElsewhere = rows.flatMap((r) => r.info.filter((i) => i.definedHere === false));
L.push('');
L.push(`helpers called but not defined in the calling file: ${definedElsewhere.length}`);
for (const d of definedElsewhere) L.push(`  ${d.helper} (${d.calls} calls)`);

writeFileSync(path.join(outDir, 'q1-helpers.md'), L.join('\n'));
console.log(L.join('\n'));
