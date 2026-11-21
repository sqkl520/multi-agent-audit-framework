#!/usr/bin/env node
/**
 * check-suite-vitality.mjs — 每个自测套件是否"真的会失败"
 *
 * ── 为什么需要（2026-11-21）────────────────────────────────────────
 *
 * 这个仓库有 45 个套件、上千条断言，全部绿。但「绿」只证明**当前代码通过了自己
 * 写的断言**，不证明「代码坏掉时断言会红」。
 *
 * 一个自测最容易出的问题不是断言写错，是**断言根本没在测东西**：
 *
 *   - 校验器改坏了，自测仍然通过（判据写成了恒真）
 *   - 断言覆盖的是无关紧要的分支，核心逻辑坏了没人管
 *   - 早退：前一条断言失败就 return，后面的检查从没执行过
 *
 * 这正是 `review-7` 记录的那个形态：「闸门全绿却有 5 条缺陷」。
 *
 * ── 它做什么 ────────────────────────────────────────────────────────
 *
 * 变异测试（mutation testing）的轻量版：
 *
 *   对每个校验器，往它的源码里注入一组典型的破坏，
 *   然后跑它的自测 —— **自测必须失败**。
 *
 *   某个破坏没被自测抓到，说明那段逻辑没有被任何断言覆盖。
 *
 * ── 变异算子（都对应"真实可能发生的错"）──────────────────────────────
 *
 *   M1 判据取反        `===` → `!==`        （把"必须相等"写成"必须不等"）
 *   M2 失败改成功      `process.exit(1)` → `process.exit(0)`
 *   M3 阈值改大        `> 0` → `> 999999`   （让判据永不触发）
 *   M4 检查跳过        `return problems` 前插 `return []`
 *
 * 只对**判定类**校验器有意义。生成器/模拟器（gen-* / simulate-*）跳过，
 * 它们没有"该失败"的概念。
 *
 * 用法：
 *   node check-suite-vitality.mjs [--json] [--only <name>] [--max-mutants 4]
 *
 * 退出码：0 = 全部变异都被抓到 / 1 = 有变异存活（存在未覆盖逻辑）
 *         2 = 配置错误
 *
 * ⚠️ 它**只写临时副本**，不碰工作区。这一点是硬要求——
 *    2026-11-20 我用变异测试时把 `.mutbak` 留在仓库里、
 *    脚本超时被杀导致框架文件停在变异状态，是批判 Agent 发现并报告的。
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const ARG = { json: false, only: null, maxMutants: 4 };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--json') ARG.json = true;
  else if (a === '--only') ARG.only = process.argv[++i];
  else if (a === '--max-mutants') ARG.maxMutants = Number(process.argv[++i]);
  else if (a === '--help' || a === '-h') {
    console.log('用法: node check-suite-vitality.mjs [--json] [--only <name>] [--max-mutants 4]');
    process.exit(0);
  } else { console.error(`未知参数: ${a}`); process.exit(2); }
}

// ── 有判定语义、且有自测的校验器 ──
// 生成器与模拟器排除：它们没有"该失败"的概念。
const SKIP_PREFIX = /^(gen-|simulate-|check-all|dsh-driver)/;

function candidates() {
  return readdirSync(HERE)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .map((f) => f.replace(/\.mjs$/, ''))
    .filter((n) => !SKIP_PREFIX.test(n))
    .filter((n) => existsSync(join(HERE, `${n}.test.mjs`)))
    .filter((n) => !ARG.only || n === ARG.only);
}

// ── 变异算子 ──
//
// 每个算子都返回改后的源码；改不动（模式不存在）就返回 null，跳过该算子。
const MUTATORS = [
  {
    id: 'M1-equality-flip',
    desc: '判据取反（=== → !==）',
    apply(src) {
      // 只翻转「比较两个变量/表达式」的 ===，跳过与 null/undefined 的比较
      //（那些翻转后几乎必然抛异常，测不出"断言是否覆盖"）
      const re = /(\w[\w.\[\]]*)\s*===\s*(\d+)/g;
      let hit = false;
      const out = src.replace(re, (m, a, b) => { hit = true; return `${a} !== ${b}`; });
      return hit ? out : null;
    },
  },
  {
    id: 'M2-exit-flip',
    desc: '失败退成成功（process.exit(1) → process.exit(0)）',
    apply(src) {
      if (!/process\.exit\(1\)/.test(src)) return null;
      return src.replace(/process\.exit\(1\)/g, 'process.exit(0)');
    },
  },
  {
    id: 'M3-threshold-inflate',
    desc: '判定阈值放大（problems.length > 0 → > 999999，让闸门永不触发）',
    apply(src) {
      // 2026-11-21 修正：第一版匹配任何 `length > 0`，结果打中的是
      // `if (warnings.length > 0)` 这种**打印分支**，不是判定逻辑。
      // 那种变异存活是正常的（少打一行警告，本来就没人断言），
      // 报出来只会是噪声，然后整条检查被关掉。
      //
      // 现在只针对 `problems.length > 0` —— 那才是"有没有问题"的判定。
      const re = /problems\.length\s*>\s*0(?!\d)/g;
      if (!re.test(src)) return null;
      return src.replace(re, 'problems.length > 999999');
    },
  },
  {
    id: 'M4-drop-a-check',
    desc: '丢掉一类违规（把某个 kind 的 push 改成空操作）',
    apply(src) {
      // 2026-11-21 修正：第一版是「把 problems.push 替换成 void (」，
      // 语法上能跑但整个文件的行为变得不可预测，测出来的东西说明不了问题。
      //
      // 现在只对**第一处** problems.push 做「整条语句注释掉」，
      // 模拟"某类检查被误删"。这是真实会发生的 bug 形态。
      const m = src.match(/^\s*problems\.push\(\{[\s\S]*?\}\);\s*$/m);
      if (!m) return null;
      return src.replace(m[0], '      /* MUTANT: check dropped */;');
    },
  },
];

