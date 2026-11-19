#!/usr/bin/env node
/**
 * check-rule-doc-link.mjs — 校验器的每条规则，契约里有没有对应段落
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────
 *   这个框架反复出同一个 bug：**校验器比契约严**。
 *   `output-contract/audit.md:180` 记过原话：
 *
 *     > 在这张表存在之前，`check-payload.mjs` 已经在执行 `missing_finding_status` 等规则，
 *     > 而契约里**没有任何一句**要求这些字段——校验器比契约严。
 *     > 结果是子 Agent 照契约写会被判违规，且修法提示指向一段不存在的规范。
 *
 *   反向也成立：契约写了规则，没有校验器（`handoff-schema` / `round-detection`
 *   都是这个形态，各补了一个校验器才解决）。
 *
 *   本工具查的是**第一个方向**：有规则实现，但执行者撞上它时，
 *   能不能在契约里找到「我为什么被判违规」。
 *
 * ── 判据（关键：不能只看规则名）──────────────────────────────────────
 *   2026-11-19 实测踩到的坑：最初只搜「规则名是否出现在文档里」，
 *   得出「71 条规则从没被文档提过」的结论。打开看，其中 48 条的**语义写在契约里**，
 *   只是没写那个 snake_case 标识符。
 *
 *   所以判据必须是**内容级**的：规则名 OR 它的错误信息里点到的字段名
 *   出现在文档中，就算「契约有对应段落」。
 *   只用名字判断会大量误报，而误报会让人直接关掉这道检查。
 *
 * ── 检查项 ──────────────────────────────────────────────────────────
 *   D1 规则在文档里有落点（规则名出现，或 msg 里的字段名出现）
 *   D2 规则名出现但 msg 里没有任何 `.md` 引用（弱提示，WARN）
 *
 * 用法：node check-rule-doc-link.mjs [--json]
 * 退出码：0 = 全部有落点（可能有 WARN）／1 = 有 D1 违规／2 = 配置错误
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FW = join(ROOT, 'framework');
const jsonOut = process.argv.includes('--json');

if (!existsSync(FW)) {
  console.error(`找不到 framework 目录: ${FW}`);
  process.exit(2);
}

// ── 读全部契约文档 ──
let docText = '';
let docFiles = 0;
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'examples') walk(p); }
    else if (e.name.endsWith('.md')) { docText += readFileSync(p, 'utf8'); docFiles++; }
  }
};
walk(FW);

if (docFiles === 0) {
  console.error('[预期失败] framework 下一个 .md 都没有——分母为 0 不等于通过');
  process.exit(2);
}

// ── 从校验器里抽「规则名 + 它的错误信息窗口」──
const rules = new Map();      // rule -> { file, window }
for (const f of readdirSync(HERE)) {
  if (!f.endsWith('.mjs') || f.endsWith('.test.mjs')) continue;
  const src = readFileSync(join(HERE, f), 'utf8');

  // ★ 必须先剥掉注释，否则会把文档注释里举的例子（`rule: 'xxx'`）
  // 当成真实规则。2026-11-19 自测第一跑就踩到：本工具自己的文件头写了两处示例，
  // 结果它把自己报成「有 1 条规则找不到落点」。
  //
  // 剥离必须保守：**只剥行首的 // 与整段 /** */ **，不能用 /(^|[^:])\/\/.*$/gm
  // 那种正则——它会把字符串字面量里的 `//` 也吃掉，进而破坏 fixture 代码。
  // （自测第二跑就踩到这个：测试 fixture 是以字符串形式写进 .test.mjs 的，
  //  过度剥离后里面的 rule: 全被删掉，4 个用例连锁失败。）
  const code = src
    .replace(/^[\t ]*\/\*[\s\S]*?\*\/[\t ]*$/gm, '')   // 独占整行的块注释
    .replace(/^[\t ]*\/\/.*$/gm, '');                  // 独占整行的行注释

  for (const m of code.matchAll(/rule:\s*['"]([a-z0-9_]+)['"]/g)) {
    const name = m[1];
    if (rules.has(name)) continue;
    // 取错误信息附近作为「这条规则在说什么」的窗口。
    //
    // ★ 必须往**前**也截一段：规则对象长这样
    //     { field: `payload.audit_slices[${i}].files`, rule: 'slice_overlap',
    //       msg: `…切片必须两两不相交（共享文件应进 shared_dependencies）` }
    //   关键字段名在 `field:` 里、在 `rule:` **之前**。只往后截会漏掉它，
    //   于是 `slice_overlap` 被判成「契约里找不到落点」——而契约明明写了这句话。
    //   2026-11-19 实测：不往前截时 16 条误报，往前截后降到个位数。
    const start = Math.max(0, m.index - 300);
    rules.set(name, { file: f, window: code.slice(start, m.index + 600) });
  }
}

if (rules.size === 0) {
  console.error('[预期失败] 一个 rule: 都没抽到——校验器结构可能变了');
  process.exit(2);
}

// ── 豁免：纯技术性错误不需要契约段落 ──
//
// 有些规则查的是「这份产物本身是不是格式正确的 JSON / 枚举值在不在闭集里」，
// 它不表达任何业务约束，执行者看到也不需要去契约里找一段规范。
// 把它们也要求有落点，只会逼着契约里塞一堆「枚举值必须合法」这种废话。
//
// 2026-11-19：`invalid_enum_value` 就是因为这个原因被误判。
// 它的 msg 提到 `ENUM_CHECKS`（校验器内部的变量名），契约当然不会有。
const TECHNICAL = /^(invalid_enum_value|invalid_role|invalid_status|invalid_finding_status|invalid_self_check_status|invalid_verdict_enum|invalid_verify_verdict|invalid_sub_verdict|invalid_coverage_kind|invalid_failure_category|invalid_mutation_check|invalid_mutation_scope|invalid_mutation_skip_reason|invalid_input_space_basis|wrong_schema_version|json_parse_failed|json_trailing_comma_fixed|multiple_json_blocks|envelope_not_object|missing_top_field|null_top_field|missing_role_field|role_mismatch|artifact_path_wrong_type|artifact_outdir_placeholder|digest_not_sha256_hex)$/;

// ── 逐条判定 ──
const findings = [];
let okCount = 0;
for (const [name, info] of rules) {
  // D1：三种判据，命中任一就算有落点。
  //
  // 为什么需要三种：只用规则名会误报 48 条（语义写了、标识符没写）；
  // 加上英文字段名能降到 16 条；再加上中文短语才降到真实水平。
  // 中文契约里大量规则是用中文描述的（「不计入 files」「切片两两不相交」），
  // 只认 snake_case 标识符会系统性漏检。
  const nameInDoc = docText.includes(name);

  // 判据 2：msg 窗口里的英文字段名。
  //
  // ★ 不能要求它被引号包住。2026-11-19 自测踩到：`msg: \`shared_dependencies 字段不合法\``
  // 里的标识符是裸的（在反引号模板串内部，没有单独的引号），
  // 用 [\`'"]...[\`'"] 去匹配会全部漏掉，于是 case 2 / case 3 连锁失败。
  // 直接收裸的 snake_case 标识符即可——误收几个普通英文单词不要紧，
  // 因为下一步是拿它去文档里找，找不到才判违规，多试几个反而更准。
  const fields = [...info.window.matchAll(/\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi)]
    .map((m) => m[1])
    .filter((x) => x !== name);
  const fieldHit = fields.find((x) => docText.includes(x));

  // 判据 3：msg 窗口里的中文短语（≥4 个连续的汉字）
  const zhPhrases = [...info.window.matchAll(/[一-龥]{4,}/g)]
    .map((m) => m[0])
    .filter((p) => !/^(规则|错误|必须|不得|以下|这个|如果|那么|否则|因此|所以)/.test(p));
  const zhHit = zhPhrases.find((p) => docText.includes(p));

  // 技术性错误豁免（见上面 TECHNICAL 的说明）
  if (TECHNICAL.test(name)) { okCount++; continue; }

  if (!nameInDoc && !fieldHit && !zhHit) {
    findings.push({
      level: 'FAIL', rule: 'D1_no_contract_anchor', rule_name: name, file: info.file,
      msg: `规则 ${name} 在契约里找不到落点：规则名没出现，且它的错误信息里点到的字段名`
        + `（${fields.slice(0, 3).join(' / ') || '无'}）也没出现在任何 framework/*.md 里。`
        + '执行者撞上这条违规时，无法在契约里找到对应的规范段落。',
    });
    continue;
  }

  // D2：契约提到了，但 msg 里没指引到哪一份文档（弱提示）
  if (!/\.md/.test(info.window)) {
    findings.push({
      level: 'WARN', rule: 'D2_no_doc_pointer', rule_name: name, file: info.file,
      msg: `规则 ${name} 的错误信息里没有指向任何 .md（执行者知道违规了，但不知道该去读哪一节）。`
        + '不是错误——很多规则的 msg 已经足够自解释。',
    });
  }
  okCount++;
}

const fails = findings.filter((f) => f.level === 'FAIL');
const warns = findings.filter((f) => f.level === 'WARN');

const result = {
  ok: fails.length === 0,
  total_rules: rules.size,
  doc_files_scanned: docFiles,
  with_anchor: okCount,
  without_anchor: fails.length,
  warn_count: warns.length,
  findings,
};

if (jsonOut) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('\n规则 → 契约落点\n');
  console.log(`  扫描契约文档   ${docFiles} 份`);
  console.log(`  校验器规则     ${rules.size} 条`);
  console.log(`  有落点         ${okCount}`);
  console.log(`  无落点         ${fails.length}`);
  console.log('');
  if (fails.length) {
    console.log(`  ✗ ${fails.length} 条规则在契约里找不到落点：`);
    for (const f of fails) console.log(`    [${f.rule_name}] ${f.file}\n      ${f.msg.split('。')[0]}`);
    console.log('');
  }
  if (warns.length) {
    console.log(`  ⚠️  ${warns.length} 条有落点但没指路（可接受）：`);
    for (const w of warns.slice(0, 5)) console.log(`    ${w.rule_name}`);
    if (warns.length > 5) console.log(`    … 另有 ${warns.length - 5} 条`);
    console.log('');
  }
  if (!fails.length) console.log('  ✅ 每条规则都能在契约里找到落点\n');
}

process.exit(fails.length > 0 ? 1 : 0);
