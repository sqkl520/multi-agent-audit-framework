#!/usr/bin/env node
/**
 * check-round-detection.test.mjs — 自测 check-round-detection.mjs
 *
 * 分两层：
 *   ① 内置 --self-test 覆盖契约第 3 节 / 第 4 节表里的每一条（那是"对不对"）
 *   ② 本文件覆盖退出码、真实目录、阻塞路径（那是"跑起来对不对"）
 *
 * 为什么两层都要：--self-test 只验证算术，验证不了「目录不可读时会不会猜一个号」。
 * 而"猜一个号"正是这份契约最想禁止的行为（它明写"不得猜测"）。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'check-round-detection.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'rd-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(SRC, join(dir, 'tools', 'check-round-detection.mjs'));
  return dir;
}

function run(dir, args) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-round-detection.mjs'), ...args], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

// ─────────────────────────────────────────────────────────────
console.log('\ncase 1: --self-test 全部符合契约（第 3 节 + 第 4 节逐条）');
{
  const dir = mk();
  const r = run(dir, ['--self-test']);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('报全部符合', /全部符合契约/.test(r.out), r.out);
  // 反证不是空跑：输出里必须有匹配模式那一节的条目
  ok('真的跑了匹配用例', /round0999/.test(r.out) && /round23-backup/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 2: 真实目录 → 算出 max+1');
{
  const dir = mk();
  const reports = join(dir, 'docs', 'reports');
  mkdirSync(join(reports, 'round1'), { recursive: true });
  mkdirSync(join(reports, 'round5'), { recursive: true });
  mkdirSync(join(reports, 'round0999'), { recursive: true });
  const r = run(dir, ['--dir', reports]);
  ok('exit 0', r.code === 0, `code=${r.code}`);
  ok('轮次号 1000（前导零按数值）', /轮次号\s+1000/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 3: 空目录 → 轮次号 1（不是 0，也不是报错）');
{
  const dir = mk();
  const reports = join(dir, 'reports');
  mkdirSync(reports, { recursive: true });
  const r = run(dir, ['--dir', reports, '--json']);
  ok('exit 0', r.code === 0);
  let j = null; try { j = JSON.parse(r.out); } catch { /* */ }
  ok('round_number === 1', j?.round_number === 1, r.out.slice(0, 200));
  ok('matched_entries === 0', j?.matched_entries === 0);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 4: 目录不存在 → 首次运行，round_number 1 + created_root true');
{
  const dir = mk();
  const r = run(dir, ['--dir', join(dir, 'nope', 'reports'), '--json']);
  ok('exit 0', r.code === 0, `code=${r.code}`);
  let j = null; try { j = JSON.parse(r.out); } catch { /* */ }
  ok('round_number === 1', j?.round_number === 1, r.out.slice(0, 200));
  ok('created_root === true', j?.created_root === true);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 5: 目录里只有非 round 命名 → round_number 1，且不报阻塞');
{
  const dir = mk();
  const reports = join(dir, 'r');
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, 'README.md'), 'x');
  writeFileSync(join(reports, 'notes.txt'), 'x');
  const r = run(dir, ['--dir', reports, '--json']);
  let j = null; try { j = JSON.parse(r.out); } catch { /* */ }
  ok('exit 0', r.code === 0);
  ok('round_number === 1', j?.round_number === 1, r.out.slice(0, 200));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 6: round23-backup 这类 → 记 NON_ROUND_NAMING 异常');
{
  const dir = mk();
  const reports = join(dir, 'r');
  mkdirSync(join(reports, 'round3'), { recursive: true });
  mkdirSync(join(reports, 'round23-backup'), { recursive: true });
  const r = run(dir, ['--dir', reports, '--json']);
  let j = null; try { j = JSON.parse(r.out); } catch { /* */ }
  ok('round_number === 4（只算合规的）', j?.round_number === 4, r.out.slice(0, 300));
  ok('有 NON_ROUND_NAMING', (j?.anomalies ?? []).some((a) => a.kind === 'NON_ROUND_NAMING'), r.out.slice(0, 400));
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 7: 路径指向文件而非目录 → exit 1（阻塞，不猜）');
{
  const dir = mk();
  const f = join(dir, 'notadir.txt');
  writeFileSync(f, 'x');
  const r = run(dir, ['--dir', f]);
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('说明是阻塞而非报错', /阻塞/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 8: 无参数 → exit 2（用法错误，不是静默通过）');
{
  const dir = mk();
  const r = run(dir, []);
  ok('exit 2', r.code === 2, `code=${r.code}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 9: SUSPICIOUS_RANGE 的条目仍参与最大值（不回退）');
{
  const dir = mk();
  const reports = join(dir, 'r');
  mkdirSync(join(reports, 'round5'), { recursive: true });
  mkdirSync(join(reports, 'round9999999'), { recursive: true });
  const r = run(dir, ['--dir', reports, '--json']);
  let j = null; try { j = JSON.parse(r.out); } catch { /* */ }
  ok('round_number === 10000000（不是 6）', j?.round_number === 10000000, r.out.slice(0, 300));
  ok('有 SUSPICIOUS_RANGE', (j?.anomalies ?? []).some((a) => a.kind === 'SUSPICIOUS_RANGE'));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