/**
 * 在临时目录里跑：拷一份仓库，改坏校验器，跑自测，看是否失败。
 *
 * ★ 只写临时副本。2026-11-20 的教训：在工作区做变异导致框架文件被留在变异状态。
 */
function runMutation(name, mutator) {
  const tmp = mkdtempSync(join(tmpdir(), `mut-${name}-`));
  try {
    // 只拷自测需要的最小集合：tools/ + framework/ + 必要的顶层 md
    cpSync(join(ROOT, 'tools'), join(tmp, 'tools'), { recursive: true });
    if (existsSync(join(ROOT, 'framework'))) cpSync(join(ROOT, 'framework'), join(tmp, 'framework'), { recursive: true });
    for (const f of ['README.md', 'README.en.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md']) {
      if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(tmp, f));
    }
    if (existsSync(join(ROOT, 'docs'))) cpSync(join(ROOT, 'docs'), join(tmp, 'docs'), { recursive: true });

    const target = join(tmp, 'tools', `${name}.mjs`);
    const orig = readFileSync(target, 'utf8');
    const mutated = mutator.apply(orig);
    if (mutated === null || mutated === orig) return { status: 'NOOP' };
    writeFileSync(target, mutated);

    // 跑自测：期望它**失败**（非 0 退出）
    try {
      execFileSync(process.execPath, [join(tmp, 'tools', `${name}.test.mjs`)], {
        encoding: 'utf8', stdio: 'pipe', timeout: 120000,
      });
      return { status: 'SURVIVED' };   // 自测仍然通过 = 这个变异没被抓到
    } catch (e) {
      if (e.signal) return { status: 'TIMEOUT', signal: e.signal };
      return { status: 'KILLED' };     // 自测失败 = 抓到了
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── 主循环 ──
const names = candidates();
if (names.length === 0) {
  console.error('[配置错误] 没有找到可测的校验器（有 .test.mjs 且不是生成器）');
  process.exit(2);
}

const results = [];
for (const name of names) {
  const perMutator = [];
  for (const m of MUTATORS.slice(0, ARG.maxMutants)) {
    const r = runMutation(name, m);
    perMutator.push({ mutator: m.id, desc: m.desc, ...r });
  }
  const applied = perMutator.filter((r) => r.status !== 'NOOP');
  const survived = applied.filter((r) => r.status === 'SURVIVED');
  results.push({
    name,
    applied: applied.length,
    killed: applied.filter((r) => r.status === 'KILLED').length,
    survived: survived.length,
    detail: perMutator,
  });
}

const totalApplied = results.reduce((a, r) => a + r.applied, 0);
const totalKilled = results.reduce((a, r) => a + r.killed, 0);
const totalSurvived = results.reduce((a, r) => a + r.survived, 0);

if (ARG.json) {
  console.log(JSON.stringify({
    ok: totalSurvived === 0,
    suites: results.length, applied: totalApplied, killed: totalKilled, survived: totalSurvived,
    results,
  }, null, 2));
  process.exit(totalSurvived === 0 ? 0 : 1);
}

console.log('\n自测套件活力检查（变异测试：改坏校验器，自测是否报错）\n');
console.log('套件'.padEnd(30) + '变异  抓到  存活');
console.log('─'.repeat(60));
for (const r of results) {
  const mark = r.survived > 0 ? '✗' : (r.applied > 0 ? '✓' : '–');
  console.log(`${mark} ${r.name.padEnd(28)}${String(r.applied).padStart(4)}${String(r.killed).padStart(6)}${String(r.survived).padStart(6)}`);
}
console.log('─'.repeat(60));
console.log(`合计: ${results.length} 个套件 / ${totalApplied} 个变异 / 抓到 ${totalKilled} / 存活 ${totalSurvived}\n`);

if (totalSurvived > 0) {
  console.log('存活的变异（这些逻辑没有被任何断言覆盖）：');
  for (const r of results) {
    for (const d of r.detail) {
      if (d.status === 'SURVIVED') console.log(`  [${r.name}] ${d.mutator}: ${d.desc}`);
    }
  }
  console.log('');
}

process.exit(totalSurvived === 0 ? 0 : 1);
