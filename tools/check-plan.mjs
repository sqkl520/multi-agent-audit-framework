#!/usr/bin/env node
/**
 * check-plan.mjs — 校验规划 Agent 产出是否符合 triage.md 约束
 *
 * 为什么需要它：规划 Agent 的产出决定「开多大面板」。如果它给的
 * member_count 少于 TIER 要求，或递归深度超界，整个面板制就失效了。
 * 而这类错误在人工阅读时极难发现——它看起来就是一份正常的计划书。
 *
 * 用法: node check-plan.mjs <plan.md 路径>
 * 退出码: 0 全通过 / 1 有失败 / 2 用法错误
 */

import { readFileSync } from 'node:fs';

const p = process.argv[2];
if (!p) {
  console.error('用法: node check-plan.mjs <plan.md>');
  process.exit(2);
}

let text;
try {
  text = readFileSync(p, 'utf8');
} catch (e) {
  console.error(`读取失败: ${e.message}`);
  process.exit(2);
}

const m = text.match(/```json\n([\s\S]*?)```/);
if (!m) { console.error('✗ 找不到 json 块'); process.exit(1); }

let j;
try {
  j = JSON.parse(m[1]);
} catch (e) {
  console.error('✗ JSON 解析失败:', e.message);
  process.exit(1);
}

const pl = j.payload;
if (!pl) { console.error('✗ 缺少 payload'); process.exit(1); }

let pass = 0, fail = 0;
const ck = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
};

console.log('\n=== 规划 Agent 产出合规性检查 ===\n');

const sum = Object.values(pl.score_breakdown ?? {}).reduce((a, b) => a + b, 0);
ck('score 等于 breakdown 之和', pl.score === sum, `score=${pl.score} sum=${sum}`);

const expectTier = sum === 0 ? 'T0' : sum === 1 ? 'T1' : 'T2';
ck('tier 与 score 对应', pl.tier === expectTier, `tier=${pl.tier} 应为 ${expectTier}`);

const allBinary = Object.entries(pl.score_breakdown ?? {}).every(([, v]) => v === 0 || v === 1);
ck('所有判定项都是 0 或 1', allBinary, JSON.stringify(pl.score_breakdown));

const minMap = { T0: 3, T1: 5, T2: 9 };
ck(`member_count ≥ ${minMap[pl.tier]}`, (pl.member_count ?? 0) >= minMap[pl.tier], `member_count=${pl.member_count}`);

const memberSum = (pl.members ?? []).reduce((a, x) => a + (x.count || 0), 0);
ck('member_count 等于 members 展开数', pl.member_count === memberSum, `member_count=${pl.member_count} sum=${memberSum}`);

const validRoles = ['execute', 'retrieve', 'critique', 'redteam', 'verify', 'arbiter'];
const rolesOk = (pl.members ?? []).every((x) => validRoles.includes(x.role));
ck('所有角色合法', rolesOk, (pl.members ?? []).map((x) => x.role).join(','));

if (pl.tier === 'T1' || pl.tier === 'T2') {
  const have = new Set((pl.members ?? []).map((x) => x.role));
  const need = ['execute', 'retrieve', 'critique', 'redteam', 'verify'];
  const missing = need.filter((r) => !have.has(r));
  ck('五职能齐备', missing.length === 0, missing.length ? '缺: ' + missing.join(',') : '');
}

const maxDepth = { T0: 1, T1: 2, T2: 3 };
ck(`递归 ≤ ${maxDepth[pl.tier]}`, (pl.recursion?.max_depth ?? 99) <= maxDepth[pl.tier],
  `max_depth=${pl.recursion?.max_depth}`);

const ks = ['K1', 'K2', 'K3', 'K4', 'K5', 'K6', 'K7'];
const missingK = ks.filter((k) => !(pl.reasoning ?? {})[k]);
ck('每项都有判据', missingK.length === 0, missingK.length ? '缺: ' + missingK.join(',') : '');

const validTpl = ['five-wave-audit', 'generic-panel'];
ck('template 合法', validTpl.includes(pl.template), pl.template);

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail > 0 ? 1 : 0);
