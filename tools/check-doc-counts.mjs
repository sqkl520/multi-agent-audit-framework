#!/usr/bin/env node
/**
 * check-doc-counts.mjs — 文档里写死的数字是否与代码实际一致
 *
 * ── 为什么需要（2026-11-21）────────────────────────────────────────
 *
 * 这个仓库的 README 反复宣传自己是"用机械校验代替人肉记忆"，
 * 但它自己的头条数字全是**手写维护**的，而且已经错过三次：
 *
 *   - 套件数：文档写 40 / 41 / 42 三种，实际 44
 *   - 出口率：文档写 8.9%（97/1084），实际 21.7%（243/1118）
 *   - 出口率为 0 的文件：文档写 14 个，实际 0 个
 *
 * 每次改动套件数都要记得同步 6 处（README 中英 × 各 2-3 处、CONTRIBUTING 中英），
 * 靠自觉必然漏。这正是 PROJECT-RULES 规则 5 说的「文档随代码一起版本化」——
 * 但规则只说了"要同步"，没说"怎么保证同步"。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *
 *   N1  文档里的「N 个自测套件 / N self-test suites」必须等于 check-all.mjs 实际条目数
 *   N2  文档里的「出口率 X%」必须与 check-rule-ledger 的输出一致（容差 0.1）
 *   N3  同一份文档里同一个指标出现多次时，几处必须互相一致（**未实现**；
 *       2026-11-26 锐评指出这一行与代码不符——代码里只有 N1/N2。
 *       原本计划靠它抓「57 项：48 个自测 + 11 个直接运行」这种行内矛盾，
 *       现在改由 N1 的两个正则（「N 项」与「N 个自测套件」分别对各自真值）覆盖。
 *
 * ── 为什么不自动改写文档 ────────────────────────────────────────────
 *
 * 能做，但刻意不做：一个会自己改 README 的脚本，在数字算错时会把错误
 * 也一起写进去，而且没人会发现。这里只报告，改不改由人决定。
 *
 * 用法：node check-doc-counts.mjs [--json]
 * 退出码：0 一致 / 1 不一致 / 2 配置错误（一条数字都没抽到）
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const jsonOut = process.argv.includes('--json');

const problems = [];
const checked = [];

// ── 真值来源 ──
/** 套件数：直接数 check-all.mjs 里的 script 条目 */
function actualSuiteCount() {
  const src = readFileSync(join(HERE, 'check-all.mjs'), 'utf8');
  return (src.match(/script:\s*'/g) ?? []).length;
}

/** 其中真正的 .test.mjs 自测数（H4：文档写「N 个自测套件」时，这个才是真值） */
function actualSelfTestCount() {
  const src = readFileSync(join(HERE, 'check-all.mjs'), 'utf8');
  return (src.match(/script:\s*'[^']+\.test\.mjs'/g) ?? []).length;
}

/** 出口率：跑一次 check-rule-ledger --json */
function actualExitRate() {
  try {
    const out = execFileSync(process.execPath, [join(HERE, 'check-rule-ledger.mjs'), '--json', '--dump-rows'],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
    const j = JSON.parse(out);
    // 严格口径：只认 script: 与 rule: 出口（artifact 是"另一份规范"，
    // 不在"可执行检查器"这个意义上算出口）
    const real = (j.rows ?? []).filter((r) => r.has_exit
      && r.exits.some((e) => e.startsWith('script:') || e.startsWith('rule:'))).length;
    return {
      rate: j.exit_rate_pct,
      sentences: j.rule_sentences,
      withExit: j.with_exit,
      strictRate: Number(((real / j.rule_sentences) * 100).toFixed(1)),
      strictCount: real,
    };
  } catch { return null; }
}

const SUITES = actualSuiteCount();
if (SUITES === 0) {
  console.error('[预期失败] 从 check-all.mjs 里数出 0 个套件——结构可能变了');
  process.exit(2);
}
const SELF_TESTS = actualSelfTestCount();
const EXIT = actualExitRate();

// ── 参与检查的文档 ──
//
// 2026-11-25（H3 锐评）：原先只有 4 份，CAPABILITIES.md 与 check-all.mjs 里的
// 写死数字完全看不见。`README.en.md:203` 甚至和同一文件第 59 行互相矛盾
// （一个写 40，一个写 57），而本工具报绿。
const DOCS = [
  'README.md', 'README.en.md', 'CONTRIBUTING.md', 'docs/i18n/CONTRIBUTING.zh-CN.md',
  'CAPABILITIES.md',
].filter((f) => existsSync(join(ROOT, f)));

let extracted = 0;

for (const doc of DOCS) {
  const text = readFileSync(join(ROOT, doc), 'utf8');

  // ── N1 · 套件数 ──
  //
  // 匹配「N 个自测套件」「N 个机械校验」「N self-test suites」「机械校验套件（N 个）」
  //
  // 2026-11-25（H3/H4 锐评）：两条修正。
  //   H4  「N 个自测套件」里 N 的真值是 **.test.mjs 的数量**，不是 check-all 的条目数。
  //        原来一律按条目数比，文档写「56 个自测套件」而实际只有 45 个 .test.mjs，
  //        数字对上了、标签是错的。
  //   H3  正则放宽：`N 个校验套件` / `N validation suites` / `about N suites` 也认。
  //
  // 2026-11-26（锐评 C1）：`N 项检查` / `N 项` / `N checks` 这类写法此前**完全没被扫**。
  // 实测：把 README 里全部「N 项」改成 999，本工具仍报绿——于是「57 项：48 个自测 + 11 个直接运行」
  // 这种行内自相矛盾（57 ≠ 48+11）能一直存在。现在补上。
  //
  // ⚠ **历史叙述**里也会出现这类数字（「2026-11-16 那次运行 57 项检查」）。
  // 那是记录不是声称当前值，改它会篡改历史。
  //
  // 2026-11-26 验收实测：第一版用「命中点前后 120 字窗」判定历史，窗口太宽——
  // `README.md:186`（`| 机械校验（59 项） |`，在「## 📌 当前进度」表里，同段有
  // `最后更新：2026-11-18`）与 `CAPABILITIES.md:4`（`适用版本：… 59 项检查`，同段有
  // `更新时间：2026-11-16`）**都是当前声称值，却被当成历史跳过了**。
  // 那正是「用过滤掩盖漏检」——本仓库反复修的形态。
  //
  // 现在：只看**命中所在的这一行**，且必须出现真正的历史标记词（`误拦`、`当时`、
  // `那 7 条修复`、`实测数据` 等）。日期本身**不再**算历史标记（当前进度表也写日期）。
  const HISTORICAL = /误拦|false blocks|那 7 条修复|当时|此前|历史|实测数据|那次/;
  const SUITE_RES = [
    { re: /(\d+)\s*个自测套件/g, truth: () => SELF_TESTS, what: '自测套件' },
    { re: /(\d+)\s*(?:个)?(?:校验)?套件/g, truth: () => SUITES, what: '套件（含直接运行的脚本）' },
    { re: /(\d+)\s*self-test suites/gi, truth: () => SELF_TESTS, what: 'self-test suites' },
    { re: /(\d+)\s*validation suites/gi, truth: () => SUITES, what: 'validation suites（含直接运行的脚本）' },
    { re: /机械校验套件（(\d+)\s*个）/g, truth: () => SUITES, what: '套件（含直接运行的脚本）' },
    // 2026-11-26 补：条目总数（= 自测套件 + 直接运行的脚本）
    { re: /(\d+)\s*项检查/g, truth: () => SUITES, what: '项检查' },
    { re: /机械校验（(\d+)\s*项）/g, truth: () => SUITES, what: '项检查' },
    { re: /(\d+)\s*项，含/g, truth: () => SUITES, what: '项检查（含 N 个自测套件）' },
    { re: /(\d+)\s*项：\d+\s*个自测套件/g, truth: () => SUITES, what: '项检查（N 项：M 个自测 + K 个直接运行）' },
    { re: /(\d+)\s+checks\b/gi, truth: () => SUITES, what: 'checks' },
    { re: /(\d+)\s*项\)/g, truth: () => SUITES, what: '项' },
    // 规则句总数：只认「实测 N 条规则句」/「Of N rule sentences」这种**声称当前值**的写法。
    { re: /实测\s*(\d+)\s*条规则句/g, truth: () => (EXIT ? EXIT.sentences : -1), what: '规则句' },
    { re: /Of\s+(\d+)\s+rule sentences/gi, truth: () => (EXIT ? EXIT.sentences : -1), what: 'rule sentences' },
  ];
  const seen = new Map();   // 数值 → 第一次出现的上下文
  for (const { re, truth, what } of SUITE_RES) {
    for (const m of text.matchAll(re)) {
      const n = Number(m[1]);
      const expectN = truth();
      // 历史叙述跳过（见 HISTORICAL）：**只看命中所在的那一行**。
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      let lineEnd = text.indexOf('\n', m.index + m[0].length);
      if (lineEnd < 0) lineEnd = text.length;
      const ctx = text.slice(lineStart, lineEnd);
      if (HISTORICAL.test(ctx)) continue;
      extracted++;
      if (n !== expectN) {
        problems.push({
          id: 'N1', doc, found: n, expected: expectN,
          msg: `${doc} 写「${m[0].trim()}」，但${what}实际是 ${expectN} 个`
            + `（check-all 共 ${SUITES} 条，其中 ${SELF_TESTS} 个 .test.mjs）`,
        });
      } else if (!seen.has(n)) {
        seen.set(n, m[0]);
      }
    }
  }

  // ── N2 · 出口率 ──
  //
  // 这里要区分**两种口径**，它们都是对的，不能判成矛盾：
  //   宽口径：所有"有出口"的规则句（含 artifact —— 另一份规范也算一种执行者）
  //   严格口径：只认 script: 与 rule:（真的有个脚本会因它报错）
  //
  // 2026-11-21 实测：第一版只认识宽口径，于是把文档里的「11.4%（严格口径）」
  // 判成错误。**同一个数字在不同口径下有两个正确值**，判据必须认得出是哪一个。
  if (EXIT) {
    for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*%/g)) {
      const lineStart = text.lastIndexOf('\n', m.index) + 1;
      let lineEnd = text.indexOf('\n', m.index);
      if (lineEnd < 0) lineEnd = text.length;
      const line = text.slice(lineStart, lineEnd);
      if (!/出口率|outlet|exit rate|机器出口/i.test(line)) continue;

      const n = Number(m[1]);
      extracted++;

      // 该数字属于哪个口径？
      //
      // 2026-11-21 两轮踩坑，才得到这个判据：
      //
      // 坑 1：只看「同一行有没有『严格口径』」不够。README.en.md:126 把两个数字
      //   写在同一句里，11.4% 前面没有 strict 字样，但它指的是严格口径。
      //
      // 坑 2：改成「向前 60 字内找」之后，README.md:187 又反了：
      //   出口率 21.9%（严格口径 11.6%）
      //   21.9% 的**后面**跟着「严格口径」，向前扫不到，向后扫就误命中。
      //
      // 正确的顺序：
      //   ① 先看数字**紧邻的后缀**（`)` 后 20 字内），那里若写「严格口径」，
      //      说明是**后一个数字**才严格，当前这个是宽口径
      //   ② 再看**前缀**（前 30 字内）是否有「严格口径 / strict」
      //   ③ 都没有 → 宽口径
      // 该数字属于哪个口径？
      //
      // 这条判据试了四轮才对。记录全部坑，因为每一轮都是真实踩过的：
      //
      // 坑 1：只看「整行有没有『严格口径』」
      //   README.en.md:126 两个数字同句、两种口径，整行匹配必然一半错。
      //
      // 坑 2：改成「向前 60 字内找」
      //   README.md:187 `出口率 21.9%（严格口径 11.6%）` 又反了——
      //   21.9% 向后才碰到「严格口径」，那是标注后一个数字的。
      //
      // 坑 3：改成「按距离取最近的标记」
      //   README.en.md:126 里 11.6% 的标记（executable rule）隔了好几个词，
      //   25 字窗口够不到。
      //
      // 坑 4：把那类标记扩到整句去找
      //   同一句里 21.9% 也被整句的 executable rule 命中，又反过来错了。
      //
      // ── 结论：不要试图从上下文推断口径 ──
      //
      // 一个数可能属于哪种口径，取决于作者怎么想，不取决于周围有什么词。
      // 硬猜必然在某些排布下出错，而这类错误会让人直接关掉检查。
      //
      // 改成：**接受两种口径中的任意一种**。只要这个数字等于宽口径或严格口径
      // 之一，就算它说的是真话——因为两种口径下的值都是工具的诚实输出。
      // 真正要抓的是「既不是 A 也不是 B」的过期数字（比如 8.9%）。
      //
      // 代价：分辨不出「把严格口径的数写成宽口径的标签」。但那个问题
      // 属于措辞审查，不属于数字一致性。
      const okWide = Math.abs(n - EXIT.rate) <= 0.15;
      const okStrict = Math.abs(n - EXIT.strictRate) <= 0.15;
      if (okWide || okStrict) continue;   // 两种口径之一，通过

      problems.push({
        id: 'N2', doc, found: n, expected: `${EXIT.rate} 或 ${EXIT.strictRate}`,
        msg: `${doc} 写出口率 ${n}%，但工具输出只有两种口径：`
          + `${EXIT.rate}%（${EXIT.withExit}/${EXIT.sentences} 有出口）`
          + ` 或 ${EXIT.strictRate}%（${EXIT.strictCount}/${EXIT.sentences} 仅有 script/rule 出口）。`
          + `${n}% 两个都不是——**这个数字过期了**`,
      });
    }
  }
}

// ── 分母为 0 不等于通过 ──
if (extracted === 0) {
  console.error('[预期失败] 一条数字都没抽到——正则可能失效，或文档结构变了');
  process.exit(2);
}

const ok = problems.length === 0;

if (jsonOut) {
  console.log(JSON.stringify({
    ok, docs: DOCS.length, numbers_checked: extracted,
    truth: { suites: SUITES, exit_rate: EXIT?.rate ?? null },
    problems,
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log('\n文档数字一致性检查（写死的数字 vs 代码实际）\n');
console.log(`  扫描文档   ${DOCS.length} 份`);
console.log(`  抽出数字   ${extracted} 处`);
console.log(`  真值       套件 ${SUITES} 个${EXIT ? ` / 出口率 ${EXIT.rate}%（${EXIT.withExit}/${EXIT.sentences}）` : ''}`);
console.log('');
if (ok) {
  console.log('  ✓ 文档里写死的数字与代码一致');
} else {
  console.log(`  ✗ ${problems.length} 处不一致：`);
  for (const p of problems) console.log(`    [${p.id}] ${p.msg}`);
  console.log('');
  console.log('  这些数字是手写维护的，改套件数时要记得同步全部位置。');
  console.log('  本工具只报告、不自动改写——一个会自己改 README 的脚本，');
  console.log('  在数字算错时会把错误也一起写进去，而且没人会发现。');
}
console.log('');
process.exit(ok ? 0 : 1);
