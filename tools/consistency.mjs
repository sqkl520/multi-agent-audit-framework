#!/usr/bin/env node
/**
 * consistency.mjs — 计算多个 agent 报告之间的一致性，并给出可比基线
 *
 * 为什么需要基线：Jaccard 0.74 听起来像「高度一致」，
 * 但如果 4 个 agent 各报 13/18 条，随机抽也会重叠 0.60。
 *
 * 必须同时给三个数，否则那个数字没有意义：
 *   实际 Jaccard  |  随机基线  |  相对随机倍数
 *
 * 用法：
 *   node consistency.mjs --fixture tools/fixtures/consistency/consistency-hits.json --universe 18
 *   node consistency.mjs --self-test
 */

import fs from 'node:fs';
import path from 'node:path';

export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  const inter = [...A].filter((x) => B.has(x)).length;
  const union = new Set([...A, ...B]).size;
  return union ? inter / union : 0;
}

/** 随机基线：两份报告各随机抽 sizeA / sizeB 条（来自 universe 大小 N）的期望 Jaccard */
export function randomJaccard(sizeA, sizeB, N) {
  const expInter = (sizeA * sizeB) / N;
  const expUnion = sizeA + sizeB - expInter;
  return expUnion ? expInter / expUnion : 0;
}

/** 理论上限：两者都全对时，最多能重合多少 */
export function jaccardCeiling(sizeA, sizeB) {
  const lo = Math.min(sizeA, sizeB);
  const hi = Math.max(sizeA, sizeB);
  return hi ? lo / hi : 0;
}

/** 达成度 = 实际 / 上限 */
export function achievement(actual, ceiling) {
  return ceiling > 0 ? actual / ceiling : 0;
}

export function assess(hits, N) {
  const names = Object.keys(hits);
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = hits[names[i]];
      const b = hits[names[j]];
      const act = jaccard(a, b);
      const rnd = randomJaccard(a.length, b.length, N);
      const ceil = jaccardCeiling(a.length, b.length);
      pairs.push({
        pair: `${names[i]}/${names[j]}`,
        jaccard: act,
        random: rnd,
        ceiling: ceil,
        liftOverRandom: rnd > 0 ? act / rnd : Infinity,
        achievement: achievement(act, ceil),
      });
    }
  }
  const avg = (k) => (pairs.length ? pairs.reduce((s, p) => s + p[k], 0) / pairs.length : 0);
  return {
    pairs,
    mean: {
      jaccard: avg('jaccard'),
      random: avg('random'),
      ceiling: avg('ceiling'),
      lift: avg('liftOverRandom'),
      achievement: avg('achievement'),
    },
  };
}

