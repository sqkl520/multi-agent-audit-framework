// The baseline choice determines what a count rule can see.
// Round-1 semantics: baseline = HEAD (pre-fix). work already has +334 raw assertions, so deleting
//   one test method often leaves the file still ABOVE HEAD -> count rule cannot fire.
// Round-N semantics: baseline = the previous round's snapshot. Then deleting a method always drops
//   the count -> count rule fires every time.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions, maskSource } from './parse-assertions.mjs';

const root = import.meta.dirname;
const manifest = JSON.parse(readFileSync(path.join(root, 'out', 'snapshot', 't0', 'manifest.json'), 'utf8'));
const files = manifest.files.filter((f) => f.rel.endsWith('.java') && f.rel.includes('src/test') && f.headContent !== null);

function testMethods(src) {
  const { code } = maskSource(src);
  const out = []; const re = /@(?:Test|ParameterizedTest)\b/g; let m;
  while ((m = re.exec(code))) {
    const i = m.index; let found = null;
    for (let k = i; k < Math.min(code.length, i + 800); k++) {
      if (code[k] !== '{') continue;
      let p = k - 1; while (p > i && /\s/.test(code[p])) p--;
      if (code[p] !== ')') continue;
      let d = 0, q = p;
      for (; q > i; q--) { if (code[q] === ')') d++; else if (code[q] === '(') { d--; if (!d) break; } }
      if (q <= i) continue;
      let r = q - 1; while (r > i && /\s/.test(code[r])) r--;
      const ne = r; while (r > i && /[\w$]/.test(code[r])) r--;
      const nm = code.slice(r + 1, ne + 1);
      if (/^[A-Za-z_$][\w$]*$/.test(nm) && !['if','for','while','switch','catch','try'].includes(nm)) { found = { brace: k, name: nm }; break; }
    }
    if (!found) continue;
    let dd = 0, close = -1;
    for (let k = found.brace; k < code.length; k++) { if (code[k] === '{') dd++; else if (code[k] === '}') { dd--; if (!dd) { close = k; break; } } }
    if (close > 0) out.push({ name: found.name, start: i, end: close + 1 });
    re.lastIndex = close > 0 ? close : i + 5;
  }
  return out;
}

// count-only detector
function countDetect(oldSrc, newSrc) {
  const o = parseAssertions(oldSrc), n = parseAssertions(newSrc);
  return n.stats.parsed < o.stats.parsed ? [`${o.stats.parsed}->${n.stats.parsed}`] : [];
}

for (const [label, pickBaseline] of [
  ['baseline=HEAD   (round-1)', (f) => f.headContent],
  ['baseline=work   (round-N)', (f) => f.workContent],
]) {
  let total = 0, caught = 0;
  for (const f of files) {
    for (const meth of testMethods(f.workContent)) {
      const mut = f.workContent.slice(0, meth.start) + f.workContent.slice(meth.end);
      if (mut === f.workContent) continue;
      total++;
      if (countDetect(pickBaseline(f), mut).length) caught++;
    }
  }
  console.log(`${label}: count rule catches ${caught}/${total} = ${(caught / total * 100).toFixed(1)}%`);
}
// how much did work grow vs HEAD?
let h = 0, w = 0;
for (const f of files) { h += parseAssertions(f.headContent).stats.parsed; w += parseAssertions(f.workContent).stats.parsed; }
console.log(`assertions HEAD=${h} work=${w} (work is ${(w / h).toFixed(2)}x)`);
