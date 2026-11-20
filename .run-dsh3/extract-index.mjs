import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter(f => /^round1-02-(sweep|audit)-.*\.md$/.test(f)).sort();

function lastJson(txt) {
  const i = txt.lastIndexOf('```json');
  if (i < 0) return null;
  const start = i + '```json'.length;
  const end = txt.indexOf('```', start);
  if (end < 0) return null;
  const raw = txt.slice(start, end);
  try { return JSON.parse(raw); } catch (e) { return { __parseError: e.message, __raw: raw.slice(0, 400) }; }
}

const out = [];
out.push('# 已有产物索引（自动抽取，供主 Agent 汇总用）');
out.push('');
out.push('## A. 深挖 findings');
out.push('');
out.push('| artifact | finding_id | severity | dimension | status | file:line | claim |');
out.push('|---|---|---|---|---|---|---|');

const auditRows = [];
for (const f of files.filter(f => f.startsWith('round1-02-audit'))) {
  const txt = fs.readFileSync(path.join(dir, f), 'utf8');
  const o = lastJson(txt);
  if (!o || o.__parseError) { out.push(`| ${f} | PARSE_ERROR | | | | | ${o?.__parseError ?? 'no json'} |`); continue; }
  const fs2 = o.payload?.findings ?? [];
  for (const x of fs2) {
    const claim = (x.inference?.claim ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 260);
    const loc = x.evidence?.file ? `${x.evidence.file}:${x.evidence.line ?? ''}` : '';
    out.push(`| ${f} | ${x.finding_id} | ${x.severity ?? ''} | ${x.dimension ?? ''} | ${x.status} | ${loc} | ${claim} |`);
    auditRows.push({ artifact: f, ...x });
  }
}

out.push('');
out.push(`findings 总数（含 NO_EVIDENCE_FOUND / EVIDENCE_GAP）：${auditRows.length}`);
out.push('');
out.push('## B. 各深挖产物的 searched_scope（files_read 数 / slice 文件数）');
out.push('');
for (const f of files.filter(f => f.startsWith('round1-02-audit'))) {
  const o = lastJson(fs.readFileSync(path.join(dir, f), 'utf8'));
  const s = o?.payload?.searched_scope;
  if (s) out.push(`- ${f}: files_read=${s.files_read?.length ?? 0} / files_in_slice=${s.files_in_slice} / unreadable=${(s.unreadable_files ?? []).length}`);
}

out.push('');
out.push('## C. 宽扫 leads');
out.push('');
out.push('| slice | lead_id | suspected_dim | confidence | file:line | why_suspicious |');
out.push('|---|---|---|---|---|---|');
let leadCount = 0;
for (const f of files.filter(f => f.startsWith('round1-02-sweep'))) {
  const txt = fs.readFileSync(path.join(dir, f), 'utf8');
  const o = lastJson(txt);
  if (!o || o.__parseError) { out.push(`| ${f} | PARSE_ERROR | | | | ${o?.__parseError ?? 'no json'} |`); continue; }
  const leads = o.payload?.leads ?? [];
  for (const l of leads) {
    leadCount++;
    const w = (l.why_suspicious ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 220);
    out.push(`| ${o.payload?.slice_id ?? f} | ${l.lead_id} | ${l.suspected_dimension} | ${l.confidence} | ${l.file}:${l.line} | ${w} |`);
  }
}
out.push('');
out.push(`leads 总数：${leadCount}`);
out.push('');
out.push('## D. 解析失败/异常');
out.push('');

fs.writeFileSync(path.join(dir, '_index.md'), out.join('\n'), 'utf8');
console.log('OK rows=' + auditRows.length + ' leads=' + leadCount);
