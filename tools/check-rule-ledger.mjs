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
 *   node check-rule-ledger.mjs --dump-rows         # 附带逐条明细（分诊用）
 *   node check-rule-ledger.mjs --gate --since <ref>   # 只闸新增，需 git
 *   node check-rule-ledger.mjs --write-baseline      # 把当前读数存为退化基准
 *   node check-rule-ledger.mjs --fail-on-regress     # 有出口数比基准少就 FAIL
 *
 * 退出码：0 = 正常（含「存量无出口」）  1 = --gate/--fail-on-regress 触发  2 = 配置错误
 *
 * ── 关于 --fail-on-regress（2026-11-20 修）──────────────────────────
 *   原判据写的是 `noExit > totalSentences - totalWithExit`，而 noExit 的定义
 *   就是这个差值 —— **恒为 false，是一段死代码**，但文件头一直宣称它可用。
 *   现在改成读 `tools/fixtures/rule-ledger-baseline.json` 的持久化基准；
 *   没有基准时 exit 2，而不是当作「无退化」（那样这道检查等于不存在）。
 *   基准只在显式 `--write-baseline` 时更新——每跑一次就改写自己的基准等于没有基准。
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

import { readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, relative, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TOOLS = join(HERE);

const ARG = { json: false, gate: false, since: null, failOnRegress: false, quiet: false, dumpRows: false, writeBaseline: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--json') ARG.json = true;
  else if (a === '--gate') ARG.gate = true;
  else if (a === '--gate-new') { ARG.gate = true; }
  else if (a === '--fail-on-regress') ARG.failOnRegress = true;
  else if (a === '--write-baseline') ARG.writeBaseline = true;
  else if (a === '--quiet') ARG.quiet = true;
  // 2026-11-20 补：--json 只给聚合数字，下游拿不到「具体是哪一句没出口」，
  // 于是任何按文件并行分诊的作业都得自己重新实现一遍抽取逻辑 —— 两份实现必然漂移。
  // 这是本框架反复记过的形态（校验器与契约各写一套正则）。明细必须由同一个抽取器导出。
  else if (a === '--dump-rows') ARG.dumpRows = true;
  else if (a === '--since') ARG.since = process.argv[++i] ?? null;
  else if (a === '--help' || a === '-h') {
    console.log('用法: node check-rule-ledger.mjs [--json] [--dump-rows] [--gate] [--since <ref>]'
      + ' [--fail-on-regress] [--write-baseline]');
    process.exit(0);
  } else { console.error(`未知参数: ${a}`); process.exit(2); }
}
if (ARG.gate && !ARG.since) ARG.since = 'HEAD';

const RULE_RE = /(必须|不得|禁止|一律|\bmust\b|\bshall\b|\bnever\b)/;
const FENCE_RE = /^\s*(```|~~~)/;
const BLOCKQUOTE_PREFIX = /^\s*>\s?/;
// 匹配「文件名.扩展名」形式的引用。`.md` 也要匹配——点名框架内的产物规范文件
// （如 `report-naming.md`）同样是一种机器出口，见 collectToolSurface 的说明。
const SCRIPT_RE = /([A-Za-z0-9._-]+\.(?:mjs|md))/g;
const SNAKE_RE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/g;
const DISCRETIONARY_RE = /DISCRETIONARY/;
const WINDOW = 3;

// 2026-11-22 补：裸工具名（不带 `.mjs`）也算出口。
//
// 实测：`protocol.md:967-968` 的闸门表写的是
//
//   | `--gate accept` | ... | 契约合规（`check-payload`）、门 0 回显（`verify-artifacts`） | ... |
//
// 两个工具都被点名了，但都没带 `.mjs`，于是 SCRIPT_RE 匹配不上，
// 整句被判「没有任何机器出口」。这不是孤例：`run-state.md:354` 的 `stop-hook` 同理。
//
// 方向是「有执行者却算成没执行者」——正是这个工具要避免的错。
// 判据要求**两侧都是边界**，避免 `check-payload-x` 之类的误命中。也要求
// 该名字确实是 tools/ 下真实存在的脚本（由调用方用 scripts 集合核对）。
//
// 注意：加这条时表面上多出 14 条出口，但其中大部分是**重复计数**——
// 同一句话在母文件和生成切片里各命中一次。重复计数已在
// collectDocs 里修掉（见 isGenerated）；本条只负责「认得出裸名」。

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
  // 2026-11-19 补：规则句点名**框架内的产物规范文件**也算一种出口。
  //
  // 实测踩到：`output-contract.md:95` 那句「`report-naming.md` 第 5 节要求…」
  // 被判成「没有任何机器出口」——但它明确指向一个真实存在、且被 Artifact 校验器
  // 使用（`check-deliverables.mjs` 会核对命名是否符合 report-naming 的约定）的文件。
  //
  // 只认 `tools/*.mjs` 会让所有「这一步由某个规范文件约束」的规则句全部落空，
  // 那类规则占了框架里相当一部分。出口不必须是可执行脚本，也可以是**被执行的规范**。
  const artifacts = new Set();
  const fwRoot = join(ROOT, 'framework');
  const walkMd = (dir) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walkMd(p); }
      else if (e.name.endsWith('.md')) artifacts.add(e.name);
    }
  };
  walkMd(fwRoot);

  // 2026-11-20：哪些 .md 真的被某个校验器读过。
  // 只扫**非测试**脚本——测试里出现某文件名只说明有 fixture 覆盖它，
  // 不说明有执行者在运行时读它并因它报错。
  const artifactReadByTool = new Set();
  const toolSources = [];

  // 2026-11-22 修：原先用**裸子串** `src.includes(a)` 判定「这份 .md 被读过」，
  // 于是短文件名会被长文件名蹭成已读：
  //
  //   `audit.md`    是 `wave2-audit.md` 的子串
  //   `critique.md` 是 `wave3-critique.md` 的子串
  //   `fix.md` / `recon.md` / `sweep.md` / `verify.md` 同理
  //
  // 实测：工具源码里出现 `wave4-fix.md` 就算作「读过 fix.md」——
  // 而**没有任何工具真的读过 `fix.md`**。`fix.md` / `recon.md` / `sweep.md`
  // 三个切片的「真读」工具数是 **0**，却全部被算成活规范。
  //
  // 后果不是统计噪声，是**8 条规则句虚增出口**（`fix-worker.md` 两条、
  // `recon-scout.md` 两条、`sweep-scout.md` 四条），出口率被抬高。
  // 这个工具存在的理由就是「不许把假出口算成真出口」，它自己不能犯这个错。
  //
  // 判据改成**文件名边界匹配**：前一个字符不能是 `[A-Za-z0-9_.-]`，
  // 后一个字符不能是 `[A-Za-z0-9_]`。这样 `wave4-fix.md` 里的 `fix.md`
  // 前面是 `-`，不算命中；而单独出现的 `fix.md` 仍然命中。
  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ARTIFACT_READERS = new Map(
    [...artifacts].map((a) => [a, new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRe(a)}(?![A-Za-z0-9_])`, 'm')]),
  );

  for (const f of readdirSync(TOOLS)) {
    if (!f.endsWith('.mjs') || f.includes('.test.') || f === 'check-rule-ledger.mjs') continue;
    const src = readFileSync(join(TOOLS, f), 'utf8');
    toolSources.push(src);
    for (const a of artifacts) if (ARTIFACT_READERS.get(a).test(src)) artifactReadByTool.add(a);
  }

  // ── 试过但**放弃**的一类判据：靠内容推断「实现关系」──
  //
  // 动机是真实存在的假阴性：`report-naming.md:29` 规定命名正则
  //   ^round(\d+)-(01-recon|02-sweep|...)-[a-z0-9]+(-[a-z0-9]+)*\.md$
  // 而 `check-deliverables.mjs:241` 的 STAGE_RE 实现了同一件事。
  // 但工具源码里没有 `report-naming.md` 这个字符串，于是 15 条规则
  // 被算成「仅靠 artifact 出口」——**规则确实有执行者，只是识别不到**。
  //
  // 试了三版，全部失败：
  //
  //   版 1「大写词命中 ≥60%」：`evidence-policy.md` 被误判为已实现，
  //     命中的是 CONFIRMED / HIGH / CRITICAL ——全框架共享的枚举值。
  //   版 2「独有连字符词 ≥60%」：`report-naming.md` 救不回来（53%），
  //     未命中的是 recon-slices / audit-slice 这类**产物文件名示例**，
  //     它们本来就不该出现在工具源码里，算进分母是错的。
  //   版 3「正则逐字子串」：实测两边**不是逐字相同**——
  //     文档写 `round(\d+)`，工具写 `${roundId}`（模板插值）。
  //     同一条规则在两处用了不同的实现形式。
  //
  // 结论：**靠词频或字面量推断「实现关系」不可靠**。
  // 一份规范被实现，可以有无数种写法；静态匹配猜不准，猜错比不猜更糟
  // （把假出口算成真出口，正是这个工具存在的理由）。
  //
  // 所以这里**只认最保守的信号：工具源码里出现该文件名**。
  // 剩下的假阴性如实留在这里——想让它变成真出口，正确做法是
  // 让工具在注释里写明「本节实现自 report-naming.md §1」，
  // 即**让人去接线**，而不是让脚本去猜。

  return { scripts, ruleNames, artifacts, artifactReadByTool };
}

// ── 枚举框架文档 ──
//
// 2026-11-22 修：**排除自动生成的产物**，否则同一条规则句会被重复计数。
//
// 实测：`framework/components/output-contract.md`（母文件）与它的 7 份角色切片
// 共享整段正文。同一句「**机械判定规则**：主Agent在接收…」在 8 个文件里各出现一次，
// 于是它被当成 8 条规则句。全仓库 1121 条规则句里 **245 条（21.9%）是重复内容**，
// 其中 **78 条被重复计入了出口数**。
//
// 这不是小误差：它同时虚增了分母和分子，出口率因此失真——
// 而「出口率」这个数字正是 `CAPABILITIES.md` 用来劝退误用的核心指标。
//
// 判据不能靠文件名硬编码（`output-contract/*.md` 是生成物，但目录名将来会变），
// 要靠生成器自己写在文件头的标记：`自动生成，请勿手改`。
function isGenerated(text) {
  return /自动生成[，,]?\s*请勿手改/.test(text.slice(0, 400));
}

function collectDocs() {
  const out = [];
  const skip = [];
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
      } else if (e.endsWith('.md')) {
        let txt = '';
        try { txt = readFileSync(p, 'utf8'); } catch { /* 读不到就当非生成物 */ }
        if (txt && isGenerated(txt)) { skip.push(p); continue; }
        out.push(p);
      }
    }
  };
  walk(join(ROOT, 'framework'));
  return { docs: out, skipped: skip };
}

