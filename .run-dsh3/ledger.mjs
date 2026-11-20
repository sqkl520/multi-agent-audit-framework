import fs from 'node:fs';
const statePath = '.run-dsh3/artifacts/state.json';
const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const mode = process.argv[2];

if (mode === 'discipline') {
  st.discipline_log.push({
    seq: st.discipline_log.length + 1,
    wave: 'wave1',
    discretion_type: 'SLICE_SIZE_DEVIATION',
    action: '保留 9 个物理行数 >1800 的切片（最大 slice-01=2290；slice-10 为单文件 oversized），未重新切分',
    basis: '侦察按非空行数装箱（1778 等），verify-artifacts G8 用物理行数口径；物理行数实测 34954，偏差 13–27%。重新切分会把切片数从 26 推到 31+，超出本轮预算；9 个切片均在 2300 物理行以内，单 agent 可在 20 文件预算内读完',
    evidence_ref: '.run-dsh3/artifacts/round1-01-recon-slices.md（payload.audit_slices[].line_count）+ .run-dsh3/summarize.mjs 的 declared/physical 对账输出',
    mechanical_check: 'node .run-dsh3/summarize.mjs ".run-dsh3/artifacts/round1-01-recon-slices.md" "<repo>" 逐片打印 declared 与 physical，偏差应为 0.0%；>1800 的片号可由同一输出直接数出',
    reversible: true,
  });
}

const readArg = (a) => (a && a.startsWith('@') ? fs.readFileSync(a.slice(1), 'utf8') : a);

if (mode === 'flight') {
  const items = JSON.parse(readArg(process.argv[3]));
  st.in_flight.push(...items);
}

if (mode === 'clearflight') {
  const ids = JSON.parse(readArg(process.argv[3]));
  st.in_flight = st.in_flight.filter((x) => !ids.includes(x.agent_id));
}

fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
console.log('ok', mode, 'in_flight=' + st.in_flight.length, 'discipline=' + st.discipline_log.length);
