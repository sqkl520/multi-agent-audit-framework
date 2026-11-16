// Variant experiment: the PLAN text says "file-level, not grouped by method", which is what
// run-mode-a.mjs implements. This file measures what changes if we key by method too, and whether
// the calibration set (3 deletions, of which #3 is a false positive) still behaves.
//
//   node variants.mjs --repo <path>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './parse-assertions.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const repo = getArg('--repo', '<TARGET_REPO>');
const ref = getArg('--ref', 'HEAD');
const outDir = getArg('--out', path.join(import.meta.dirname, 'out'));
mkdirSync(outDir, { recursive: true });

const git = (a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });

function changed() {
  const out = [];
  for (const rel of git(['diff', '--name-only', '--', 'src/test']).trim().split('\n').filter(Boolean)) out.push({ rel, st: 'M' });
  for (const l of git(['status', '--porcelain', '--', 'src/test']).trim().split('\n')) if (l.startsWith('??')) out.push({ rel: l.slice(3).trim(), st: 'A' });
  const m = new Map(); for (const f of out) if (!m.has(f.rel)) m.set(f.rel, f);
  return [...m.values()];
}

const CALIBRATION = [
  { file: 'src/test/java/com/hilltopvillage/mechanics/TabListManagerTest.java', subject: 'field("refreshTask")', truth: 'legit (reported-ok)' },
  { file: 'src/test/java/com/hilltopvillage/mechanics/TabListManagerTest.java', subject: 'field("scheduledPeriod")', truth: 'legit (reported-ok)' },
  { file: 'src/test/java/com/hilltopvillage/shop/ShopConfigLoaderTest.java', subject: 'config.getItems().get(0).getPrice()', truth: 'FALSE POSITIVE if flagged' },
];

/* ---------------------------------------------------------------- variants */

// V1: file-scoped subject set (what the plan literally says)
function v1(oldP, newP) {
  const f = [];
  for (const [s, o] of oldP.subjects) {
    const n = newP.subjects.get(s);
    if (!n) { f.push({ rule: 'dropped', subject: s, scope: 'file' }); continue; }
    const os = sig(o), ns = sig(n);
    if ([...os].some((x) => !ns.has(x))) f.push({ rule: 'reversed', subject: s, scope: 'file', old: [...os], new: [...ns] });
  }
  return f;
}

// V2: method-scoped subject set
function v2(oldP, newP) {
  const f = [];
  const key = (m, s) => `${m}::${s}`;
  const o = flatten(oldP), n = flatten(newP);
  const nMap = new Map();
  for (const x of n) push(nMap, key(x.method, x.subject), x);
  for (const x of o) {
    const hit = nMap.get(key(x.method, x.subject));
    if (!hit) {
      // method may have been renamed: fall back to file scope so renames are not "dropped"
      const anyFile = n.find((y) => y.subject === x.subject);
      if (!anyFile) f.push({ rule: 'dropped', subject: x.subject, method: x.method, scope: 'method' });
      else f.push({ rule: 'moved-or-renamed', subject: x.subject, method: x.method, foundIn: anyFile.method, scope: 'soft' });
      continue;
    }
    if (!hit.some((y) => y.pclass === x.pclass && y.expected === x.expected)) {
      f.push({ rule: 'reversed', subject: x.subject, method: x.method, scope: 'method', old: [`${x.pclass}(${x.expected})`], new: hit.map((y) => `${y.pclass}(${y.expected})`) });
    }
  }
  return f;
}

// V3: file-scoped but compare the EXPECTED-VALUE MULTISET per subject (catches "one method changed
// value while another kept the old value" only if counts change) — included to show it does not help
function v3(oldP, newP) {
  const f = [];
  for (const [s, o] of oldP.subjects) {
    const n = newP.subjects.get(s);
    if (!n) { f.push({ rule: 'dropped', subject: s, scope: 'file' }); continue; }
    const om = multiset(o), nm = multiset(n);
    if (JSON.stringify(om) !== JSON.stringify(nm)) f.push({ rule: 'reversed', subject: s, scope: 'file-multiset', old: om, new: nm });
  }
  return f;
}

function sig(arr) { return new Set(arr.map((a) => `${a.pclass}:${a.expected}`)); }
function multiset(arr) { return arr.map((a) => `${a.pclass}(${a.expected})`).sort(); }
function flatten(p) {
  const out = [];
  for (const [s, arr] of p.subjects) for (const a of arr) out.push({ ...a, subject: s });
  return out;
}
function push(m, k, v) { if (!m.has(k)) m.set(k, []); m.get(k).push(v); }

/* ---------------------------------------------------------------- driver */

const files = changed();
const variants = { v1, v2, v3 };
const report = {};
for (const [name, fn] of Object.entries(variants)) {
  const perFile = [];
  for (const f of files) {
    const newSrc = readFileSync(path.join(repo, f.rel), 'utf8');
    let oldSrc = null;
    try { oldSrc = git(['show', `${ref}:${f.rel}`]); } catch { oldSrc = null; }
    const oldP = oldSrc === null ? { subjects: new Map(), unparsable: [], stats: null } : parseAssertions(oldSrc);
    const newP = parseAssertions(newSrc);
    const findings = fn(oldP, newP);
    if (findings.length) perFile.push({ file: f.rel, st: f.st, findings });
  }
  report[name] = perFile;
}

writeFileSync(path.join(outDir, 'variants.json'), JSON.stringify(report, null, 2));

const L = [];
L.push('# rule variants on the 27 changed test files');
for (const [name, perFile] of Object.entries(report)) {
  const total = perFile.reduce((a, x) => a + x.findings.length, 0);
  L.push(`\n## ${name}: ${total} findings across ${perFile.length} files`);
  for (const f of perFile) {
    const cal = CALIBRATION.filter((c) => c.file === f.file);
    L.push(`\n### ${f.file}`);
    for (const x of f.findings) {
      const isCal = cal.find((c) => c.subject === x.subject);
      L.push(`  - ${x.rule} [${x.scope}] ${x.subject}${x.method ? ' @' + x.method : ''}${isCal ? `   <<< CALIBRATION: ${isCal.truth}` : ''}`);
      if (x.old) L.push(`      old=${JSON.stringify(x.old)}`);
      if (x.new) L.push(`      new=${JSON.stringify(x.new)}`);
      if (x.foundIn) L.push(`      foundIn=${x.foundIn}`);
    }
  }
  // calibration table
  L.push(`\n  calibration check:`);
  for (const c of CALIBRATION) {
    const hits = (report[name].find((f) => f.file === c.file)?.findings ?? []).filter((x) => x.subject === c.subject);
    L.push(`    ${c.file.split('/').pop()} ${c.subject} -> ${hits.length ? hits.map((h) => h.rule).join(',') : 'no hit'}   [${c.truth}]`);
  }
}
writeFileSync(path.join(outDir, 'variants.md'), L.join('\n'));
console.log(L.join('\n'));
