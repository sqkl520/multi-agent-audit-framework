#!/usr/bin/env node
/**
 * score.mjs — 给 fixture2 的审计报告打分
 *
 * 判分口径与 experiments/score.mjs 一致（零裁量）：
 *   命中 = 报告里的 file 匹配，且 line 落在缺陷行 ±3 内
 *   误报 = 不在任何缺陷位置 ±3 内
 *
 * 差异：fixture2 只有 5 个源文件，文件名不做 src/ 前缀假设，
 *       而是从 manifest 的 file 字段直接取。
 *
 * 用法: node score.mjs <report.md>
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(HERE, 'manifest.json'), 'utf8'));
const defects = manifest.defects;

const reportPath = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!reportPath || !existsSync(reportPath)) {
  console.error('用法: node score.mjs <report.md>');
  process.exit(2);
}
const report = readFileSync(reportPath, 'utf8');

const FILES = 'template|events|pagination|validate|index';

function extractFindings(text) {
  const parts = text.split(/^#{2,3}\s+/m);
  const sections = parts.filter((s) => {
    const head = s.split('\n')[0].trim();
    if (/^模式检查结果|^结论|^总结|^附|^已排除|^负例|^核实为正确/.test(head)) return false;
    return /^(发现|Finding)\s*\d+/i.test(head) || /^\d+\.\s+\S/.test(head);
  });
  const out = [];
  for (const sec of sections) {
    let m = sec.match(new RegExp(`\\*\\*file\\*\\*\\s*[:：]\\s*(?:src[\\\\/])?(${FILES})\\.js\\s*[:：]\\s*(\\d+)(?:\\s*[-–]\\s*(\\d+))?`, 'i'));
    if (!m) m = sec.match(new RegExp(`(?:src[\\\\/])?(${FILES})\\.js\\s*[:：]\\s*(\\d+)(?:\\s*[-–]\\s*(\\d+))?`, 'i'));
    if (!m) m = sec.match(new RegExp(`(?:src[\\\\/])?(${FILES})\\.js\\s*第\\s*(\\d+)\\s*行`, 'i'));
    if (m) {
      const start = Number(m[2]);
      const end = m[3] ? Number(m[3]) : start;
      out.push({ file: `src/${m[1]}.js`, line: start, end });
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
const native = defects.filter((d) => d.origin === 'native');
const injected = defects.filter((d) => d.origin !== 'native');

console.log(`\n=== ${basename(reportPath)} ===\n`);
console.log(`缺陷总数 ${defects.length} | 报告 ${findings.length} 条`);
console.log(`recall ${hitIds.size}/${defects.length} = ${(hitIds.size / defects.length * 100).toFixed(1)}%`);
console.log(`精确命中 ${exactIds.size}/${defects.length}`);
console.log(`未匹配 ${fps.length}（未必是误报）| precision ${findings.length ? (used.size / findings.length * 100).toFixed(1) : 0}%`);
console.log();
console.log(`  注入型  ${injected.filter((d) => hitIds.has(d.id)).length}/${injected.length}`);
console.log(`  原生型  ${native.filter((d) => hitIds.has(d.id)).length}/${native.length}`);
console.log();
for (const d of defects) {
  const mark = exactIds.has(d.id) ? '★★' : hitIds.has(d.id) ? '★ ' : '✗ ';
  console.log(`  ${mark} ${d.id}  ${d.file}:${d.line}  [${d.severity}] ${d.title.slice(0, 46)}`);
}
if (fps.length) {
  console.log('\n未匹配的发现（**不等于误报**）：');
  for (const f of fps) console.log(`  ? ${f.file}:${f.line}${f.end !== f.line ? '-' + f.end : ''}`);
  console.log('\n  ⚠ 这些位置不在当前 manifest 的缺陷行 ±3 内。');
  console.log('    但 manifest 已知不完整（补过两次，8 → 7 → 14 条）。');
  console.log('    历史上每轮都有「误报」复核后确认是真缺陷的例子。');
  console.log('    统计 precision 之前必须逐条人工核实。');
}
