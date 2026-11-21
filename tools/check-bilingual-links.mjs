#!/usr/bin/env node
/**
 * check-bilingual-links.mjs — 中英双语文档的互链是否真的双向可达
 *
 * ── 为什么需要（D:\Projects\docs\PROJECT-RULES.md 规则 6）────────────────
 *
 * 规则原文：
 *
 *   **首行必须是语言互链**：
 *       [English](README-EN.md) | 简体中文
 *   **缺一边就会出现「点进去回不来」的单向链接。有 CI 的项目应加一条检查。**
 *
 * 这个仓库有 CI，但此前没有这条检查。人工看着"每份都有互链"是不够的——
 * 真正会坏的是这两种：
 *
 *   1. **链接目标不存在**：文件改名了（`README-EN.md` → `README.en.md`），
 *      链接没跟着改。打开就是 404。
 *   2. **单向链接**：A 指向 B，B 里没有指回 A 的。点进去回不来。
 *
 * 两者都不是"写得不好看"，是**读者实际走不通**。所以必须机械验证。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *
 *   对每一份参与双语的文档：
 *     L1  首行（跳过空行）必须是语言互链形态
 *     L2  链接的相对路径必须解析到一个**真实存在的文件**
 *     L3  对端文件的首行必须指回来（双向）
 *     L4  若规则 6 的命名约定与仓库实际不一致，报出来让人决定（见下）
 *
 * ── 关于 L4：一个需要人决定的分歧 ─────────────────────────────────────
 *
 * PROJECT-RULES.md 规则 6 的表格写的是 `README.md` / `README-EN.md`（连字符 + 大写），
 * 而本仓库实际用的是 `README.en.md`（点 + 小写）。
 *
 * 后者是 GitHub 官方的本地化 README 约定（`README.<ISO 639-1>.md`）——
 * 用官方命名的好处是 GitHub 会自动在仓库页显示语言切换。
 *
 * 规则第 6 行写着「各项目可有自己的补充规则…但不得与本文件冲突」，
 * 所以这是一个**真实的分歧**，不该由我单方面改掉。
 * L4 只报告、不判失败，把选择权留给维护者。
 *
 * 用法：node check-bilingual-links.mjs [--json] [--strict]
 * 退出码：0 通过 / 1 有 FAIL / 2 配置错误（一份双语文件都找不到 = 分母为 0）
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const jsonOut = process.argv.includes('--json');
const strict = process.argv.includes('--strict');

// ── 参与双语的文档（显式列举，不扫描推断）──
//
// 为什么不扫描：一份文档「该不该有英文版」是人的决定，不是文件名能推的。
// `CAPABILITIES.md`、`START-HERE.md` 目前只有中文，那是选择，不是缺失。
// 把它们也判成"缺英文"只会制造噪声，然后这条检查会被关掉。
const PAIRS = [
  { zh: 'README.md', en: 'README.en.md' },
  { zh: 'docs/i18n/CONTRIBUTING.zh-CN.md', en: 'CONTRIBUTING.md' },
  { zh: 'docs/i18n/SECURITY.zh-CN.md', en: 'SECURITY.md' },
  { zh: 'docs/i18n/CODE_OF_CONDUCT.zh-CN.md', en: 'CODE_OF_CONDUCT.md' },
];

// 首行形态：`[文本](路径) | 文本`
const LINK_LINE = /^\s*\[[^\]]+\]\(([^)]+)\)\s*\|/;

const problems = [];
const warnings = [];
const checked = [];

/** 取首行语言互链里的链接目标 */
function firstLinkLine(rel) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return { error: 'file_missing' };
  const lines = readFileSync(abs, 'utf8').split('\n');
  for (const raw of lines) {
    const l = raw.replace(/^\uFEFF/, '');      // BOM
    if (l.trim() === '') continue;             // 跳过空行
    const m = l.match(LINK_LINE);
    return m ? { target: m[1], line: l.trim() } : { error: 'no_link_line', line: l.trim().slice(0, 80) };
  }
  return { error: 'empty_file' };
}

