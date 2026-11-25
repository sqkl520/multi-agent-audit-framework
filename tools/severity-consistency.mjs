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

// 2026-11-25：抽出来的数字全是 0/NaN，因为两处缺陷叠在一起——
//
//   1. **严重性词表只认英文。** 报告里写「- **严重性**: 高 / 中 / 低」，
//      而正则只认 CRITICAL|HIGH|MEDIUM|LOW。fixture2 的 T1 报告 18 条全是中文，
//      于是 `extractSeverities` 抽到 0 条，这个工具**永远报「可比缺陷 0」**。
//   2. **0 个可比缺陷时仍以 exit 0 结束**，且百分比算成 NaN。
//      和本仓库反复修的那类一样：分母为 0 被当成通过。
//
// 这个工具不是校验器（它是仪表），但「跑出全 0」必须可见，不能静默。
const SEV_MAP = {
  CRITICAL: 'CRITICAL', HIGH: 'HIGH', MEDIUM: 'MEDIUM', LOW: 'LOW',
  严重: 'CRITICAL', 高: 'HIGH', 中: 'MEDIUM', 低: 'LOW',
};
// 2026-11-26（锐评 4/8/5）三处修正：
//
//   · 词表要认大小写：旧版中文 label 的正则带 /i，新版丢了，于是
//     `**严重性**: High` / `Medium` / `Low` 从「能抽」变成「抽不到」——回归。
//   · 中文裸词不能不加边界：`\b` 对中文不生效，但**对中文紧邻 ASCII 数字/字母时生效**
//     （`共1高2中3低` 会抽到「高」）。中文严重性只在 label 之后接受，
//     裸词分支只留英文——那才是它原本的语义。
//   · `严重` 排在 `高|中|低` 之前，于是「严重程度：中」会被截成「严重」→ CRITICAL。
//     现在把「严重程度 / 严重性」当**二级 label 前缀**消费掉，而不是当成值。
const SEV_MAP_CI = new Map(Object.entries(SEV_MAP).map(([k, v]) => [k.toLowerCase(), v]));
const SEV_VALUE = 'CRITICAL|HIGH|MEDIUM|LOW|严重|高|中|低';                // 值：标量
const SEV_BARE = 'CRITICAL|HIGH|MEDIUM|LOW';                              // 裸词只认英文
const SEV_LABEL_SRC = '(?:严重性|严重程度|severity)';                      // label 的几种写法

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

    // label 优先（大小写都认），裸词兜底只认英文（见文件头的三条修正）。
    // 「严重程度：中」的「严重程度」是**二级 label**，不是值——所以 label 分支允许
    // 它出现在冒号之后，然后才取真正的值。
    const labelRe = new RegExp(
      `\\*\\*\\s*${SEV_LABEL_SRC}\\s*\\*\\*\\s*[:：]\\s*(?:${SEV_LABEL_SRC}\\s*[:：]\\s*)?(${SEV_VALUE})(?![\\u4e00-\\u9fffA-Za-z0-9_])`,
      'i',
    );
    const bareRe = new RegExp(`\\b(${SEV_BARE})\\b`, 'i');
    const sev = sec.match(labelRe) ?? sec.match(bareRe);
    if (!sev) continue;
    const norm = SEV_MAP_CI.get(sev[1].toLowerCase());
    if (!norm) continue;
    out.push({ file: `src/${fm[1]}`, line: Number(fm[2]), severity: norm });
  }
  return out;
}

const SEV_ORDER = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };

// 每份报告：缺陷 id → severity
const perReport = {};


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

  const sevs = extractSeverities(text);
  const map = {};
  for (const id of hitIds) {
    const d = manifest.defects.find((x) => x.id === id);
    if (!d) continue;
    // 找报告里离该缺陷行号最近的记录
    const cands = sevs.filter((s) => s.file === d.file && Math.abs(s.line - d.line) <= 3);
    if (!cands.length) continue;
    // 2026-11-26（锐评 9）：注释说「找离该缺陷行号最近的记录」，代码却取窗口内第一条。
    // 实测：缺陷真值 HIGH@118，同段里邻近的 116 行「低」在文档顺序上更靠前 → 取成 LOW。
    // 现在真的按 |line - d.line| 取最近。
    cands.sort((a, b) => Math.abs(a.line - d.line) - Math.abs(b.line - d.line));
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
if (comparable === 0) {
  console.error('\n✗ 没有任何缺陷被 2 个以上 agent 同时报出——分母为 0 不等于「一致」。');
  console.error('  两份报告覆盖的缺陷没有重叠，或严重性写法不在词表里（认：CRITICAL/HIGH/MEDIUM/LOW，'
    + '不区分大小写；以及「严重性: 严重 / 高 / 中 / 低」）。');
  process.exit(2);
}

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
