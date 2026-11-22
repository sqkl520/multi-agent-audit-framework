#!/usr/bin/env node
/**
 * check-test-registration.mjs — 有没有测试文件漏在 check-all 之外
 *
 * ── 为什么需要（2026-11-22 实测）────────────────────────────────────
 *
 * 这个仓库有 42 个 `.test.mjs`，但 `check-all` 只注册了 37 个。
 * 漏掉的 5 个能跑通、共 204 条断言，**从没在 CI 里跑过**：
 *
 *   check-files-touched-harness      99 条
 *   check-fix-instances-harness      59 条
 *   check-fix-artifacts-envelope     47 条
 *   fix-phase-e2e                    48 条
 *   check-suite-vitality              8 条
 *
 * 它们不是「故意不跑」，是写完之后**忘了接线**。
 * 这比没有测试更糟：它给人一种「这块有覆盖」的错觉。
 *
 * 同类事故这个仓库记录过：`check-wrapper-integrity` 曾经只有 script
 * 没有 args，于是永远跑的是不带基线对比的版本，永远绿。注释原文：
 * 「检查器写对了，只是没接上线」。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *
 *   R1  每个 `tools/*.test.mjs` 都必须出现在 `check-all.mjs` 的 CHECKS 里
 *   R2  CHECKS 里引用的每个 `.test.mjs` / fixture 脚本都必须真实存在
 *   R3  注册了 `.test.mjs` 之外的脚本时，该文件必须存在（防路径写错）
 *
 * 用法：node check-test-registration.mjs [--json]
 * 退出码：0 全部接线 / 1 有漏 / 2 配置错误
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const jsonOut = process.argv.includes('--json');

// ── 从 check-all.mjs 读注册表 ──
const allSrc = readFileSync(join(HERE, 'check-all.mjs'), 'utf8');
const registered = [...allSrc.matchAll(/script:\s*'([^']+)'/g)].map((m) => m[1]);
if (registered.length === 0) {
  console.error('[预期失败] 从 check-all.mjs 里读不到任何 script 条目——结构可能变了');
  process.exit(2);
}

// ── 磁盘上的测试文件 ──
const onDisk = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).sort();
if (onDisk.length === 0) {
  console.error('[预期失败] tools/ 下一个 .test.mjs 都没有');
  process.exit(2);
}

const problems = [];

// R1 · 每个测试文件都要被注册
for (const f of onDisk) {
  if (!registered.includes(f)) {
    problems.push({
      id: 'R1', file: f,
      msg: `${f} 在磁盘上存在，但没被 check-all 注册——**它从不在 CI 里跑**`,
    });
  }
}

// R2/R3 · 注册的每个路径都要真实存在
for (const r of registered) {
  const p = join(HERE, r);
  if (!existsSync(p)) {
    problems.push({
      id: 'R2', file: r,
      msg: `check-all 注册了 \`${r}\`，但该文件不存在——总检会报「脚本缺失」`,
    });
  }
}

// 反向：注册了但磁盘上没有对应 —— 已由 R2 覆盖。

const ok = problems.length === 0;

if (jsonOut) {
  console.log(JSON.stringify({
    ok,
    on_disk: onDisk.length,
    registered: registered.length,
    missing_from_ci: problems.filter((p) => p.id === 'R1').map((p) => p.file),
    problems,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log('\n自测接线检查（有没有测试漏在 check-all 之外）\n');
console.log(`  磁盘上的 .test.mjs   ${onDisk.length} 个`);
console.log(`  check-all 注册       ${registered.length} 条`);
console.log('');
if (ok) {
  console.log('  ✓ 所有测试都已接线，注册的路径也都存在');
} else {
  console.log(`  ✗ ${problems.length} 处问题：`);
  for (const p of problems) console.log(`    [${p.id}] ${p.msg}`);
  console.log('');
  console.log('  一个能跑通却从不在 CI 里跑的测试，比没有测试更糟——');
  console.log('  它给人一种「这块有覆盖」的错觉。');
}
console.log('');
process.exit(ok ? 0 : 1);
