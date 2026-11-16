// Does a coarse "assertion COUNT per file decreased" rule close the leave-one-out gap?
// The 17 misses are methods whose subjects survive elsewhere in the file, so subject-identity
// rules are blind. A count rule is subject-blind and should catch them.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions, maskSource } from './parse-assertions.mjs';

const root = import.meta.dirname;
const snap = path.join(root, 'out', 'snapshot', 't0');
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));
const files = manifest.files.filter((f) => f.rel.endsWith('.java') && f.rel.includes('src/test') && f.headContent !== null);

// full detector = v4 rules (drop + reversed multiset) + count rule
function detect(oldSrc, newSrc) {
  const o = parseAssertions(oldSrc), n = parseAssertions(newSrc);
  const out = [];
  for (const [subj, arr] of o.subjects) if (!n.subjects.has(subj)) out.push({ rule: 'target_dropped', subject: subj });
  const idx = (p) => { const m = new Map(); for (const [s, a] of p.subjects) for (const x of a) { const k = x.method + '::' + s; if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; };
  const sig = (a) => `${a.pclass}(${a.expected})`;
  const oi = idx(o), ni = idx(n);
  for (const [k, olds] of oi) {
    const news = ni.get(k);
    if (!news) continue;
    const oc = new Map(), nc = new Map();
    for (const a of olds) oc.set(sig(a), (oc.get(sig(a)) ?? 0) + 1);
    for (const a of news) nc.set(sig(a), (nc.get(sig(a)) ?? 0) + 1);
    const lost = [];
    for (const [s, v] of oc) { const d = v - (nc.get(s) ?? 0); for (let i = 0; i < d; i++) lost.push(s); }
    if (lost.length) out.push({ rule: 'reversed', subject: k.split('::')[1], method: k.split('::')[0], lost });
  }
  if (n.stats.parsed < o.stats.parsed) out.push({ rule: 'count_decreased', detail: `${o.stats.parsed} -> ${n.stats.parsed}` });
  return out;
}

// 1. real change set
const real = files.map((f) => ({ rel: f.rel, findings: detect(f.headContent, f.workContent) })).filter((r) => r.findings.length);
console.log(`[real] files with findings: ${real.length}, total findings: ${real.reduce((a, r) => a + r.findings.length, 0)}`);
for (const r of real) for (const f of r.findings) console.log(`   ${r.rel.split('/').pop()} :: ${f.rule} ${f.subject ?? f.detail}`);

// 2. leave-one-out
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
let total = 0, caught = 0, byCount = 0;
for (const f of files) {
  for (const meth of testMethods(f.workContent)) {
    const mut = f.workContent.slice(0, meth.start) + f.workContent.slice(meth.end);
    if (mut === f.workContent) continue;
    total++;
    const fs2 = detect(f.headContent, mut);
    if (fs2.length) caught++;
    if (fs2.some((x) => x.rule === 'count_decreased')) byCount++;
  }
}
console.log(`[leave-one-out] caught ${caught}/${total} = ${(caught / total * 100).toFixed(1)}%  (count-rule fired on ${byCount})`);

// 3. residual misses after all rules
console.log('\n[residual misses]');
for (const f of files) {
  for (const meth of testMethods(f.workContent)) {
    const mut = f.workContent.slice(0, meth.start) + f.workContent.slice(meth.end);
    if (mut === f.workContent) continue;
    if (!detect(f.headContent, mut).length) {
      const p = parseAssertions(f.workContent.slice(meth.start, meth.end));
      console.log(`   MISS ${f.rel.split('/').pop()} :: ${meth.name} (asserts=${p.stats.parsed})`);
    }
  }
}

// 4. count-rule false-positive risk: legitimate consolidation (3 asserts -> 1 assertAll/helper)
console.log('\n[count-rule FP risk on legitimate consolidation]');
const f0 = files.find((x) => x.rel.includes('ConfigManagerTest'));
const src = f0.workContent;
const consolidated = src.replace(
  /assertEquals\(7, config\.getActiveConfig\(\)\.getVictoryWaves\(\),\n\s*"失败分支的语义是「读不到就不动内存」：拒绝重载后内存值必须保持 7"\);\n(\s*)assertTrue\(config\.getSettingsGate\(\)\.isReadOnly\(\),\n\s*"前置\/结果校验：空文件必须让 settings 闸门锁定只读"\);/,
  'assertEquals(7, config.getActiveConfig().getVictoryWaves());'
);
if (consolidated !== src) {
  const fs2 = detect(f0.headContent, consolidated);
  console.log('  consolidated 2 asserts -> 1:', fs2.map((x) => x.rule + ':' + (x.subject ?? x.detail)).join(', ') || 'none');
}
