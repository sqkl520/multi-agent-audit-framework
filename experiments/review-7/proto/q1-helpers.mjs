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

// Locate a specific method definition by NAME (avoids a general regex: the general one
// backtracks catastrophically on real files).
function findBody(src, name) {
  const { code } = maskSource(src);
  const re = new RegExp(`(?<![\\w$])${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(code))) {
    // find the matching ')' then expect '{' (i.e. this is a definition, not a call)
    let d = 0, j = code.indexOf('(', m.index);
    for (; j < code.length; j++) {
      if (code[j] === '(') d++;
      else if (code[j] === ')') { d--; if (!d) break; }
    }
    const rest = code.slice(j + 1, j + 200);
    const brace = rest.indexOf('{');
    if (brace < 0) continue;
    if (!/^\s*(?:throws\s+[\w.,\s]+)?\{/.test(rest.slice(0, brace + 1))) continue;
    const open = j + 1 + brace;
    let dd = 0, close = -1;
    for (let k = open; k < code.length; k++) {
      if (code[k] === '{') dd++;
      else if (code[k] === '}') { dd--; if (!dd) { close = k; break; } }
    }
    if (close > 0) return src.slice(open, close + 1);
  }
  return null;
}

const rows = [];
for (const f of workFiles) {
  const src = readFileSync(f, 'utf8');
  const p = parseAssertions(src);
  const helperNames = [...new Set(p.unparsable.map((u) => u.fn))].filter((n) => n !== 'fail');
  if (!helperNames.length) continue;
  const info = [];
  for (const h of helperNames) {
    const defBody = findBody(src, h);
    if (!defBody) { info.push({ helper: h, definedHere: false, calls: p.unparsable.filter((u) => u.fn === h).length, assertsInside: null }); continue; }
    const inner = parseAssertions(defBody);
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
