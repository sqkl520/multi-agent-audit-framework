#!/usr/bin/env node
/**
 * check-round-detection.mjs — 轮次探测的机械校验
 *
 * ── 为什么需要它（2026-11-19 补）────────────────────────────────────
 *   `framework/artifacts/round-detection.md` 把轮次探测的每一条都写成了
 *   可判定的形式：正则 `^round(\d+)([a-z]*)$`、大小写不敏感、前导零按数值、
 *   超 10^6 记 SUSPICIOUS_RANGE 但仍参与比较、尾部只允许纯小写字母、
 *   以及一张边界情况判定表。
 *
 *   它自己还写着「本文件的所有判断都是模式匹配和数值比较，
 *   **不包含任何"这个目录看起来像不像一轮"的主观判断**」。
 *
 *   但 `grep -rl round-detection tools/*.mjs` 是 **0** —— 这份规格零校验。
 *   `check-deliverables.mjs` 虽然用到 `round{N}` 这个形状，却只做字符串拼接，
 *   不校验轮次号是怎么算出来的。
 *
 *   与 handoff-schema 同一形态：不是引用断了，是根本没有检测器。
 *
 * ── 这类缺陷的代价 ──────────────────────────────────────────────────
 *   轮次号算错会**静默复用已审过的轮次**。框架自己的历史里就有一次：
 *   round31 停在 IN_PROGRESS，新开一轮会重审已审过的 40 片。
 *   而且它不会报错——只会让「本轮和上轮审的是同一批文件」这件事没人发现。
 *
 * ── 检查项 ──────────────────────────────────────────────────────────
 *   R1  matchRoundName(name)     条目名 → { number, suffix } 或 null，严格按第 3 节
 *   R2  computeRoundNumber(names)  → max + 1，无匹配则 1（第 2 节步骤 5–6）
 *   R3  anomalies                 SUSPICIOUS_RANGE / NON_ROUND_NAMING 的判定
 *   R4  边界情况                  目录不存在 / 空目录 / 全是非 round 命名
 *
 * ── 用法 ────────────────────────────────────────────────────────────
 *   node check-round-detection.mjs --dir <docs/reports>     # 对真实目录算一次
 *   node check-round-detection.mjs --self-test              # 内置用例自证
 *   node check-round-detection.mjs --dir X --json
 *
 * 退出码：0 = 正常／1 = 目录不可读或出现阻塞异常／2 = 用法错误
 *
 * ── 不检查什么 ──────────────────────────────────────────────────────
 *   不检查「写入是否原子」——那是探测 Agent 的职责，本工具只做算术。
 *   不猜测异常目录的意图：按契约，无法确定的一律记 anomalies 而不是猜。
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const ARGS = { dir: null, json: false, selfTest: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--json') ARGS.json = true;
  else if (a === '--self-test') ARGS.selfTest = true;
  else if (a === '--dir') ARGS.dir = process.argv[++i] ?? null;
  else if (a === '--help' || a === '-h') {
    console.log('用法: node check-round-detection.mjs --dir <docs/reports> [--json]');
    console.log('      node check-round-detection.mjs --self-test');
    process.exit(0);
  } else if (!a.startsWith('--') && !ARGS.dir) ARGS.dir = a;
  else { console.error(`未知参数: ${a}`); process.exit(2); }
}

// ── 第 3 节的精确定义，逐条落实 ──
const ROUND_RE = /^round(\d+)([a-z]*)$/;     // 作用于 basename 去扩展名
const SUSPICIOUS_ABOVE = 1_000_000;          // 超过 10^6 记 SUSPICIOUS_RANGE

/** 去掉最后一个扩展名：`round16-notes.md` → `round16-notes`；`round16` → `round16` */
function stripExt(name) {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/**
 * R1：按第 3 节判定一个条目名。
 * 返回 { number, suffix } 或 null（不匹配）。
 *
 * 注意「空数字不匹配」：`round.md`、`round-`、`round(` 都不该匹配。
 * 正则里的 `(\d+)` 已经保证这一点（至少一个数字），这里不额外处理。
 */
function matchRoundName(entryName) {
  const base = stripExt(entryName).toLowerCase();   // 大小写不敏感
  const m = base.match(ROUND_RE);
  if (!m) return null;
  return { number: parseInt(m[1], 10), suffix: m[2] };  // 前导零按数值
}

/**
 * R2 + R3：对一组条目名算出轮次号与异常。
 * 契约：SUSPICIOUS_RANGE 的条目**仍参与**最大值计算
 * （不因可疑而忽略，否则会导致轮次号回退）。
 */
function computeRoundNumber(entryNames) {
  const matched = [];
  const anomalies = [];
  for (const name of entryNames) {
    const hit = matchRoundName(name);
    if (!hit) {
      // 只对「看起来像 round 但不合规」的记 NON_ROUND_NAMING。
      // 契约的例子：round23-backup / round23_old / round23 (1)。
      // 完全不相干的文件（如 README.md）不算异常，只是不参与。
      if (/^round/i.test(stripExt(name))) {
        anomalies.push({ kind: 'NON_ROUND_NAMING', entry: name });
      }
      continue;
    }
    if (hit.number > SUSPICIOUS_ABOVE) {
      anomalies.push({ kind: 'SUSPICIOUS_RANGE', entry: name, number: hit.number });
    }
    matched.push(hit);
  }
  const max = matched.length ? Math.max(...matched.map((h) => h.number)) : 0;
  return {
    round_number: matched.length ? max + 1 : 1,
    scanned_entries: entryNames.length,
    matched_entries: matched.length,
    max_seen: matched.length ? max : null,
    anomalies,
  };
}

/** R4：对整个目录按第 2 节步骤 1–8 走一遍 */
function detect(dir) {
  if (!existsSync(dir)) {
    return { round_number: 1, created_root: true, scanned_entries: 0, matched_entries: 0, max_seen: null, anomalies: [] };
  }
  if (!statSync(dir).isDirectory()) {
    return { error: `不是目录: ${dir}`, blocking: true };
  }
  let entries;
  try {
    entries = readdirSync(dir);
  } catch (e) {
    // 契约：无法读取目录 → 阻塞，返回 PERMANENT_FAILURE，不得猜测
    return { error: `无法读取目录: ${e.message}`, blocking: true };
  }
  const r = computeRoundNumber(entries);
  return { ...r, created_root: false };
}

// ── 内置自证：把第 3 节与第 4 节表里的每一条都跑一遍 ──
function selfTest() {
  const cases = [
    // [条目名, 期望 number, 期望 suffix, 说明]
    ['round16', 16, '', '基本形态'],
    ['round16.md', 16, '', '带扩展名'],
    ['Round16', 16, '', '大写 R'],
    ['ROUND16', 16, '', '全大写'],
    ['round0999', 999, '', '前导零按数值'],
    ['round23b', 23, 'b', '尾部小写后缀'],
    ['round.md', null, null, '空数字不匹配'],
    ['round-', null, null, '空数字不匹配（横线）'],
    ['round(', null, null, '空数字不匹配（括号）'],
    ['round23-backup', null, null, '尾部非纯字母 → 不匹配'],
    ['round23_old', null, null, '尾部下划线 → 不匹配'],
    ['round23 (1)', null, null, '尾部空格括号 → 不匹配'],
    ['README', null, null, '完全不相干'],
  ];
  let bad = 0;
  console.log('\n第 3 节 匹配模式：');
  for (const [name, wantN, wantS, why] of cases) {
    const hit = matchRoundName(name);
    const gotN = hit ? hit.number : null;
    const gotS = hit ? hit.suffix : null;
    const pass = gotN === wantN && gotS === wantS;
    if (!pass) bad++;
    console.log(`  ${pass ? '✓' : '✗'} ${name.padEnd(16)} → ${String(gotN).padEnd(6)} ${String(gotS ?? '')}（${why}）`);
  }

  console.log('\n第 2 节 计算：');
  const calc = [
    [[], 1, '空目录 → 1'],
    [['README.md'], 1, '全是非 round 命名 → 1'],
    [['round1', 'round2'], 3, 'max+1'],
    [['round0999'], 1000, '前导零参与数值比较'],
    [['round9999999'], 10000000, 'SUSPICIOUS_RANGE 仍参与（不回退）'],
  ];
  for (const [names, want, why] of calc) {
    const r = computeRoundNumber(names);
    const pass = r.round_number === want;
    if (!pass) bad++;
    console.log(`  ${pass ? '✓' : '✗'} ${JSON.stringify(names).padEnd(28)} → ${r.round_number}（期望 ${want}，${why}）`);
  }

  console.log('\n第 3 节 异常：');
  const a1 = computeRoundNumber(['round23-backup']);
  const a2 = computeRoundNumber(['round9999999']);
  const t1 = a1.anomalies.some((a) => a.kind === 'NON_ROUND_NAMING');
  const t2 = a2.anomalies.some((a) => a.kind === 'SUSPICIOUS_RANGE');
  if (!t1) bad++;
  if (!t2) bad++;
  console.log(`  ${t1 ? '✓' : '✗'} round23-backup → NON_ROUND_NAMING`);
  console.log(`  ${t2 ? '✓' : '✗'} round9999999 → SUSPICIOUS_RANGE`);

  console.log(`\n${bad === 0 ? '✅ 全部符合契约' : `✗ ${bad} 项不符合`}\n`);
  return bad === 0 ? 0 : 1;
}

// ── 主流程 ──
if (ARGS.selfTest) process.exit(selfTest());

if (!ARGS.dir) {
  console.error('需要 --dir <docs/reports> 或 --self-test');
  process.exit(2);
}

const result = detect(ARGS.dir);

if (ARGS.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n轮次探测（${ARGS.dir}）\n`);
  if (result.blocking) {
    console.log(`  ✗ 阻塞: ${result.error}`);
    console.log('  契约：无法读取目录时返回 PERMANENT_FAILURE，不得猜测轮次号\n');
    process.exit(1);
  }
  console.log(`  轮次号        ${result.round_number}`);
  console.log(`  扫描条目      ${result.scanned_entries}`);
  console.log(`  匹配条目      ${result.matched_entries}`);
  console.log(`  见过的最大值  ${result.max_seen ?? '（无）'}`);
  if (result.created_root) console.log('  目录不存在 → 首次运行');
  if (result.anomalies.length) {
    console.log(`\n  异常 ${result.anomalies.length} 项：`);
    for (const a of result.anomalies.slice(0, 10)) console.log(`    [${a.kind}] ${a.entry}`);
  }
  console.log('');
}
process.exit(0);
