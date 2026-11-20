import fs from 'node:fs';
const p = 'D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/audit-summary.md';
const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
const dims = {}; const bySlice = {}; let n = 0;
for (const l of lines) {
  const m = l.match(/^\|\s*(slice-\d+)\s*\|\s*(L\d+)\s*\|\s*([a-z-]+)\s*\|/);
  if (!m) continue;
  n++;
  dims[m[3]] = (dims[m[3]] || 0) + 1;
  bySlice[m[1]] = (bySlice[m[1]] || 0) + 1;
}
console.log('lead rows', n);
console.log('by dim', JSON.stringify(dims));
const deep = new Set(['slice-01','slice-04','slice-05','slice-08','slice-10','slice-11','slice-13','slice-15','slice-16','slice-20','slice-21','slice-22','slice-24','slice-26']);
let inDeep = 0, inSweepOnly = 0; let deepDims = {}; let sweepDims = {};
for (const [s, c] of Object.entries(bySlice)) {
  if (deep.has(s)) inDeep += c; else inSweepOnly += c;
}
console.log('leads in deep-audited slices', inDeep, 'in sweep-only slices', inSweepOnly);
console.log('per-slice', JSON.stringify(bySlice));
