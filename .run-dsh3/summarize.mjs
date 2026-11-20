import fs from 'node:fs';
import path from 'node:path';

const p = process.argv[2];
const repo = process.argv[3] || null;
const t = fs.readFileSync(p, 'utf8');
const fence = '```json';
const blocks = [];
let idx = 0;
while (true) {
  const i = t.indexOf(fence, idx);
  if (i < 0) break;
  const j = t.indexOf('```', i + fence.length);
  if (j < 0) break;
  blocks.push(t.slice(i + fence.length, j));
  idx = j + 3;
}
let last = null;
for (const b of blocks) {
  try { last = JSON.parse(b.trim()); } catch (e) { console.error('parse fail:', e.message); }
}
if (!last) { console.error('no parsable envelope'); process.exit(1); }
const pay = last.payload || {};
console.log('role', last.role, 'status', last.status, 'slice_count', pay.slice_count, 'slices', (pay.audit_slices || []).length);

const out = [];
for (const s of pay.audit_slices || []) {
  let physical = 0;
  let missing = 0;
  if (repo) {
    for (const f of s.files || []) {
      const abs = path.join(repo, f);
      try {
        const txt = fs.readFileSync(abs, 'utf8');
        physical += txt.split(/\r?\n/).length;
      } catch { missing++; }
    }
  }
  out.push({ slice_id: s.slice_id, root: s.root_dir, files: s.files, line_count: s.line_count, physical_lines: physical, missing_files: missing, oversized: !!s.oversized_file });
}
if (process.argv[4]) fs.writeFileSync(process.argv[4], JSON.stringify(out, null, 1));
for (const o of out) {
  const delta = o.physical_lines ? ((o.physical_lines - o.line_count) / o.physical_lines * 100).toFixed(1) + '%' : 'n/a';
  console.log([o.slice_id, 'declared=' + o.line_count, 'physical=' + o.physical_lines, 'delta=' + delta, 'n=' + o.files.length, o.missing_files ? 'MISSING=' + o.missing_files : ''].join('\t'));
}
