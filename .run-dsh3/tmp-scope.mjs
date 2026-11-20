import fs from 'node:fs';
const dir = 'D:/Projects/AI prompt/many-agents_multi-prompt-files_token-heavy/multi-agent-audit-framework/.run-dsh3/artifacts';
for (const f of fs.readdirSync(dir).filter(f => f.startsWith('round1-02-audit-')).sort()) {
  const txt = fs.readFileSync(`${dir}/${f}`, 'utf8');
  const i = txt.lastIndexOf('```json');
  const j = JSON.parse(txt.slice(txt.indexOf('\n', i) + 1, txt.indexOf('```', txt.indexOf('\n', i) + 1)));
  const s = j.payload.searched_scope || {};
  console.log(`## ${f}`);
  console.log(` slice_id=${j.payload.slice_id} files_in_slice=${JSON.stringify(s.files_in_slice)}`);
  console.log(` shared=${JSON.stringify(s.shared_dependencies_read)}`);
  console.log(` without=${JSON.stringify(s.files_scanned_without_findings)}`);
  console.log(` check=${(s.dimension_checklist||[]).length} keys=${Object.keys(j.payload).join(',')}`);
}
