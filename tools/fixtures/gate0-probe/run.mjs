import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// 默认用本文件所在目录——这样 check-all.mjs 直接调用（无参数）也能工作。
// 2026-11-12 实测：不带参数时 process.argv[2] 是 undefined，
// path.resolve(undefined) 直接抛 ERR_INVALID_ARG_TYPE，整个 check-all 记一项失败。
const R = path.resolve(process.argv[2] ?? import.meta.dirname);
const repo = R + '/repo';
const arts = R + '/arts';
const script = path.join(R, '..', '..', '..', 'tools', 'verify-artifacts.mjs');

// 先跑生成器，保证 repo/ 与 arts/ 存在。
// 之前这两个目录是实验留下的，被清理后就再也跑不起来了——
// 一个 runner 不该依赖「上次跑过 gen」这个隐式前提。
if (!fs.existsSync(repo + '/src') || !fs.existsSync(arts)) {
  execFileSync('node', [path.join(R, 'gen.mjs'), R], { stdio: 'inherit' });
}

// expect: G0 应该 PASS 还是 FAIL
const EXPECT = {
  '01-truthful': { g0: 'PASS', why: '光标准确、引文逐字来自第 15 行 —— 对照组' },
  '02-crossline': { g0: 'FAIL', why: '把第 8 行和第 15 行的片段拼成一句（跨行拼接）' },
  '03-wrong-function': { g0: 'FAIL', why: '行号说 15，内容却是第 8 行（安全函数的守卫）' },
  '04-off-by-one': { g0: 'FAIL', why: '引文真实但行号偏 1（说 16，实际在 15）' },
  '05-fuzzy-tokens': { g0: 'FAIL', why: '只抄几个 token，顺序对但原文不连续 —— 契约没禁止，但应看清' },
  '06-comment-quote': { g0: 'FAIL', why: '引的是注释不是代码（行号也错）。即使行号对，纯注释也不能作为代码缺陷的证据' },
  '06b-comment-right-line': { g0: 'FAIL', why: '行号准确、引文逐字存在，但整行是注释 —— 2026-11-12 之前会判 PASS' },
  '08b-legit-doc-mismatch': { g0: 'PASS', why: '反向对照：缺陷本身就是「注释与实现不符」，注释是被审对象不是证据' },
  '07-blank-line': { g0: 'FAIL', why: '行号指向空行，quote 为空' },
  '08-truthful-quote-wrong-claim': { g0: 'PASS', why: '引文真实（但结论相反）—— 门 0 只管引文真伪，不管结论对错' },
};

const rows = [];
for (const f of fs.readdirSync(arts).filter((x) => x.endsWith('.md')).sort()) {
  const name = f.replace('.md', '');
  const oneDir = `${R}/runs/${name}`;
  fs.rmSync(oneDir, { recursive: true, force: true });
  fs.mkdirSync(oneDir, { recursive: true });
  fs.copyFileSync(`${arts}/${f}`, `${oneDir}/${f}`);

  let out = '';
  try {
    out = execFileSync('node', [script, '--repo', repo, '--artifacts', oneDir], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    out = (e.stdout ?? '') + (e.stderr ?? '');
  }
  const g0Line = out.split('\n').find((l) => /\[G0\]/.test(l)) ?? '(无 G0 输出)';
  const status = /PASS/.test(g0Line) ? 'PASS' : /FAIL/.test(g0Line) ? 'FAIL' : /WARN/.test(g0Line) ? 'WARN' : 'SKIP';
  rows.push({ name, status, line: g0Line.trim(), exp: EXPECT[name] });
}

console.log('\n=== 门 0 能挡住哪些伪造手法 ===\n');
console.log('探针                              实测   说明');
let mismatched = 0;
for (const r of rows) {
  const e = r.exp?.g0 ?? '?';
  const ok = e === r.status || (e === 'PASS?' && r.status === 'PASS');
  if (!ok) mismatched++;
  console.log(`${ok ? '  ' : '⚠ '}${r.name.padEnd(32)} ${r.status.padEnd(6)} ${r.exp?.why ?? ''}`);
  console.log(`${' '.repeat(35)}${r.line}`);
}
console.log('');
for (const r of rows) fs.rmSync(`${R}/runs/${r.name}`, { recursive: true, force: true });

// 2026-11-24：这个 runner 此前**从不设置退出码**，于是「⚠ 不符」只打印不失败，
// check-all 与实际行为无关地永远判它通过。与 2026-11-21 修 stop-hook.test.mjs
// 缺 process.exit 是同一类缺陷：一个自称对照表的套件，不失败就等于没测。
if (mismatched > 0) {
  console.log(`✗ ${mismatched} 条探针的实测结果与契约期望不符\n`);
  process.exit(1);
}
console.log(`✓ ${rows.length} 条探针全部符合契约期望\n`);
