#!/usr/bin/env node
/**
 * verify-postfix-snapshot.mjs — 核对「修复后快照」与真实被审仓库是否一致
 *
 * 为什么需要它：`experiments/hilltop-dsh/repair-work/post-fix/` 是**事后补拍**的源码快照。
 * 事后补拍的东西有一个共同的失效模式——**补漏了没人发现**。
 * 2026-11-15 第一次补拍就漏了 7 个文件（4 个被修改的测试类 + 3 个新增测试类），
 * 是人工 `git status` 逐行比对才发现的，不是任何机制发现的。
 *
 * 这个脚本把那次人工比对变成机械检查：
 *   被审仓库 `git status` 里的每一条改动（M / ??），
 *   都必须在快照目录里有同名文件，且内容逐字节相同。
 *
 * 用法：
 *   node verify-postfix-snapshot.mjs \
 *     --repo "D:/path/to/target-repo" \
 *     --snapshot experiments/<run>/repair-work/post-fix
 *
 * 退出码：0 一致 / 1 有差异 / 2 配置错误
 *
 * ── 它检查什么 ──────────────────────────────────────────────────────
 *   repo_not_git               --repo 不是 git 仓库（拿不到改动清单）      exit 2
 *   snapshot_missing          快照目录不存在                              exit 2
 *   changed_file_not_snapshotted  仓库里有改动但快照里没有同名文件        FAIL
 *   content_differs           两边都有但内容不同（快照过期）              FAIL
 *   snapshot_file_not_in_repo 快照里有、仓库改动清单里没有（多余/陈旧）   WARN
 *   snapshot_empty            快照里一个文件都没有                        exit 2
 *
 * ── 它不检查什么 ────────────────────────────────────────────────────
 *   不做 git 操作（不 stash、不 diff 全仓），只用 `git status --porcelain` 拿清单。
 *   不判断那些改动「对不对」——那是评审的事。
 *   不检查未跟踪目录（`repair-artifacts/` 这类）里的每个文件，只看顶层条目。
 */

import { readFileSync, existsSync, statSync, readdirSync, lstatSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ARGS = { repo: null, snapshot: null, json: false, exclude: [] };
{
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--repo') ARGS.repo = a[++i];
    else if (a[i] === '--snapshot') ARGS.snapshot = a[++i];
    else if (a[i] === '--exclude') ARGS.exclude.push(a[++i]);
    else if (a[i] === '--json') ARGS.json = true;
    else if (a[i] === '--help' || a[i] === '-h') {
      console.log('用法: node verify-postfix-snapshot.mjs --repo <被审仓库> --snapshot <快照目录> [--exclude <前缀或glob>]... [--json]');
      console.log('');
      console.log('  --exclude  跳过不纳入源码快照的路径前缀（可重复）。');
      console.log('             典型用途：修复产物目录（如 repair-artifacts/）不是源码，');
      console.log('             它有自己的落点（框架仓库的 repair/），不该混进源码快照。');
      console.log('             写成前缀即可：--exclude repair-artifacts/');
      process.exit(0);
    }
  }
}

const problems = [];
const fail = (rule, message, meta = {}) => problems.push({ level: 'FAIL', rule, message, ...meta });
const warn = (rule, message, meta = {}) => problems.push({ level: 'WARN', rule, message, ...meta });

function finish(code) {
  if (ARGS.json) {
    console.log(JSON.stringify({ repo: ARGS.repo, snapshot: ARGS.snapshot, problems, exitCode: code }, null, 2));
  } else {
    if (problems.length === 0) {
      console.log('\n✓ 快照与被审仓库的改动清单一致。\n');
    } else {
      console.log('');
      for (const p of problems) {
        const mark = p.level === 'FAIL' ? '✗' : p.level === 'WARN' ? '!' : 'i';
        console.log(`  ${mark} [${p.rule}] ${p.message}`);
      }
      const f = problems.filter((p) => p.level === 'FAIL').length;
      const w = problems.filter((p) => p.level === 'WARN').length;
      console.log(`\n合计: ${f} FAIL / ${w} WARN\n`);
      if (f > 0) {
        console.log('快照与实际改动对不上。事后补拍的快照最常见的失效就是「补漏了没人发现」——');
        console.log('这份检查就是为了让漏补变成一次机械 FAIL，而不是下次有人想起来才 grep。\n');
      }
    }
  }
  process.exit(code);
}

if (!ARGS.repo) fail('usage', '缺少 --repo <被审仓库>');
if (!ARGS.snapshot) fail('usage', '缺少 --snapshot <快照目录>');
if (problems.length > 0) finish(2);

