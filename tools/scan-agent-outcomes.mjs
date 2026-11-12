#!/usr/bin/env node
/**
 * scan-agent-outcomes.mjs — 判断一批子 Agent 的实际结局，不依赖转录文件大小
 *
 * 为什么需要（2026-11-12 实测）：
 *   本次会话 80 个子 Agent 里，**22 个（27.5%）的 JSONL 转录是 0 字节**。
 *   我据此多次判定「它没跑 / 还在跑 / 失败了」。
 *
 *   核查发现：用过的 8 个 scratch 工作目录里全都有文件（4–10 个），
 *   其中包括转录同样为 0 字节的那些。**转录大小不能用来判断子 Agent 是否工作过。**
 *
 * 这个脚本只做一件机械的事：把「转录大小」和「工作目录文件数」两个**独立事实**
 * 摆出来，让人自己判断——而不是拿其中一个去冒充另一个。
 *
 * **它不猜。** 对应不上的 agent 明确报 UNKNOWN，不硬归类。
 *
 * 用法：
 *   node scan-agent-outcomes.mjs --tasks <tasks目录> [--scratch-map <json>]
 *   node scan-agent-outcomes.mjs --self-test
 *
 * scratch-map 形如：{ "<agent_id前缀>": "<scratch目录绝对路径>" }
 * 没有映射时只报告转录侧事实，并声明这一侧不足以判定。
 */

import { existsSync, statSync, readdirSync } from 'node:fs';
import { resolve, basename, join } from 'node:path';

/**
 * 只根据「两个独立事实」分类，不做因果推断。
 *
 *   transcriptSize  转录文件字节数（0 表示 harness 没写/没写出来）
 *   scratchFiles    已知工作目录里的文件数（null 表示**不知道**，不是 0）
 */
export function classifyAgent({ transcriptSize, scratchFiles }) {
  const known = scratchFiles !== null && scratchFiles !== undefined;
  const hasWork = known && scratchFiles > 0;
  const hasTranscript = transcriptSize > 0;

  if (hasWork) return hasTranscript ? 'WORKED_AND_TRANSCRIBED' : 'WORKED_SILENTLY';
  if (!known) {
    // 工作侧未知：只能报转录侧事实，不能断言「没干活」
    return hasTranscript ? 'TRANSCRIBED_WORK_UNKNOWN' : 'UNKNOWN';
  }
  return hasTranscript ? 'TRANSCRIBED_ONLY' : 'NEVER_STARTED';
}

const HINT = {
  WORKED_AND_TRANSCRIBED: '转录有内容 + 工作目录有文件 → 正常',
  WORKED_SILENTLY: '**转录 0 字节但工作目录有文件** → 它真干过，别因转录空就判失败',
  TRANSCRIBED_WORK_UNKNOWN: '转录有内容；工作目录未提供 → 无法判断是否留了产物',
  TRANSCRIBED_ONLY: '转录有内容但工作目录为空 → 可能只是问答式任务，或产物写到了别处',
  UNKNOWN: '**两侧都无法判定** → 转录 0 字节且工作目录未知，不能说它没跑',
  NEVER_STARTED: '转录 0 + 工作目录确认空 → 大概率从未启动',
};

