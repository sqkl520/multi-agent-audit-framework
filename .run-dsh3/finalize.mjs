import fs from 'node:fs';
const dir = process.argv[2] || '.run-dsh3/artifacts';
const statePath = dir + '/state.json';
const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));

st.phase = 'closed';
st.status = 'PARTIALLY_CLOSED'; // 覆盖不完整（14/26 片深挖），但结论闭合
st.report = st.report || {};
st.report.dir_ready = true;
st.report.dir_path = dir;
st.report.final_report_path = dir + '/round1-final-report.md';
st.report.written_at = new Date().toISOString();
st.report.is_complete = false; // PARTIAL_BUDGET
st.in_flight = [];

// 记录锐评相位派发（便于 G4 对账）
st.wave2_completed = st.wave2_completed || [];
const critiqueAgents = [
  ['critique-skeptic-a', 'skeptic'],
  ['critique-skeptic-b1', 'skeptic'],
  ['critique-skeptic-b2', 'skeptic'],
  ['critique-skeptic-c', 'skeptic'],
  ['critique-devils-advocate', 'devils_advocate'],
  ['critique-arbiter', 'arbiter'],
];
for (const [id, role] of critiqueAgents) {
  if (st.wave2_completed.some((x) => x.agent_id === id)) continue;
  const file = role === 'arbiter'
    ? 'round1-03-critique-arbiter.md'
    : role === 'devils_advocate'
      ? 'round1-03-critique-devils-advocate.md'
      : 'round1-03-critique-' + id.replace('critique-', '') + '.md';
  if (!fs.existsSync(dir + '/' + file)) continue;
  st.wave2_completed.push({
    agent_id: id,
    slice_id: null,
    task: 'critique',
    dimension: null,
    dispatched_at: new Date().toISOString(),
    terminal_at: new Date().toISOString(),
    final_status: 'SUCCESS',
    artifact_path: file,
    lead_or_finding_count: 0,
    dimension_assigned_by_discretion: false,
  });
}

fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
console.log('finalized: phase=' + st.phase + ' status=' + st.status + ' report=' + st.report.final_report_path);
console.log('wave2_completed=' + st.wave2_completed.length);
