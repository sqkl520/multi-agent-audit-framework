import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || '.run-dsh3/artifacts';
const st = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));

const slices = Object.entries(st.slices || {});
const done = slices.filter(([, s]) => s.state === 'DONE').length;
const pending = slices.filter(([, s]) => s.state === 'PENDING').length;

let md = `# round1 账本\n\n`;
md += `> 本文件是 \`state.json\` 的可读投影，两者不一致时以 \`state.json\` 为准。生成命令：\`node .run-dsh3/build-ledger.mjs\`。\n\n`;
md += `## 1. 切片状态表\n\n| slice_id | 状态 | 文件数 | 线索/发现数 | attempt | 产物 |\n|---|---|---|---|---|---|\n`;
for (const [id, s] of slices) {
  md += `| ${id} | ${s.state} | ${(s.files || []).length} | ${s.lead_count ?? 0} | ${s.attempt ?? 0} | ${(s.artifact_paths || []).join('<br>') || '—'} |\n`;
}
md += `\n合计：${slices.length} 片，DONE ${done}，PENDING ${pending}。\n`;

md += `\n## 2. 预算\n\n| total_cap | spent | 剩余 | 说明 |\n|---|---|---|---|\n`;
md += `| ${st.budget.total_cap} | ${st.budget.spent} | ${st.budget.total_cap - st.budget.spent} | planned_sweep_agents=${st.budget.planned_sweep_agents}；spawned_deep_dive=${st.budget.spawned_deep_dive}；failed_sweep=${st.budget.failed_sweep}；failed_deep_dive=${st.budget.failed_deep_dive} |\n`;

md += `\n## 3. 失败分类\n\n| slice_id | error_type | artifact_bytes | last_write_at | inferred_cause | 重派策略 |\n|---|---|---|---|---|---|\n`;
let anyFail = false;
for (const [id, s] of slices) {
  const f = s.failure || {};
  if (f.error_type) {
    anyFail = true;
    md += `| ${id} | ${f.error_type} | ${f.artifact_bytes ?? 0} | ${f.last_write_at ?? '—'} | ${f.inferred_cause ?? '—'} | 原样重派 |\n`;
  }
}
if (!anyFail) md += `| — | — | — | — | 无失败切片 | — |\n`;

md += `\n## 4. 裁量日志（discipline_log）\n\n| seq | 波次 | 类型 | 动作 | 依据 | 机械复核方法 |\n|---|---|---|---|---|---|\n`;
for (const l of st.discipline_log || []) {
  md += `| ${l.seq} | ${l.wave} | ${l.discretion_type} | ${l.action} | ${l.basis} | ${l.mechanical_check} |\n`;
}
if (!(st.discipline_log || []).length) md += `| — | — | — | 无裁量 | — | — |\n`;

md += `\n## 5. 轮次链\n\n| 轮次 | 覆盖 | 新增发现 | DEFERRED 剩余 | 状态 |\n|---|---|---|---|---|\n`;
md += `| round1 | 见 §1 | 见最终报告 | ${pending} | ${st.status} |\n`;

fs.writeFileSync(path.join(dir, 'round1-ledger.md'), md);
console.log('ledger written:', path.join(dir, 'round1-ledger.md'), 'slices=' + slices.length, 'done=' + done);
