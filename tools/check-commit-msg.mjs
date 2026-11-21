#!/usr/bin/env node
/**
 * check-commit-msg.mjs — commit message 的 type 是否在允许的七种之内
 *
 * ── 为什么需要（D:\Projects\docs\PROJECT-RULES.md 规则 3.2）──────────────
 *
 * 规则原文：
 *
 *   格式 `type(scope): 描述`，写**为什么改**而不只是**改了什么**。
 *   **type 用这七个，不要自创**（取自 Conventional Commits）：
 *   feat / fix / docs / refactor / test / chore / perf
 *
 * 本仓库历史上自创过 `cleanup`、`correct`、`diagnosis`、`probe`、`verdict`。
 * 自创 type 的代价不是"不好看"：`git log --grep="^feat"` 这类用法会静默漏掉
 * 本该被筛到的提交，而写提交的人并不知道自己漏了。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *
 *   M1  type 必须在七种之内             → FAIL
 *   M2  格式必须是 `type: 描述` 或 `type(scope): 描述` → FAIL
 *   M3  描述不能为空、不能只有标点       → FAIL
 *
 *   `revert:` 单独放行 —— Conventional Commits 里它是合法的特殊形式，
 *   而且本仓库确实用过一次真正的回滚。
 *
 * ── 它检查哪个范围 ───────────────────────────────────────────────────
 *
 *   默认只查 `--since` 之后的提交，不给就查最近 1 个（HEAD）。
 *
 *   **不查历史存量。** 历史提交改不了（改要重写历史，规则 3.3 禁止
 *   `push --force` 与破坏性命令），而一道上线首日就红出 8 条的闸门
 *   会被立刻关掉，然后连带把真的能用的检查一起拖下水。
 *   这与 check-rule-ledger 的处置相同：存量只统计，新增才拦。
 *
 * 用法：
 *   node check-commit-msg.mjs [--since <ref>] [--all] [--json]
 *   node check-commit-msg.mjs --msg "feat(x): y"   # 直接验一条（给 pre-commit 用）
 *
 * 退出码：0 通过 / 1 有违规 / 2 配置错误（非 git 仓库）
 */

import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

const ARG = { since: null, all: false, json: false, msg: null };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--since') ARG.since = process.argv[++i];
  else if (a === '--all') ARG.all = true;
  else if (a === '--json') ARG.json = true;
  else if (a === '--msg') ARG.msg = process.argv[++i];
  else if (a === '--help' || a === '-h') {
    console.log('用法: node check-commit-msg.mjs [--since <ref>] [--all] [--json] [--msg "<message>"]');
    process.exit(0);
  } else { console.error(`未知参数: ${a}`); process.exit(2); }
}

const ALLOWED = new Set(['feat', 'fix', 'docs', 'refactor', 'test', 'chore', 'perf', 'revert']);
// `type` 或 `type(scope)`，后接 `: ` 与描述


