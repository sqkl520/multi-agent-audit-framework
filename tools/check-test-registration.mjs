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
 *   R4  每个「有自测的校验器」都必须至少在**一条真实调用路径**上：
 *         (a) 出现在 `check-repo.mjs` 的 TARGETS 里（对真实仓库跑）
 *         (b) 出现在 `check-repo.mjs` 的 SKIPPED / MANUAL_ONLY 里（需要运行时输入 / 只能按需跑）
 *         (c) 被另一个非 .test 的 `tools/*.mjs` **在代码里**引用
 *         (d) 在 CI workflow 的 `run:` 步骤里真的被执行
 *       四条都不满足 → 它只在自测里存在，从没对着任何真实输入跑过
 *
 *   R4 是 2026-11-24 补的。R1–R3 只保证「自测会跑」，不保证「校验器会跑」。
 *   实测：`check-doc-counts` 的接线修好前报出 14 处过期数字（exit 1），
 *   而它的自测一直绿、CI 一直绿。**自测绿和仓库干净是两个命题。**
 *
 *   2026-11-25 锐评实测修正了 (c)/(d) 的判据：
 *     · (c) 原来是裸子串 `src.includes(name)`，于是**注释里提到**也算接线——
 *       `check-contract-slices`（唯一"引用"是别人文件头的注释）与
 *       `check-suite-vitality`（唯一"引用"是 check-all.mjs 的注释）被误判为已接线，
 *       而它们正是 R4 要抓的那类。现在走 `lib/code-scan.mjs`：去注释 + 完整文件名匹配
 *       （后者顺带解决 `consistency.mjs` ⊂ `check-enum-consistency.mjs` 的撞车）。
 *     · (d) 原来直接对整份 workflow 跑正则，注释掉的 `# run: node tools/old.mjs`
 *       也会命中。现在只认未注释的 `run:` 行。
 *
 * 用法：node check-test-registration.mjs [--json]
 * 退出码：0 全部接线 / 1 有漏 / 2 配置错误
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mentionsFile, workflowRuns } from './lib/code-scan.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
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

// ── R4 · 有自测的校验器必须至少在一条真实调用路径上 ──
//
// 四种「接上了」的形态：
//   (a) check-repo.mjs 的 TARGETS：对真实仓库跑
//   (b) check-repo.mjs 的 SKIPPED / MANUAL_ONLY：需要运行时输入 / 只能按需跑
//   (c) 被另一个非 .test 的 tools/*.mjs **在代码里**引用（不是注释里提到）
//   (d) CI workflow 的 run: 步骤里真的执行它（不是注释里的历史命令）
//
// check-repo.mjs 自身也必须被 check-all 注册，否则 R4 的证据来源本身就没人跑。
const repoPath = join(HERE, 'check-repo.mjs');
if (!existsSync(repoPath)) {
  problems.push({ id: 'R4', file: 'check-repo.mjs', msg: 'check-repo.mjs 不存在——R4 的证据来源缺失' });
} else if (!registered.includes('check-repo.mjs')) {
  problems.push({
    id: 'R4', file: 'check-repo.mjs',
    msg: 'check-repo.mjs 存在但没被 check-all 注册——那条「对真实仓库跑一遍」的路径从不在 CI 里跑',
  });
}

if (existsSync(repoPath)) {
  const repoSrc = readFileSync(repoPath, 'utf8');
  // (a)(b)：check-repo.mjs 里 TARGETS / SKIPPED / MANUAL_ONLY 的 script 字段
  const wired = new Set([
    ...[...repoSrc.matchAll(/script:\s*'([^']+\.mjs)'/g)].map((m) => m[1]),
  ]);

  // (c) 被其他非 test 脚本**在代码里**引用。
  //
  // 2026-11-25：原先这里是裸子串 `src.includes(n)`，锐评实测它把注释当引用，
  // 于是 `check-contract-slices` 与 `check-suite-vitality` 被误判为已接线——
  // 它们唯一的"引用"分别是文件头注释与 check-all.mjs 的说明性注释。
  // 现在走 lib/code-scan.mjs：去注释 + 完整文件名（顺带解决 consistency.mjs
  // ⊂ check-enum-consistency.mjs 的子串撞车）。
  const allTools = readdirSync(HERE).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
  const srcOf = new Map(allTools.map((f) => [f, readFileSync(join(HERE, f), 'utf8')]));
  for (const n of allTools) {
    for (const [g, src] of srcOf) {
      if (g !== n && g !== 'check-test-registration.mjs' && mentionsFile(src, n)) wired.add(n);
    }
  }

  const validatorsWithTests = allTools
    .map((f) => f.replace(/\.mjs$/, ''))
    .filter((n) => existsSync(join(HERE, `${n}.test.mjs`)));

  // (d) CI workflow 里 `run:` 一行真的执行它。
  //
  // 2026-11-24：`check-bilingual-links` 与 `check-commit-msg` 在 CI 里是独立步骤，
  // 但不在 check-repo 里，第一版 R4 把它们误报成「只在自测里」。
  // 2026-11-25：改成只认未注释的 `run:` 行——原先对整份 YAML 跑正则，
  // `# run: node tools/old.mjs` 这种注释掉的历史命令也会命中。
  const wfPath = join(ROOT, '.github', 'workflows', 'checks.yml');
  const wfSrc = existsSync(wfPath) ? readFileSync(wfPath, 'utf8') : '';
  for (const n of allTools) {
    if (workflowRuns(wfSrc, n)) wired.add(n);
  }

  for (const n of validatorsWithTests) {
    const file = `${n}.mjs`;
    if (wired.has(file)) continue;
    problems.push({
      id: 'R4', file,
      msg: `${file} 有自测，但**没有任何一条真实调用路径**——`
        + '不在 check-repo.mjs 的 TARGETS/SKIPPED 里，也没被其他工具引用。'
        + '它的自测会在 CI 里跑，而它本人从没对着真实输入跑过',
    });
  }
}

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
