#!/usr/bin/env node
/**
 * verify-postfix-snapshot.test.mjs — 快照一致性校验器自测
 *
 * 这些用例全部来自真实失效：
 *   2026-11-15 第一次补拍 post-fix 快照，漏了 7 个文件（4 个被改的测试类 + 3 个新增测试类），
 *   是人工逐行比对 `git status` 才发现的。这个校验器就是把那次人工比对变成机械检查。
 *
 * 所以用例的重点不是「正常情况能过」，而是「漏补、过期、多余 能不能被抓到」。
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'verify-postfix-snapshot.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

const run = (args) => {
  const r = spawnSync('node', [TOOL, ...args], { encoding: 'utf8' });
  return { code: r.status ?? 1, out: (r.stdout ?? '') + (r.stderr ?? '') };
};
const write = (base, rel, body) => {
  const p = join(base, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
};

// 造一个最小的 git 仓库：一个已提交文件 + 一个改动 + 一个新增
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'snap-repo-'));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  write(repo, 'src/a.txt', 'origin a\n');
  write(repo, 'src/b.txt', 'origin b\n');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  // 改一个（M）、新增一个（??）
  write(repo, 'src/a.txt', 'changed a\n');
  write(repo, 'src/c.txt', 'new c\n');
  return { root, repo };
}

// 造一个「正确」的快照：把改动清单里的文件原样拷过去
function makeSnapshot(root, repo, { skip = [], mutate = {} } = {}) {
  const snap = join(root, 'post-fix');
  const changed = ['src/a.txt', 'src/c.txt'].filter((p) => !skip.includes(p));
  for (const p of changed) {
    write(snap, p, mutate[p] ?? (p === 'src/a.txt' ? 'changed a\n' : 'new c\n'));
  }
  return snap;
}

console.log('case 1: 快照完整且内容一致 → exit 0');
{
  const { root, repo } = makeRepo();
  const snap = makeSnapshot(root, repo);
  try {
    const r = run(['--repo', repo, '--snapshot', snap]);
    expect('退出码 0', r.code === 0, `实际 ${r.code}：${r.out.slice(0, 300)}`);
    expect('输出说一致', /一致/.test(r.out), r.out.slice(0, 200));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 2: 漏补一个改动文件 → exit 1，并点名是哪个');
{
  const { root, repo } = makeRepo();
  const snap = makeSnapshot(root, repo, { skip: ['src/a.txt'] });
  try {
    const r = run(['--repo', repo, '--snapshot', snap]);
    expect('退出码 1', r.code === 1, `实际 ${r.code}`);
    expect('报 changed_file_not_snapshotted',
      /changed_file_not_snapshotted/.test(r.out), r.out.slice(0, 400));
    expect('点名叫得上 src/a.txt', /src\/a\.txt/.test(r.out), r.out.slice(0, 400));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 3: 快照过期（内容与仓库不同）→ exit 1');
{
  const { root, repo } = makeRepo();
  const snap = makeSnapshot(root, repo, { mutate: { 'src/a.txt': 'STALE a\n' } });
  try {
    const r = run(['--repo', repo, '--snapshot', snap]);
    expect('退出码 1', r.code === 1, `实际 ${r.code}`);
    expect('报 content_differs', /content_differs/.test(r.out), r.out.slice(0, 400));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 4: 快照里有多余文件 → WARN 但不阻断');
{
  const { root, repo } = makeRepo();
  const snap = makeSnapshot(root, repo);
  write(snap, 'src/EXTRA.txt', 'not in repo changes\n');
  try {
    const r = run(['--repo', repo, '--snapshot', snap]);
    expect('退出码 0（WARN 不阻断）', r.code === 0, `实际 ${r.code}：${r.out.slice(0, 300)}`);
    expect('报 snapshot_file_not_in_repo',
      /snapshot_file_not_in_repo/.test(r.out), r.out.slice(0, 400));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 5: 快照目录不存在 → exit 2');
{
  const { root, repo } = makeRepo();
  try {
    const r = run(['--repo', repo, '--snapshot', join(root, 'nope')]);
    expect('退出码 2', r.code === 2, `实际 ${r.code}`);
    expect('报 snapshot_missing', /snapshot_missing/.test(r.out), r.out.slice(0, 300));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 6: --repo 不是 git 仓库 → exit 2');
{
  const root = mkdtempSync(join(tmpdir(), 'snap-nogit-'));
  const snap = join(root, 'post-fix');
  write(snap, 'x.txt', 'x');
  try {
    const r = run(['--repo', root, '--snapshot', snap]);
    expect('退出码 2', r.code === 2, `实际 ${r.code}`);
    expect('报 repo_not_git', /repo_not_git/.test(r.out), r.out.slice(0, 400));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 7: 快照是空目录 → exit 2（「一个文件都没有」不是「一致」）');
{
  const { root, repo } = makeRepo();
  const snap = join(root, 'post-fix');
  mkdirSync(snap, { recursive: true });
  try {
    const r = run(['--repo', repo, '--snapshot', snap]);
    expect('退出码 2', r.code === 2, `实际 ${r.code}`);
    expect('报 snapshot_empty', /snapshot_empty/.test(r.out), r.out.slice(0, 300));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 8: 仓库无改动 → WARN（快照可能对错了仓库）');
{
  const root = mkdtempSync(join(tmpdir(), 'snap-clean-'));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  write(repo, 'src/a.txt', 'only a\n');
  const g = (...a) => execFileSync('git', ['-C', repo, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const snap = join(root, 'post-fix');
  write(snap, 'src/a.txt', 'only a\n');
  try {
    const r = run(['--repo', repo, '--snapshot', snap]);
    expect('退出码 0（没有改动不是错误）', r.code === 0, `实际 ${r.code}：${r.out.slice(0, 300)}`);
    expect('但给出 repo_no_changes 警告',
      /repo_no_changes/.test(r.out), r.out.slice(0, 400));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 9: 未跟踪的新目录会被展开成文件（不是只算一条）');
{
  const { root, repo } = makeRepo();
  // 造一个全新目录，里面 3 个文件
  write(repo, 'newdir/x.txt', '1');
  write(repo, 'newdir/y.txt', '2');
  write(repo, 'newdir/z.txt', '3');
  const snap = makeSnapshot(root, repo);
  try {
    const r = run(['--repo', repo, '--snapshot', snap]);
    expect('退出码 1', r.code === 1, `实际 ${r.code}`);
    expect('点名 newdir/x.txt', /newdir\/x\.txt/.test(r.out), r.out.slice(0, 500));
    expect('点名 newdir/z.txt（三个都要报，不能只报目录）',
      /newdir\/z\.txt/.test(r.out), r.out.slice(0, 500));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 10: --json 输出机器可读且带 exitCode');
{
  const { root, repo } = makeRepo();
  const snap = makeSnapshot(root, repo, { skip: ['src/c.txt'] });
  try {
    const r = run(['--repo', repo, '--snapshot', snap, '--json']);
    let j = null;
    try { j = JSON.parse(r.out); } catch { /* 下面断言 */ }
    expect('JSON 可解析', j !== null, r.out.slice(0, 200));
    expect('exitCode 字段是 1', j?.exitCode === 1, JSON.stringify(j?.exitCode));
    expect('problems 里有 FAIL', (j?.problems ?? []).some((p) => p.level === 'FAIL'),
      JSON.stringify(j?.problems?.map((p) => p.rule)));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 11: --exclude 跳过指定前缀（产物目录不是源码）');
{
  const { root, repo } = makeRepo();
  write(repo, 'artifacts/done-1.md', 'not source');
  const snap = makeSnapshot(root, repo);   // 只拷 src/a.txt 与 src/c.txt
  try {
    const r1 = run(['--repo', repo, '--snapshot', snap]);
    expect('不排除时 exit 1（artifacts/ 也被查）', r1.code === 1, `实际 ${r1.code}`);
    const r2 = run(['--repo', repo, '--snapshot', snap, '--exclude', 'artifacts/']);
    expect('排除后 exit 0', r2.code === 0, `实际 ${r2.code}：${r2.out.slice(0, 300)}`);
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 12: --exclude 不能吞掉源码（匹配按路径段边界，不是裸前缀）');
{
  const { root, repo } = makeRepo();
  const snap = makeSnapshot(root, repo, { skip: ['src/a.txt'] });
  try {
    // 排除了 'sr' 这种短前缀也不该误伤 'src/a.txt'
    const r = run(['--repo', repo, '--snapshot', snap, '--exclude', 'sr']);
    expect('仍然 exit 1（未被 "sr" 误排除）', r.code === 1, `实际 ${r.code}`);
    expect('仍点名 src/a.txt', /src\/a\.txt/.test(r.out), r.out.slice(0, 400));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 13: --exclude 排除源码 → FAIL（有开关的检查会被用来关掉检查）');
{
  const { root, repo } = makeRepo();
  // 造一个源码文件 + 一个产物文件
  write(repo, 'src/Main.java', 'class Main {}');
  const snap = makeSnapshot(root, repo, { skip: ['src/Main.java'] });
  try {
    const r = run(['--repo', repo, '--snapshot', snap, '--exclude', 'src/Main.java']);
    expect('退出码 1', r.code === 1, `实际 ${r.code}`);
    expect('报 exclude_hides_source', /exclude_hides_source/.test(r.out), r.out.slice(0, 400));
    expect('点名被藏起来的源码文件', /src\/Main\.java/.test(r.out), r.out.slice(0, 500));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

console.log('case 14: --exclude 排除非源码（产物目录）→ 允许');
{
  const { root, repo } = makeRepo();
  write(repo, 'artifacts/report.json', '{}');
  write(repo, 'artifacts/notes.md', 'notes');
  const snap = makeSnapshot(root, repo);
  try {
    const r = run(['--repo', repo, '--snapshot', snap, '--exclude', 'artifacts/']);
    expect('退出码 0（.json/.md 不算源码）', r.code === 0, `实际 ${r.code}：${r.out.slice(0, 300)}`);
    expect('不报 exclude_hides_source', !/exclude_hides_source/.test(r.out), r.out.slice(0, 300));
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// ── 用法错误的提前返回 ──
//
// 2026-11-21 变异测试：把 `if (problems.length > 0) finish(2);` 里的
// `> 0` 改成 `> 999999` 后自测仍全过——这条**用法错误的提前返回**从没被覆盖。
//
// 它保证「缺 --repo / --snapshot 时立即停」，而不是继续往下走、
// 在某个空路径上抛出看不懂的异常。少了它，用户看到的是堆栈而不是"缺参数"。
console.log('缺 --repo → exit 2，且给出可读提示（不是堆栈）');
{
  const r = run(['--snapshot', join(tmpdir(), 'whatever')]);
  expect('exit 2', r.code === 2, `code=${r.code}`);
  expect('提到 --repo', /--repo/.test(r.out), r.out.slice(0, 200));
  expect('不是堆栈', !/at Object\.|TypeError|ReferenceError/.test(r.out), r.out.slice(0, 200));
}

console.log('缺 --snapshot → exit 2，且给出可读提示');
{
  const r = run(['--repo', join(tmpdir(), 'whatever')]);
  expect('exit 2', r.code === 2, `code=${r.code}`);
  expect('提到 --snapshot', /--snapshot/.test(r.out), r.out.slice(0, 200));
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
