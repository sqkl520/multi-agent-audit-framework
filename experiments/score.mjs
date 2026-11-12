#!/usr/bin/env node
/**
 * score.mjs — 给审计报告打分（重建版）
 *
 * 判分口径（零裁量）：
 *   命中 = 报告的 file 匹配，且 line 落在注入行 ±3 内
 *   误报 = 不在任何缺陷位置 ±3 内
 *
 * 支持的行号格式：
 *   src/x.js:51
 *   src/x.js:51-57      ← 行范围：注入行落在 [start-3, end+3] 即算命中
 *   src/x.js 第 51 行
 *
 * 只从「## 发现」小节里抽，不抽序言和总结（否则说明文字里的位置会被算成 finding）。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const mIdx = process.argv.indexOf('--manifest');
const manifestPath = mIdx >= 0 ? process.argv[mIdx + 1] : join(HERE, 'manifest.json');
if (!existsSync(manifestPath)) {
  console.error('找不到 manifest.json');
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const defects = manifest.defects;

const reportPath = process.argv.slice(2).find((a, i, arr) => !a.startsWith('--') && arr[i - 1] !== '--manifest');
if (!reportPath || !existsSync(reportPath)) {
  console.error('用法: node score.mjs <report.md>');
  process.exit(2);
}
const report = readFileSync(reportPath, 'utf8');

function extractFindings(text) {
  // 支持多种小节格式：
  //   ## 发现 N / ## 发现 3
  //   ### N. 标题
  //   ### 发现 N
  // 关键：只要有「小节标题 + 小节内有 file:line」，就算一条发现
  const parts = text.split(/^#{2,3}\s+/m);
  const sections = parts.filter((s) => {
    const head = s.split('\n')[0].trim();
    if (/^模式检查结果|^结论|^总结|^附/.test(head)) return false;
    // 「发现 N」「N. 标题」「Finding N」
    return /^(发现|Finding)\s*\d+/i.test(head) || /^\d+\.\s+\S/.test(head);
  });
  const out = [];
  for (const sec of sections) {
    let m = sec.match(/\*\*file\*\*\s*[:：]\s*(?:src[\\/])?([a-z-]+\.js)\s*[:：]\s*(\d+)(?:\s*[-–]\s*(\d+))?/i);
    if (!m) m = sec.match(/(?:src[\\/])?([a-z-]+\.js)\s*[:：]\s*(\d+)(?:\s*[-–]\s*(\d+))?/i);
    if (!m) m = sec.match(/(?:src[\\/])?([a-z-]+\.js)\s*第\s*(\d+)\s*行/i);
    if (m) {
      const start = Number(m[2]);
      const end = m[3] ? Number(m[3]) : start;
      out.push({ file: `src/${m[1]}`, line: start, end });
    }
  }
  const seen = new Set();
  return out.filter((f) => {
    const k = `${f.file}:${f.line}-${f.end}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const findings = extractFindings(report);
const TOL = 3;
const hitIds = new Set();
const exactIds = new Set();
const used = new Set();

for (const d of defects) {
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i];
    if (f.file !== d.file) continue;
    const lo = Math.min(f.line, f.end) - TOL;
    const hi = Math.max(f.line, f.end) + TOL;
    if (d.line >= lo && d.line <= hi) {
      hitIds.add(d.id);
      if (f.line === d.line || f.end === d.line) exactIds.add(d.id);
      used.add(i);
      break;
    }
  }
}

const fps = findings.filter((_, i) => !used.has(i));
const recall = hitIds.size / defects.length;

// 分层：注入型 vs 原生型。用 origin 字段，它由 classify.mjs 实测得出。
const injected = defects.filter((d) => d.origin !== 'native');
const native = defects.filter((d) => d.origin === 'native');
const injHit = injected.filter((d) => hitIds.has(d.id)).length;
const natHit = native.filter((d) => hitIds.has(d.id)).length;

console.log(`\n=== ${basename(reportPath)} ===\n`);
console.log(`缺陷总数 ${defects.length} | 报告 ${findings.length} 条`);
console.log(`recall ${hitIds.size}/${defects.length} = ${(recall * 100).toFixed(1)}%`);
console.log(`精确命中 ${exactIds.size}/${defects.length} = ${(exactIds.size / defects.length * 100).toFixed(1)}%`);
console.log(`未匹配 ${fps.length}（未必是误报）| precision ${findings.length ? (used.size / findings.length * 100).toFixed(1) : 0}%`);
console.log();
console.log(`  注入型（我造进去的）  ${injHit}/${injected.length}`);
console.log(`  原生型（base 自带）   ${natHit}/${native.length}`);console.log();
for (const d of defects) {
  const mark = exactIds.has(d.id) ? '★★' : hitIds.has(d.id) ? '★ ' : '✗ ';
  console.log(`  ${mark} ${d.id}  ${d.file}:${d.line}  [${d.severity}] ${d.title.slice(0, 42)}`);
}
if (fps.length) {
  console.log('\n未匹配的发现（**不等于误报**）：');
  for (const f of fps) console.log(`  ? ${f.file}:${f.line}${f.end !== f.line ? '-' + f.end : ''}`);
  console.log('\n  ⚠ 这些位置不在当前 manifest 的缺陷行 ±3 内。');
  console.log('    但 manifest 已知不完整——已补过四次。');
  console.log('    历史上每轮都有「误报」复核后确认是真缺陷的例子。');
  console.log('    统计 precision 之前必须逐条人工核实。');
}
