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

const roleRequired = loadRoleRequired();
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
