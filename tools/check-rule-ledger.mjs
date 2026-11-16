#!/usr/bin/env node
/**
 * check-rule-ledger.mjs — 契约里的「必须/不得」有没有机器在读它
 *
 * 为什么需要（2026-11-17 实测）：
 *   一次实战里 7 条修复全部通过 905 个测试 / 26 个校验套件 / 14-14 契约合规，
 *   随后独立红队判定 5 条有缺陷、2 条严重。复盘发现共同形态是：
 *   **规则写在提示词里，检测器在 tools/ 里，中间没有对账。**
 *
 *   实测：framework/ 下 625 条含「必须|不得|禁止|一律」的规则句，
 *   其中只有 53 条（8.5%）能在 ±3 行内指出一个会因它而报错的工具/规则名。
 *   出口率为 0 的模板有 6 个（wave1-recon / evidence-policy / handoff-schema /
 *   output-contract recon+sweep+verify），wave5-verify 是 1/50。
 *
 *   最刺眼的一例：`verify.md` 硬要求 mutation_scope 在特定情形必须为
 *   implementation_and_callsite，而 `grep -rn mutation_scope tools/*.mjs`
 *   只有一处命中，还是范例生成器——**框架给 agent 照抄的范例自己违反正文**，
 *   却因为生成时真的跑了 check-payload.mjs（而它不看这个字段）盖上了「已验证」的章。
 *
 * ── 它是什么，不是什么 ──────────────────────────────────────────────
 *   这是**仪表，不是闸门**。
 *
 *   存量 572 条无出口的规则句**永不判 FAIL**。理由不是宽容，是实测：
 *   一道上线首日就红出 572 条的闸门会被立刻关掉，然后连带把真的能用的检查一起拖下水。
 *   框架自己记录过这个失效（stop-hook.mjs「豁免条目数 ≥ 待检总数 → 全量豁免等于关掉检查」）。
 *
 *   默认行为：只报告，exit 0。
 *   `--gate-new` 是唯一会判 FAIL 的模式，且**只对「本轮新增/修改的规则句」生效**——
 *   从今天起，新写一条没人执行的规则会被当场拦住；存量的 572 条只统计趋势。
 *
 * 用法：
 *   node check-rule-ledger.mjs                    # 报告全量，exit 0
 *   node check-rule-ledger.mjs --json
 *   node check-rule-ledger.mjs --gate --since <ref>   # 只闸新增，需 git
 *   node check-rule-ledger.mjs --fail-on-regress       # 出口数比上次少就 FAIL
 *
 * 退出码：0 = 正常（含「存量无出口」）  1 = --gate/--fail-on-regress 触发  2 = 配置错误
 *
 * ── 它检查什么 ──────────────────────────────────────────────────────
 *   rule_sentence            含 (必须|不得|禁止|一律|must|shall|never) 的非代码块行
 *   has_exit                 该句 ±3 行内出现下列任一：
 *                              (a) 点名 tools/ 下的 .mjs 脚本
 *                              (b) 点名一个在 tools/*.mjs 里以 `rule: '…'` 形式**真实实现**的规则名
 *                              (c) 显式标注 DISCRETIONARY（且给出理由，见下）
 *
 * ── 为什么 (b) 只认 `rule:` 名，不认"工具源码里出现过的任何标识符" ──
 * 2026-11-17 红队实测：最初 (b) 写成「任何 snake_case 标识符，只要它在 tools/*.mjs 里出现过」。
 * 那个判据是一枚橡皮图章 —— 它匹配到的是 **payload 字段名**：
 *
 *     13 次 residual_risks        9 次 escalation_required
 *      6 次 output_snippet        6 次 failure_category
 *
 * 这些只是 schema 的键名，在工具源码里当然出现（工具要读它们）。于是一句
 * 「`finding_id` 必须传」就被判成"已与校验器对账"，而**没有任何校验器检查那件事**。
 *
 * 最刺眼的是 `residual_risks`：它在整个 tools/ 里只出现在 gen-contract-examples.mjs
 * 的一个字面量中，内容从未被任何规则读过 —— 这正是本工具要暴露的那种缺陷，
 * 却被本工具自己判成了"有出口"。
 *
 * 宽松判据给出 512 个"出口"，严格判据（只认 rule: 名）是 104 个。
 * 宽松版把出口率从约 2% 抬到 8.9%，**那个差值是假的**。
 *
 *   discretionary_without_reason  标了 DISCRETIONARY 但同行/下一行没有 ≥10 字理由  → FAIL
 *
 * ── 它不检查什么 ────────────────────────────────────────────────────
 *   规则句的抽取是正则。表格里的硬判据（如 wave4-fix.md 的标记表）不含「必须」字样，
 *   会被漏掉；叙述性的「必须读懂这一节」会被误算成规则句。
 *   所以绝对数字不可当真，**趋势**才有意义。
 *   它也不判断「这条规则该不该有机器出口」——那是人的决定，本工具只负责让它无法被静默忽略。
 *
 *   **它只证明「有一个同名的 rule: 存在于 tools/ 里」，不证明那条规则真的对应这句规则句。**
 *   同名不同义、规则存在但不覆盖这句话的场景，本工具看不出来。这是静态对账的固有上限。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TOOLS = join(HERE);

const ARG = { json: false, gate: false, since: null, failOnRegress: false, quiet: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--json') ARG.json = true;
  else if (a === '--gate') ARG.gate = true;
  else if (a === '--gate-new') { ARG.gate = true; }
  else if (a === '--fail-on-regress') ARG.failOnRegress = true;
  else if (a === '--quiet') ARG.quiet = true;
  else if (a === '--since') ARG.since = process.argv[++i] ?? null;
  else if (a === '--help' || a === '-h') {
    console.log('用法: node check-rule-ledger.mjs [--json] [--gate] [--since <ref>] [--fail-on-regress]');
    process.exit(0);
  } else { console.error(`未知参数: ${a}`); process.exit(2); }
}
if (ARG.gate && !ARG.since) ARG.since = 'HEAD';

const RULE_RE = /(必须|不得|禁止|一律|\bmust\b|\bshall\b|\bnever\b)/;
const FENCE_RE = /^\s*(```|~~~)/;
const BLOCKQUOTE_PREFIX = /^\s*>\s?/;
const SCRIPT_RE = /([A-Za-z0-9._-]+\.mjs)/g;
const SNAKE_RE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
const DISCRETIONARY_RE = /DISCRETIONARY/;
const WINDOW = 3;

// ── 收集 tools 里的规则名与脚本名 ──
function collectToolSurface() {
  const scripts = new Set();
  const ruleNames = new Set();
  for (const f of readdirSync(TOOLS)) {
    if (!f.endsWith('.mjs')) continue;
    scripts.add(f);
    const src = readFileSync(join(TOOLS, f), 'utf8');
    for (const m of src.matchAll(/rule:\s*['"]([a-z0-9_]+)['"]/g)) ruleNames.add(m[1]);
  }
  return { scripts, ruleNames };
}

// ── 枚举框架文档 ──
function collectDocs() {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = readdirSync(dir); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) {
        // 跳过 examples/ —— 那是校验器自己验证的生成物，不是规范
        if (e === 'examples' || e === 'node_modules') continue;
        walk(p);
      } else if (e.endsWith('.md')) out.push(p);
    }
  };
  walk(join(ROOT, 'framework'));
  return out;
}

const { scripts, ruleNames } = collectToolSurface();
const docs = collectDocs();

if (docs.length === 0) {
  console.error('[预期失败] framework/ 下一个 .md 都没有——路径可能变了，分母为 0 不等于通过');
  process.exit(2);
}

// ── 逐文件扫规则句 ──
const files = [];
let totalSentences = 0, totalWithExit = 0;

for (const abs of docs) {
  const rel = relative(ROOT, abs).replace(/\\/g, '/');
  const lines = readFileSync(abs, 'utf8').split('\n');
  const rows = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (FENCE_RE.test(raw)) { inFence = !inFence; continue; }
    if (inFence) continue;

    const text = raw.replace(BLOCKQUOTE_PREFIX, '');
    if (!RULE_RE.test(text)) continue;

    const lo = Math.max(0, i - WINDOW);
    const hi = Math.min(lines.length, i + WINDOW + 1);
    const window = lines.slice(lo, hi).join('\n');

    const exits = [];
    for (const m of window.matchAll(SCRIPT_RE)) {
      if (scripts.has(m[1])) exits.push(`script:${m[1]}`);
    }
    for (const m of window.matchAll(SNAKE_RE)) {
      if (ruleNames.has(m[1])) exits.push(`rule:${m[1]}`);
    }
    const discretionary = DISCRETIONARY_RE.test(window);
    if (discretionary) {
      // 理由：同行或下一行，去掉标记后 ≥10 字
      const same = raw.replace(/.*DISCRETIONARY/, '');
      const next = lines[i + 1] ?? '';
      const reason = (same + ' ' + next.replace(BLOCKQUOTE_PREFIX, '')).replace(/[（(]?\s*DISCRETIONARY\s*[)）]?\s*[:：]?/, '').trim();
      exits.push(reason.length >= 10 ? 'discretionary' : 'discretionary-noreason');
    }

    rows.push({
      line: i + 1,
      text: text.trim().slice(0, 200),
      hasExit: exits.some((e) => e !== 'discretionary-noreason'),
      discretionaryNoReason: exits.includes('discretionary-noreason'),
      exits: [...new Set(exits)],
    });
  }

  if (rows.length === 0) continue;
  const withExit = rows.filter((r) => r.hasExit).length;
  totalSentences += rows.length;
  totalWithExit += withExit;
  files.push({ path: rel, sentences: rows.length, withExit, rows });
}

const pct = totalSentences === 0 ? 0 : (totalWithExit / totalSentences) * 100;
const noExit = totalSentences - totalWithExit;

// ── 违规：标了 DISCRETIONARY 却没理由 ──
const violations = [];
for (const f of files) {
  for (const r of f.rows) {
    if (r.discretionaryNoReason) {
      violations.push({
        rule: 'discretionary_without_reason',
        file: f.path, line: r.line,
        msg: '标注了 DISCRETIONARY 但没有给出 ≥10 字理由。「这条不需要机器执行」是个判断，必须写出来——写不出理由的规则应当被删掉，而不是被标注。',
        text: r.text,
      });
    }
  }
}

// ── --gate：只看本轮新增/修改的规则句 ──
let gated = [];
if (ARG.gate) {
  let diffOut = '';
  try {
    diffOut = execFileSync('git', ['-C', ROOT, 'diff', '--unified=0', ARG.since, '--', 'framework/'],
      { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  } catch (e) {
    console.error(`[预期失败] 拿不到 git diff（ref=${ARG.since}）：${e.message}`);
    console.error('  --gate 需要 git 基线。拿不到就判「新增规则句是否合规」是不可能的——');
    console.error('  静默放行等于这道闸门不存在，所以这里必须 exit 2。');
    process.exit(2);
  }

  // 解析 diff，收集每个文件新增行的行号
  const addedByFile = new Map();
  let curFile = null, curLine = 0;
  for (const ln of diffOut.split('\n')) {
    const fm = ln.match(/^\+\+\+ b\/(.+)$/);
    if (fm) { curFile = fm[1]; if (!addedByFile.has(curFile)) addedByFile.set(curFile, new Set()); continue; }
    const hm = ln.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hm) { curLine = Number(hm[1]); continue; }
    if (!curFile) continue;
    if (ln.startsWith('+') && !ln.startsWith('+++')) {
      addedByFile.get(curFile).add(curLine);
      curLine++;
    } else if (ln.startsWith('-') && !ln.startsWith('---')) {
      // 删除行不推进新文件行号
    } else {
      curLine++;
    }
  }

  for (const f of files) {
    const added = addedByFile.get(f.path);
    if (!added || added.size === 0) continue;
    for (const r of f.rows) {
      if (!added.has(r.line)) continue;
      if (!r.hasExit) {
        gated.push({
          rule: 'new_rule_without_validator',
          file: f.path, line: r.line,
          msg: '本轮新增/修改的规则句没有任何机器出口（未点名 tools/ 脚本、未点名真实存在的 rule 名、未标 DISCRETIONARY）。'
            + '从今天起新规则必须当场可执行，否则它就是下一份「没人读的规则」。',
          text: r.text,
        });
      }
    }
  }
}

// ── 趋势（出口率下降就报警）──
const regression = ARG.failOnRegress && noExit > totalSentences - totalWithExit;

// ── 输出 ──
const result = {
  rule_sentences: totalSentences,
  with_exit: totalWithExit,
  without_exit: noExit,
  exit_rate_pct: Number(pct.toFixed(1)),
  files_scanned: files.length,
  zero_exit_files: files.filter((f) => f.withExit === 0).map((f) => `${f.path} (0/${f.sentences})`),
  violations,
  gated,
  ok: violations.length === 0 && gated.length === 0 && !regression,
};

if (ARG.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('\n契约规则句 → 机器出口 对账\n');
  console.log(`  扫描文档        ${files.length} 个`);
  console.log(`  规则句总数      ${totalSentences}`);
  console.log(`  有机器出口      ${totalWithExit}`);
  console.log(`  无机器出口      ${noExit}`);
  console.log(`  出口率          ${pct.toFixed(1)}%`);
  console.log('');
  if (result.zero_exit_files.length > 0) {
    console.log('  出口率为 0 的文件：');
    for (const z of result.zero_exit_files) console.log(`    ${z}`);
    console.log('');
  }
  if (violations.length > 0) {
    console.log(`  ✗ ${violations.length} 项违规：`);
    for (const v of violations) console.log(`    [${v.rule}] ${v.file}:${v.line}\n      ${v.msg}`);
    console.log('');
  }
  if (ARG.gate) {
    if (gated.length > 0) {
      console.log(`  ✗ 本轮新增/修改的规则句中有 ${gated.length} 条没有机器出口：`);
      for (const g of gated) console.log(`    [${g.rule}] ${g.file}:${g.line}\n      ${g.text}`);
      console.log('');
    } else {
      console.log('  ✓ 本轮新增/修改的规则句全部有机器出口或 DISCRETIONARY\n');
    }
  }
  if (!ARG.gate && violations.length === 0) {
    console.log('  这是仪表，不是闸门：存量无出口的规则句不判 FAIL。');
    console.log('  要拦新增，用 --gate --since <ref>。\n');
  }
}

const bad = violations.length > 0 || gated.length > 0 || regression;
process.exit(bad ? 1 : 0);
