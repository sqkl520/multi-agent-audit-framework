// 统计 dsh 这轮真实产物的发现条数与严重性分布
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const DIR = '.run-dsh3/artifacts';
const FENCE = /```json\s*\n([\s\S]*?)```/g;

let total = 0;
const bySev = {};
const rows = [];
for (const f of readdirSync(DIR)) {
  if (!/02-audit|01-recon|02-sweep/.test(f)) continue;
  const text = readFileSync(join(DIR, f), 'utf8');
  const blocks = [...text.matchAll(FENCE)].map((m) => m[1]);
  if (!blocks.length) { console.log(`${f} — 无信封`); continue; }
  let env;
  try { env = JSON.parse(blocks[blocks.length - 1]); } catch { console.log(`${f} — 尾部 JSON 解析失败`); continue; }
  const fs2 = env.payload?.findings ?? [];
  const leads = env.payload?.leads ?? [];
  const n = fs2.length;
  total += n;
  for (const fd of fs2) bySev[fd.severity] = (bySev[fd.severity] ?? 0) + 1;
  rows.push({ f, findings: n, leads: leads.length, status: env.status });
}
console.log('文件'.padEnd(46) + 'findings  leads  status');
for (const r of rows) console.log(r.f.padEnd(46) + String(r.findings).padStart(8) + String(r.leads).padStart(7) + '  ' + r.status);
console.log('\n深挖发现总数:', total);
console.log('严重性分布:', JSON.stringify(bySev));
