// Final metrics used in the report. One place, so every number quoted is reproducible.
//   node final-metrics.mjs

import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions, maskSource } from './parse-assertions.mjs';
import { detectV4 } from './v4.mjs';

const root = import.meta.dirname;
const treeRoot = path.join(root, 'out', 'fulltree');
const snap = path.join(root, 'out', 'snapshot', 't0');
const manifest = JSON.parse(readFileSync(path.join(snap, 'manifest.json'), 'utf8'));

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p)); else if (e.name.endsWith('.java')) out.push(p);
  }
  return out;
}

/* ---------------- Q1: whole tree ---------------- */
const treeFiles = walk(path.join(treeRoot, 'src_test'));
let T = { files: treeFiles.length, phys: 0, calls: 0, parsed: 0, unparsable: 0, containers: 0 };
const unparsableBy = new Map();
const shape = {};
const byFileSubject = new Map();
const subjectHex = new Map();
let assertionsTotal = 0;
for (const f of treeFiles) {
  const rel = path.relative(treeRoot, f).split(path.sep).join('/');
  const p = parseAssertions(readFileSync(f, 'utf8'));
  T.phys += p.stats.physicalAssertLines; T.calls += p.stats.callSites;
  T.parsed += p.stats.parsed; T.unparsable += p.stats.unparsable; T.containers += p.stats.containers;
  for (const u of p.unparsable) unparsableBy.set(`${u.fn}: ${u.reason}`, (unparsableBy.get(`${u.fn}: ${u.reason}`) ?? 0) + 1);
  for (const [subj, arr] of p.subjects) {
    for (const a of arr) {
      assertionsTotal++;
      shape[bucket(subj)] = (shape[bucket(subj)] ?? 0) + 1;
      const k = `${rel}::${subj}`;
      if (!byFileSubject.has(k)) byFileSubject.set(k, new Set());
      byFileSubject.get(k).add(`${a.pclass}(${a.expected})`);
      subjectHex.set(subj, (subjectHex.get(subj) ?? 0) + 1);
    }
  }
}
function bucket(s) {
  if (/^size\(/.test(s)) return 'sizeForm';
  if (s.startsWith('throws:')) return 'throws';
  if (s.startsWith('nothrow:')) return 'nothrow';
  if (/^(verify|expect)\(/.test(s)) return 'interaction';
  if (/^[A-Za-z_$][\w$]*$/.test(s)) return 'bareIdentifier';
  if (s.includes('"')) return 'literalCoupled';
  if (/^[\w$.]+(\(\))?(\.[\w$]+(\([^()]*\))?)*$/.test(s)) return 'dottedPath';
  return 'compositeExpr';
}
const collisions = [...byFileSubject.values()].filter((v) => v.size > 1).length;
const hexTop = [...subjectHex.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);

/* ---------------- Q1/Q2/Q3 on the change set ---------------- */
const changed = manifest.files.filter((f) => f.rel.endsWith('.java') && f.rel.includes('src/test/') && !f.rel.includes('testsupport'));
let C = { files: changed.length, modified: 0, added: 0, calls: 0, parsed: 0, unparsable: 0, sites: 0 };
for (const f of changed) {
  if (f.headContent !== null) C.modified++; else C.added++;
  for (const src of [f.headContent, f.workContent]) {
    if (src === null) continue;
    C.sites++;
    const p = parseAssertions(src);
    C.calls += p.stats.callSites; C.parsed += p.stats.parsed; C.unparsable += p.stats.unparsable;
  }
}

const findings = changed.flatMap((f) => detectV4(f.headContent, f.workContent).findings.map((x) => ({ ...x, file: f.rel })));
const byRule = {};
for (const f of findings) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;

/* ---------------- predicate classes ---------------- */
const classes = {};
for (const f of changed) {
  for (const src of [f.headContent, f.workContent]) {
    if (!src) continue;
    const p = parseAssertions(src);
    for (const arr of p.subjects.values()) for (const a of arr) classes[a.pclass] = (classes[a.pclass] ?? 0) + 1;
  }
}

/* ---------------- deleted/added raw assert lines (ground truth) ---------------- */
// computed by q1-quality.mjs from git; re-derive here from the snapshot's own diff content
function rawAssertTexts(src) {
  const { code } = maskSource(src);
  const out = [];
  const re = /(?<![\w$])(assert[A-Z]\w*|fail|verify)\s*\(/g;
  let m;
  while ((m = re.exec(code))) {
    const open = code.indexOf('(', m.index + m[0].length - 1);
    let d = 0, close = -1;
    for (let i = open; i < code.length; i++) { if (code[i] === '(') d++; else if (code[i] === ')') { d--; if (!d) { close = i; break; } } }
    if (close < 0) continue;
    const after = code.slice(close + 1, close + 90).trimStart();
    if (after.startsWith('{') || /^throws\s/.test(after)) continue;
    out.push(src.slice(m.index, close + 1).replace(/\s+/g, ' '));
  }
  return out;
}
let rawRemoved = 0, rawAdded = 0;
for (const f of changed) {
  if (f.headContent === null) { rawAdded += rawAssertTexts(f.workContent).length; continue; }
  const a = rawAssertTexts(f.headContent), b = rawAssertTexts(f.workContent);
  const na = new Map(), nb = new Map();
  for (const x of a) na.set(x, (na.get(x) ?? 0) + 1);
  for (const x of b) nb.set(x, (nb.get(x) ?? 0) + 1);
  for (const [k, v] of na) rawRemoved += Math.max(0, v - (nb.get(k) ?? 0));
  for (const [k, v] of nb) rawAdded += Math.max(0, v - (na.get(k) ?? 0));
}

/* ---------------- Q5 ---------------- */
const added = changed.filter((f) => f.headContent === null);
let addedParsed = 0;
for (const f of added) addedParsed += parseAssertions(f.workContent).stats.parsed;
const addedFindings = added.reduce((a, f) => a + detectV4('', f.workContent).findings.length, 0);

/* ---------------- Q6 ---------------- */
const q6 = existsSync(path.join(root, 'out', 'q6-f1.json')) ? JSON.parse(readFileSync(path.join(root, 'out', 'q6-f1.json'), 'utf8')) : null;

const M = {
  q1_tree: T,
  q1_tree_unparsable_rate_pct: +(T.unparsable / T.calls * 100).toFixed(2),
  q1_unparsable_forms: [...unparsableBy.entries()].sort((a, b) => b[1] - a[1]),
  q1_shapes: shape,
  q1_assertions_total: assertionsTotal,
  q1_colliding_file_subject_pairs: collisions,
  q1_colliding_ratio_pct: +(collisions / byFileSubject.size * 100).toFixed(1),
  q1_top_generic_subjects: hexTop,
  changeset: C,
  changeset_unparsable_rate_pct: C.calls ? +(C.unparsable / C.calls * 100).toFixed(2) : 0,
  findings_count: findings.length,
  findings_by_rule: byRule,
  findings,
  predicate_classes: classes,
  raw_diff: { removed: rawRemoved, added: rawAdded },
  q5: { addedFiles: added.length, assertionsInAdded: addedParsed, findingsOnAdded: addedFindings },
  q6,
};
mkdirSync(path.join(root, 'out'), { recursive: true });
writeFileSync(path.join(root, 'out', 'final-metrics.json'), JSON.stringify(M, null, 2));
console.log(JSON.stringify({ ...M, findings: M.findings, q6: q6 && q6.rows?.map((r) => ({ id: r.id, reported: r.reported })) }, null, 2));
