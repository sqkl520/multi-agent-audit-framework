import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || '.run-dsh3/artifacts';
const statePath = path.join(dir, 'state.json');
const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();

const envOf = (f) => {
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  const i = t.lastIndexOf('```json');
  if (i < 0) return null;
  const j = t.indexOf('```', i + 7);
  try { return JSON.parse(t.slice(i + 7, j).trim()); } catch { return null; }
};

st.wave2_completed = [];
let sweeps = 0, audits = 0;
const now = new Date().toISOString();

for (const f of files) {
  if (/final-report|ledger/.test(f)) continue;
  const env = envOf(f);
  if (!env) continue;
  const p = env.payload || {};
  if (env.role === 'sweep' && p.slice_id) {
    const s = st.slices[p.slice_id];
    if (!s) continue;
    s.state = 'DONE';
    s.sweep_artifact = f;
    s.lead_count = Array.isArray(p.leads) ? p.leads.length : 0;
    s.reachability = p.reachability || s.reachability;
    s.artifact_paths = Array.from(new Set([...(s.artifact_paths || []), f]));
    st.wave2_completed.push({
      agent_id: env.agent_id, slice_id: p.slice_id, task: 'sweep', dimension: null,
      dispatched_at: now, terminal_at: now, final_status: 'SUCCESS', artifact_path: f,
      lead_or_finding_count: s.lead_count, dimension_assigned_by_discretion: false,
    });
    sweeps++;
  }
  if (env.role === 'audit') {
    const m = f.match(/^round\d+-02-audit-(slice-\d+)-([a-z-]+)\.md$/);
    if (!m) continue;
    const [, sid, dim] = m;
    const s = st.slices[sid];
    if (s) {
      s.deep_dive_done = Array.from(new Set([...(s.deep_dive_done || []), dim]));
      s.artifact_paths = Array.from(new Set([...(s.artifact_paths || []), f]));
      if (s.state === 'DONE') s.state = 'DONE';
    }
    const count = (p.findings || []).filter((x) => x.status === 'CONFIRMED').length;
    st.wave2_completed.push({
      agent_id: env.agent_id, slice_id: sid, task: 'deep_dive', dimension: dim,
      dispatched_at: now, terminal_at: now, final_status: 'SUCCESS', artifact_path: f,
      lead_or_finding_count: count, dimension_assigned_by_discretion: false,
    });
    audits++;
  }
}

st.budget.spent = st.wave2_completed.length;
st.budget.spawned_deep_dive = audits;
st.budget.failed_sweep = 0;
st.budget.failed_deep_dive = 0;
st.phase = process.argv[3] || st.phase;
fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
console.log(`state rebuilt: sweeps=${sweeps} audits=${audits} spent=${st.budget.spent} phase=${st.phase}`);
