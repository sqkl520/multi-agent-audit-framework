import { readFileSync, readdirSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = join(homedir(), '.dsh', 'sessions', '<dsh-project-dir>');

function summarize(dir) {
  const p = join(root, dir, 'session.v4.jsonl.zstd');
  let lines;
  try {
    lines = zstdDecompressSync(readFileSync(p)).toString('utf8').split('\n').filter(Boolean);
  } catch (e) {
    return { dir, error: e.message };
  }
  const types = {};
  const events = [];
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      const t = j.type ?? j.kind ?? j.event ?? '?';
      types[t] = (types[t] ?? 0) + 1;
      events.push(j);
    } catch { types['<parse-error>'] = (types['<parse-error>'] ?? 0) + 1; }
  }
  return { dir, count: lines.length, types, events };
}

const dirs = readdirSync(root).filter((d) => !d.startsWith('.'));
const target = process.argv[2];
const picks = target ? dirs.filter((d) => d.includes(target)) : dirs.slice(0, 4);

for (const d of picks) {
  const s = summarize(d);
  console.log('=== ' + d + ' ===');
  if (s.error) { console.log('  error:', s.error); continue; }
  console.log('  events:', s.count);
  console.log('  types:', JSON.stringify(s.types));
}
