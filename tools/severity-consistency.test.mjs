// severity-consistency 自测
//
// 这个工具 2026-11-25 之前**一直在报全 0**：报告里写「**严重性**: 高 / 中 / 低」，
// 而正则只认 CRITICAL|HIGH|MEDIUM|LOW，于是 fixture2 的 T1 报告 18 条一条都抽不到。
// 更糟的是它打 0/NaN 然后 exit 0——一个专门抓「严重性分歧」的仪表，
// 自己「一条都没抓到」时却不响。
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'severity-consistency.mjs');
const FIX = join(HERE, '..', 'experiments', 'fixture2');

let pass = 0, fail = 0;
const expect = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};
const dirs = [];

function run(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

/** 写一份最小报告：severity 用给定的原文 */
function report(sevRaw, file = 'src/template.js', line = 118) {
  const d = mkdtempSync(join(tmpdir(), 'sv-'));
  dirs.push(d);
  const p = join(d, 'r.md');
  writeFileSync(p, `# 报告\n\n## 发现 1\n- **file**: ${file}:${line}\n- **严重性**: ${sevRaw}\n- **问题**: x\n`);
  return p;
}

console.log('\n=== severity-consistency 自测 ===\n');

console.log('case 1: 真实 fixture 两份报告 → 有可比定级（不是 0）');
{
  const r = run([FIX, join(FIX, 'T1-report.md'), join(FIX, 'U1-report.md')]);
  expect('exit 0', r.code === 0, `code=${r.code}`);
  expect('可比缺陷 > 0', /可比缺陷[^\n]*\s([1-9]\d*)/.test(r.out), r.out.slice(0, 400));
  expect('没有 NaN', !/NaN/.test(r.out), r.out.slice(-300));
}

console.log('case 2: 中文严重性（高/中/低）必须被识别');
{
  // T1-report 全用中文。修好之前这个数字是 0。
  const r = run([FIX, join(FIX, 'T1-report.md'), join(FIX, 'U1-report.md')]);
  const m = r.out.match(/可比缺陷（>=2 个 agent 都报了）\s+(\d+)/);
  expect('可比缺陷 ≥ 5', m && Number(m[1]) >= 5, JSON.stringify(m?.[1]));
}

console.log('case 3: 0 个定级判断 → exit 2（分母为 0 不等于「一致」）');
{
  // 指向 fixture 里不存在的文件：score.mjs 一条都判不出来
  const a = report('HIGH', 'src/nonexistent.js', 1);
  const b = report('HIGH', 'src/nonexistent.js', 1);
  const r = run([FIX, a, b]);
  expect('exit 2', r.code === 2, `code=${r.code}\n${r.out.slice(-300)}`);
  expect('说明分母为 0', /分母为 0/.test(r.out), r.out.slice(-300));
}

console.log('case 4: 英文严重性仍然识别（不能为了中文把英文弄坏）');
{
  // 2026-11-26 锐评实测：上一版用 T1+U1 混跑只断言「可比缺陷 > 0」，
  // 靠中文分支就能过——**把英文分支整个删掉，这条依然绿**（恒真测试）。
  // 现在改用两份**纯英文**报告：只有英文分支能给出可比定级。
  const a = report('HIGH');
  const b = report('HIGH');
  const r = run([FIX, a, b]);
  expect('纯英文两份 → 可比缺陷 = 1', /可比缺陷[^\n]*\s1\b/.test(r.out), r.out.slice(0, 300));
  expect('exit 0', r.code === 0, `code=${r.code}`);
}

console.log('case 4b: 大小写变体（High / Medium / low）必须识别（回归）');
{
  // 旧版中文 label 的正则带 /i，新版丢了 → `**严重性**: High` 从能抽变抽不到。
  for (const v of ['High', 'MEDIUM', 'low', 'Critical']) {
    const r = run([FIX, report(v), report(v)]);
    expect(`${v} → 可比缺陷 = 1`, /可比缺陷[^\n]*\s1\b/.test(r.out), `${v}: ${r.out.slice(0, 200)}`);
  }
}

console.log('case 4b2: **英文 label + 中文值**（`**Severity**: 中`）必须识别');
{
  // 2026-11-26 验收实测：这是唯一真正依赖 label 正则 /i 的场景——
  // 上面 4b 的 `High/low` 是**值**的大小写，即使 label 不带 /i 也会被带 /i 的裸词分支兜住。
  // 没有这条，把 label 的 /i 删掉整套自测依然全绿。
  for (const [label, val, want] of [
    ['**Severity**', '中', 'MEDIUM'],
    ['**SEVERITY**', '高', 'HIGH'],
    ['**Severity**', '低', 'LOW'],
  ]) {
    const d = mkdtempSync(join(tmpdir(), 'sv-'));
    dirs.push(d);
    const p = join(d, 'r.md');
    writeFileSync(p, `# R\n\n## 发现 1\n- **file**: src/template.js:118\n- ${label}: ${val}\n`);
    const r = run([FIX, p, p]);
    expect(`${label}: ${val} → ${want}`,
      new RegExp(`F2-01\\s+HIGH\\s+\\S+:${want}`).test(r.out), `${label}:${val}: ${r.out.slice(0, 300)}`);
  }
}

console.log('case 4c: 「严重程度：中」不得被截成「严重」→ CRITICAL');
{
  const p = report('严重程度：中');
  const r = run([FIX, p, p]);
  expect('抽到的是 MEDIUM 而不是 CRITICAL',
    /F2-01\s+HIGH\s+\S+:MEDIUM/.test(r.out), r.out.slice(0, 400));
}

console.log('case 4d: 中文裸词不得从正文里误抽（`共1高2中3低` 这类）');
{
  // 报告没有 `**严重性**` 行，正文里有紧邻 ASCII 数字的中文单字。
  // 裸词分支现在只认英文，所以这份报告应该抽不到任何定级 → 0 可比 → exit 2。
  const d = mkdtempSync(join(tmpdir(), 'sv-'));
  dirs.push(d);
  const p = join(d, 'r.md');
  writeFileSync(p, '# 报告\n\n## 发现 1\n- **file**: src/template.js:118\n- 说明：共1高2中3低\n');
  const r = run([FIX, p, p]);
  expect('exit 2（一条定级都抽不到，不得编造）', r.code === 2, `code=${r.code}\n${r.out.slice(0, 300)}`);
}

console.log('case 4e: 邻近行号的干扰下取「最近」的那条（锐评 9）');
{
  // 缺陷 F2-01 真值 HIGH@src/template.js:118。整段里先出现 116 行「低」，
  // 按文档顺序取第一条会拿到 LOW；按最近行号才拿到 HIGH。
  const d = mkdtempSync(join(tmpdir(), 'sv-'));
  dirs.push(d);
  const p = join(d, 'r.md');
  writeFileSync(p, [
    '# R', '',
    '## 发现 1', '- **file**: src/template.js:116', '- **严重性**: 低', '',
    '## 发现 2', '- **file**: src/template.js:118', '- **严重性**: 高', '',
  ].join('\n'));
  const r = run([FIX, p, p]);
  expect('F2-01 取到 HIGH（不是 116 行的 LOW）',
    /F2-01\s+HIGH\s+\S+:HIGH/.test(r.out), r.out.slice(0, 400));
}

console.log('case 5: 用法错误 → exit 2');
{
  const r = run([FIX]);
  expect('exit 2', r.code === 2, `code=${r.code}`);
}

console.log('case 6: 两份报告无重叠 → 0 可比 → exit 2（NaN 之前就停）');
{
  const a = report('HIGH', 'src/template.js', 118);
  const b = report('中', 'src/pagination.js', 5);
  const r = run([FIX, a, b]);
  expect('exit 2', r.code === 2, `code=${r.code}\n${r.out.slice(-300)}`);
  expect('不打印 NaN', !/NaN/.test(r.out), r.out.slice(-300));
}

for (const d of dirs) rmSync(d, { recursive: true, force: true });

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
