import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseAssertions } from './parse-assertions.mjs';

const repo = '<TARGET_REPO>';
const rel = process.argv[2];
const show = (r, p) => execFileSync('git', ['-C', r, 'show', `${p}:${rel}`], { encoding: 'utf8' });

const oldSrc = show(repo, 'HEAD');
const newSrc = readFileSync(`${repo}/${rel}`, 'utf8');
const o = parseAssertions(oldSrc);
const n = parseAssertions(newSrc);

const onlyOld = [...o.subjects.keys()].filter((k) => !n.subjects.has(k));
const onlyNew = [...n.subjects.keys()].filter((k) => !o.subjects.has(k));
console.log('--- only old', onlyOld.length);
for (const k of onlyOld) console.log('  ', k, '=>', o.subjects.get(k).map((a) => `${a.pclass}(${a.expected})@${a.line}`).join(' | '));
console.log('--- only new', onlyNew.length);
for (const k of onlyNew) console.log('  ', k, '=>', n.subjects.get(k).map((a) => `${a.pclass}(${a.expected})@${a.line}`).join(' | '));
console.log('--- shared whose signature changed');
for (const [k, ov] of o.subjects) {
  const nv = n.subjects.get(k);
  if (!nv) continue;
  const os = new Set(ov.map((a) => `${a.pclass}:${a.expected}`));
  const ns = new Set(nv.map((a) => `${a.pclass}:${a.expected}`));
  const diff = [...os].filter((x) => !ns.has(x));
  if (diff.length) console.log('  ', k, '\n     old:', [...os].join(','), '\n     new:', [...ns].join(','));
}
console.log('--- unparsable', o.unparsable.length, n.unparsable.length);
for (const u of [...o.unparsable, ...n.unparsable]) console.log('  L' + u.line, u.fn, u.reason, '::', u.text.slice(0, 90));
