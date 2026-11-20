import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2];
const repo = process.argv[3];
const files = fs.readdirSync(dir).filter(f => /^round1-02-audit-.*\.md$/.test(f)).sort();

function lastJson(txt) {
  const i = txt.lastIndexOf('```json');
  if (i < 0) return null;
  const start = i + 7;
  const end = txt.indexOf('```', start);
  return JSON.parse(txt.slice(start, end));
}
const norm = s => s.replace(/\r/g, '').replace(/\s+/g, ' ').trim();
const lines = [];
let checked = 0, ok = 0, bad = 0;

for (const f of files) {
  const env = lastJson(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!env || env.role !== 'audit') continue;
  for (const x of env.payload?.findings ?? []) {
    if (x.status !== 'CONFIRMED') continue;
    checked++;
    const rel = x.evidence?.file;
    const line = x.evidence?.line;
    const quote = x.evidence?.quote;
    const abs = path.join(repo, rel);
    if (!rel || !line || !quote) { lines.push(`MISSING ${f} ${x.finding_id}`); bad++; continue; }
    if (!fs.existsSync(abs)) { lines.push(`NOFILE ${f} ${x.finding_id} ${rel}`); bad++; continue; }
    const src = fs.readFileSync(abs, 'utf8').replace(/\r/g, '').split('\n');
    const start = line - 1;
    const window = src.slice(start, start + 15).join('\n');
    const qn = norm(quote);
    if (norm(window).includes(qn)) { ok++; lines.push(`OK   ${f} ${x.finding_id} ${rel}:${line}`); }
    else {
      // locate anywhere
      const all = src.join('\n');
      const idx = norm(all).indexOf(qn);
      const where = idx >= 0 ? all.slice(0, idx).split('\n').length : -1;
      lines.push(`FAIL ${f} ${x.finding_id} ${rel}:${line} quoteFoundAtLine=${where}`);
      bad++;
    }
  }
}
console.log(lines.join('\n'));
console.log(`\nCONFIRMED checked=${checked} ok=${ok} bad=${bad}`);
fs.writeFileSync(path.join(dir, '_gate0-report.md'), lines.join('\n') + `\n\nCONFIRMED checked=${checked} ok=${ok} bad=${bad}\n`, 'utf8');

