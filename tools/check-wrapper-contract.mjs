#!/usr/bin/env node
/**
 * check-wrapper-contract.mjs — 静态检查每个 wrapper 是否覆盖了它所属角色的必填字段
 *
 * 为什么需要：
 *   校验器（check-payload.mjs）按 role 要求一组必填字段。但「角色 → 哪个 wrapper」
 *   这层映射此前只存在于人脑里。如果一个 wrapper 从头到尾没提过某个必填字段，
 *   那么**加载它的 agent 根本不可能产出合规产物**——不是它不听话，是它不知道有这一项。
 *
 *   这件事不需要跑 LLM 就能查：wrapper 是纯文本，必填字段是确定的字符串。
 *   而跑 LLM 的成本高、结果随机，还会被上游可用性卡住。
 *
 * 判定分三档，因为「提到」有强弱之分：
 *   - 字段名出现（弱）：可能只是顺带一提
 *   - 字段名 + 冒号/引导词（中）：像是被当作要填的项
 *   - 在「产物格式」小节内出现（强）：确实写进了交付要求
 *
 * 用法：
 *   node check-wrapper-contract.mjs [--json] [--strict]
 *
 * 退出码：0 = 全部角色都有强覆盖  1 = 有角色只达到中/弱覆盖或缺失  2 = 用法错误
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WRAPPERS = join(ROOT, 'framework', 'wrappers');
const VALIDATOR = join(HERE, 'check-payload.mjs');

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const strict = args.includes('--strict');

// ── 角色 → wrapper 文件（映射本身也要能被检查，所以写成显式表） ──
const ROLE_WRAPPER = {
  recon: 'recon-scout.md',
  sweep: 'sweep-scout.md',
  audit: 'audit-specialist.md',
  critique: 'critique-panel.md',
  fix: 'fix-worker.md',
  verify: 'verifier.md',
  planner: 'planner.md',
};

// ── 从校验器里抽出 ROLE_REQUIRED，避免两处各写一份而漂移 ──
function loadRoleRequired() {
  const src = readFileSync(VALIDATOR, 'utf8');
  const block = src.match(/const ROLE_REQUIRED\s*=\s*\{([\s\S]*?)\n\};/);
  if (!block) {
    console.error('无法从 check-payload.mjs 解析出 ROLE_REQUIRED —— 校验器结构变了，先修这里');
    process.exit(2);
  }
  const out = {};
  for (const m of block[1].matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)) {
    out[m[1]] = m[2].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
  }
  return out;
}

/**
 * 2026-11-20 补：条件必填字段。
 *
 * `ROLE_REQUIRED` 只装**无条件**必填的键，所以它看不到另一种必填：
 * 由另一个字段的取值决定「这个字段此刻必不必填」。
 *
 * 最典型的是 `fix.disposition`——`check-payload.mjs:219` 报 `missing_disposition`，
 * 意思是**任何 fix 产物缺它都违规**（因为 `disposition` 本身没有默认值）。
 * 但它不在 `ROLE_REQUIRED.fix` 里（那里只有 `files_touched`），于是 wrapper 覆盖检查
 * 只核对 `files_touched`，报「强覆盖 1/1、全部通过」——**而 `fix-worker.md` 当时
 * 明确说「payload 只包含四个字段」，把 `disposition` 排除在外。**
 *
 * 两张表对不上，检查就是绿的。这个映射必须手写并注明出处，不能从 ROLE_REQUIRED 推。
 */
const ROLE_CONDITIONAL = {
  // 出处：check-payload.mjs:219 `missing_disposition`
  // 语义：「每条发现必须表态」，四值闭集，没有默认值 → 对 fix 恒必填
  fix: ['disposition'],
  // 出处：check-payload.mjs:1020 `missing_self_check`（audit 恒需三项）
  // 已在 ROLE_REQUIRED 里，此处仅作示例保留位置
  audit: [],
};

/**
 * 把 wrapper 拆成「产物规格区」和「其余部分」。
 *
 * 实测发现：所有 wrapper 的统一结构是
 *   §4「产物格式（硬要求）」——只声明「必须写一个 JSON 信封」并给出自检命令
 *   §5「返回要求」——给出信封的**完整字段模板**
 *
 * 所以字段定义本来就在 §5，只切 §4 会把所有 wrapper 都误判成「没写字段」。
 * 产物规格区 = §4 + §5（小节在下一个同级或更高级标题处结束，因为产物区里
 * 常带 `###` 子标题，按「遇标题即停」会漏掉后面真正列字段的内容）。
 */
