// Prototype driver for PLAN §A.2 "mode A": does assert-level subject matching survive
// real data? Read-only against the audited repo (git show / readFileSync only).
//
//   node run-mode-a.mjs --repo <path> [--ref HEAD] [--json <out>]

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { parseAssertions } from './parse-assertions.mjs';

/* ------------------------------------------------------------------ git */

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
}
function gitShow(repo, ref, rel) {
  try {
    return git(repo, ['show', `${ref}:${rel}`]);
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- rules */

const MESSAGE_RE = /\b(TEST_CONFLICT|TEST_ASSERTION_CHANGED)\b/;

function pclassRank(p) {
  // how much a predicate "gives up"; used only for reporting, never for gating by itself
  return { exact: 0, zero_or_empty: 1, negative: 1, non_empty: 1, existence_only: 3, truthy: 3, broadened: 3, interaction: 0 }[p] ?? 2;
}

export function detect(oldSrc, newSrc, { rel, reportedConflict = false } = {}) {
  const oldP = oldSrc === null ? null : parseAssertions(oldSrc);
  const newP = parseAssertions(newSrc);
  const findings = [];

  if (oldP) {
    for (const [subj, olds] of oldP.subjects) {
      const news = newP.subjects.get(subj);
      if (!news) {
        findings.push({
          rule: 'assertion_target_dropped',
          severity: 'FAIL',
          subject: subj,
          old: olds.map(fmtA),
          new: null,
        });
        continue;
      }
      // compare predicate class / expected
      const oldClasses = new Set(olds.map((a) => a.pclass));
      const newClasses = new Set(news.map((a) => a.pclass));
      const classChanged = [...oldClasses].some((c) => !newClasses.has(c));
      const oldExps = new Set(olds.map((a) => `${a.pclass}:${a.expected}`));
      const newExps = new Set(news.map((a) => `${a.pclass}:${a.expected}`));
      const valueChanged = [...oldExps].some((e) => !newExps.has(e));
      const widened =
        Math.max(...[...newClasses].map(pclassRank)) > Math.max(...[...oldClasses].map(pclassRank));

      if (classChanged || valueChanged || widened) {
        const sev = reportedConflict ? 'WARN' : 'FAIL';
        findings.push({
          rule: reportedConflict ? 'assertion_reversed_reported' : 'assertion_reversed_unreported',
          severity: sev,
          subject: subj,
          old: olds.map(fmtA),
          new: news.map(fmtA),
          detail: [classChanged && 'pclass', valueChanged && 'expected', widened && 'broadened']
            .filter(Boolean).join('+'),
        });
      }
    }
  }

  // test_disabled
  const disabled = [];
  const DISABLE_RE = /@Disabled\b(?!\s*\()|@Ignore\b|\bit\.skip\s*\(|@pytest\.mark\.skip|\bxfail\b/g;
  const oldDis = countDisable(oldSrc);
  const newDis = countDisable(newSrc);
  if (newDis.length > oldDis.length) {
    findings.push({ rule: 'test_disabled', severity: 'FAIL', added: newDis.slice(oldDis.length) });
  }

  const unparsableOld = oldP ? oldP.unparsable : [];
  return {
    rel,
    hasOld: oldP !== null,
    stats: {
      old: oldP ? oldP.stats : null,
      new: newP.stats,
    },
    findings,
    unparsable: { old: unparsableOld, new: newP.unparsable },
    containers: { old: oldP ? oldP.containers : [], new: newP.containers },
    subjectsOld: oldP ? [...oldP.subjects.keys()] : null,
    subjectsNew: [...newP.subjects.keys()],
  };
}

function countDisable(src) {
  if (src === null) return [];
  const out = [];
  const re = /@Disabled\b|\b@Ignore\b|\bit\.skip\s*\(|@pytest\.mark\.skip|\bxfail\b/g;
  let m;
  while ((m = re.exec(src))) out.push({ at: m.index, text: m[0] });
  return out;
}

function fmtA(a) {
  return `${a.pclass}(${a.expected}) @${a.line} ${a.method}`;
}

/* ---------------------------------------------------------------- driver */

function changedTestFiles(repo) {
  const out = [];
  const diff = git(repo, ['diff', '--name-only', '--diff-filter=M', '--', 'src/test']).trim();
  if (diff) for (const rel of diff.split('\n')) out.push({ rel, status: 'M' });
  const ren = git(repo, ['diff', '--name-only', '--diff-filter=R', '-M', '--', 'src/test']).trim();
  if (ren) for (const rel of ren.split('\n')) out.push({ rel, status: 'R' });
  const st = git(repo, ['status', '--porcelain', '--', 'src/test']).trim();
  for (const line of st.split('\n')) {
    if (line.startsWith('??')) out.push({ rel: line.slice(3).trim(), status: 'A' });
  }
  const dedup = new Map();
  for (const f of out) if (!dedup.has(f.rel)) dedup.set(f.rel, f);
  return [...dedup.values()];
}

const args = process.argv.slice(2);
const getArg = (k, d) => {
  const i = args.indexOf(k);
  return i >= 0 ? args[i + 1] : d;
};
const repo = getArg('--repo', '<TARGET_REPO>');
const ref = getArg('--ref', 'HEAD');
const outDir = getArg('--out', path.join(import.meta.dirname, 'out'));

mkdirSync(outDir, { recursive: true });

const files = changedTestFiles(repo);
const results = [];
for (const f of files) {
  const abs = path.join(repo, f.rel);
  const newSrc = readFileSync(abs, 'utf8');
  const oldSrc = gitShow(repo, ref, f.rel);
  results.push({ ...detect(oldSrc, newSrc, { rel: f.rel }), status: f.status });
}

const summary = {
  repo, ref,
  files: results.length,
  modified: results.filter((r) => r.hasOld).length,
  added: results.filter((r) => !r.hasOld).length,
  totalOldPhysicalAssertLines: results.reduce((a, r) => a + (r.stats.old?.physicalAssertLines ?? 0), 0),
  totalNewPhysicalAssertLines: results.reduce((a, r) => a + r.stats.new.physicalAssertLines, 0),
  oldCallSites: results.reduce((a, r) => a + (r.stats.old?.callSites ?? 0), 0),
  newCallSites: results.reduce((a, r) => a + r.stats.new.callSites, 0),
  oldParsed: results.reduce((a, r) => a + (r.stats.old?.parsed ?? 0), 0),
  newParsed: results.reduce((a, r) => a + r.stats.new.parsed, 0),
  oldUnparsable: results.reduce((a, r) => a + (r.stats.old?.unparsable ?? 0), 0),
  newUnparsable: results.reduce((a, r) => a + r.stats.new.unparsable, 0),
  findings: results.flatMap((r) => r.findings.map((x) => ({ ...x, file: r.rel }))),
};

writeFileSync(path.join(outDir, 'mode-a-result.json'), JSON.stringify({ summary, results }, null, 2));

/* ---------------------------------------------------------------- report */

const L = [];
L.push(`# mode A prototype run`);
L.push(`repo: ${repo}`);
L.push(`ref : ${ref}`);
L.push('');
L.push(`changed test files : ${summary.files} (modified ${summary.modified} / added ${summary.added})`);
L.push(`physical assert lines: old ${summary.totalOldPhysicalAssertLines} -> new ${summary.totalNewPhysicalAssertLines}`);
L.push(`assert call sites    : old ${summary.oldCallSites} -> new ${summary.newCallSites}`);
L.push(`parsed subjects      : old ${summary.oldParsed} -> new ${summary.newParsed}`);
L.push(`unparsable           : old ${summary.oldUnparsable} -> new ${summary.newUnparsable}`);
L.push('');
L.push(`## findings (${summary.findings.length})`);
for (const f of summary.findings) {
  L.push(`\n- [${f.severity}] ${f.rule}  ${f.file}`);
  L.push(`  subject: ${f.subject}`);
  if (f.old) L.push(`  old: ${f.old.join(' | ')}`);
  if (f.new) L.push(`  new: ${f.new.join(' | ')}`);
  if (f.detail) L.push(`  detail: ${f.detail}`);
}
L.push('\n## per-file');
for (const r of results) {
  L.push(`\n### ${r.rel}  (${r.status})`);
  L.push(`  old: phys=${r.stats.old?.physicalAssertLines ?? '-'} calls=${r.stats.old?.callSites ?? '-'} parsed=${r.stats.old?.parsed ?? '-'} unparsable=${r.stats.old?.unparsable ?? '-'} subjects=${r.stats.old?.distinctSubjects ?? '-'}`);
  L.push(`  new: phys=${r.stats.new.physicalAssertLines} calls=${r.stats.new.callSites} parsed=${r.stats.new.parsed} unparsable=${r.stats.new.unparsable} subjects=${r.stats.new.distinctSubjects}`);
  if (r.unparsable.new.length) {
    L.push('  unparsable samples:');
    for (const u of r.unparsable.new.slice(0, 8)) L.push(`    L${u.line} ${u.fn}: ${u.reason} :: ${u.text}`);
  }
  const fs2 = r.findings;
  if (fs2.length) L.push(`  findings: ${fs2.map((x) => x.rule).join(', ')}`);
}
writeFileSync(path.join(outDir, 'mode-a-report.md'), L.join('\n'));
console.log(L.join('\n'));
