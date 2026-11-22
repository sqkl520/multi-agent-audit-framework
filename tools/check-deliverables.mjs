#!/usr/bin/env node
/**
 * check-deliverables.mjs — 交付物规范检查
 *
 * 为什么需要它：2026-11-05 之前，框架只规定了「波次产物的文件名」，
 * 没规定「一次运行结束后用户该拿走什么」。
 * 结果是交付物很乱：11.6KB 到 25.0KB 的文件长什么样全凭 agent 心情，
 * 用户要自己翻一堆文件才能拼出结论。
 *
 * 现在规定两类必交付（report-naming.md §4.1）：
 *   ① round{N}-final-report.md  人读，固定六节
 *   ② round{N}-ledger.md        机读，固定五节
 *
 * 用法：
 *   node check-deliverables.mjs --round-dir docs/reports/round3 [--json]
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const di = args.indexOf('--round-dir');
const roundDir = di >= 0 ? args[di + 1] : null;

if (!roundDir) {
  console.error('用法: node check-deliverables.mjs --round-dir <docs/reports/roundN> [--json]');
  process.exit(2);
}

const findings = [];
const add = (level, rule, msg, detail) => findings.push({ level, rule, msg, detail: detail ?? null });
const fail = (r, m, d) => add('FAIL', r, m, d);
const warn = (r, m, d) => add('WARN', r, m, d);
const pass = (r, m, d) => add('PASS', r, m, d);

if (!existsSync(roundDir)) {
  console.error(`轮次目录不存在: ${roundDir}`);
  process.exit(2);
}

const st = statSync(roundDir);
if (!st.isDirectory()) {
  console.error(`不是目录: ${roundDir}`);
  process.exit(2);
}

// 从目录名推断 round_id（round3 → round3）
// round_id 的来源，按优先级：
//   1. --round-id 显式指定（最可靠，测试和多轮共用目录时必须用）
//   2. 目录名（round3 → round3）
//   3. 目录里的 state.json 的 round_id
//   4. 目录里唯一一个 round*-final-report.md 的前缀
//
// 2026-11-09 加 1/3/4：原来只用目录名，导致临时目录或非常规命名时
// 全部判「必交付文件缺失」——检查器自己制造了假阳性。
const explicitId = (() => {
  const i = args.indexOf('--round-id');
  return i >= 0 ? args[i + 1] : null;
})();

function deriveRoundId() {
  if (explicitId) return { id: explicitId, source: '--round-id' };

  const byDir = basename(roundDir).replace(/\\/g, '/').split('/').pop();
  if (/^round\d+$/.test(byDir)) return { id: byDir, source: '目录名' };

  // 从 state.json 读
  const sp = join(roundDir, 'state.json');
  if (existsSync(sp)) {
    try {
      const s = JSON.parse(readFileSync(sp, 'utf8'));
      if (s.round_id) return { id: s.round_id, source: 'state.json' };
    } catch { /* 忽略 */ }
  }

  // 从文件名推断（找唯一一个 round*-final-report.md）
  try {
    const reports = readdirSync(roundDir).filter((f) => /^round\d+-final-report\.md$/.test(f));
    if (reports.length === 1) {
      return { id: reports[0].replace('-final-report.md', ''), source: '产物文件名' };
    }
  } catch { /* 忽略 */ }

  return { id: byDir, source: '目录名（无法验证）' };
}

const roundInfo = deriveRoundId();
const roundId = roundInfo.id;
const files = readdirSync(roundDir);

// ────────────────────────────────────────────────────────────────────
// D1 · 两类必交付文件必须存在且非空
// ────────────────────────────────────────────────────────────────────
const reportName = `${roundId}-final-report.md`;
const ledgerName = `${roundId}-ledger.md`;

function checkFile(name) {
  const p = join(roundDir, name);
  if (!existsSync(p)) {
    fail('D1', `必交付文件缺失: ${name}`);
    return null;
  }
  const s = statSync(p);
  if (s.size === 0) {
    fail('D1', `必交付文件是空文件: ${name}`);
    return null;
  }
  pass('D1', `${name} 存在（${s.size} 字节）`);
  return readFileSync(p, 'utf8');
}

const reportText = checkFile(reportName);
const ledgerText = checkFile(ledgerName);