const { scripts, ruleNames, artifacts, artifactReadByTool } = collectToolSurface();
const { docs, skipped: generatedDocs } = collectDocs();

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
      if (scripts.has(m[1])) { exits.push(`script:${m[1]}`); continue; }
      // 点名框架内的产物规范文件也算出口 —— 但要排除两种假出口：
      //   1. **自指**：本文件提到自己的名字（`wave2-audit.md` 里写「加载 wave2-audit.md」）
      //   2. **命令示例里的文件名**：`xargs grep foo.md` 不是在引用规范
      // 2026-11-19 实测：不排除的话出口率会从 33% 虚高，抽 6 条全是为了假出口。
      if (!artifacts.has(m[1])) continue;
      if (m[1] === basename(rel)) continue;                    // 自指
      // 2026-11-20 修：旧判据是 `/grep|xargs|find|cat |del |rm /i`，其中 `find` 没有词边界，
      // 会命中 **`finding_id` / `findings`** —— 而这两个词几乎出现在每一条 finding 相关规则
      // 附近，于是它们所指的 `.md` 出口被系统性否决。
      //
      // 实测：窗口里含 `.md` 文件名且被旧判据否决的有 51 条，换成下面这条只在
      // 「真的是命令上下文」时否决的判据后只剩 5 条 —— **46 条真出口被一个正则吃掉了**。
      // 这不是出口率的统计噪声，是"有检测器却算成没检测器"。
      if (/(^|[\s`|(])(grep|xargs|find|cat|del|rm)\s+[-./'"`A-Za-z]/i.test(window)) continue;  // 命令示例
      // 必须真的是「另一份规范在约束这件事」，而不是顺手提了一句文件名。
      // 判据：该文件名附近出现「按/依/见/遵循/符合/由…规定/参见」这类指引词。
      // 2026-11-19 实测：不加这条时，「两遍制能保证…」（正文提到 protocol.md）
      // 也会被算成有出口 —— 抽 5 条里有 1 条是这种假出口。
      const near = window.slice(
        Math.max(0, window.indexOf(m[1]) - 30),
        window.indexOf(m[1]) + m[1].length + 40,
      );
      if (!/(按|依|见|遵循|符合|规定|参见|参照|依据|要求)/.test(near)) continue;
      // 2026-11-20 补：二级判据 —— 所指的那份 `.md` 是否真的被某个校验器读取过。
      //
      // 起因：226 条「有出口」里 123 条的**唯一**出口是另一个 `.md` 的文件名。
      // 抽样核对，其中确实有真的（`planner.md` 说「score 必须等于七项之和」，
      // 由 check-payload 的 score_mismatch 执行），也确实有纯装饰的
      //（正文顺手提到 protocol.md）。判据本身分不开这两者。
      //
      // 分得开的机械办法只有一个：**那份规范有没有被 tools/ 里任何一个脚本读过**。
      // 没被读过 = 没有任何执行者会因它而报错 = 它不是出口。
      //
      // 实测：123 条里 115 条所指的 .md 确实被 tools/ 读取，只有 8 条是孤儿。
      // 所以这条判据很温和（只筛掉 6.5%），但它把「真假混在一起」变成了
      // 两类可分开的出口，报告里分别计数。
      const isReadByTool = artifactReadByTool.has(m[1]);
      exits.push(isReadByTool ? `artifact:${m[1]}` : `artifact_orphan:${m[1]}`);
    }
    // 裸工具名（不带 `.mjs`）：`check-payload` / `verify-artifacts` / `stop-hook` 等。
    // 只认 tools/ 下真实存在的脚本，且两侧必须是边界，避免 `check-payload-x` 误命中。
    // 已经带 `.mjs` 的会在上面被 SCRIPT_RE 抓到，这里用 Set 去重不影响计数。
    for (const s of scripts) {
      const bare = s.replace(/\.mjs$/, '');
      if (bare === s) continue;
      const re = new RegExp(`(^|[^A-Za-z0-9_.-])${bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_.-])`);
      if (re.test(window)) exits.push(`script:${s}`);
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
      // 2026-11-20：`artifact_orphan:` 不算出口 —— 它指的是一个**没有任何校验器读过**
      // 的 .md 文件，因此没有任何执行者会因这条规则而报错。
      // 保留该标记是为了在报告里区分「指向活规范」与「指向死文档」，
      // 但只有后者的话，这句话仍然是「没人执行的规则」。
      hasExit: exits.some((e) => e !== 'discretionary-noreason' && !e.startsWith('artifact_orphan:')),
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

  // 解析 diff，收集每个文件新增行的行号。
  //
  // ★ 2026-11-19 修正：原实现把 diff 里**所有** `+` 行都当成「新增规则句」。
  // 实测踩到：把「子Agent」批量改成「子 Agent」（纯空白调整）后，57 条规则被报成
  // 「新增规则句没有出口」——而它们的内容一个字都没变，只是行号移动了。
  //
  // 一个只会惩罚排版的闸门，第二天就会被人用 --no-verify 绕过。
  // 所以先做**内容规范化**再比对：删除行集合里已存在同样内容（忽略空白）时，
  // 这个 `+` 行不算新增，只是移动/重排版。
  const norm = (s) => String(s).replace(/\s+/g, '');
  const addedByFile = new Map();
  const removedByFile = new Map();
  let curFile = null, curLine = 0;
  for (const ln of diffOut.split('\n')) {
    const fm = ln.match(/^\+\+\+ b\/(.+)$/);
    if (fm) {
      curFile = fm[1];
      if (!addedByFile.has(curFile)) addedByFile.set(curFile, new Set());
      if (!removedByFile.has(curFile)) removedByFile.set(curFile, new Set());
      continue;
    }
    const hm = ln.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hm) { curLine = Number(hm[1]); continue; }
    if (!curFile) continue;
    if (ln.startsWith('+') && !ln.startsWith('+++')) {
      addedByFile.get(curFile).add(curLine);
      curLine++;
    } else if (ln.startsWith('-') && !ln.startsWith('---')) {
      // 记录被删行的内容（去掉前导 '-'），供下面的「是否为纯重排版」判定
      removedByFile.get(curFile)?.add(norm(ln.slice(1)));
    } else {
      curLine++;
    }
  }

  for (const f of files) {
    const added = addedByFile.get(f.path);
    if (!added || added.size === 0) continue;
    const removed = removedByFile.get(f.path) ?? new Set();
    for (const r of f.rows) {
      if (!added.has(r.line)) continue;
      // 纯重排版不算新增：内容（忽略空白）在删除集合里已有同样的一行。
      // 这一条让「批量改空格 / 调整缩进 / 换行移动」不会触发闸门，
      // 同时真正的规则新增仍然会被拦（新写的句子不可能出现在删除集合里）。
      if (removed.has(norm(r.text))) continue;
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
//
// 2026-11-20 修：此前的判据是
//   const regression = ARG.failOnRegress && noExit > totalSentences - totalWithExit;
// 而 noExit 的定义就是 `totalSentences - totalWithExit`，所以右侧**恒为 false**。
// `--fail-on-regress` 从写下那天起就是一段死代码，文件头却一直宣称它可用。
// 一个「仪表自己坏了而仪表盘显示正常」的典型。
//
// 正确实现需要**上一次的值**，而这个工具不持久化任何东西。做法：把上次的读数
// 存进 `tools/fixtures/rule-ledger-baseline.json`，只在**显式要求更新**时写。
// 默认不写——一个每跑一次就改写自己基准的检查，等于没有基准。
const BASELINE_PATH = join(HERE, 'fixtures', 'rule-ledger-baseline.json');

function readBaseline() {
  try { return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')); } catch { return null; }
}

let regression = false;
let regressionDetail = null;
if (ARG.failOnRegress) {
  const prev = readBaseline();
  if (!prev) {
    console.error('[预期失败] --fail-on-regress 需要一份已存的基准，但 ' + BASELINE_PATH + ' 不存在。');
    console.error('  先跑一次 `node check-rule-ledger.mjs --write-baseline` 建立基准。');
    console.error('  「没有基准」不能当成「没有退化」——那样这道检查等于不存在。');
    process.exit(2);
  }
  // 比的是**出口数**（绝对量），不是出口率：分母会随文档增删变化，
  // 用率去比会让「新写了一条有出口的规则」把整体率拉低而误报退化。
  //
  // 2026-11-23 修：只用绝对量不够。当天我把自动生成的 7 份切片排除出分母
  // （母文件与切片内容重复，同一句规则被算 8 次），分母从 1118 降到 909，
  // 出口绝对数随之从 243 掉到 201——**没有一条规则丢掉出口**，
  // 但闸门报了「退化」。这正是它最该避免的误报：一个会因为统计范围
  // 修正而变红的闸门，下次就会被人用 --no-verify 绕过。
  //
  // 改法：基准里存**逐文件的出口数**，比对时按文件归因。
  //   · 同一文件当前出口数下降 → 真退化，报出文件名与降幅
  //   · 文件整个消失 → 单独报，并区分「生成物被排除」与「文件被删」
  //   · 新增文件 → 不算退化（新写的规则有出口是好事）
  // 老基准没有 by_file 字段，退回绝对量比对并明确说明这是粗判据。
  const prevByFile = prev.by_file ?? null;
  if (prevByFile) {
    const curByFile = Object.fromEntries(files.map((f) => [f.path, f.withExit]));
    const lost = [];
    const dropped = [];      // 变成生成物被排除：统计范围变了，不是退化
    for (const [p, n] of Object.entries(prevByFile)) {
      if (n <= 0) continue;
      if (!(p in curByFile)) {
        const abs = join(ROOT, p);
        let isGen = false;
        try { isGen = isGenerated(readFileSync(abs, 'utf8')); } catch { /* 读不到就是真没了 */ }
        if (isGen) {
          // 母文件成了生成物 / 文件被标为生成物 → 从分母里移除是**修正**，不是退化。
          dropped.push(`${p}（基准 ${n} 条出口）`);
        } else {
          lost.push(`${p}（基准 ${n} 条出口，文件已不存在）`);
        }
      } else if (curByFile[p] < n) {
        lost.push(`${p}：${n} → ${curByFile[p]}`);
      }
    }
    if (lost.length > 0) {
      regression = true;
      regressionDetail = `${lost.length} 处出口数下降（基准 ${prev.baseline_date ?? '未知日期'}）：\n`
        + lost.map((x) => `      · ${x}`).join('\n')
        + '\n    同一文件出口数下降通常意味着某条规则句被改写后丢掉了它原本点名的出口。';
      if (dropped.length > 0) {
        regressionDetail += `\n    （另有 ${dropped.length} 份文件已标为自动生成物、移出分母，`
          + '那是统计口径修正，不算退化）';
      }
    }
  } else if (totalWithExit < prev.with_exit) {
    regression = true;
    regressionDetail = `有出口的规则句从 ${prev.with_exit} 降到 ${totalWithExit}`
      + `（${prev.baseline_date ?? '未知日期'} 的基准）。`
      + '这通常意味着某条规则句被改写后丢掉了它原本点名的出口。'
      + '\n    ⚠️ 这份基准没有逐文件明细（by_file），只能做粗判'
      + '——统计范围一变（例如排除生成物）就会误报。建议重新 --write-baseline。';
  }
}

if (ARG.writeBaseline) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify({
    baseline_date: new Date().toISOString().slice(0, 10),
    rule_sentences: totalSentences,
    with_exit: totalWithExit,
    without_exit: noExit,
    exit_rate_pct: Number(pct.toFixed(1)),
    // 逐文件明细：只有它能把「真退化」和「统计范围变了」分开。
    // 没有这个字段时，闸门只能比总数，任何分母变动都会误报。
    by_file: Object.fromEntries(files.map((f) => [f.path, f.withExit])),
  }, null, 2) + '\n');
  console.log(`\n已写入基准: ${BASELINE_PATH}`);
  console.log('  含逐文件明细（by_file），下次比对可精确归因到文件。');
}

// ── 输出 ──
const result = {
  rule_sentences: totalSentences,
  with_exit: totalWithExit,
  without_exit: noExit,
  exit_rate_pct: Number(pct.toFixed(1)),
  files_scanned: files.length,
  // 被排除的自动生成文档数。必须报出来——静默跳过等于隐瞒分母，
  // 而分母正是这个工具唯一有意义的部分。
  generated_files_skipped: generatedDocs.length,
  zero_exit_files: files.filter((f) => f.withExit === 0).map((f) => `${f.path} (0/${f.sentences})`),
  violations,
  gated,
  ok: violations.length === 0 && gated.length === 0 && !regression,
};

// 逐条明细：默认不输出（会让 --json 的体积涨 20 倍，CI 日志读不了）。
// 分诊作业需要它，所以显式开。
if (ARG.dumpRows) {
  result.rows = files.flatMap((f) => f.rows.map((r) => ({
    file: f.path,
    line: r.line,
    text: r.text,
    has_exit: r.hasExit,
    discretionary_no_reason: r.discretionaryNoReason,
    exits: r.exits,
  })));
}

if (ARG.json) {
  console.log(JSON.stringify(result, null, 2));
} else if (ARG.quiet) {
  // 2026-11-20：`--quiet` 此前只被解析、从未被使用——又一个「声明了但没接上」的参数。
  // 用途：check-all 每次跑它只需要一个结论行，不需要整份仪表盘。
  // 只打印「有没有问题」这一行；有违规/退化时仍然把关键信息吐出来（静默不能吃掉错误）。
  if (violations.length > 0) {
    console.log(`✗ ${violations.length} 项违规（discretionary 无理由）`);
  } else if (ARG.failOnRegress && regression) {
    console.log(`✗ 退化：${regressionDetail}`);
  } else if (ARG.failOnRegress) {
    console.log(`✓ 无退化（有出口 ${totalWithExit}）`);
  } else {
    console.log(`出口 ${totalWithExit}/${totalSentences}＝${pct.toFixed(1)}%`);
  }
} else {
  console.log('\n契约规则句 → 机器出口 对账\n');
  console.log(`  扫描文档        ${files.length} 个`);
  if (generatedDocs.length > 0) {
    console.log(`  另有生成物      ${generatedDocs.length} 个（自动生成，与母文件内容重复，不计入分母）`);
  }
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
  if (ARG.failOnRegress && regression) {
    console.log(`  ✗ 退化：${regressionDetail}`);
    console.log('');
  } else if (ARG.failOnRegress) {
    const prev = readBaseline();
    console.log(`  ✓ 无退化（基准 ${prev?.baseline_date ?? '?'}：有出口 ${prev?.with_exit}，现在 ${totalWithExit}）`);
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
