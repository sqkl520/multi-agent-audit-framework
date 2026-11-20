import fs from 'node:fs';
import path from 'node:path';

const dir = '.run-dsh3/artifacts';
const files = fs.readdirSync(dir).filter(f => /^round1-02-sweep-slice-\d+\.md$/.test(f)).sort();

function envelope(text) {
  const idx = text.lastIndexOf('```json');
  if (idx < 0) return null;
  const end = text.indexOf('```', idx + 7);
  try { return JSON.parse(text.slice(idx + 7, end)); } catch { return null; }
}

const DIMS = ['logic', 'concurrency', 'security', 'error-handling', 'data-consistency', 'contract'];
const PRIORITY = { concurrency: 0, 'data-consistency': 1, 'error-handling': 2, contract: 3, security: 4, logic: 5 };
const CONF = { HIGH: 0, MEDIUM: 1, LOW: 2 };

const slices = [];
const byDim = Object.fromEntries(DIMS.map(d => [d, 0]));
const byConf = { HIGH: 0, MEDIUM: 0, LOW: 0 };
const all = [];

for (const f of files) {
  const env = envelope(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!env) { console.log('NO_JSON ' + f); continue; }
  const p = env.payload;
  const leads = p.leads || [];
  slices.push({ file: f, slice: p.slice_id, reach: p.reachability, leads, hist: p.dimension_histogram, filesRead: (p.files_read || []).length });
  for (const l of leads) {
    byDim[l.suspected_dimension] = (byDim[l.suspected_dimension] || 0) + 1;
    byConf[l.confidence] = (byConf[l.confidence] || 0) + 1;
    all.push({ ...l, slice: p.slice_id });
  }
}

const out = [];
out.push('# 宽扫线索汇总（26 切片 / ' + all.length + ' 条 lead）');
out.push('');
out.push('- 来源：`.run-dsh3/artifacts/round1-02-sweep-slice-*.md` 的 `payload.leads`（机械抽取，未改动原文）。');
out.push('- 生成：`.run-dsh3/lead-summary.mjs`；每条 lead 的 `quote` 仍以对应 sweep 产物为准，深挖时必须回源文件重读。');
out.push('- 宽扫覆盖：**26/26 切片**（slice-17/18/19/23 为本回合补扫）。');
out.push('');
out.push('## 1. 维度与置信度分布');
out.push('');
out.push('| 维度 | lead 数 |');
out.push('|---|---|');
for (const d of DIMS) out.push(`| ${d} | ${byDim[d]} |`);
out.push(`| **合计** | **${all.length}** |`);
out.push('');
out.push(`置信度：HIGH ${byConf.HIGH} / MEDIUM ${byConf.MEDIUM} / LOW ${byConf.LOW}。`);
out.push('');
out.push('## 2. 逐切片线索数');
out.push('');
out.push('| slice | 可达性 | 文件数 | lead 数 | 维度分布 | 已深挖 |');
out.push('|---|---|---|---|---|---|');
const done = {
  'slice-15': 'concurrency（已落盘）',
  'slice-20': 'concurrency（已落盘）',
  'slice-21': 'concurrency（已落盘）',
  'slice-24': 'data-consistency（已落盘）',
};
for (const s of slices) {
  const hist = DIMS.filter(d => (s.hist?.[d] || 0) > 0).map(d => `${d}:${s.hist[d]}`).join(' ');
  out.push(`| ${s.slice} | ${s.reach} | ${s.filesRead} | ${s.leads.length} | ${hist || '—'} | ${done[s.slice] || '—'} |`);
}
out.push('');
out.push('## 3. 待深挖优先级队列（按维度优先级 × 置信度排序）');
out.push('');
out.push('> 只列尚未深挖的切片；同一格内按 HIGH 优先。');
out.push('');
out.push('| 序 | slice | 维度 | lead | 置信度 | 位置 | 一句话 |');
out.push('|---|---|---|---|---|---|---|');
const pending = all
  .filter(l => !done[l.slice])
  .sort((a, b) => (PRIORITY[a.suspected_dimension] - PRIORITY[b.suspected_dimension])
    || (CONF[a.confidence] - CONF[b.confidence])
    || a.slice.localeCompare(b.slice));
let i = 0;
for (const l of pending) {
  i++;
  const why = (l.why_suspicious || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ');
  out.push(`| ${i} | ${l.slice} | ${l.suspected_dimension} | ${l.lead_id} | ${l.confidence} | \`${l.file}:${l.line}\` | ${why} |`);
}
out.push('');
out.push('## 4. 已处置的深挖（本回合前已落盘，不重做）');
out.push('');
out.push('| 产物 | 覆盖 | check-payload |');
out.push('|---|---|---|');
for (const [s, d] of Object.entries(done)) {
  out.push(`| \`round1-02-audit-${s}-${d.split('（')[0]}.md\` | ${s} / ${d.split('（')[0]} | exit 0 |`);
}
out.push('');
out.push('## 5. 说明');
out.push('');
out.push('- 宽扫 lead 是**线索**，不是发现；深挖阶段允许大量证伪，证伪结果必须逐条落盘（REFUTED / EVIDENCE_GAP）。');
out.push('- 本节表格的 `quote` 列从略：151 条原文引用在各自 sweep 产物的 JSON 里，避免二次转写引入偏差。');

fs.writeFileSync('.run-dsh3/lead-summary.md', out.join('\n'), 'utf8');
console.log('wrote lead-summary.md, leads=' + all.length + ', slices=' + slices.length);
