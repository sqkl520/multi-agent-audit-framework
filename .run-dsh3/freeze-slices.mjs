import fs from 'node:fs';
const slices = JSON.parse(fs.readFileSync('.run-dsh3/slices.json', 'utf8'));
const statePath = '.run-dsh3/artifacts/state.json';
const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const out = {};
for (const s of slices) {
  out[s.slice_id] = {
    state: 'PENDING',
    files: s.files,
    reachability: null,
    sweep_artifact: null,
    lead_count: 0,
    deep_dive_dims: [],
    deep_dive_done: [],
    deep_dive_pending: [],
    artifact_paths: [],
    attempt: 0,
    failure: { error_type: null, observed: null, artifact_bytes: 0, last_write_at: null, inferred_cause: null },
  };
}
st.slices = out;
st.budget.planned_sweep_agents = slices.length;
st.phase = 'wave2a';
st.current_plan = {
  phase: 'wave2a',
  written_at: new Date().toISOString(),
  steps: [
    { id: 1, action: '按切片分 7 批派宽扫 agent（每批 4 个）', done_when: '26 个宽扫 agent 全部到终态' },
    { id: 2, action: '读全部 sweep 产物，统计 lead 并选深挖切片', done_when: 'lead 总数与 lead 分布落盘' },
    { id: 3, action: '按预算派深挖 agent（单切片单维度）', done_when: '深挖实例全部到终态且产物合规' },
  ],
  exit_condition: '26 个宽扫 + 全部深挖 agent 终态，账本更新完',
  current_step: 1,
  revised_at: null,
  revision_reason: null,
};
fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
console.log('slices written:', Object.keys(out).length, 'planned_sweep_agents:', st.budget.planned_sweep_agents);
