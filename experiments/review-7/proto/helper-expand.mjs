// Measure: if we resolve local helper definitions and recurse into their bodies, what does the
// unparsable rate become, and how many files stop needing "strong gate disabled"?
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions, maskSource } from './parse-assertions.mjs';

const root = import.meta.dirname;
const treeRoot = path.join(root, 'out', 'fulltree');
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (e.name.endsWith('.java')) out.push(p);
  }
  return out;
}
function findBodies(src, name) {
  const { code } = maskSource(src);
  const re = new RegExp('(?<![\\w$])' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(', 'g');
  const out = [];
  let m;
  while ((m = re.exec(code))) {
    let d = 0, j = code.indexOf('(', m.index);
    for (; j < code.length; j++) { if (code[j] === '(') d++; else if (code[j] === ')') { d--; if (!d) break; } }
    const rest = code.slice(j + 1, j + 200);
    const brace = rest.indexOf('{');
    if (brace < 0) continue;
    if (!/^\s*(?:throws\s+[\w.,\s]+)?\{/.test(rest.slice(0, brace + 1))) continue;
    const open = j + 1 + brace;
    let dd = 0, close = -1;
    for (let k = open; k < code.length; k++) { if (code[k] === '{') dd++; else if (code[k] === '}') { dd--; if (!dd) { close = k; break; } } }
    if (close > 0) out.push(src.slice(open, close + 1));
  }
  return out;
}
function findBody(src, name) {
  const all = findBodies(src, name);
  return all.length ? all[0] : null;
}

let calls = 0, parsed = 0, unparsableBefore = 0, unparsableAfter = 0;
let filesNeedingDowngradeBefore = 0, filesNeedingDowngradeAfter = 0;
const still = new Map();
const depths = new Map();
for (const f of walk(path.join(treeRoot, 'src_test'))) {
  const src = readFileSync(f, 'utf8');
  const p = parseAssertions(src);
  calls += p.stats.callSites;
  parsed += p.stats.parsed;
  unparsableBefore += p.stats.unparsable;
  if (p.unparsable.length) filesNeedingDowngradeBefore++;

  // after: resolve helper bodies RECURSIVELY (they delegate: assertOk(3-arg) -> assertOk(5-arg))
  function resolveDeep(fnName, depth, seen) {
    if (depth > 4) return { ok: false, why: 'depth' };
    const bodies = findBodies(src, fnName);
    if (!bodies.length) return { ok: false, why: 'no-body' };
    // try EVERY overload of this name: Java overloads delegate (3-arg -> 5-arg)
    for (let bi = 0; bi < bodies.length; bi++) {
      const key = `${fnName}#${bi}`;
      if (seen.has(key)) continue;
      const inner = parseAssertions(bodies[bi]);
      if (inner.stats.parsed > 0) return { ok: true, depth };
      for (const u2 of inner.unparsable) {
        if (u2.fn === 'fail') continue;
        const r = resolveDeep(u2.fn, depth + 1, new Set([...seen, key]));
        if (r.ok) return { ok: true, depth: r.depth };
      }
    }
    return { ok: false, why: 'body-has-no-assert' };
  }

  let remaining = 0;
  for (const u of p.unparsable) {
    if (u.fn === 'fail') { remaining++; still.set('fail', (still.get('fail') ?? 0) + 1); continue; }
    const r = resolveDeep(u.fn, 1, new Set());
    if (r.ok) { depths.set(r.depth, (depths.get(r.depth) ?? 0) + 1); continue; }
    remaining++; still.set(`${u.fn} (${r.why})`, (still.get(`${u.fn} (${r.why})`) ?? 0) + 1);
  }
  unparsableAfter += remaining;
  if (remaining > 0) filesNeedingDowngradeAfter++;
}
console.log(`calls(parsed+unparsable) = ${parsed + unparsableBefore}`);
console.log(`unparsable before: ${unparsableBefore} (${(unparsableBefore / (parsed + unparsableBefore) * 100).toFixed(2)}%), files downgraded: ${filesNeedingDowngradeBefore}`);
console.log(`unparsable after : ${unparsableAfter} (${(unparsableAfter / (parsed + unparsableBefore) * 100).toFixed(2)}%), files downgraded: ${filesNeedingDowngradeAfter}`);
console.log(`effective parse coverage: ${((parsed) / (parsed + unparsableAfter) * 100).toFixed(2)}%`);
console.log('remaining forms:', [...still.entries()]);
console.log('resolution depth distribution:', [...depths.entries()]);
