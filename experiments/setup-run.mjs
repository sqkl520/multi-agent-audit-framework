#!/usr/bin/env node
/**
 * setup-run.mjs — 为一次审计实验准备隔离环境
 *
 * 为什么需要：这个实验已经两次因为「答案表就在被审目录旁边」而作废。
 *   第一次：base/ 和 injected/ 同级 → D 组引用了 base 做 diff
 *   第二次：manifest.json 在 injected 的父目录 → F 组明确说它找到了
 *
 * 人的记性靠不住，所以做成脚本。
 *
 * 用法：node setup-run.mjs <run-name> [--fixture2]
 * 产出：%TEMP%/iso-<run-name>/code/（只有代码）
 *
 * 两道检查的分工：
 *   - 源目录祖先链（软警告）：这里是 experiments/，本来就存着全部答案和报告。
 *     只要拷贝是逐字复制、目标目录干净，源目录旁边有什么都不影响隔离性。
 *   - 目标目录祖先链（硬失败）：这才是审计 agent 实际会看到的路径。
 */

import { cpSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const useFixture2 = process.argv.includes('--fixture2');
const SRC = join(HERE, useFixture2 ? 'fixture2/injected' : 'injected');

const runName = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!runName) {
  console.error('用法: node setup-run.mjs <run-name> [--fixture2]');
  process.exit(2);
}
if (!existsSync(SRC)) {
  console.error(`找不到被审代码: ${SRC}`);
  process.exit(2);
}

// ── 1. 泄题检查 ──
const FORBIDDEN = [
  /^manifest\.json$/i,
  /^answer.*\.json$/i,
  /^expected.*\.json$/i,
  /^ground-?truth/i,
  /^(base|original|before|baseline)$/i,
  /-report\.md$/i,
  /^score\.mjs$/,
  /^verify\.mjs$/,
  /^setup-run\.mjs$/,
  /^inject\.mjs$/,
];

function leakCheck(dir, maxUp = Infinity) {
  const hits = [];
  let cur = resolve(dir);
  let up = 0;
  while (up <= maxUp) {
    let entries = [];
    try { entries = readdirSync(cur); } catch { break; }
    for (const name of entries) {
      if (FORBIDDEN.some((re) => re.test(name))) hits.push(join(cur, name));
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
    up += 1;
  }
  return hits;
}

const srcLeaks = leakCheck(SRC);
if (srcLeaks.length > 0) {
  console.log(`\n⚠ 源目录祖先链上有 ${srcLeaks.length} 个答案类文件（预期之内，拷贝是逐字复制）`);
  console.log('  真正的判据是下面目标目录的检查结果。');
}

// ── 2. 建隔离环境 ──
const dest = join(tmpdir(), `iso-${runName}`);
rmSync(dest, { recursive: true, force: true });
cpSync(SRC, join(dest, 'code'), { recursive: true });

// ── 3. 硬检查：目标目录的祖先链必须干净（只看隔离根往上两层）──
// 审计 agent 的 cwd 是 iso-<run>/code，往上两级是 iso-<run> 和 %TEMP%。
// 再往上就是系统目录，那里有什么与本次实验无关。
const destLeaks = leakCheck(join(dest, 'code'), 2);
if (destLeaks.length > 0) {
  console.error('\n✗ 隔离环境仍然有泄露：');
  for (const l of destLeaks) console.error(`    ${l}`);
  process.exit(1);
}

const files = readdirSync(join(dest, 'code', 'src'));
console.log(`\n✓ 隔离环境就绪: ${join(dest, 'code')}`);
console.log(`✓ 目标祖先链干净（无答案文件）`);
console.log(`✓ 源文件: ${files.length} 个`);
console.log(`✓ fixture: ${useFixture2 ? 'fixture2（模板/事件/分页/校验）' : 'fixture1（队列/重试/store）'}\n`);
console.log(`把任务书指向: ${join(dest, 'code')}\n`);
