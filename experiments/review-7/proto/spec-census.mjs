// Final census using the SHIPPED spec implementation (check-test-assertion-diff.mjs),
// so every number quoted in the spec header is reproducible from the shipped code.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './check-test-assertion-diff.mjs';

const root = import.meta.dirname;
const treeRoot = path.join(root, 'out', 'fulltree');
function walk(d) {
  const out = [];
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (e.name.endsWith('.java')) out.push(p);
  }
  return out;
}
let files = 0, calls = 0, parsed = 0, unresolved = 0, resolved = 0, containers = 0;
const shapes = {}, classes = {}, still = new Map();
for (const f of walk(path.join(treeRoot, 'src_test'))) {
  files++;
  const p = parseAssertions(readFileSync(f, 'utf8'));
  calls += p.stats.callSites; parsed += p.stats.parsed;
  unresolved += p.stats.unparsable;
  resolved += p.unparsable.filter((u) => u.resolved).length;
  containers += p.stats.containers;
  for (const u of p.unparsable.filter((x) => !x.resolved)) still.set(u.fn + ': ' + u.reason, (still.get(u.fn + ': ' + u.reason) ?? 0) + 1);
  for (const [s, arr] of p.subjects) for (const a of arr) {
    classes[a.pclass] = (classes[a.pclass] ?? 0) + 1;
    const shape = /^size\(/.test(s) ? 'sizeForm' : s.startsWith('throws:') ? 'throws' : s.startsWith('nothrow:') ? 'nothrow'
      : /^(verify|expect)\(/.test(s) ? 'interaction' : /^[A-Za-z_$][\w$]*$/.test(s) ? 'bareIdentifier'
      : s.includes('"') ? 'literalCoupled'
      : /^[\w$.]+(\(\))?(\.[\w$]+(\([^()]*\))?)*$/.test(s) ? 'dottedPath' : 'compositeExpr';
    shapes[shape] = (shapes[shape] ?? 0) + 1;
  }
}
console.log(`files=${files} callSites=${calls} parsed=${parsed} resolved-helpers=${resolved}`);
console.log(`unresolved=${unresolved} rate=${(unresolved / calls * 100).toFixed(2)}% containers=${containers}`);
console.log('shapes', JSON.stringify(shapes));
console.log('classes', JSON.stringify(classes));
console.log('remaining', [...still.entries()]);
