// 谁读谁：每个 framework/*.md 被哪些 tools/*.mjs 引用（字面文件名出现在源码里）。
// 这是「有没有检查器会看见这个文件的改动」的上界——连读都不读，就一定看不见。
import { readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';

const tools = readdirSync('tools').filter((f) => f.endsWith('.mjs') && !f.includes('.test.'));
const src = new Map(tools.map((f) => [f, readFileSync(join('tools', f), 'utf8')]));

const fwFiles = [];
const walk = (d) => {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.md')) fwFiles.push(p);
  }
};
walk('framework');

const rows = [];
for (const p of fwFiles) {
  const b = basename(p);
  const rel = p.split(/[\\/]/).slice(1).join('/');
  const readers = [];
  for (const [f, s] of src) {
    if (s.includes(b) || s.includes(rel)) readers.push(f);
  }
  rows.push({ file: rel, readers: [...new Set(readers)] });
}
rows.sort((a, b) => a.readers.length - b.readers.length);
console.log('文件'.padEnd(42) + '读它的校验器数');
console.log('-'.repeat(100));
for (const r of rows) {
  console.log(r.file.padEnd(42) + String(r.readers.length).padStart(3) + '  ' + r.readers.join(', ').slice(0, 110));
}
const zero = rows.filter((r) => r.readers.length === 0);
console.log('\n无人读取的框架文档: ' + zero.length + ' / ' + rows.length);
for (const z of zero) console.log('  !! ' + z.file);
