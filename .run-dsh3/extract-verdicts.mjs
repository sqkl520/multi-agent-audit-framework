import fs from 'node:fs';
import path from 'node:path';

const dir = '.run-dsh3/artifacts';
const files = fs.readdirSync(dir).filter(f => /^round1-03-.*\.md$/.test(f)).sort();

function envelope(text) {
  const idx = text.lastIndexOf('```json');
  if (idx < 0) return null;
  const end = text.indexOf('```', idx + 7);
  try { return JSON.parse(text.slice(idx + 7, end)); } catch { return null; }
}

const out = { artifacts: [], verdicts: [], gaps: [] };
for (const f of files) {
  const env = envelope(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!env?.payload) { console.log('SKIP ' + f); continue; }
  const p = env.payload;
  out.artifacts.push({ file: f, role: p.critique_role, agent_id: env.agent_id, verdicts: (p.verdicts || []).length, gaps: (p.coverage_gaps || []).length });
  for (const v of p.verdicts || []) {
    out.verdicts.push({
      source: f, critique_role: p.critique_role, finding_id: v.finding_id, verdict: v.verdict,
      reason: (v.reason || '').replace(/\s+/g, ' ').slice(0, 400),
      missing: v.missing_evidence || null,
      five_step: v.five_step ? Object.entries(v.five_step).map(([k, x]) => `${k}=${x}`).join(',') : null,
    });
  }
  for (const g of p.coverage_gaps || []) {
    out.gaps.push({ source: f, ...g });
  }
}
fs.writeFileSync('.run-dsh3/verdicts-summary.json', JSON.stringify(out, null, 2), 'utf8');

const md = [];
md.push('# 锐评裁决汇总（机械抽取）');
md.push('');
for (const a of out.artifacts) md.push(`- ${a.file} · ${a.role} · verdicts=${a.verdicts} · gaps=${a.gaps}`);
md.push('');
md.push('## verdicts');
md.push('');
md.push('| source | role | finding_id | verdict | reason(节选) |');
md.push('|---|---|---|---|---|');
for (const v of out.verdicts) {
  md.push(`| ${v.source.replace('round1-03-critique-', '').replace('.md', '')} | ${v.critique_role} | ${v.finding_id} | ${v.verdict} | ${(v.reason || '').replace(/\|/g, '\\|').slice(0, 220)} |`);
}
md.push('');
md.push('## coverage_gaps');
md.push('');
for (const g of out.gaps) md.push(`- [${g.kind}] ${g.target} — ${(g.reason || g.potential_impact || '').replace(/\s+/g, ' ').slice(0, 200)}`);
fs.writeFileSync('.run-dsh3/verdicts-summary.md', md.join('\n'), 'utf8');
console.log('verdicts=' + out.verdicts.length + ' gaps=' + out.gaps.length);
console.log(out.artifacts.map(a => `${a.file}:${a.role}:${a.verdicts}/${a.gaps}`).join('\n'));
