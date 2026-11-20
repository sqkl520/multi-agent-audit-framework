import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || '.run-dsh3/artifacts';
const statePath = path.join(dir, 'state.json');
const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const files = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();

function envOf(f) {
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  const i = t.lastIndexOf('```json');
  if (i < 0) return null;
  const j = t.indexOf('```', i + 7);
  try { return JSON.parse(t.slice(i + 7, j).trim()); } catch { return null; }
}

const completed = [];
let sweeps = 0, audits = 0;
const now = new Date().toISOString();

for (const f of files) {
  if (/final-report|ledger|_index|_gate0/.test(f)) continue;
  const env = envOf(f);
  if (!env) continue;
  const p = env.payload || {};
  if (env.role === 'sweep' && p.slice_id && st.slices[p.slice_id]) {
    const s = st.slices[p.slice_id];
    s.state = 'DONE';
    s.sweep_artifact = f;
    s.lead_count = Array.isArray(p.leads) ? p.leads.length : 0;
    s.reachability = p.reachability || s.reachability;
    s.artifact_paths = Array.from(new Set([...(s.artifact_paths || []), f]));
    completed.push({ agent_id: env.agent_id, slice_id: p.slice_id, task: 'sweep', dimension: null,
      final_status: 'SUCCESS', artifact_path: f, lead_or_finding_count: s.lead_count });
    sweeps++;
  }
  if (env.role === 'audit') {
    const m = f.match(/^round1-02-audit-(slice-\d+)-([a-z-]+)\.md$/);
    if (!m) continue;
    const [, sid, dim] = m;
    const s = st.slices[sid];
    if (s) {
      s.deep_dive_done = Array.from(new Set([...(s.deep_dive_done || []), dim]));
      s.deep_dive_pending = (s.deep_dive_pending || []).filter(d => d !== dim);
      s.artifact_paths = Array.from(new Set([...(s.artifact_paths || []), f]));
    }
    const count = (p.findings || []).filter(x => x.status === 'CONFIRMED').length;
    completed.push({ agent_id: env.agent_id, slice_id: sid, task: 'deep_dive', dimension: dim,
      final_status: 'SUCCESS', artifact_path: f, lead_or_finding_count: count });
    audits++;
  }
}

st.wave2_completed = completed;
st.budget.spent = completed.length;
st.budget.spawned_deep_dive = audits;
st.budget.failed_sweep = 0;
st.budget.failed_deep_dive = 0;
st.phase = 'wave3';
st.status = 'RUNNING';
st.in_flight = [];
st.report.is_complete = false;

st.discipline_log = (st.discipline_log || []).filter(l => l.seq !== 2);
st.discipline_log.push({
  seq: 2,
  wave: 'wave2b',
  discretion_type: 'DEEP_DIVE_SELECTION',
  action: '在 12 个计划深挖之外增派 5 个实例（s26-DC、s04-logic、s20-security、s22-DC、s10-error-handling），并把 s22 的维度由 concurrency 改为 data-consistency；计划中的 s07-DC 未派。',
  basis: 's26 有 2 条 HIGH（YAML 原子降级、隔离文件写回），s04 有 2 条 HIGH（跨世界 distanceSquared、NaN 伤害），s20 有世界准入绕过线索，s22 的 nodes.yml 静默删除风险高于其唯一一条 LOW 并发线索，s10 有「无法校验即放行」的 HIGH；s07 的 2 条 MEDIUM 留给报告 §D。最终预算 26 宽扫 + 15 深挖 + 4 锐评 = 45 ≤ 60。',
  evidence_ref: '.run-dsh3/deep-dive-plan.md；.run-dsh3/artifacts/round1-02-audit-slice-26-data-consistency.md、-slice-04-logic.md、-slice-20-security.md、-slice-22-data-consistency.md、-slice-10-error-handling.md',
  mechanical_check: 'node -e "const fs=require(\'fs\');const d=\'.run-dsh3/artifacts\';console.log(fs.readdirSync(d).filter(f=>/^round1-02-audit-/.test(f)).length)" 应为 15；state.json.wave2_completed 中 task=deep_dive 的条数应同为 15；s07 无 audit 产物。',
  reversible: true
});

fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
console.log(`state rebuilt: sweeps=${sweeps} audits=${audits} spent=${st.budget.spent} phase=${st.phase}`);
