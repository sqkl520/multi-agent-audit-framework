#!/usr/bin/env node
/**
 * check-concurrency-cap.mjs — 主 Agent 有没有突破并发上限
 *
 * ── 为什么需要（2026-11-20 实测）────────────────────────────────────
 *
 * `scale-mapping.md` 写了并发上限（`concurrency_window` = min(窗口值, harness_cap)，
 * harness_cap 缺失时取保守值 4），`protocol.md` §1.2 L0 写了槽位释放条件是
 * 「进入终态」而不是「产物已落盘」。**但没有任何校验器读这两条。**
 *
 * 于是一次真实 dsh 运行里，主 Agent 用「产物已落盘」当作「agent 已终态」补位，
 * 并发峰值冲上去了。这件事是它**自己写在 discipline_log 里申报的**：
 *
 *     discretion_type: CONCURRENCY_CAP_BREACH
 *     action: 并发峰值达到 5–6（上限 4）…
 *     mechanical_check: 按 harness 的 agent 起止时间做区间重叠计数；
 *                       或按产物 mtime 与 agent 派发顺序人工复核（不可完全机械化，故同时给出自述）
 *
 * 那句「不可完全机械化」是错的。用 dsh 会话日志里每个子 agent session 的
 * 首/末事件时间戳当存活区间，扫描线求最大重叠，就是并发峰值。实测这套数据
 * 算出来是 **13**（它自己估的是 5–6，低估了一半以上）。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *
 *   cap_source=RECORDED  从 state.json 读 concurrency_cap / concurrency_window
 *   cap_source=FALLBACK  没记录 → 按 scale-mapping §312 取保守值 4
 *                        （「主 Agent 不得因为可能支持更高并发而自行提高窗口」）
 *
 *   peak = 会话日志里子 agent session 区间的最大重叠数
 *   peak > cap → FAIL
 *
 * 另有一条独立判据：**自述与实测不符**。如果 discipline_log 里申报了
 * CONCURRENCY_CAP_BREACH 且给了数值，但它明显低于实测峰值，那是「申报了但报小了」，
 * 单列一条 FAIL —— 因为「诚实地报了一个小数字」比「不报」更难被发现。
 *
 * 用法：
 *   node check-concurrency-cap.mjs --state <state.json> --sessions <~/.dsh/sessions>
 *                                  [--project <子目录名>] [--since <ISO 时间>]
 *                                  [--cap <n>] [--json]
 *
 * 退出码：0 通过 / 1 超限 / 2 用法错误或无数据（分母为 0 不等于通过）
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as zlib from 'node:zlib';

const ARG = { state: null, sessions: null, project: null, since: null, cap: null, json: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--state') ARG.state = process.argv[++i];
  else if (a === '--sessions') ARG.sessions = process.argv[++i];
  else if (a === '--project') ARG.project = process.argv[++i];
  else if (a === '--since') ARG.since = process.argv[++i];
  else if (a === '--cap') ARG.cap = Number(process.argv[++i]);
  else if (a === '--json') ARG.json = true;
  else if (a === '--help' || a === '-h') {
    console.log('用法: node check-concurrency-cap.mjs --sessions <目录> [--state <state.json>]'
      + ' [--project <名>] [--since <ISO>] [--cap <n>] [--json]');
    process.exit(0);
  } else { console.error(`未知参数: ${a}`); process.exit(2); }
}

if (!ARG.sessions) {
  console.error('必须给 --sessions（dsh 的会话根目录）。没有会话日志就算不出并发峰值');
  process.exit(2);
}

const SESS_DIR = ARG.project ? join(ARG.sessions, ARG.project) : ARG.sessions;
if (!existsSync(SESS_DIR)) {
  console.error(`会话目录不存在: ${SESS_DIR}`);
  process.exit(2);
}

// ── 1 · 定上限 ──
const FALLBACK_CAP = 4;   // scale-mapping §312
let cap = FALLBACK_CAP;
let capSource = 'FALLBACK(scale-mapping §312)';
if (Number.isFinite(ARG.cap)) {
  cap = ARG.cap;
  capSource = '--cap 显式指定';
} else if (ARG.state && existsSync(ARG.state)) {
  try {
    const st = JSON.parse(readFileSync(ARG.state, 'utf8'));
    const recorded = st.concurrency_cap ?? st.ledger?.concurrency_cap
      ?? st.concurrency_window ?? st.ledger?.concurrency_window;
    if (Number.isFinite(Number(recorded))) {
      cap = Number(recorded);
      capSource = `state.json 记录`;
    }
  } catch { /* 用兜底值 */ }
}

