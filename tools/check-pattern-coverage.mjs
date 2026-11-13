#!/usr/bin/env node
/**
 * check-pattern-coverage.mjs — 每条 ground truth 缺陷是否都有明确的模式归属
 *
 * 为什么需要：
 *   审计波靠 8 个模式指导 agent「该去查什么」。一个缺陷如果**没有任何模式指向它**，
 *   那它结构上就找不到——不是 agent 不够聪明，是没人告诉它去看那里。
 *   再加 agent、再换模型，也只是在碰运气。
 *
 *   但「没有模式覆盖」不一定等于「缺陷」：有些问题（比较运算符方向写反、
 *   原型链赋值）本来就靠逐行阅读发现，硬塞进模式反而稀释模式的有效性。
 *   **所以本检查器的要求不是「必须被覆盖」，而是「必须有明确归属或明确说没有」。**
 *
 *   悬空才是问题：一条缺陷既没被模式覆盖，也没人记录过这件事——
 *   那么覆盖率那一栏就是假的，因为它不知道分母里有多少条根本查不到。
 *
 * 两个 fixture 都查。只看 fixture1 会得出「覆盖良好」的错觉——
 * 模式 1/2/3 本身就是从 fixture1 的缺陷反推出来的（教考合一），
 * fixture2 才是跨领域检验。
 *
 * 数据来源：各 manifest 的 defects[].pattern
 *   - 数字 1..8   属于该模式
 *   - "none"      明确认定不属于任何模式（须在 none_reason 说明理由）
 *
 * 用法：node check-pattern-coverage.mjs [--json]
 * 退出码：0 = 全部有归属   1 = 有悬空   2 = 数据异常
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WAVE2 = join(ROOT, 'framework', 'templates', 'wave2-audit.md');

const MANIFESTS = [
  { path: join(ROOT, 'experiments', 'manifest.json'), label: 'fixture1' },
  { path: join(ROOT, 'experiments', 'fixture2', 'manifest.json'), label: 'fixture2' },
];

const jsonOut = process.argv.includes('--json');

// ── 读 wave2-audit.md 里声明的模式编号 ──
const wave2 = readFileSync(WAVE2, 'utf8');
const declaredPatterns = new Set();
for (const m of wave2.matchAll(/^\|\s*\*\*(\d)\*\*\s*\|/gm)) declaredPatterns.add(Number(m[1]));
if (declaredPatterns.size === 0) {
  for (const m of wave2.matchAll(/模式\s*(\d)/g)) declaredPatterns.add(Number(m[1]));
}
if (declaredPatterns.size === 0) {
  console.error('无法从 wave2-audit.md 识别出任何模式——模板结构可能变了');
  process.exit(2);
}
const PATTERN_LIST = [...declaredPatterns].sort((a, b) => a - b);

// ── 载入两个 manifest ──
const loaded = [];
for (const { path, label } of MANIFESTS) {
  if (!existsSync(path)) {
    console.error(`找不到 ${path}`);
    process.exit(2);
  }
  const j = JSON.parse(readFileSync(path, 'utf8'));
  if (!Array.isArray(j.defects) || j.defects.length === 0) {
    console.error(`${label} 的 manifest 里没有 defects`);
    process.exit(2);
  }
  loaded.push({ label, defects: j.defects });
}

// ── 校验归属 ──
const problems = [];
const summary = [];

for (const { label, defects } of loaded) {
  const byPattern = new Map(PATTERN_LIST.map((n) => [n, []]));
  const noPattern = [];

  for (const d of defects) {
    const p = d.pattern;

    if (p === undefined || p === null) {
      problems.push({
        kind: 'pattern_undeclared', id: `${label}/${d.id}`,
        detail: `${label} ${d.id} 没有 pattern 字段——属于哪个模式、或明确不属于任何模式，必须写出来`,
      });
      continue;
    }

    if (p === 'none') {
      if (!d.none_reason || String(d.none_reason).trim() === '') {
        problems.push({
          kind: 'none_without_reason', id: `${label}/${d.id}`,
          detail: `${label} ${d.id} 标了 pattern="none" 但没写 none_reason——「不属于任何模式」是个判断，必须给理由`,
        });
      }
      noPattern.push(d);
      continue;
    }

    const nums = Array.isArray(p) ? p : [p];
    for (const n of nums) {
      if (typeof n !== 'number' || !declaredPatterns.has(n)) {
        problems.push({
          kind: 'pattern_not_in_template', id: `${label}/${d.id}`,
          detail: `${label} ${d.id} 标了模式 ${n}，但 wave2-audit.md 里没有（现有: ${PATTERN_LIST.join(',')}）`,
        });
        continue;
      }
      byPattern.get(n).push(d.id);
    }
  }

  summary.push({ label, defects, byPattern, noPattern });
}

if (jsonOut) {
  console.log(JSON.stringify({
    patterns: PATTERN_LIST,
    fixtures: summary.map(({ label, defects, byPattern, noPattern }) => ({
      label,
      total: defects.length,
      noPattern: noPattern.map((d) => d.id),
      byPattern: Object.fromEntries([...byPattern].map(([n, ids]) => [n, ids])),
    })),
    problems,
  }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

// ── 输出 ──
console.log('\n=== Ground truth 的模式归属 ===\n');
console.log(`模板声明模式 ${PATTERN_LIST.join(', ')}\n`);

for (const { label, defects, byPattern, noPattern } of summary) {
  console.log(`--- ${label}：${defects.length} 条，其中 ${noPattern.length} 条明确无模式覆盖 ---`);
  for (const [n, ids] of [...byPattern].sort((a, b) => a[0] - b[0])) {
    if (ids.length === 0) continue;
    console.log(`  模式 ${n}  ${ids.join(', ')}`);
  }
  const empty = [...byPattern.entries()].filter(([, ids]) => ids.length === 0).map(([n]) => n);
  if (empty.length) console.log(`  （模式 ${empty.join(',')} 在此 fixture 上零归属）`);
  for (const d of noPattern) {
    console.log(`  无模式  ${d.id}  ${d.title.slice(0, 42)}`);
  }
  console.log('');
}

const totalDefects = summary.reduce((s, x) => s + x.defects.length, 0);
const totalNone = summary.reduce((s, x) => s + x.noPattern.length, 0);

if (problems.length === 0) {
  console.log(`结论：两个 fixture 共 ${totalDefects} 条，全部有明确归属`);
  console.log(`（${totalDefects - totalNone} 条被模式覆盖，${totalNone} 条明确说明无覆盖）。`);
  console.log('覆盖率的分母从此是已知的——不再有「查不到又没人知道」的盲区。');
  process.exit(0);
}

console.log(`发现 ${problems.length} 个问题：`);
for (const p of problems) console.log(`  [${p.kind}] ${p.detail}`);
process.exit(1);
