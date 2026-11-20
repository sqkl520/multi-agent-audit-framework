import fs from 'node:fs';
import path from 'node:path';

const dir = '.run-dsh3/artifacts';
const files = fs.readdirSync(dir).filter(f => /^round1-02-sweep-slice-\d+\.md$/.test(f)).sort();

function envelope(text) {
  const idx = text.lastIndexOf('```json');
  if (idx < 0) return null;
  const end = text.indexOf('```', idx + 7);
  const raw = text.slice(idx + 7, end);
  try { return JSON.parse(raw); } catch (e) { return null; }
}

const rows = [];
let total = 0;
for (const f of files) {
  const text = fs.readFileSync(path.join(dir, f), 'utf8');
  const env = envelope(text);
  if (!env) { console.log('NO_JSON', f); continue; }
  const p = env.payload || {};
  const leads = p.leads || [];
  total += leads.length;
  rows.push({ f, slice: p.slice_id, reach: p.reachability, n: leads.length, h: p.dimension_histogram, leads });
  console.log(`\n=== ${f} | ${p.slice_id} | reach=${p.reachability} | leads=${leads.length} | bytes=${text.length}`);
  console.log('    hist=' + JSON.stringify(p.dimension_histogram));
  for (const l of leads) {
    const w = (l.why_suspicious || '').replace(/\s+/g, ' ');
    console.log(`  - ${l.lead_id} [${l.suspected_dimension}/${l.confidence}] ${l.file}:${l.line}`);
    console.log(`    q: ${(l.quote || '').replace(/\s+/g, ' ').slice(0, 140)}`);
    console.log(`    w: ${w.slice(0, 220)}`);
  }
}
console.log(`\nTOTAL slices=${rows.length} leads=${total}`);
