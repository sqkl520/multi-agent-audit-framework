import fs from 'node:fs';
import path from 'node:path';

const dir = '.run-dsh3/artifacts';
const files = fs.readdirSync(dir).filter(f => /^round1-02-audit-.*\.md$/.test(f)).sort();

function envelope(text) {
  const idx = text.lastIndexOf('```json');
  if (idx < 0) return null;
  const end = text.indexOf('```', idx + 7);
  try { return JSON.parse(text.slice(idx + 7, end)); } catch { return null; }
}

const audits = [];
const findings = [];
for (const f of files) {
  const env = envelope(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!env || !env.payload) { console.log('SKIP ' + f); continue; }
  const p = env.payload;
  const conf = (p.findings || []).filter(x => x.status === 'CONFIRMED');
  audits.push({ file: f, slice: p.slice_id, dim: conf[0]?.dimension || null, confirmed: conf.length, total: (p.findings || []).length });
  for (const x of p.findings || []) {
    findings.push({
      audit_file: f,
      slice: p.slice_id,
      finding_id: x.finding_id,
      severity: x.severity,
      dimension: x.dimension,
      status: x.status,
      file: x.evidence?.file || null,
      line: x.evidence?.line ?? null,
      claim: x.inference?.claim || null,
      alternatives: x.inference?.alternatives?.length ?? 0,
    });
  }
}

const bySev = {};
for (const f of findings.filter(x => x.status === 'CONFIRMED')) bySev[f.severity] = (bySev[f.severity] || 0) + 1;
const byDim = {};
for (const f of findings.filter(x => x.status === 'CONFIRMED')) byDim[f.dimension] = (byDim[f.dimension] || 0) + 1;

const out = {
  generated_at: new Date().toISOString(),
  audits,
  counts: {
    audits: audits.length,
    confirmed: findings.filter(x => x.status === 'CONFIRMED').length,
    non_confirmed: findings.filter(x => x.status !== 'CONFIRMED').length,
    by_severity: bySev,
    by_dimension: byDim,
  },
  findings,
};
fs.writeFileSync('.run-dsh3/findings-inventory.json', JSON.stringify(out, null, 2), 'utf8');

const md = [];
md.push('# 深挖发现清单（机械抽取）');
md.push('');
md.push(`- 审计产物：${audits.length} 份；CONFIRMED：${out.counts.confirmed} 条；非 CONFIRMED 条目：${out.counts.non_confirmed} 条。`);
md.push(`- 严重性：${Object.entries(bySev).map(([k, v]) => `${k} ${v}`).join(' / ') || '—'}`);
md.push(`- 维度：${Object.entries(byDim).map(([k, v]) => `${k} ${v}`).join(' / ') || '—'}`);
md.push('');
md.push('| # | finding_id | 严重性 | 维度 | 位置 | claim | 状态 |');
md.push('|---|---|---|---|---|---|---|');
let i = 0;
for (const f of findings) {
  i++;
  const claim = (f.claim || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  md.push(`| ${i} | ${f.finding_id} | ${f.severity ?? 'null'} | ${f.dimension} | \`${(f.file || '').replace('src/main/java/com/hilltopvillage/', '')}:${f.line ?? '-'}\` | ${claim} | ${f.status} |`);
}
md.push('');
md.push('## 按审计产物');
md.push('');
md.push('| 产物 | 切片 | 维度 | CONFIRMED | 条目总数 |');
md.push('|---|---|---|---|---|');
for (const a of audits) md.push(`| ${a.file} | ${a.slice} | ${a.dim || '—'} | ${a.confirmed} | ${a.total} |`);
fs.writeFileSync('.run-dsh3/findings-inventory.md', md.join('\n'), 'utf8');
console.log(JSON.stringify(out.counts, null, 2));
console.log('audits=' + audits.length);
for (const a of audits) console.log(`${a.file} ${a.slice} ${a.dim} confirmed=${a.confirmed}/${a.total}`);
