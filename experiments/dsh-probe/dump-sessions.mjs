import { readFileSync } from 'node:fs';
import { zstdDecompressSync } from 'node:zlib';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = join(homedir(), '.dsh', 'sessions', process.argv[2] ?? '<dsh-project-dir>');
const childId = '82757119-cfd1-45d1-8807-d5f82d3f52e6';
const parentId = 'session-ecc5b264-5bf5-41c7-88c7-405e7468c822';

function load(id) {
  const p = join(root, id, 'session.v4.jsonl.zstd');
  return zstdDecompressSync(readFileSync(p)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

for (const [label, id] of [['CHILD', childId], ['PARENT', parentId]]) {
  console.log('\n######## ' + label + ' ' + id + ' ########');
  for (const ev of load(id)) {
    const t = ev.type ?? ev.kind ?? '?';
    if (/descriptor|session$|inbox|request\/header|user\/message|assistant\/message|turn\/(start|end)/.test(t)) {
      console.log('--- ' + t + ' ---');
      console.log(JSON.stringify(ev).slice(0, 700));
    }
  }
}
