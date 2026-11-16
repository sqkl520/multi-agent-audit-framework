// Parse-quality census over the whole test tree of the audited repo.
//   node census.mjs --repo <path>

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './parse-assertions.mjs';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const repo = getArg('--repo', '<TARGET_REPO>');
const outDir = getArg('--out', path.join(import.meta.dirname, 'out'));
mkdirSync(outDir, { recursive: true });

const files = execFileSync('git', ['-C', repo, 'ls-files', 'src/test'], { encoding: 'utf8' })
  .split('\n').filter((f) => f.endsWith('.java'));
const untracked = execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', 'src/test'], { encoding: 'utf8' })
  .split('\n').filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim());
const all = [...new Set([...files, ...untracked])];

const BUCKET = {
  bareIdentifier: 0,      // subject is a single token: `before`, `config`, `failure`
  literalCoupled: 1,      // subject contains a string literal (identity depends on fixture text)
  dottedPath: 2,          // a.b.c()
  sizeForm: 3,            // size(X)
  compositeExpr: 4,       // contains operators / method chain with boolean structure
  interaction: 5,         // mockito verify
};

const rows = [];
let totals = {
  files: 0, physical: 0, callSites: 0, parsed: 0, unparsable: 0, containers: 0,
  buckets: {}, distinct: 0,
};

for (const rel of all) {
  let src;
  try { src = readFileSync(path.join(repo, rel), 'utf8'); } catch { continue; }
  const p = parseAssertions(src);
  totals.files++;
  totals.physical += p.stats.physicalAssertLines;
  totals.callSites += p.stats.callSites;
  totals.parsed += p.stats.parsed;
  totals.unparsable += p.stats.unparsable;
  totals.containers += p.stats.containers;

  for (const arr of p.subjects.values()) {
    for (const a of arr) {
      const b = bucketOf(a.subject, a.kind);
      totals.buckets[b] = (totals.buckets[b] ?? 0) + 1;
    }
  }
  if (p.unparsable.length) rows.push({ rel, unparsable: p.unparsable });
}

function bucketOf(subj, kind) {
  if (kind === 'verify') return 'interaction';
  if (/^size\(.*\)$/.test(subj)) return 'sizeForm';
  if (/^[A-Za-z_$][\w$]*$/.test(subj)) return 'bareIdentifier';
  if (subj.includes('"')) return 'literalCoupled';
  if (/^[\w$."]*(\(\))?(\.[\w$]+(\([^()]*\))?)*$/.test(subj)) return 'dottedPath';
  return 'compositeExpr';
}

// bare-identifier subject census: which identifiers dominate (collision risk)
const bareNames = new Map();
for (const rel of all) {
  let src; try { src = readFileSync(path.join(repo, rel), 'utf8'); } catch { continue; }
  const p = parseAssertions(src);
  for (const [subj, arr] of p.subjects) {
    if (/^[A-Za-z_$][\w$]*$/.test(subj)) bareNames.set(subj, (bareNames.get(subj) ?? 0) + arr.length);
  }
}

const dur = parseFloat(((totals.callSites - totals.unparsable) / totals.callSites) * 100).toFixed(2);
const L = [];
L.push('# parse census (whole src/test tree)');
L.push(`files: ${totals.files}`);
L.push(`physical assert lines: ${totals.physical}`);
L.push(`assert call sites    : ${totals.callSites}`);
L.push(`parsed               : ${totals.parsed} (${dur} of call sites)`);
L.push(`unparsable           : ${totals.unparsable} (${(100 - dur).toFixed(2)}%)`);
L.push(`assertAll containers : ${totals.containers} (recursed into, not counted as subjects)`);
L.push('');
L.push('## subject shape buckets');
for (const [k, v] of Object.entries(totals.buckets).sort((a, b) => b[1] - a[1])) {
  L.push(`  ${k.padEnd(18)} ${v}  (${((v / totals.parsed) * 100).toFixed(1)}%)`);
}
L.push('');
L.push('## top bare-identifier subjects (collision risk)');
for (const [k, v] of [...bareNames.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) L.push(`  ${k}: ${v}`);
L.push('');
L.push(`## files with unparsable assertions: ${rows.length}`);
for (const r of rows) {
  L.push(`\n### ${r.rel}`);
  for (const u of r.unparsable) L.push(`  L${u.line} ${u.fn}: ${u.reason} :: ${u.text.slice(0, 110)}`);
}
writeFileSync(path.join(outDir, 'census.md'), L.join('\n'));
console.log(L.join('\n'));