for (const pair of PAIRS) {
  let pairOk = true;
  for (const [side, rel] of [['zh', pair.zh], ['en', pair.en]]) {
    const other = side === 'zh' ? pair.en : pair.zh;
    const res = firstLinkLine(rel);

    if (res.error === 'file_missing') {
      problems.push({ id: 'L0', file: rel, msg: `${rel} 不存在（它在双语配对表里）` });
      pairOk = false;
      continue;
    }
    if (res.error === 'no_link_line') {
      problems.push({
        id: 'L1', file: rel,
        msg: `${rel} 首行不是语言互链形态（应以 \`[English](...) | 简体中文\` 开头）`
          + `，实际首行: ${res.line}`,
      });
      pairOk = false;
      continue;
    }

    // L2：链接目标必须真实存在
    const targetAbs = resolve(dirname(join(ROOT, rel)), res.target);
    if (!existsSync(targetAbs) || !statSync(targetAbs).isFile()) {
      problems.push({
        id: 'L2', file: rel,
        msg: `${rel} 的互链指向 ${res.target}，但该文件不存在`
          + '——**点进去就是 404**。改名后忘记同步链接？',
      });
      pairOk = false;
      continue;
    }

    // L3：对端必须指回来
    const back = firstLinkLine(other);
    if (back.error) {
      problems.push({ id: 'L3', file: other, msg: `${other} 缺少语言互链（对端 ${rel} 指向了它）` });
      pairOk = false;
      continue;
    }
    const backAbs = resolve(dirname(join(ROOT, other)), back.target);
    const backRel = relative(ROOT, backAbs).replace(/\\/g, '/');

    if (backRel !== rel.replace(/\\/g, '/')) {
      problems.push({
        id: 'L3', file: other,
        msg: `${other} 的首行指向 ${back.target}（→ ${backRel}），`
          + `但没有指回 ${rel}——**单向链接，点进去回不来**`,
      });
      pairOk = false;
    }
  }
  // 一对只记一次，不按文件重复计
  if (pairOk) checked.push(pair);
}

// ── L4：规则 6 命名约定 vs 仓库实际（只报告）──
const RULE_NAMES = { 'README.md': 'README-EN.md', 'CONTRIBUTING.md': 'CONTRIBUTING-EN.md', 'SECURITY.md': 'SECURITY-EN.md' };
const ACTUAL_NAMES = { 'README.md': 'README.en.md' };
for (const [base, expected] of Object.entries(RULE_NAMES)) {
  const actual = ACTUAL_NAMES[base] ?? (existsSync(join(ROOT, expected)) ? expected : null);
  if (actual && actual !== expected) {
    warnings.push({
      id: 'L4', file: base,
      msg: `PROJECT-RULES.md 规则 6 的表格写的是 \`${expected}\`，本仓库用的是 \`${actual}\`。`
        + '后者是 GitHub 官方本地化命名（README.<ISO 639-1>.md，会自动显示语言切换）。'
        + '这是规则与项目的分歧，需维护者决定：改文件还是改规则',
    });
  }
}

// ── 分母为 0 不等于通过 ──
if (checked.length === 0 && problems.length === 0) {
  console.error('[预期失败] 一对合规的双语文件都没有——配对表可能写错了，或路径变了');
  process.exit(2);
}

const ok = problems.length === 0 && (!strict || warnings.length === 0);

if (jsonOut) {
  console.log(JSON.stringify({ ok, checked: checked.length, pairs: PAIRS.length, problems, warnings }, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log('\n中英双语互链检查（PROJECT-RULES.md 规则 6）\n');
console.log(`  配对      ${PAIRS.length} 对 / ${PAIRS.length * 2} 份文件`);
console.log(`  完整互通  ${checked.length} 对`);
console.log('');

if (problems.length === 0) {
  console.log('  ✓ 所有双语文件首行互链均双向可达');
} else {
  console.log(`  ✗ ${problems.length} 处问题：`);
  for (const p of problems) console.log(`    [${p.id}] ${p.msg}`);
}
if (warnings.length > 0) {
  console.log(`\n  ! ${warnings.length} 条需人决定（不影响判定）：`);
  for (const w of warnings) console.log(`    [${w.id}] ${w.msg}`);
}
console.log('');
process.exit(ok ? 0 : 1);
