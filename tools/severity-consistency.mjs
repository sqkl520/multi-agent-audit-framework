#!/usr/bin/env node
/**
 * severity-consistency.mjs — 抽取多份审计报告里「同一缺陷被定为什么严重性」
 *
 * 为什么要单独做：上一轮的一致性用的是 Jaccard，它只看「找没找到」。
 * 两个 agent 都报了同一条缺陷、但一个说 CRITICAL 一个说 LOW，在 Jaccard 里
 * 算完全一致。而严重性分歧在实际审计里可能比「漏报」更危险——
 * 它直接决定这条缺陷会不会被排进修复队列。
 *
 * 用法：node severity-consistency.mjs <fixture目录> <报告1> <报告2> ...
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args.length < 3) {
  console.error('用法: node severity-consistency.mjs <fixture目录> <报告1> <报告2> ...');
  process.exit(2);
}

const FIX = args[0];
const reports = args.slice(1);

// 复用 score.mjs 的解析：先拿到每份报告命中了哪些缺陷
const scoreScript = path.join(FIX, 'score.mjs');
const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));

/** 从报告文本里抽 (file, line, severity) 三元组 */
function extractSeverities(text) {
  const parts = text.split(/^#{2,3}\s+/m);
  const out = [];
  for (const sec of parts) {
    const head = sec.split('\n')[0].trim();
    if (/^模式检查结果|^结论|^总结|^附|^已排除|^负例/.test(head)) continue;
    if (!/^(发现|Finding)\s*\d+/i.test(head) && !/^\d+\.\s+\S/.test(head)) continue;

    const fm = sec.match(/(?:src[\\/])?([a-z0-9-]+\.js)\s*[:：]\s*(\d+)/i);
    if (!fm) continue;
    const sev = sec.match(/\*\*严重性\*\*\s*[:：]\s*(CRITICAL|HIGH|MEDIUM|LOW)/i)
      ?? sec.match(/\*\*severity\*\*\s*[:：]\s*(CRITICAL|HIGH|MEDIUM|LOW)/i)
      ?? sec.match(/\b(CRITICAL|HIGH|MEDIUM|LOW)\b/);
    if (!sev) continue;
    out.push({ file: `src/${fm[1]}`, line: Number(fm[2]), severity: sev[1].toUpperCase() });
  }
  return out;
}

const SEV_ORDER = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

// 每份报告：缺陷 id → severity
const perReport = {};
const allHits = {};

for (const r of reports) {
  const name = path.basename(r, '.md');
  const text = fs.readFileSync(r, 'utf8');
  // 用 score.mjs 判定哪些行号算命中
  let scoreOut = '';
  try {
    scoreOut = execFileSync('node', [scoreScript, r], { encoding: 'utf8' });
  } catch (e) {
    scoreOut = (e.stdout ?? '');
  }
  const hitIds = scoreOut.split('\n').filter((l) => /★/.test(l)).map((l) => l.trim().split(/\s+/)[1]);
  allHits[name] = hitIds;

  const sevs = extractSeverities(text);
  const map = {};
  for (const id of hitIds) {
    const d = manifest.defects.find((x) => x.id === id);
    if (!d) continue;
    // 找报告里离该缺陷行号最近的记录
    const cands = sevs.filter((s) => s.file === d.file && Math.abs(s.line - d.line) <= 3);
    if (!cands.length) continue;
    map[id] = cands[0].severity;
  }
  perReport[name] = map;
}

// ── 对每条缺陷，看各报告的定级 ──
console.log('\n=== 同一缺陷的严重性分歧 ===\n');
console.log('缺陷    真值      各 agent 定级                        分歧');
let comparable = 0;
let exactAgree = 0;
let bigDisagree = 0;

for (const d of manifest.defects) {
  const ratings = reports
    .map((r) => path.basename(r, '.md'))
    .filter((n) => perReport[n][d.id])
    .map((n) => `${n}:${perReport[n][d.id]}`);

  if (ratings.length < 2) continue;
  comparable++;

  const sevs = ratings.map((x) => x.split(':')[1]);
  const uniq = [...new Set(sevs)];
  const nums = sevs.map((s) => SEV_ORDER[s] ?? 0);
  const spread = Math.max(...nums) - Math.min(...nums);

  let verdict;
  if (uniq.length === 1) { verdict = '完全一致'; exactAgree++; }
  else if (spread >= 2) { verdict = `**严重分歧**（差 ${spread} 级）`; bigDisagree++; }
  else { verdict = `轻微分歧（差 1 级）`; }

  console.log(`${d.id}  ${d.severity.padEnd(8)}  ${ratings.join('  ').padEnd(46)} ${verdict}`);
}

console.log('\n--- 汇总 ---');
console.log(`  可比缺陷（>=2 个 agent 都报了）  ${comparable}`);
console.log(`  定级完全一致                     ${exactAgree}  (${(exactAgree / comparable * 100).toFixed(1)}%)`);
console.log(`  相差 >=2 级（严重分歧）          ${bigDisagree}  (${(bigDisagree / comparable * 100).toFixed(1)}%)`);

// ── 与真值比较：谁标高了谁标低了 ──
console.log('\n=== 与 manifest 真值比较 ===\n');
let over = 0;
let under = 0;
let match = 0;
for (const d of manifest.defects) {
  for (const r of reports) {
    const name = path.basename(r, '.md');
    const got = perReport[name][d.id];
    if (!got) continue;
    const delta = (SEV_ORDER[got] ?? 0) - (SEV_ORDER[d.severity] ?? 0);
    if (delta > 0) over++;
    else if (delta < 0) under++;
    else match++;
  }
}
const tot = over + under + match;
console.log(`  与真值相同  ${match}  (${(match / tot * 100).toFixed(1)}%)`);
console.log(`  标高了      ${over}  (${(over / tot * 100).toFixed(1)}%)`);
console.log(`  标低了      ${under}  (${(under / tot * 100).toFixed(1)}%)`);
console.log(`\n  合计 ${tot} 个 (报告 × 缺陷) 定级判断`);