function splitSections(text) {
  const lines = text.split('\n');
  const isSpecHeader = (l) =>
    /^#{1,4}\s*.*(产物格式|产物|交付格式|输出格式|产出格式|返回要求)/.test(l);
  const headerLevel = (l) => {
    const m = l.match(/^(#{1,6})\s/);
    return m ? m[1].length : 0;
  };

  const chunks = [];
  let collecting = false;
  let startLevel = 0;
  let buf = [];

  for (const line of lines) {
    const lvl = headerLevel(line);
    if (lvl > 0) {
      if (collecting && lvl <= startLevel) {
        chunks.push(buf.join('\n'));
        buf = [];
        collecting = false;
      }
      if (!collecting && isSpecHeader(line)) {
        collecting = true;
        startLevel = lvl;
        continue;
      }
    }
    if (collecting) buf.push(line);
  }
  if (collecting) chunks.push(buf.join('\n'));

  const productText = chunks.join('\n');
  return { productText, allText: text };
}

function coverageOf(field, { productText, allText }) {
  const esc = field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const inProduct = new RegExp(`\\b${esc}\\b`).test(productText);
  // 「被当作要填的项」：字段后面跟冒号，或者在表格/列表里和反引号一起出现
  const asField = new RegExp(`\\b${esc}\\b\\s*[：:]`).test(allText)
    || new RegExp('`' + esc + '`').test(allText);
  const mentioned = new RegExp(`\\b${esc}\\b`).test(allText);

  if (inProduct) return 'strong';
  if (asField) return 'medium';
  if (mentioned) return 'weak';
  return 'missing';
}

/**
 * 剥掉「修正说明」块——引用块里以 **YYYY-MM-DD 修正** 开头的段落。
 *
 * 为什么必须剥：勘误注释会逐字引用被推翻的旧原文。检查器若读全文，
 * 就会把引文当成现行规则，于是**修好之后仍然报错**。
 * 这不是理论问题——本文件第一版就是这样，改完 wrapper 再跑还是红的。
 *
 * 只剥「日期 + 修正/更正/勘误」开头的引用块，不碰正文里的普通引用，
 * 避免把真正的规则说明也一起删掉。
 */
function stripCorrectionNotes(text) {
  const lines = text.split('\n');
  const out = [];
  let inNote = false;
  for (const l of lines) {
    const isNoteStart = /^\s*>\s*\*\*\d{4}-\d{2}-\d{2}\s*(修正|更正|勘误|补正)/.test(l);
    if (isNoteStart) { inNote = true; continue; }
    if (inNote) {
      // 引用块结束：遇到非 `>` 开头的行
      if (/^\s*>/.test(l)) continue;
      inNote = false;
    }
    out.push(l);
  }
  return out.join('\n');
}

const roleRequired = loadRoleRequired();
// 条件必填字段并进同一张表：排他性断言检查的是「wrapper 说的字段集」，
// 而那个集合应当包含**所有会被校验器判违规的字段**，不论无条件还是条件必填。
for (const [role, extra] of Object.entries(ROLE_CONDITIONAL)) {
  if (!roleRequired[role]) continue;
  for (const f of extra) if (!roleRequired[role].includes(f)) roleRequired[role].push(f);
}
const results = [];
const problems = [];

for (const [role, fields] of Object.entries(roleRequired)) {
  const file = ROLE_WRAPPER[role];
  if (!file) {
    problems.push({ role, kind: 'no_wrapper_mapping', detail: `角色 ${role} 在校验器里有要求，但没有对应 wrapper` });
    continue;
  }
  const path = join(WRAPPERS, file);
  if (!existsSync(path)) {
    problems.push({ role, kind: 'wrapper_missing', detail: `找不到 ${file}` });
    continue;
  }

  const text = readFileSync(path, 'utf8');
  const sections = splitSections(text);
  const perField = fields.map((f) => ({ field: f, level: coverageOf(f, sections) }));

  results.push({ role, file, hasProductSection: sections.productText.trim() !== '', fields: perField });

  if (!sections.productText.trim()) {
    problems.push({
      role, file, kind: 'no_product_section',
      detail: '找不到「产物格式」类小节——agent 无法知道该写什么结构',
    });
  }

  for (const { field, level } of perField) {
    if (level === 'strong') continue;
    if (level === 'medium' && !strict) continue;
    problems.push({
      role, file, field, kind: 'field_coverage_' + level,
      detail: level === 'missing'
        ? `必填字段 ${field} 在 wrapper 里完全没有出现`
        : level === 'weak'
          ? `必填字段 ${field} 只被顺带一提，没有被写成要填的项`
          : `必填字段 ${field} 提到了，但没写进「产物格式」小节`,
    });
  }

  // ── 2026-11-20 补：排他性表述 ──
  //
  // 上面那些判据只查「字段有没有出现」。它抓不到另一种更狠的形态：
  // wrapper 明确说「payload **只包含** N 个字段」，而这 N 个少于契约要求的。
  //
  // 实测两例（都是照它写就必被校验器打回，而 wrapper 又要求「写完自检、非 0 不返回」）：
  //   wrappers/fix-worker.md:76    「payload 只包含四个字段：files_touched / verification_commands /
  //                                  affected_issues / residual_risks」
  //                                 → 契约要 10 个，缺 disposition 即 CONTRACT_VIOLATION
  //   wrappers/audit-specialist.md 「即使一条都没找到，也要写 "findings": []」
  //                                 → 契约说空数组一律 CONTRACT_VIOLATION
  //
  // 判据刻意保守（只报「只包含 / 只有 / 仅包含」这类闭集断言）：
  // 宁可漏报，也不要对正常的「必填字段如下」句式误报。
  //
  // ★ 必须先剥掉「修正说明」块：本节自己的勘误注释里会**引用**旧原文
  //   （「此前写的是『只包含四个字段…』」），不剥的话检查器会把引文当规则，
  //   于是修好之后仍然报错——这正是本工具第一版踩的坑（修完还是红的）。
  const live = stripCorrectionNotes(text);
  const EXCLUSIVE = /(?:只包含|只有|仅包含|仅限于|只允许包含)\s*([^\n]{0,200})/g;
  for (const m of live.matchAll(EXCLUSIVE)) {
    const tail = m[1];
    // 该句里点名了哪些契约字段
    const named = fields.filter((f) => tail.includes(f));
    if (named.length === 0) continue;              // 不是在讲 payload 字段
    const omitted = fields.filter((f) => !tail.includes(f));
    if (omitted.length === 0) continue;            // 点全了，没问题
    problems.push({
      role, file, kind: 'exclusive_field_claim',
      field: omitted.join(','),
      detail: `wrapper 声称「${m[0].trim().slice(0, 60)}…」，只点名了 ${named.length}/${fields.length} 个必填字段，`
        + `漏掉 ${omitted.join('、')}。**照这句话写产物必被判违规**，而 wrapper 又要求写完自检——Agent 无法自救`,
    });
  }

  // ── 2026-11-20 补：与契约直接相反的表述 ──
  //
  // 「即使一条都没找到，也要写 "findings": []」——契约 §2.2 明文说空数组一律
  // CONTRACT_VIOLATION，正确写法是写一条 status=NO_EVIDENCE_FOUND 的条目。
  // 这类「wrapper 说的和契约正好相反」的形态，字段覆盖检查永远看不出来。
  if (role === 'audit') {
    // 「空数组是合法的结论」这句话本身，在现行契约下就是错的。
    // 不用复杂的同行正则：只要 wrapper 里出现「findings: []」且同时把空数组
    // 说成合法结论，就足以判反向。两个条件分别匹配，避免被反引号/加粗打断。
    // 同样必须先剥勘误注释——那里的引文不是现行规则。
    const claimsEmptyOk = /空数组是一个结论|空数组也是(?:一个)?结论|空数组(?:是)?合法的?结论/.test(live);
    const showsEmptyFindings = /findings["'\s:：]*\[\]/.test(live);
    if (claimsEmptyOk && showsEmptyFindings) {
      problems.push({
        role, file, kind: 'contradicts_contract',
        field: 'findings',
        detail: 'wrapper 说「findings: [] 是一个结论」，而契约 §2.2 明文规定空数组一律 CONTRACT_VIOLATION，'
          + '正确写法是写一条 status=NO_EVIDENCE_FOUND 的条目（并填 payload.searched_scope）。**照 wrapper 写会被打回**',
      });
    }
  }
}

if (jsonOut) {
  console.log(JSON.stringify({ results, problems }, null, 2));
  process.exit(problems.length === 0 ? 0 : 1);
}

console.log('\n=== wrapper 对契约必填字段的覆盖 ===\n');
for (const r of results) {
  const strong = r.fields.filter((f) => f.level === 'strong').length;
  console.log(`${r.role.padEnd(10)} ${r.file.padEnd(22)} 强覆盖 ${strong}/${r.fields.length}` +
    (r.hasProductSection ? '' : '  ⚠ 无产物格式小节'));
  for (const f of r.fields) {
    if (f.level !== 'strong') {
      const tag = { medium: '中', weak: '弱', missing: '缺' }[f.level];
      console.log(`    ${tag}  ${f.field}`);
    }
  }
}

console.log('');
// 「中」在非 strict 下不算失败，但它**不是强覆盖**。
// 汇总语必须如实反映这一点：说「全部强覆盖」而同时打印出「中 xxx」是自相矛盾，
// 会让人以为没问题——2026-11-13 实测时正是这个矛盾让 case 3 的失败被掩盖。
const mediums = results.flatMap((r) =>
  r.fields.filter((f) => f.level === 'medium').map((f) => ({ role: r.role, field: f.field })));
const weaks = results.flatMap((r) =>
  r.fields.filter((f) => f.level === 'weak').map((f) => ({ role: r.role, field: f.field })));

if (problems.length === 0) {
  if (mediums.length > 0 || weaks.length > 0) {
    console.log(`全部 ${results.length} 个角色：没有字段缺失，但有 ${mediums.length + weaks.length} 项未达强覆盖：`);
    for (const m of mediums) console.log(`  中  ${m.role}.${m.field}（提到了，但没写进产物规格区）`);
    for (const w of weaks) console.log(`  弱  ${w.role}.${w.field}（只被顺带一提）`);
    console.log('\n非 strict 模式不判失败；加 --strict 可把它们当问题处理。');
  } else {
    console.log(`全部 ${results.length} 个角色：必填字段均在「产物格式」小节内写成强覆盖。`);
  }
  process.exit(0);
}

console.log(`发现 ${problems.length} 个覆盖问题（--strict 下「中」也算问题）：`);
for (const p of problems) console.log(`  [${p.kind}] ${p.role}: ${p.detail}`);
process.exit(1);