// ────────────────────────────────────────────────────────────────────
// 自测
// ────────────────────────────────────────────────────────────────────
function selfTest() {
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
  };

  console.log('\n=== 一致性计算器自测 ===\n');

  ok('完全相同 → Jaccard 1', jaccard(['a','b','c'], ['a','b','c']) === 1);
  ok('完全不同 → Jaccard 0', jaccard(['a','b'], ['c','d']) === 0);
  ok('半重合 → 0.5', Math.abs(jaccard(['a','b'], ['b','c']) - 1/3) < 1e-9,
    '实际 ' + jaccard(['a','b'], ['b','c']));
  ok('一边为空 → 0', jaccard([], ['a']) === 0);

  // 随机基线：N==sizeA==sizeB 时，必全部重合 → 1
  ok('N==k 时随机基线为 1', Math.abs(randomJaccard(5, 5, 5) - 1) < 1e-9);
  // 报告极小时随机基线接近 0
  ok('k<<N 时随机基线很小', randomJaccard(1, 1, 100) < 0.02,
    String(randomJaccard(1, 1, 100)));

  // 关键：报告越小，随机基线越低，同样的 Jaccard 意义越大
  const bigR = randomJaccard(13, 13, 18);
  const smallR = randomJaccard(2, 2, 18);
  ok('大报告随机基线 > 小报告', bigR > smallR, `${bigR.toFixed(3)} vs ${smallR.toFixed(3)}`);

  ok('上限：相等大小 → 1', jaccardCeiling(5, 5) === 1);
  ok('上限：2 vs 4 → 0.5', jaccardCeiling(2, 4) === 0.5);
  ok('达成度：实际==上限 → 1', achievement(0.5, 0.5) === 1);

  // 整体评估
  const r = assess({ X: ['a','b','c'], Y: ['a','b','c'] }, 10);
  ok('全体一致 → 均值 1', Math.abs(r.mean.jaccard - 1) < 1e-9);
  ok('全体一致 → 倍数 > 1（随机基线 < 1）', r.mean.lift > 1);

  // 这个是本工具存在理由的核心断言：
  // 报告占满真值集时，Jaccard 必然很高，但那是「没得选」，不是「有共识」。
  // 此时相对随机的倍数应接近 1。
  const saturated = assess({
    A: ['1','2','3','4','5','6','7','8'],
    B: ['1','2','3','4','5','6','7','8'],
  }, 8);
  ok('占满真值集 → Jaccard 1 但倍数 1（无信息量）',
    Math.abs(saturated.mean.jaccard - 1) < 1e-9 && Math.abs(saturated.mean.lift - 1) < 1e-9,
    'jaccard=' + saturated.mean.jaccard.toFixed(3) + ' lift=' + saturated.mean.lift.toFixed(2));

  // 反例：报告很大但重合是偶然的，倍数应偏低
  const loose = assess({
    A: ['1','2','3','4','5','6','7','8','9','10'],
    B: ['1','2','3','4','11','12','13','14','15','16'],
  }, 40);
  ok('报告大而重合少 → 倍数接近 1',
    loose.mean.lift < 2,
    'jaccard=' + loose.mean.jaccard.toFixed(3) + ' lift=' + loose.mean.lift.toFixed(2));

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
  return fail === 0;
}

// ────────────────────────────────────────────────────────────────────
// 入口
// ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--self-test')) {
  process.exit(selfTest() ? 0 : 1);
}

const fi = args.indexOf('--fixture');
const ui = args.indexOf('--universe');
if (fi < 0) {
  // 无参数时跑自测——这样 check-all.mjs 可以直接调用它
  if (args.length === 0) process.exit(selfTest() ? 0 : 1);
  console.error('用法: node consistency.mjs --fixture <hits.json> --universe <N>');
  console.error('   或: node consistency.mjs --self-test');
  process.exit(2);
}

const hits = JSON.parse(fs.readFileSync(args[fi + 1], 'utf8'));
const N = ui >= 0 ? Number(args[ui + 1]) : 18;

const r = assess(hits, N);

console.log(`\n=== Agent 间一致性（${Object.keys(hits).length} 份报告，真值集 ${N} 条）===\n`);
console.log('配对        Jaccard   随机     上限     倍数');
for (const p of r.pairs) {
  console.log(
    `${p.pair.padEnd(10)}  ${p.jaccard.toFixed(3)}     ${p.random.toFixed(3)}    ${p.ceiling.toFixed(3)}    ${p.liftOverRandom.toFixed(2)}x`,
  );
}

console.log('\n--- 汇总 ---');
console.log(`  实际 Jaccard   ${r.mean.jaccard.toFixed(3)}`);
console.log(`  随机基线       ${r.mean.random.toFixed(3)}`);
console.log(`  相对随机       ${r.mean.lift.toFixed(2)}x   ← 这个数才是「有没有共识」的答案`);
console.log(`  理论上限       ${r.mean.ceiling.toFixed(3)}`);
console.log(`  达成度         ${(r.mean.achievement * 100).toFixed(0)}%`);

// 检出分布
const all = [...new Set(Object.values(hits).flat())];
const cnt = {};
for (const id of all) cnt[id] = Object.values(hits).filter((h) => h.includes(id)).length;
const byCount = {};
for (const [id, n] of Object.entries(cnt)) {
  (byCount[n] ??= []).push(id);
}

console.log('\n--- 检出分布 ---');
const total = Object.keys(hits).length;
for (const n of Object.keys(byCount).map(Number).sort((a, b) => b - a)) {
  console.log(`  ${n}/${total}  ${String(byCount[n].length).padStart(2)} 条  ${byCount[n].join(', ')}`);
}

console.log('\n⚠ 只统计「被报过的」会漏掉 0 检出的缺陷。');
console.log('  判断有无系统性盲区，必须拿完整真值集比对，不能用报告的并集。\n');
