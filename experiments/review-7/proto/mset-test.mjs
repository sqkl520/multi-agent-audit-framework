// Multiset vs set comparison: measured on the real change set.
// Q: does switching rule 2 from "signature SET" to "signature MULTISET per method" add recall
//    or add noise? This is exactly the "expected 用多重集比较" constraint the coordinator asked about.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions, maskSource } from './parse-assertions.mjs';

const root = import.meta.dirname;
const snap = path.join(root, 'out', 'snapshot', 't0');
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
const files = manifest.files.filter((f) => f.rel.endsWith('.java') && f.rel.includes('src/test') && f.headContent !== null);

function idx(p) {
  const m = new Map();
  for (const [subj, arr] of p.subjects) for (const a of arr) {
    const k = `${a.method}::${subj}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(a);
  }
  return m;
}
const sig = (a) => `${a.pclass}(${a.expected})`;

function detect(oldSrc, newSrc, mode) {
  const o = parseAssertions(oldSrc), n = parseAssertions(newSrc);
  const out = [];
  for (const [subj, olds] of o.subjects) if (!n.subjects.has(subj)) out.push({ rule: 'target_dropped', subject: subj });
  const oi = idx(o), ni = idx(n);
  for (const [k, olds] of oi) {
    const news = ni.get(k);
    if (!news) continue;
    const meth = k.slice(0, k.indexOf('::')), subj = k.slice(k.indexOf('::') + 2);
    if (mode === 'set') {
      const os = new Set(olds.map(sig)), ns = new Set(news.map(sig));
      const lost = [...os].filter((x) => !ns.has(x));
      if (lost.length) out.push({ rule: 'reversed', subject: subj, method: meth, lost });
    } else {
      // multiset: compare counts per signature
      const cnt = (arr) => { const m = new Map(); for (const a of arr) m.set(sig(a), (m.get(sig(a)) ?? 0) + 1); return m; };
      const oc = cnt(olds), nc = cnt(news);
      const lost = [];
      for (const [s, v] of oc) { const d = v - (nc.get(s) ?? 0); for (let i = 0; i < d; i++) lost.push(s); }
      if (lost.length) out.push({ rule: 'reversed', subject: subj, method: meth, lost });
    }
  }
  return out;
}

// 1. real change set
for (const mode of ['set', 'multiset']) {
  const all = files.flatMap((f) => detect(f.headContent, f.workContent, mode).map((x) => ({ ...x, file: f.rel })));
  console.log(`\n[real] ${mode}: ${all.length} findings`);
  for (const f of all) console.log(`   ${f.file.split('/').pop()} :: ${f.subject} @${f.method} lost=${JSON.stringify(f.lost)}`);
}

// 2. leave-one-out recall
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

for (const mode of ['set', 'multiset']) {
  let total = 0, caught = 0;
  for (const f of files) {
    for (const meth of testMethods(f.workContent)) {
      const mut = f.workContent.slice(0, meth.start) + f.workContent.slice(meth.end);
      if (mut === f.workContent) continue;
      total++;
      if (detect(f.headContent, mut, mode).length) caught++;
    }
  }
  console.log(`[leave-one-out] ${mode}: ${caught}/${total} = ${(caught / total * 100).toFixed(1)}%`);
}
