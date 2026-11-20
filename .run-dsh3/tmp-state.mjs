import fs from 'node:fs';
const p = 'D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts/state.json';
const j = JSON.parse(fs.readFileSync(p, 'utf8'));
console.log('status', j.status, 'phase', j.phase);
const ent = Object.entries(j.slices || {});
console.log('slices', ent.length);
for (const [id, x] of ent) {
  console.log([id, x.state, 'sweep=' + x.sweep_artifact, 'done=' + JSON.stringify(x.deep_dive_done), 'pending=' + JSON.stringify(x.deep_dive_pending), 'leads=' + x.lead_count, 'arts=' + (x.artifact_paths || []).length].join(' | '));
}
console.log('--- wave2_completed ---');
console.log(JSON.stringify(j.wave2_completed, null, 1).slice(0, 3000));
console.log('--- discipline_log entries ---', (j.discipline_log || []).length);
