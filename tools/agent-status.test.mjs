#!/usr/bin/env node
/**
 * agent-status.test.mjs — 「agent 到底做完了没有」判定器的自测
 *
 * 为什么专门测：2026-11-12 我连续 35 分钟声称一个 agent「还在跑」，
 * 而它的产物早已写完。根因是我用 JSONL 转录文件大小当进度指标，
 * 那个文件从头到尾是 0 字节，和任务成功标准毫无关系。
 *
 * 所以这个工具的判据必须是：**产物存在 > 工作目录有活动**。
 * 下面每个用例都在钉住这个优先级。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'agent-status.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

function run(artifact, workdir, extra = []) {
  try {
    const out = execFileSync('node', [SCRIPT, '--artifact', artifact, '--workdir', workdir, '--json', ...extra],
      { encoding: 'utf8' });
    return { code: 0, r: JSON.parse(out) };
  } catch (e) {
    try { return { code: e.status ?? 1, r: JSON.parse(e.stdout) }; }
    catch { return { code: e.status ?? 1, r: null, raw: e.stdout }; }
  }
}

/** 把文件 mtime 推到 N 分钟前 */
function ageFile(p, minutes) {
  const t = (Date.now() - minutes * 60000) / 1000;
  utimesSync(p, t, t);
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'as-test-'));
  const work = join(root, 'work');
  mkdirSync(work, { recursive: true });
  return { root, work, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

console.log('\n=== agent 状态判定器自测 ===\n');

console.log('case 1: 产物已写出 → DONE');
{
  const f = fixture();
  const art = join(f.work, 'round1-02-audit-slice-01-logic.md');
  writeFileSync(art, '# 报告\n\n```json\n{"role":"audit"}\n```\n');
  const { r } = run(art, f.work);
  expect('verdict=DONE', r?.verdict === 'DONE', r?.verdict);
  expect('退出码 0', r !== null);
  f.cleanup();
}

console.log('case 2: 产物不存在，但工作目录刚有活动 → RUNNING');
{
  const f = fixture();
  const art = join(f.work, 'not-yet.md');
  writeFileSync(join(f.work, 'probe1.mjs'), '// x');
  const { r } = run(art, f.work);
  expect('verdict=RUNNING', r?.verdict === 'RUNNING', r?.verdict);
  f.cleanup();
}

console.log('case 3: 产物不存在，工作目录也久无活动 → STALLED（不能继续干等）');
{
  const f = fixture();
  const art = join(f.work, 'not-yet.md');
  const old = join(f.work, 'probe1.mjs');
  writeFileSync(old, '// x');
  ageFile(old, 60);
  const { r } = run(art, f.work, ['--stall-minutes', '15']);
  expect('verdict=STALLED', r?.verdict === 'STALLED', r?.verdict);
  expect('退出码 2', r !== null);
  f.cleanup();
}

console.log('case 4: 产物是 0 字节 → 不算 DONE（骨架不是交付）');
{
  const f = fixture();
  const art = join(f.work, 'empty.md');
  writeFileSync(art, '');
  const { r } = run(art, f.work, ['--stall-minutes', '15']);
  expect('verdict 不是 DONE', r?.verdict !== 'DONE', r?.verdict);
  f.cleanup();
}

console.log('case 5: 关键优先级——产物已在，即使工作目录很旧也必须判 DONE');
{
  // 这正是 2026-11-12 的实际情形：
  // 产物 22:39 就写好了，而我盯的转录文件一直是 0 字节。
  // 判定必须以产物为准，不能被「工作目录多久没动」带偏。
  const f = fixture();
  const art = join(f.work, 'round1-02-audit-slice-01-logic.md');
  writeFileSync(art, '# 报告\n\n内容\n');
  ageFile(art, 40);
  const oldProbe = join(f.work, 'reconcile.mjs');
  writeFileSync(oldProbe, '// x');
  ageFile(oldProbe, 44);
  const { r } = run(art, f.work, ['--stall-minutes', '15']);
  expect('verdict=DONE', r?.verdict === 'DONE', r?.verdict);
  expect('提示里说「不要再等」', /不要再等/.test(r?.hint ?? ''), r?.hint);
  f.cleanup();
}

console.log('case 6: 工作目录不存在 → 不崩，给 UNKNOWN');
{
  const f = fixture();
  const art = join(f.root, 'nope', 'a.md');
  const { r } = run(art, join(f.root, 'also-nope'));
  expect('有 verdict', typeof r?.verdict === 'string');
  expect('不是 DONE', r?.verdict !== 'DONE');
  f.cleanup();
}

console.log('case 7: 产物在子目录里（round1/xxx.md），工作目录是父级');
{
  // 实测中 agent 把产物写在 work/round1/ 下，而我 --workdir 指向 work/
  const f = fixture();
  const sub = join(f.work, 'round1');
  mkdirSync(sub, { recursive: true });
  const art = join(sub, 'round1-02-audit-slice-01-logic.md');
  writeFileSync(art, '# 报告\n');
  const { r } = run(art, f.work);
  expect('verdict=DONE', r?.verdict === 'DONE', r?.verdict);
  f.cleanup();
}

console.log('case 8: --artifact 传的是目录 → 必须拒绝，不能给 STALLED');
{
  // 2026-11-13 真实踩到：把 scratch 目录本身当 --artifact 传进去，
  // 四个早就交付的 agent 全被判 STALLED。错误的「它没交付」比没有结论更危险，
  // 所以这里必须硬拒绝（退出码 2），而不是返回一个看起来很确定的判定。
  const f = fixture();
  writeFileSync(join(f.work, 'x.mjs'), '// scratch\n');
  const { code, r } = run(f.work, f.work);
  expect('传目录退出码 2', code === 2, `实际 ${code}`);
  expect('传目录不给 verdict', r === null || r?.verdict === undefined, JSON.stringify(r?.verdict));
  f.cleanup();
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
