import fs from 'node:fs';
import path from 'node:path';

const dir = 'D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts';
const files = fs.readdirSync(dir).filter(f => /^round1-(01|02)-.*\.md$/.test(f)).sort();

function lastJson(file) {
  const txt = fs.readFileSync(path.join(dir, file), 'utf8');
  const idx = txt.lastIndexOf('```json');
  if (idx < 0) return null;
  const start = txt.indexOf('\n', idx) + 1;
  const end = txt.indexOf('```', start);
  try { return JSON.parse(txt.slice(start, end)); } catch (e) { return { parse_error: String(e) }; }
}

for (const f of files) {
  const j = lastJson(f);
  if (!j) { console.log(`## ${f}\nNO_JSON`); continue; }
  const p = j.payload || {};
  if (j.role === 'sweep') {
    const read = (p.files_read || []).map(x => x.path);
    console.log(`## ${f} | slice=${p.slice_id} | agent=${j.agent_id}`);
    console.log(`files_read(${read.length}):`);
    read.forEach(x => console.log('  R ' + x));
    console.log(`files_unreadable(${(p.files_unreadable || []).length}): ` + JSON.stringify(p.files_unreadable || []));
    console.log(`lead_count=${p.lead_count} hist=${JSON.stringify(p.dimension_histogram)}`);
  } else if (j.role === 'audit') {
    const read = (p.searched_scope?.files_read || p.files_read || []).map(x => (typeof x === 'string' ? x : x.path));
    const unread = p.searched_scope?.unreadable_files || p.unreadable_files || [];
    console.log(`## ${f} | slice=${p.slice_id} | dim=${p.dimension} | agent=${j.agent_id}`);
    console.log(`files_read(${read.length}):`);
    read.forEach(x => console.log('  R ' + x));
    console.log(`unreadable(${unread.length}): ` + JSON.stringify(unread));
    console.log(`findings: ` + JSON.stringify((p.findings || []).map(x => `${x.finding_id}:${x.status}:${x.severity}`)));
    console.log(`scope_keys=${Object.keys(p.searched_scope || {}).join(',')} payload_keys=${Object.keys(p).join(',')}`);
  }
}