function selfTest() {
  let pass = 0, fail = 0;
  const ok = (n, c, d = '') => { c ? (pass++, console.log(`  ✓ ${n}`)) : (fail++, console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`)); };

  console.log('\n=== 结局判定器自测 ===\n');

  ok('转录 0 + 工作目录确认空 → NEVER_STARTED',
    classifyAgent({ transcriptSize: 0, scratchFiles: 0 }) === 'NEVER_STARTED');
  ok('转录 0 + 工作目录有文件 → WORKED_SILENTLY（核心用例）',
    classifyAgent({ transcriptSize: 0, scratchFiles: 4 }) === 'WORKED_SILENTLY');
  ok('转录有内容 + 工作目录有文件 → WORKED_AND_TRANSCRIBED',
    classifyAgent({ transcriptSize: 700000, scratchFiles: 5 }) === 'WORKED_AND_TRANSCRIBED');
  ok('转录有内容 + 工作目录空 → TRANSCRIBED_ONLY',
    classifyAgent({ transcriptSize: 5000, scratchFiles: 0 }) === 'TRANSCRIBED_ONLY');

  // 最关键：工作侧未知时，绝不能断言任何结论
  ok('转录 0 + 工作目录未知 → UNKNOWN（不能判「没跑」）',
    classifyAgent({ transcriptSize: 0, scratchFiles: null }) === 'UNKNOWN');
  ok('转录有内容 + 工作目录未知 → TRANSCRIBED_WORK_UNKNOWN',
    classifyAgent({ transcriptSize: 900, scratchFiles: null }) === 'TRANSCRIBED_WORK_UNKNOWN');

  // 「0 是事实，null 是不知道」必须区分——这是这个工具存在的底线
  ok('scratchFiles=0 与 scratchFiles=null 判出的结局不同',
    classifyAgent({ transcriptSize: 0, scratchFiles: 0 })
    !== classifyAgent({ transcriptSize: 0, scratchFiles: null }));

  console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
  return fail === 0;
}

// ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--self-test') || args.length === 0) {
  process.exit(selfTest() ? 0 : 1);
}

const ti = args.indexOf('--tasks');
const mi = args.indexOf('--scratch-map');
if (ti < 0) {
  console.error('用法: node scan-agent-outcomes.mjs --tasks <tasks目录> [--scratch-map <json>]');
  process.exit(2);
}

const tasksDir = resolve(args[ti + 1]);
if (!existsSync(tasksDir)) {
  console.error(`找不到 ${tasksDir}`);
  process.exit(2);
}

let scratchMap = {};
if (mi >= 0) {
  try {
    const raw = JSON.parse(await (await import('node:fs/promises')).readFile(resolve(args[mi + 1]), 'utf8'));
    scratchMap = raw;
  } catch (e) {
    console.error(`scratch-map 读取失败: ${e.message}`);
    process.exit(2);
  }
}

const rows = [];
for (const f of readdirSync(tasksDir).filter((x) => x.endsWith('.output'))) {
  const id = basename(f, '.output');
  const st = statSync(join(tasksDir, f));

  // 只有明确给了映射才知道工作目录；否则是 null（不知道），不是 0（空）
  let scratchFiles = null;
  const key = Object.keys(scratchMap).find((k) => id.startsWith(k));
  if (key) {
    const dir = scratchMap[key];
    try { scratchFiles = existsSync(dir) ? readdirSync(dir).length : 0; } catch { scratchFiles = null; }
  }

  rows.push({
    id: id.slice(0, 10),
    transcript: st.size,
    scratchFiles,
    kind: classifyAgent({ transcriptSize: st.size, scratchFiles }),
  });
}

const counts = rows.reduce((a, r) => { a[r.kind] = (a[r.kind] ?? 0) + 1; return a; }, {});
const mapped = rows.filter((r) => r.scratchFiles !== null).length;

console.log(`\n扫描 ${rows.length} 个子 Agent（工作目录已知 ${mapped} 个 / ${rows.length}）\n`);
console.log('结局                        数量   比例    含义');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(26)} ${String(v).padStart(4)}  ${(v / rows.length * 100).toFixed(1).padStart(5)}%  ${HINT[k] ?? ''}`);
}

const emptyT = rows.filter((r) => r.transcript === 0);
if (emptyT.length) {
  const known = emptyT.filter((r) => r.scratchFiles !== null);
  const worked = known.filter((r) => r.scratchFiles > 0);
  console.log(`\n转录为 0 字节的: ${emptyT.length} / ${rows.length}（${(emptyT.length / rows.length * 100).toFixed(1)}%）`);
  if (known.length) {
    console.log(`  其中工作目录已知的 ${known.length} 个里，${worked.length} 个确实有文件。`);
  } else {
    console.log('  ⚠ 这些 agent 的工作目录都未知——**不能据此说它们没跑**。');
  }
}

console.log('');
process.exit(0);
