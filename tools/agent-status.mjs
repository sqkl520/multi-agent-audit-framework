#!/usr/bin/env node
/**
 * agent-status.mjs — 判断一个子 Agent 现在是哪种状态
 *
 * 为什么需要（2026-11-12 真实事故）：
 *   我派了一个 agent 去审计，然后连续 35 分钟说「它还在跑」。
 *   事实是它 22:39 就把产物写完了，而我一直只 stat 它的 JSONL 转录文件——
 *   那个文件从启动起就一直是 0 字节，从头到尾没有任何信息量。
 *
 *   问题不在「等太久」，在于**用一个和任务成功标准无关的指标当进度**。
 *
 *   任务定义的成功标准是「产物文件存在且合规」，
 *   而我盯的是「转录文件有多大」。
 *
 * 这个脚本把「它到底做到哪了」变成三个可观测事实：
 *
 *   1. 声明的产物路径存在吗
 *   2. 它多久没动了（mtime 距今）
 *   3. 工作目录里有没有活动痕迹
 *
 * 用法：
 *   node agent-status.mjs --artifact <预期产物路径> [--workdir <工作目录>] [--json]
 *
 * 退出码：0 = 已产出  1 = 可能还在跑  2 = 疑似黏住（有活动但很久没产物）
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const ai = args.indexOf('--artifact');
const wi = args.indexOf('--workdir');
const STALL_MIN = Number((args.find((a, i) => args[i - 1] === '--stall-minutes') ?? '15'));

if (ai < 0) {
  console.error('用法: node agent-status.mjs --artifact <预期产物路径> [--workdir <目录>] [--stall-minutes 15] [--json]');
  process.exit(2);
}

const artifact = resolve(args[ai + 1]);
const workdir = wi >= 0 ? resolve(args[wi + 1]) : dirname(artifact);

const now = Date.now();
const minutesAgo = (t) => Math.round((now - t) / 60000);

const out = {
  artifact,
  artifact_exists: false,
  artifact_size: 0,
  artifact_age_min: null,
  workdir,
  workdir_recent_files: [],
  workdir_latest_age_min: null,
  verdict: 'UNKNOWN',
  hint: '',
};

// ── 1. 产物本身：这是唯一和「任务成功」直接相关的指标 ──
if (existsSync(artifact)) {
  const st = statSync(artifact);
  out.artifact_exists = true;
  out.artifact_size = st.size;
  out.artifact_age_min = minutesAgo(st.mtimeMs);
}

// ── 2. 工作目录的最近活动：只作辅助，不能当主指标 ──
if (existsSync(workdir)) {
  let files = [];
  try { files = readdirSync(workdir, { withFileTypes: true }); } catch { files = []; }
  const stats = [];
  for (const f of files) {
    if (!f.isFile()) continue;
    try {
      const st = statSync(resolve(workdir, f.name));
      stats.push({ name: f.name, age_min: minutesAgo(st.mtimeMs), size: st.size });
    } catch { /* ignore */ }
  }
  stats.sort((a, b) => a.age_min - b.age_min);
  out.workdir_recent_files = stats.slice(0, 10);
  out.workdir_latest_age_min = stats.length ? stats[0].age_min : null;
}

// ── 3. 判定 ──
if (out.artifact_exists && out.artifact_size > 0) {
  out.verdict = 'DONE';
  out.hint = `产物已存在（${out.artifact_size} 字节，${out.artifact_age_min} 分钟前修改）——不要再等，去读它`;
} else if (!out.artifact_exists || out.artifact_size === 0) {
  const latest = out.workdir_latest_age_min;
  if (latest !== null && latest <= STALL_MIN) {
    out.verdict = 'RUNNING';
    out.hint = `产物还没写出，但工作目录 ${latest} 分钟内有活动——可能真的还在跑`;
  } else if (latest !== null && latest > STALL_MIN) {
    out.verdict = 'STALLED';
    out.hint = `产物没写出来，工作目录也 ${latest} 分钟没动了（阈值 ${STALL_MIN} 分钟）——` +
               `要么它已经悄悄结束但没交付，要么卡死了。不要继续等，直接查或重派`;
  } else {
    out.verdict = 'UNKNOWN';
    out.hint = '产物不存在，工作目录也没有任何文件——可能还没开始写，或者工作目录给错了';
  }
}

if (jsonOut) {
  console.log(JSON.stringify(out, null, 2));
} else {
  console.log(`\nAgent 状态: ${out.verdict}\n`);
  console.log(`  预期产物  ${out.artifact}`);
  console.log(`    ${out.artifact_exists ? `存在，${out.artifact_size} 字节，${out.artifact_age_min} 分钟前修改` : '不存在'}`);
  console.log(`  工作目录  ${out.workdir}`);
  if (out.workdir_latest_age_min !== null) {
    console.log(`    最近活动 ${out.workdir_latest_age_min} 分钟前`);
    for (const f of out.workdir_recent_files.slice(0, 5)) {
      console.log(`      ${String(f.age_min).padStart(4)} 分钟前  ${f.name}`);
    }
  } else {
    console.log('    没有文件');
  }
  console.log(`\n  → ${out.hint}\n`);
}

process.exit(out.verdict === 'DONE' ? 0 : out.verdict === 'STALLED' ? 2 : 1);