if (!existsSync(ARGS.snapshot) || !statSync(ARGS.snapshot).isDirectory()) {
  fail('snapshot_missing', `快照目录不存在或不是目录: ${ARGS.snapshot}`);
  finish(2);
}

// ── 拿被审仓库的改动清单 ──
let porcelain;
try {
  porcelain = execFileSync('git', ['-C', ARGS.repo, 'status', '--porcelain'], { encoding: 'utf8' });
} catch (e) {
  fail('repo_not_git', `无法在 ${ARGS.repo} 执行 git status: ${String(e.message ?? e).slice(0, 200)}`);
  finish(2);
}

// porcelain 行格式：`XY <path>`（rename 时是 `XY <old> -> <new>`）
// XY 里可能含空格（例如 ` M`、`??`、`R `），所以按前两个字符切。
const changed = [];
for (const line of porcelain.split('\n')) {
  if (!line.trim()) continue;
  const xy = line.slice(0, 2);
  let rest = line.slice(3).trim();
  if (rest.includes(' -> ')) rest = rest.split(' -> ').pop().trim();   // rename 只看新路径
  // 未跟踪目录在 porcelain 里带尾斜杠（`?? newdir/`）。**不能在这里跳过**——
  // 跳过等于把「一个目录里 20 个新文件」算作 0 条，那是漏报的最短路径。
  // 交给下面的展开逻辑逐个枚举。
  changed.push({ xy, path: rest.replace(/\\/g, '/') });
}

// 未跟踪目录（`?? dir/`）展开成其中的文件，避免「一个新目录里 20 个文件全漏」被算作一条
const expanded = [];
for (const c of changed) {
  const abs = join(ARGS.repo, c.path.replace(/\/$/, ''));
  let isDir = false;
  try { isDir = statSync(abs).isDirectory(); } catch { /* 已删除的文件取不到，保留原条目 */ }
  if (isDir && c.xy.includes('?')) {
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else expanded.push({ xy: c.xy, path: relative(ARGS.repo, p).replace(/\\/g, '/') });
      }
    };
    walk(abs);
  } else {
    expanded.push({ ...c, path: c.path.replace(/\/$/, '') });
  }
}

if (expanded.length === 0) {
  warn('repo_no_changes', '被审仓库 `git status` 是干净的——没有改动可核。若修复确实发生过，说明快照对错了仓库。');
}

// ── 逐条核对快照 ──
const snapshotFiles = new Set();
const walkSnap = (dir, base) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkSnap(p, base);
    else snapshotFiles.add(relative(base, p).replace(/\\/g, '/'));
  }
};
walkSnap(ARGS.snapshot, ARGS.snapshot);

if (snapshotFiles.size === 0) {
  fail('snapshot_empty', `快照目录 ${ARGS.snapshot} 里一个文件都没有`);
  finish(2);
}

const repoChangedSet = new Set();
const excluded = (p) => ARGS.exclude.some((ex) => {
  const e = ex.replace(/\\/g, '/').replace(/\*+$/, '');
  return p === e || p.startsWith(e.endsWith('/') ? e : e + '/');
});
for (const c of expanded) {
  if (excluded(c.path)) continue;
  repoChangedSet.add(c.path);
  const snapFile = join(ARGS.snapshot, c.path);
  if (!existsSync(snapFile)) {
    fail('changed_file_not_snapshotted',
      `仓库里 ${c.path} 有改动（${c.xy.trim() || c.xy}），但快照里没有这个文件`,
      { path: c.path });
    continue;
  }
  // 内容比对（删除的文件跳过：快照里留着删除前的版本是合理的）
  const repoAbs = join(ARGS.repo, c.path);
  if (!existsSync(repoAbs)) continue;   // 被删除的：不比对内容
  let same = false;
  try { same = readFileSync(repoAbs).equals(readFileSync(snapFile)); } catch { /* 读失败按不同处理 */ }
  if (!same) {
    fail('content_differs',
      `${c.path} 在仓库与快照里内容不同——快照是旧版本，或补拍之后仓库又变了`,
      { path: c.path });
  }
}

for (const sf of snapshotFiles) {
  if (sf === 'README.md') continue;   // 快照自带的说明文件
  if (!repoChangedSet.has(sf)) {
    warn('snapshot_file_not_in_repo',
      `快照里有 ${sf}，但被审仓库的改动清单里没有它（多余、或那个改动已被回退）`,
      { path: sf });
  }
}

const failCount = problems.filter((p) => p.level === 'FAIL').length;
finish(failCount > 0 ? 1 : 0);
