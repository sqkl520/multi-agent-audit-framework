import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const R = path.resolve(process.argv[2] ?? import.meta.dirname);
const D = R;
const script = path.join(R, '..', '..', '..', 'tools', 'verify-artifacts.mjs');

// 先跑生成器，保证 repo/ 与 arts/ 存在。
// 2026-11-12 实测：arts/ 被清理后本 runner 直接 ENOENT 崩掉，
// 而 check-all 会把它记成一项失败——依赖隐式前置步骤的 runner 是不可靠的。
if (!fs.existsSync(D + '/repo/src') || !fs.existsSync(D + '/arts')) {
  execFileSync('node', [path.join(D, 'gen.mjs'), D], { stdio: 'inherit' });
}

const EXPECT = {
  'scope-01-claim-20-quote-1': { g7: 'WARN', why: '声称读 20 个文件，19 个无 quote —— 2026-11-12 之前判 PASS、0 警告' },
  'scope-02-honest-files': { g7: 'NONE', why: '诚实报「只读了 1 个」—— 应当得到覆盖警告，但不应有 G7（它没虚报范围）' },
  'scope-03-all-findings-one-file': { g7: 'WARN', why: '所有发现集中在 1 个文件，却声称覆盖 20 个' },
  'scope-04-honest-marked': { g7: 'PASS', why: '反向对照：20 个全读，19 个显式列进 files_scanned_without_findings —— 应放行' },
};

// 04 需要现造：用 01 的产物，补上 files_scanned_without_findings
{
  const raw = fs.readFileSync(`${D}/arts/scope-01-claim-20-quote-1.md`, 'utf8');
  // \r? —— Windows checkout（core.autocrlf=true）会把文件写成 CRLF，
  // 只匹配 \n 时这里返回 null，然后 JSON.parse(null[1]) 崩掉。
  // CI 实测：Linux 全绿、Windows 唯一 job 因此失败。
  const m = raw.match(/```json\r?\n([\s\S]*?)\r?\n```/);
  const e = JSON.parse(m[1]);
  e.payload.searched_scope.files_scanned_without_findings =
    e.payload.files.filter((f) => f !== 'src/queue.js');
  // 2026-11-24：同 gen.mjs —— 不写绝对路径，避免把本机盘符写进被跟踪的夹具。
  e.artifact_path = 'scope-04-honest-marked.md';
  fs.writeFileSync(`${D}/arts/scope-04-honest-marked.md`,
    '# 报告\n\n正文\n\n```json\n' + JSON.stringify(e, null, 2) + '\n```\n');
}

const rows = [];
for (const name of Object.keys(EXPECT)) {
  const oneDir = `${D}/runs/${name}`;
  fs.rmSync(oneDir, { recursive: true, force: true });
  fs.mkdirSync(oneDir, { recursive: true });
  fs.copyFileSync(`${D}/arts/${name}.md`, `${oneDir}/${name}.md`);

  let out = '';
  try {
    out = execFileSync('node', [script, '--repo', `${D}/repo`, '--artifacts', oneDir], { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    out = (e.stdout ?? '') + (e.stderr ?? '');
  }
  const g7Lines = out.split('\n').filter((l) => /\[G7\]/.test(l));
  const status = g7Lines.some((l) => /WARN/.test(l)) ? 'WARN'
    : g7Lines.some((l) => /PASS/.test(l)) ? 'PASS' : 'NONE';
  rows.push({ name, status, exp: EXPECT[name], line: g7Lines[0]?.trim() ?? '' });
  fs.rmSync(oneDir, { recursive: true, force: true });
}

console.log('\n=== 声明范围（searched_scope）能否被整段编造 ===\n');
console.log('探针                              实测   期望   说明');
let bad = 0;
for (const r of rows) {
  const ok = r.status === r.exp.g7;
  if (!ok) bad++;
  console.log(`${ok ? '  ' : '⚠ '}${r.name.padEnd(32)} ${r.status.padEnd(6)} ${r.exp.g7.padEnd(6)} ${r.exp.why}`);
  if (r.line) console.log(`${' '.repeat(35)}${r.line.slice(0, 150)}`);
}
console.log(`\n${rows.length - bad}/${rows.length} 符合预期\n`);
process.exit(bad > 0 ? 1 : 0);
