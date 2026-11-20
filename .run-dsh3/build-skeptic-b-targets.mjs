import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter(f => /^round1-02-audit-.*\.md$/.test(f)).sort();
function lastJson(txt) {
  const i = txt.lastIndexOf('```json');
  const start = i + 7;
  const end = txt.indexOf('```', start);
  return JSON.parse(txt.slice(start, end));
}
const rows = [];
for (const f of files) {
  const env = lastJson(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const x of env.payload?.findings ?? []) {
    if (x.status !== 'CONFIRMED') continue;
    if (x.dimension === 'concurrency') continue;
    rows.push({ artifact: f, finding_id: x.finding_id, severity: x.severity, dimension: x.dimension,
      file: x.evidence.file, line: x.evidence.line, quote: x.evidence.quote,
      claim: x.inference.claim, basis: x.inference.basis, alternatives: x.inference.alternatives });
  }
}
rows.sort((a, b) => a.dimension.localeCompare(b.dimension) || a.finding_id.localeCompare(b.finding_id));
const md = [];
md.push('# skeptic-b 目标清单（非并发 CONFIRMED，机械生成）');
md.push('');
md.push(`共 ${rows.length} 条。每条都要执行五步测试并给 verdict；不得遗漏任何 finding_id。`);
md.push('');
for (const r of rows) {
  md.push(`## ${r.finding_id}`);
  md.push(`- dimension: ${r.dimension} / severity: ${r.severity}`);
  md.push(`- evidence: \`${r.file}:${r.line}\``);
  md.push(`- artifact: \`${r.artifact}\``);
  md.push(`- claim: ${r.claim}`);
  md.push(`- basis: ${r.basis}`);
  md.push(`- alternatives: ${(r.alternatives || []).join(' | ')}`);
  md.push('');
}
fs.writeFileSync(path.join(dir, 'round1-03-skeptic-b-targets.md'), md.join('\n'), 'utf8');
fs.writeFileSync(path.join(dir, 'round1-03-skeptic-b-targets.json'), JSON.stringify(rows.map(r => r.finding_id), null, 2), 'utf8');
console.log('targets=' + rows.length + ' ' + JSON.stringify(rows.map(r => r.finding_id)));
