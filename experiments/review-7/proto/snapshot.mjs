// Freeze the audited tree into proto/out/snapshot/<stamp>/ so later runs are reproducible even if
// somebody else edits the audited repo (it DID change mid-run: ScratchReloadProbeTest.java vanished).
//
//   node snapshot.mjs --repo <path> [--stamp <name>]
//
// Read-only against the audited repo. Writes only under proto/out/.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const getArg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const repo = getArg('--repo', '<TARGET_REPO>');
const stamp = getArg('--stamp', new Date().toISOString().replace(/[:.]/g, '-'));
const base = path.join(import.meta.dirname, 'out', 'snapshot', stamp);

const git = (a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });

const headSha = git(['rev-parse', 'HEAD']).trim();

const status = git(['status', '--porcelain']);
const entries = [];
for (const line of status.split('\n').filter(Boolean)) {
  const code = line.slice(0, 2);
  let rel = line.slice(3).trim();
  let renamedFrom = null;
  if (rel.includes(' -> ')) {
    const [a, b] = rel.split(' -> ');
    renamedFrom = a.replace(/^"|"$/g, '');
    rel = b.replace(/^"|"$/g, '');
  }
  if (code.includes('D')) continue;
  entries.push({ code, rel, renamedFrom });
}

const manifest = { stamp, repo, headSha, createdAt: new Date().toISOString(), files: [] };
for (const e of entries) {
  const abs = path.join(repo, e.rel);
  const rec = { code: e.code, rel: e.rel, renamedFrom: e.renamedFrom, exists: existsSync(abs), headContent: null, workContent: null };
  if (rec.exists) {
    try { rec.workContent = readFileSync(abs, 'utf8'); } catch { rec.exists = false; }
  }
  const headRel = e.renamedFrom ?? e.rel;
  try { rec.headContent = git(['show', `${headSha}:${headRel}`]); } catch { rec.headContent = null; }
  manifest.files.push(rec);
}

mkdirSync(path.join(base, 'work'), { recursive: true });
for (const f of manifest.files) {
  if (f.workContent !== null) {
    const p = path.join(base, 'work', f.rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, f.workContent);
  }
  if (f.headContent !== null) {
    const p = path.join(base, 'head', f.rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, f.headContent);
  }
}
writeFileSync(path.join(base, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`snapshot: ${base}`);
console.log(`HEAD: ${headSha}`);
console.log(`files: ${manifest.files.length} (with HEAD version: ${manifest.files.filter((f) => f.headContent !== null).length})`);