// ────────────────────────────────────────────────────────────────────
// D2 · 最终报告必须有六节
// ────────────────────────────────────────────────────────────────────
if (reportText) {
  // 允许 "## 0. 一句话结论" 这种编号形式；按标题关键词匹配
  const required = [
    { key: '结论', name: '0. 一句话结论' },
    { key: '元信息', name: '1. 元信息' },
    { key: '覆盖说明', name: '2. 覆盖说明' },
    { key: '发现', name: '3. 发现汇总' },
    { key: '未闭合', name: '4. 失败与未闭合' },
    { key: '零写入', name: '5. 零写入自证' },
    { key: '下一步', name: '6. 下一步' },
  ];
  const headings = [...reportText.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]);

  // 2026-11-14 修（批判 agent 实测）：
  // 此前用 `headings.some(h => h.includes(key))`——只要某个标题里**包含**关键词就算命中。
  // 实测把七个关键词塞进同一个标题即判「七节齐全」：
  //   ## 0. 一句话结论 1. 元信息 2. 覆盖说明 3. 发现汇总 4. 失败与未闭合 5. 零写入自证 6. 下一步
  // 一个标题承载七个节，报告实际上只有一节。
  //
  // 修法：每个节必须**独占一个标题**，且一个标题只能满足一个节。
  // 判据从「包含」改为「一个标题里出现该关键词」+ 「该标题没被别的节占用」。
  const used = new Set();
  const missing = [];
  for (const r of required) {
    const idx = headings.findIndex((h, i) => !used.has(i) && h.includes(r.key));
    if (idx < 0) {
      missing.push(r);
    } else {
      used.add(idx);
    }
  }

  // 附加：一个标题里塞了多个节关键词 → 明确报出来，而不是默默算通过
  const stuffers = headings.filter((h) => required.filter((r) => h.includes(r.key)).length > 1);

  if (missing.length > 0) {
    fail('D2', `最终报告缺节: ${missing.map((m) => m.name).join(' / ')}`, {
      实际标题: headings.join(' | ') || '(无二级标题)',
    });
  } else if (stuffers.length > 0) {
    fail('D2', `一个标题里塞了多个节，节没有独立成标题: 「${stuffers[0].slice(0, 60)}」`, {
      说明: '每个节必须独占一个二级标题',
    });
  } else {
    pass('D2', `最终报告七节齐全（${headings.length} 个二级标题）`);
  }

  // 覆盖率必须是「N/N = xx%」的形式，且分母不能是 0、结果必须自洽且 ≤100%
  const cov = reportText.match(/(\d+)\s*\/\s*(\d+)\s*=\s*([\d.]+)\s*%/);
  if (!cov) {
    warn('D2', '覆盖说明里没找到「N/N = xx%」形式的覆盖率');
  } else if (Number(cov[2]) === 0) {
    fail('D2', `覆盖率分母为 0: ${cov[0]}`);
  } else {
    // 2026-11-14 修：此前只查「分母不为 0」。实测 `999 / 3 = 33300%` 被判定通过——
    // 一个超过 100% 的覆盖率在数学上不可能，它意味着分子分母不是同一套口径。
    const num = Number(cov[1]), den = Number(cov[2]), pct = Number(cov[3]);
    const realPct = (num / den) * 100;
    if (pct > 100) {
      fail('D2', `覆盖率不可能超过 100%: ${cov[0]}——分子分母不是同一套口径`);
    } else if (Math.abs(realPct - pct) > 0.5) {
      fail('D2', `覆盖率算错: ${cov[0]}（${num}/${den} 实际是 ${realPct.toFixed(1)}%）`);
    } else {
      pass('D2', `覆盖率有明确数值且自洽: ${cov[0]}`);
    }
  }

  // D2b · 证据覆盖率（2026-11-10 新增）
  // 派发覆盖率可以 100% 而证据覆盖率 0%：每片都派了、都返回 SUCCESS，
  // 但每份产物都是空的 NO_EVIDENCE_FOUND。只报派发覆盖率是自欺。
  const evCov = reportText.match(/证据覆盖率[^\n]*?(\d+)\s*\/\s*(\d+)\s*=\s*([\d.]+)\s*%/);
  if (!evCov) {
    fail('D2b', '最终报告缺「证据覆盖率」——它是唯一能暴露「派了但没查」的指标。' +
                '格式：证据覆盖率 = Q / F = xx%（Q=门 0 通过的 quote 条数，F=切片声明文件总数）');
  } else {
    const rate = Number(evCov[3]);
    const num = Number(evCov[1]), den = Number(evCov[2]);
    const realRate = (num / den) * 100;
    if (den === 0) {
      fail('D2b', `证据覆盖率分母为 0: ${evCov[0]}`);
    } else if (rate > 100) {
      // 2026-11-14 修：此前 D2b 只查「分母为 0」和「低于 5%」，没有上限。
      // 实测 `证据覆盖率 = Q / F = 999 / 3 = 33300%` 被 D2b 判定通过，
      // 而同一份报告的 D2 已经判它 FAIL——**一份报告两处结论互相矛盾**，
      // 正是本会话早些时候修过的同一类缺陷（表格全绿而合计说有问题）。
      fail('D2b', `证据覆盖率不可能超过 100%: ${evCov[0]}——Q 不可能大于 F（Q=门0通过的quote数，F=声明文件总数）`);
    } else if (Math.abs(realRate - rate) > 0.5) {
      fail('D2b', `证据覆盖率算错: ${evCov[0]}（${num}/${den} 实际是 ${realRate.toFixed(1)}%）`);
    } else if (rate < 5) {
      warn('D2b', `证据覆盖率仅 ${rate}%（${num}/${den}）。` +
                 `可能是 Agent 没真读代码，也可能是本轮确实无缺陷——报告必须显式说明是哪一种`);
    } else {
      pass('D2b', `证据覆盖率 ${rate}%`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// D3 · 账本必须有五节
// ────────────────────────────────────────────────────────────────────
if (ledgerText) {
  const required = [
    { key: '切片', name: '1. 切片状态表' },
    { key: '预算', name: '2. 预算' },
    { key: '失败', name: '3. 失败分类' },
    { key: '裁量', name: '4. 裁量日志' },
  ];
  const headings = [...ledgerText.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1]);
  const missing = required.filter((r) => !headings.some((h) => h.includes(r.key)));
  if (missing.length > 0) {
    fail('D3', `账本缺节: ${missing.map((m) => m.name).join(' / ')}`, {
      实际标题: headings.join(' | ') || '(无二级标题)',
    });
  } else {
    pass('D3', `账本四节必备齐全（第四节轮次链为可选）`);
  }
}

// ────────────────────────────────────────────────────────────────────
// D4 · 目录里不得有自由命名的文件（不能归入任何 stage 的）
// ────────────────────────────────────────────────────────────────────
// 2026-11-22：本节的命名规则实现自 `framework/artifacts/report-naming.md` §1。
//
// 这行注释不是装饰。`check-rule-ledger.mjs` 判断「一条规则有没有机器出口」时，
// 只认「工具源码里出现了该规范的文件名」。此前这里没有出处，
// 于是 report-naming.md 的 15 条规则被算成「仅靠 artifact 出口」——假阴性。
//
// 试过让 ledger 靠内容推断实现关系（词频、正则字面量），三版全部失败：
// 同一条规则在文档里写 `round(\d+)`、在代码里写 `${roundId}`，
// 形式不同，静态匹配猜不准。**猜错比不猜更糟**——把假出口算成真出口
// 正是那个工具要防的事。
//
// 正确做法是人来接线：写下出处，机器就能认。
{
  // 规则正则以 `framework/artifacts/report-naming.md` §1 为准，
  // 改这里必须同步改文档（反之亦然）。
  const STAGE_RE = new RegExp(`^${roundId}-(01-recon|02-sweep|02-audit|03-critique|04-fix|05-verify)-[a-z0-9]+(-[a-z0-9]+)*\\.md$`);
  const DELIVERABLE_RE = new RegExp(`^${roundId}-(final-report|ledger)\\.md$`);
  const LOG_OK = new RegExp(`^${roundId}-log\\.(txt|md)$`);

  const unknown = files.filter((f) => {
    if (f === 'state.json') return false;
    if (DELIVERABLE_RE.test(f)) return false;
    if (LOG_OK.test(f)) return false;
    if (STAGE_RE.test(f)) return false;
    return true;
  });

  if (unknown.length > 0) {
    warn('D4', `目录里有 ${unknown.length} 个文件不符合任何命名规范`, {
      文件: unknown.slice(0, 8).join(', ') + (unknown.length > 8 ? ' …' : ''),
    });
  } else {
    pass('D4', '目录内所有文件都有规范归属');
  }
}

// ────────────────────────────────────────────────────────────────────
// D5 · 不得有子目录（规范要求扁平）
// ────────────────────────────────────────────────────────────────────
{
  const subdirs = files.filter((f) => {
    try { return statSync(join(roundDir, f)).isDirectory(); } catch { return false; }
  });
  if (subdirs.length > 0) {
    warn('D5', `轮次目录下不应有子目录（规范要求扁平）`, { 子目录: subdirs.join(', ') });
  } else {
    pass('D5', '目录是扁平的');
  }
}

// ────────────────────────────────────────────────────────────────────
// 输出
// ────────────────────────────────────────────────────────────────────
const counts = findings.reduce((a, f) => { a[f.level] = (a[f.level] ?? 0) + 1; return a; }, {});

if (jsonOut) {
  console.log(JSON.stringify({ roundDir, roundId, counts, findings }, null, 2));
} else {
  console.log(`\n交付物检查: ${roundId}\n`);
  console.log(`  目录: ${roundDir}`);
  console.log(`  文件: ${files.length} 个\n`);

  const order = { FAIL: 0, WARN: 1, PASS: 2 };
  for (const f of [...findings].sort((a, b) => order[a.level] - order[b.level])) {
    const tag = { FAIL: '✗', WARN: '!', PASS: '✓' }[f.level];
    console.log(`${tag} [${f.rule}] ${f.msg}`);
    if (f.detail) for (const [k, v] of Object.entries(f.detail)) console.log(`     ${k}: ${v}`);
  }
  console.log(`\n合计: ${counts.FAIL ?? 0} FAIL / ${counts.WARN ?? 0} WARN / ${counts.PASS ?? 0} PASS\n`);
}

process.exit((counts.FAIL ?? 0) > 0 ? 1 : 0);