/** 验一条 message，返回 null（通过）或问题描述 */
function checkOne(subject) {
  const s = String(subject ?? '').trim();
  if (!s) return { id: 'M3', msg: '提交信息为空' };

  // 先单独判「有没有 type 与冒号」，把「缺描述」和「格式全错」区分开。
  // 2026-11-21 实测踩到：`feat: ` 经 trim 后变成 `feat:`，
  // 直接套完整 FORMAT（要求冒号后有 \S）会判成 M2「格式不符」——
  // 但它的 type 和冒号都是对的，只是没写描述，属于 M3。
  // 分类错了会让修法提示指向错误的方向。
  const head = s.match(/^([a-z]+)(\([^)]*\))?!?:\s*(.*)$/);
  if (!head) {
    return {
      id: 'M2',
      msg: `格式不符合 \`type: 描述\` 或 \`type(scope): 描述\` —— 实际: "${s.slice(0, 70)}"`,
    };
  }
  const [, type, , desc] = head;
  if (!ALLOWED.has(type)) {
    return {
      id: 'M1',
      msg: `type \`${type}\` 不在允许的七种之内（${[...ALLOWED].join(' / ')}）。`
        + '**不要自创**——`git log --grep="^feat"` 这类用法会静默漏掉它',
    };
  }
  // 描述不能为空，也不能只是标点 / 敷衍词。
  // 注意：CJK 两个字就是有意义的描述（「还原」「修正」），
  // 所以下限取 2 个非标点字符，而不是"词数"。
  const bare = desc.replace(/[.。，,、;；:：!！?？\s\-—_*#`]/g, '');
  if (bare.length < 2) {
    return { id: 'M3', msg: `描述为空或只有标点: "${desc.trim()}"` };
  }
  return null;
}

// ── 直接验一条（--msg）──
if (ARG.msg !== null) {
  const bad = checkOne(ARG.msg);
  if (ARG.json) {
    console.log(JSON.stringify({ ok: !bad, message: ARG.msg, problem: bad }, null, 2));
    process.exit(bad ? 1 : 0);
  }
  if (bad) { console.log(`  ✗ [${bad.id}] ${bad.msg}`); process.exit(1); }
  console.log('  ✓ 格式合规');
  process.exit(0);
}

// ── 从 git 读提交 ──
function gitSubject(ref) {
  return execFileSync('git', ['-C', ROOT, 'log', '-1', '--format=%s', ref], { encoding: 'utf8' }).trim();
}

let commits = [];   // { sha, subject }
try {
  if (ARG.all) {
    const out = execFileSync('git', ['-C', ROOT, 'log', '--format=%h\t%s'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    commits = out.trim().split('\n').filter(Boolean).map((l) => {
      const [sha, ...rest] = l.split('\t');
      return { sha, subject: rest.join('\t') };
    });
  } else {
    const range = ARG.since ? `${ARG.since}..HEAD` : 'HEAD~1..HEAD';
    const out = execFileSync('git', ['-C', ROOT, 'log', range, '--format=%h\t%s'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    commits = out.trim().split('\n').filter(Boolean).map((l) => {
      const [sha, ...rest] = l.split('\t');
      return { sha, subject: rest.join('\t') };
    });
  }
} catch (e) {
  console.error(`[配置错误] 读不到 git 提交（${e.message}）。本检查需要 git 仓库`);
  process.exit(2);
}

if (commits.length === 0) {
  // 空范围不是"通过"——但也可能是确实没有新提交（如刚 tag 完）。
  // 这里不判失败，而是明确说明"没有可检查的提交"，避免假装查过。
  if (ARG.json) { console.log(JSON.stringify({ ok: true, checked: 0, note: 'no commits in range' }, null, 2)); process.exit(0); }
  console.log('\n没有可检查的提交（范围为 0 条）——这不等于通过，只是没有新增\n');
  process.exit(0);
}

const results = commits.map((c) => ({ ...c, problem: checkOne(c.subject) }));
const bad = results.filter((r) => r.problem);

if (ARG.json) {
  console.log(JSON.stringify({ ok: bad.length === 0, checked: results.length, violations: bad }, null, 2));
  process.exit(bad.length === 0 ? 0 : 1);
}

console.log('\n提交信息格式检查（PROJECT-RULES.md 规则 3.2）\n');
console.log(`  检查范围   ${ARG.all ? '全部历史（--all）' : (ARG.since ? `${ARG.since}..HEAD` : 'HEAD~1..HEAD')}`);
console.log(`  提交数     ${results.length}`);
console.log('');

if (bad.length === 0) {
  console.log('  ✓ 全部合规');
} else {
  console.log(`  ✗ ${bad.length} 条不合规：`);
  for (const r of bad) console.log(`    [${r.problem.id}] ${r.sha}  ${r.problem.msg}`);
}
console.log('');
process.exit(bad.length === 0 ? 0 : 1);
