import fs from 'node:fs';
const dir = process.argv[2] || '.run-dsh3/artifacts';
const statePath = dir + '/state.json';
const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));

// 1) 清掉陈旧的 in_flight（skeptic 指出：仍有 slice-01..04 的 UUID，且 started_at 晚于 terminal_at）
st.in_flight = [];

// 2) 补齐被 Skeptic 抓到的未申报裁量（U1/U3/L0）与修正 mechanical_check（M1）
const has = (t) => (st.discipline_log || []).some((e) => e.discretion_type === t);
const push = (e) => { if (!has(e.discretion_type)) st.discipline_log.push({ seq: st.discipline_log.length + 1, ...e }); };

push({
  wave: 'wave2b',
  discretion_type: 'DEEP_DIVE_SELECTION',
  action: '实际深挖 10 片（01/05/08/11/13/15/20/21/24/26），与 deep-dive-plan.md 的 12 片计划不一致；计划内 07/16/22 未执行，计划外 01/13/26 被执行',
  basis: '预算与墙钟时间优先给了「已确认高影响」与「用户点名维度」（concurrency/data-consistency/error-handling/contract）；07/16/22 的线索在深挖阶段被判定为低价值或已在相邻切片被覆盖。此裁量**未在派发时申报**，由 Skeptic A 的 mechanical 比对发现（U1）',
  evidence_ref: '.run-dsh3/deep-dive-plan.md vs .run-dsh3/artifacts/state.json 的 wave2_completed；round1-03-critique-skeptic-a.md 的 discipline_audit.undeclared_discretions',
  mechanical_check: 'diff 两份清单：`node -e "const s=require(\'./.run-dsh3/artifacts/state.json\');console.log(s.wave2_completed.filter(x=>x.task===\'deep_dive\').map(x=>x.slice_id).sort().join(\',\'))"` 与 deep-dive-plan.md 的表逐行比对',
  reversible: true,
});

push({
  wave: 'wave2b',
  discretion_type: 'DIMENSION_ASSIGNMENT',
  action: '10 条深挖记录的 dimension_assigned_by_discretion 全为 false，但 state.json 的 slices[*].deep_dive_dims 为空数组，没有「线索→维度」映射留痕',
  basis: '维度是按各 sweep 的 dimension_histogram 直接取的，未做主观调整；但字段留空使复核者无法从账本还原指派依据（Skeptic A 的 U2）',
  evidence_ref: 'round1-03-critique-skeptic-a.md 的 discipline_audit；各 round1-02-sweep-*.md 的 payload.dimension_histogram',
  mechanical_check: '对每个 slice，`wave2_completed` 里的 dimension 必须出现在该片 sweep 产物的 dimension_histogram 键中且计数 >0',
  reversible: true,
});

push({
  wave: 'wave2a',
  discretion_type: 'CONCURRENCY_CAP_BREACH',
  action: '并发峰值达到 5–6（上限 4），原因是用「产物已落盘」当作「agent 已到终态」补位；共两次（宽扫阶段一次、锐评阶段一次）',
  basis: '违反 protocol.md §1.2 L0（槽位释放条件是进入终态，不是文件已落盘）；属主 Agent 操作违规，不是子 Agent 失败',
  evidence_ref: 'round1-03-critique-skeptic-a.md 的 discipline_audit.l0_violations；RUN-REPORT.md 记录的并行实例',
  mechanical_check: '按 harness 的 agent 起止时间做区间重叠计数；或按产物 mtime 与 agent 派发顺序人工复核（不可完全机械化，故同时给出自述）',
  reversible: false,
});

// 3) 修正 seq1 的 mechanical_check 措辞与实际输出一致（M1）
for (const e of st.discipline_log) {
  if (e.discretion_type === 'SLICE_SIZE_DEVIATION') {
    e.basis = '侦察按非空行数装箱（1778 等），verify-artifacts G8 用物理行数口径；物理行数实测 34954，初版声明值与实测偏差 13–27%，修正后 26/26 片偏差 0.0%。9 个切片物理行数 >1800（最大 slice-01=2290；slice-10 为单文件 oversized）。重切会把 26 片推到 31+，超出本轮预算。';
    e.mechanical_check = 'node .run-dsh3/summarize.mjs ".run-dsh3/artifacts/round1-01-recon-slices.md" "<repo>" 应逐片打印 declared=physical、delta=0.0%；>1800 的片号可由同一输出数出（共 9 个）。注意：该命令验证的是「修正后一致」，不能复现「初版偏差 13–27%」——那一项只有旧值被覆盖前的对照才能复现，属不可回溯声明。';
  }
}

// 4) 账本状态推进
st.phase = 'wave3';
st.status = 'RUNNING';
st.report = st.report || {};
st.report.dir_ready = true;
st.report.dir_path = dir;
fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
console.log('state fixed: in_flight=0, discipline_log=' + st.discipline_log.length + ', phase=' + st.phase);
