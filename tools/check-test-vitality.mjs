#!/usr/bin/env node
/**
 * check-test-vitality.mjs — 每个自测文件是否**真的会失败**
 *
 * ── 为什么需要（2026-11-22 血的教训）────────────────────────────────
 *
 * 原生 dsh 跑完整审计后，我用变异测试扫了一遍框架自己的 45 个套件，
 * 发现 `stop-hook.test.mjs` **末尾只有 console.log，没有 process.exit()**。
 *
 * 后果：135 条断言，即使 66 条失败，进程仍然以 0 退出 ——
 * **这个套件从写下的那天起就没红过**，`check-all` 和 CI 永远是绿的。
 *
 * 断言写得再多，不以非零退出就等于没写。
 *
 * ── 为什么不能只靠变异测试 ──
 *
 * `check-suite-vitality.mjs` 里有这条检查，但全量变异要跑十几分钟，
 * 没人会每次提交都跑。而「忘记写 process.exit」是新写测试最常见的疏漏之一——
 * 它必须进 `check-all`，每次提交都查。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *
 *   V1  文件里必须有 `process.exit(` 或 `process.exitCode =`
 *   V2  那个 exit **不能是常量**：`process.exit(0)` 单独出现不算，
 *       因为「永远成功」和「不写」等价
 *   V3  文件里得有 `fail` / `pass` 这类计数变量（否则断言可能根本没被统计）
 *
 * 用法：node check-test-vitality.mjs [--json]
 * 退出码：0 通过 / 1 有致命问题 / 2 配置错误（一个测试文件都没找到）
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const jsonOut = process.argv.includes('--json');

const testFiles = readdirSync(HERE).filter((f) => f.endsWith('.test.mjs')).sort();
if (testFiles.length === 0) {
  console.error('[预期失败] 一个 .test.mjs 都没有——路径可能变了');
  process.exit(2);
}

const problems = [];
const checked = [];

for (const f of testFiles) {
  const src = readFileSync(join(HERE, f), 'utf8');

  // V1 · 有没有 exit
  const hasExit = /process\.exit\s*\(|process\.exitCode\s*=/.test(src);
  if (!hasExit) {
    problems.push({
      id: 'V1', file: f,
      msg: `${f} 没有 process.exit() / process.exitCode —— **无论多少条断言失败，它都以 0 退出**`,
    });
    continue;
  }

  // V2 · exit 的值是不是常量 0
  //
  // 只认 `process.exit(fail > 0 ? 1 : 0)` 这类**条件**退出。
  // `process.exit(0)` 单独写在结尾，与「不写」等价。
  //
  // 例外：`--self-test` 这类分支里允许主动 exit(0)（成功路径提前返回），
  // 但文件末尾必须还有一个带条件的退出。判据取「文件里至少有一处条件退出」。
  const conditionalExit = /process\.exit\s*\([^)]*\?[^)]*\)/.test(src)
    || /process\.exit\s*\(\s*(?:fail|failCount|failed|errs|errors)\b/.test(src)
    || /process\.exit\s*\(\s*[a-zA-Z_$][\w$]*\s*\)/.test(src)
    || /process\.exitCode\s*=\s*[^0\s]/.test(src);
  if (!conditionalExit) {
    // 再看是不是所有 exit 都是常量 0
    const exits = [...src.matchAll(/process\.exit\s*\(\s*([^)]*)\)/g)].map((m) => m[1].trim());
    const allLiteralZero = exits.length > 0 && exits.every((a) => a === '0');
    if (allLiteralZero) {
      problems.push({
        id: 'V2', file: f,
        msg: `${f} 的 process.exit() 全部是常量 0 —— 与「不写 exit」等价，永远不会失败`,
      });
      continue;
    }
  }

  // V3 · 有没有失败计数
  //
  // 2026-11-21 实测：有些文件用 `let pass = 0, fail = 0` + `expect()` 累加。
  // 如果连计数变量都没有，断言可能只是 console.log，压根没统计。
  const hasCounter = /\b(fail|failed|failCount|errors|errs|problems)\b\s*(\+\+|\+=|=)/.test(src)
    || /\b(fail|failed|failCount)\b/.test(src);
  if (!hasCounter) {
    problems.push({
      id: 'V3', file: f,
      msg: `${f} 找不到失败计数变量（fail / failed / errors）——断言可能根本没被统计`,
    });
    continue;
  }

  checked.push(f);
}

const ok = problems.length === 0;

if (jsonOut) {
  console.log(JSON.stringify({ ok, total: testFiles.length, passed: checked.length, problems }, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log('\n自测活力检查（每个套件是否真的会失败）\n');
console.log(`  测试文件   ${testFiles.length} 个`);
console.log(`  合格       ${checked.length} 个`);
console.log('');
if (ok) {
  console.log('  ✓ 全部会以非零退出码表示失败');
} else {
  console.log(`  ✗ ${problems.length} 个有致命问题：`);
  for (const p of problems) console.log(`    [${p.id}] ${p.msg}`);
  console.log('');
  console.log('  断言写得再多，不以非零退出就等于没写。');
  console.log('  这类文件在 check-all 和 CI 里永远是绿的——而它本该红。');
}
console.log('');
process.exit(ok ? 0 : 1);