// ── 2 · 从会话日志算峰值 ──
const sinceTs = ARG.since ? new Date(ARG.since).getTime() : 0;

/** 每个子 agent 一个 session 目录；取它所有事件时间戳的首末作为存活区间 */
function collectSpans() {
  const spans = [];
  let dirs;
  try { dirs = readdirSync(SESS_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { return spans; }
  for (const d of dirs) {
    const dir = join(SESS_DIR, d.name);
    let files;
    try { files = readdirSync(dir).filter((f) => f.endsWith('.zstd') || f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const p = join(dir, f);
      let txt = null;
      try {
        const buf = readFileSync(p);
        txt = f.endsWith('.zstd')
          ? (zlib.zstdDecompressSync ? zlib.zstdDecompressSync(buf).toString('utf8') : null)
          : buf.toString('utf8');
      } catch { continue; }
      if (!txt) continue;
      const times = [];
      for (const line of txt.split('\n')) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          const t = j.time ?? j.at ?? j.timestamp ?? j.ts;
          if (t) {
            const ms = new Date(t).getTime();
            if (Number.isFinite(ms)) times.push(ms);
          }
        } catch { /* 跳过坏行 */ }
      }
      if (times.length < 2) continue;
      const start = Math.min(...times), end = Math.max(...times);
      if (start < sinceTs) continue;
      spans.push({ session: d.name.slice(0, 8), start, end, events: times.length });
    }
  }
  return spans;
}

const spans = collectSpans();
if (spans.length === 0) {
  console.error(`[预期失败] ${SESS_DIR} 下没有可解析的会话时间戳（since=${ARG.since ?? '不限'}）。`);
  console.error('  分母为 0 不等于通过——先确认 --sessions / --project / --since 是否指向这次运行');
  process.exit(2);
}

// 扫描线求最大重叠；同一时刻先处理结束（-1）再处理开始（+1），
// 即「A 结束的瞬间 B 才开始」不算并发。
const evts = [];
for (const s of spans) { evts.push([s.start, +1]); evts.push([s.end, -1]); }
evts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
let cur = 0, peak = 0, peakAt = 0;
for (const [t, d] of evts) {
  cur += d;
  if (cur > peak) { peak = cur; peakAt = t; }
}

// ── 3 · 自述 vs 实测 ──
//
// 它可能在 discipline_log 里申报一个比实测小的数字。那比不报更危险：
// 读者看到「已申报、已记录」就不会再查。
let declared = null;
if (ARG.state && existsSync(ARG.state)) {
  try {
    const st = JSON.parse(readFileSync(ARG.state, 'utf8'));
    for (const d of (st.discipline_log ?? [])) {
      if (String(d.discretion_type ?? '').includes('CONCURRENCY')) {
        const nums = String(d.action ?? '').match(/\d+/g);
        if (nums) declared = Math.max(...nums.map(Number));
      }
    }
  } catch { /* ignore */ }
}

// ── 输出 ──
const overCap = peak > cap;
const underDeclared = Number.isFinite(declared) && declared > 0 && peak > declared * 1.5;

const result = {
  ok: !overCap && !underDeclared,
  cap, cap_source: capSource,
  peak, peak_at: peakAt ? new Date(peakAt).toISOString() : null,
  spans: spans.length,
  declared_peak: declared,
  over_cap: overCap,
  under_declared: underDeclared,
};

if (ARG.json) {
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}

console.log('\n并发上限检查\n');
console.log(`  上限            ${cap}（${capSource}）`);
console.log(`  实测峰值        ${peak}${peakAt ? ` 于 ${new Date(peakAt).toISOString()}` : ''}`);
console.log(`  子 agent 区间   ${spans.length} 个`);
if (Number.isFinite(declared)) console.log(`  自述峰值        ${declared}`);
console.log('');

if (overCap) {
  console.log(`  ✗ 超过上限 ${peak - cap}：峰值 ${peak} > 上限 ${cap}`);
  console.log('    protocol.md §1.2 L0 规定槽位释放条件是「进入终态」，不是「产物已落盘」。');
  console.log('    用「文件写完了」当作「agent 结束」会虚增并发。');
  console.log('');
}
if (underDeclared) {
  console.log(`  ✗ 自述低于实测：申报 ${declared}，实测 ${peak}（低估 ${(peak - declared)}）`);
  console.log('    「申报了一个偏小的数字」比「不申报」更难被发现——读者看到已记录就不再查。');
  console.log('');
}
if (result.ok) console.log('  ✓ 未突破上限，且自述与实测相符\n');

process.exit(result.ok ? 0 : 1);
