import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || '.run-dsh3/artifacts';
const outMd = process.argv[3] || '.run-dsh3/audit-summary.md';
const outJson = process.argv[4] || '.run-dsh3/envelopes.json';

const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
const envs = [];
const parseErrors = [];
for (const f of files) {
  if (/final-report|ledger/.test(f)) continue;
  const p = path.join(dir, f);
  const t = fs.readFileSync(p, 'utf8');
  const fence = '```json';
  let i = t.lastIndexOf(fence);
  if (i < 0) { parseErrors.push({ file: f, error: 'no json fence' }); continue; }
  const j = t.indexOf('```', i + fence.length);
  let env = null;
  try { env = JSON.parse(t.slice(i + fence.length, j).trim()); } catch (e) { parseErrors.push({ file: f, error: e.message }); continue; }
  envs.push({ file: f, env });
}

const rows = [];
const findings = [];
for (const { file, env } of envs) {
  const p = env.payload || {};
  const base = { file, role: env.role, agent_id: env.agent_id, status: env.status, artifact_path: env.artifact_path };
  if (env.role === 'sweep') {
    Object.assign(base, { slice: p.slice_id, reachability: p.reachability, leads: (p.leads || []).length, files_read: (p.files_read || []).length });
    for (const l of p.leads || []) {
      rows.push({ kind: 'lead', slice: p.slice_id, id: l.lead_id, dim: l.suspected_dimension, sev: l.confidence, loc: `${short(l.file)}:${l.line}`, note: oneLine(l.why_suspicious) });
    }
  } else if (env.role === 'audit') {
    const fsr = p.searched_scope?.files_read || [];
    const conf = (p.findings || []).filter((f) => f.status === 'CONFIRMED').length;
    Object.assign(base, { dimension: (p.findings || [])[0]?.dimension || null, confirmed: conf, files_read: fsr.length });
    for (const f of p.findings || []) {
      findings.push({ id: f.finding_id, status: f.status, severity: f.severity, dimension: f.dimension, loc: f.evidence ? `${short(f.evidence.file)}:${f.evidence.line}` : null, claim: oneLine(f.inference?.claim), artifact: file });
    }
  } else if (env.role === 'critique') {
    Object.assign(base, { critique_role: p.critique_role, verdicts: (p.verdicts || []).length, gaps: (p.coverage_gaps || []).length });
  } else if (env.role === 'recon') {
    Object.assign(base, { slices: p.slice_count, entry_points: (p.entry_points || []).length, unverified: (p.unverified || []).length });
  }
  rows.push({ kind: 'artifact', ...base });
}

function short(f) { return String(f || '').replace('src/main/java/com/hilltopvillage/', ''); }
function oneLine(s) { return String(s || '').replace(/\s+/g, ' ').slice(0, 150); }

let md = '# 产物聚合摘要（机械生成）\n\n';
md += `产物文件：${files.length}；解析成功信封：${envs.length}；解析失败：${parseErrors.length}\n\n`;
if (parseErrors.length) md += '解析失败：\n' + parseErrors.map((e) => `- ${e.file}: ${e.error}`).join('\n') + '\n\n';
md += '## 信封清单\n\n| file | role | agent_id | status | slice/dim/role | 计数 |\n|---|---|---|---|---|---|\n';
for (const r of rows.filter((x) => x.kind === 'artifact')) {
  const tag = r.role === 'sweep' ? `${r.slice} ${r.reachability} leads=${r.leads}` : r.role === 'audit' ? `${r.dimension} confirmed=${r.confirmed}` : r.role === 'critique' ? `${r.critique_role} verdicts=${r.verdicts} gaps=${r.gaps}` : r.role === 'recon' ? `slices=${r.slices}` : '';
  md += `| ${r.file} | ${r.role} | ${r.agent_id} | ${r.status} | ${tag} | |\n`;
}
md += '\n## 线索（lead）\n\n| slice | id | dim | conf | 位置 | 摘要 |\n|---|---|---|---|---|---|\n';
for (const r of rows.filter((x) => x.kind === 'lead')) md += `| ${r.slice} | ${r.id} | ${r.dim} | ${r.sev} | ${r.loc} | ${r.note} |\n`;
md += '\n## 发现（finding）\n\n| id | status | severity | dim | 位置 | 摘要 | 产物 |\n|---|---|---|---|---|---|---|\n';
for (const f of findings) md += `| ${f.id} | ${f.status} | ${f.severity} | ${f.dimension} | ${f.loc} | ${f.claim} | ${f.artifact} |\n`;

fs.writeFileSync(outMd, md);
fs.writeFileSync(outJson, JSON.stringify({ envelopes: envs.map((e) => ({ file: e.file, ...e.env })), findings, parseErrors }, null, 1));
console.log(`files=${files.length} envelopes=${envs.length} leads=${rows.filter((r) => r.kind === 'lead').length} findings=${findings.length} parseErrors=${parseErrors.length}`);
console.log('wrote', outMd, 'and', outJson);
