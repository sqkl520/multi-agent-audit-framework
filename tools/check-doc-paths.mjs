#!/usr/bin/env node
/**
 * check-doc-paths.mjs — 文档里引用的仓库内路径是否真实存在
 *
 * ── 为什么需要 ──────────────────────────────────────────────────────
 *
 * 这个仓库的"代码"大部分是 Markdown。文档里到处写着「见 `framework/wrappers/*.md`」
 * 「规则在 `tools/check-payload.mjs`」——**这些路径就是文档的实际内容**，
 * 断了等于文档说了一句不存在的话。
 *
 * 2026-11-21 发生过一次大面积的文件移动（180 个工作产物文件移出仓库），
 * 那次之后我逐个手查了引用，但那是**一次性的**。下一次移动还会再断一次。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *
 *   从面向贡献者的文档里抽出两类引用：
 *     P1  反引号包裹的仓库内路径   `framework/x.md`
 *     P2  markdown 相对链接        [文字](docs/x.md)
 *
 *   对每一条：
 *     - 含通配符（`*`）→ 展开成 glob，**至少匹配到一个文件**才算通过
 *     - 不含通配符     → 文件或目录必须存在
 *
 * ── 不检查什么 ──────────────────────────────────────────────────────
 *
 *   - 外部 URL（http/https）——那是网络可达性问题，不是仓库内一致性问题
 *   - 锚点链接（`#xxx`）——同文件内跳转，与路径无关
 *   - `experiments/` 下的历史文档——它们是当时的快照，引用的东西可能已被清理，
 *     改它们等于篡改历史记录
 *
 * 用法：node check-doc-paths.mjs [--json] [--all]
 * 退出码：0 通过 / 1 有断链 / 2 配置错误（一条引用都没抽到 = 分母为 0）
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const jsonOut = process.argv.includes('--json');
const scanAll = process.argv.includes('--all');

// ── 参与检查的文档 ──
//
// 默认只查「面向贡献者的文档」：根目录的 .md、.github/ 下的、docs/ 下的。
// `--all` 时再加上 framework/ 与 experiments/（后者是历史快照，断链属正常）。
function collectDocs() {
  const out = [];
  const add = (rel) => { if (existsSync(join(ROOT, rel))) out.push(rel); };

  // 根目录 .md
  for (const f of readdirSync(ROOT)) {
    if (f.endsWith('.md') && !f.startsWith('.')) add(f);
  }
  // .github/
  const gh = join(ROOT, '.github');
  if (existsSync(gh)) {
    for (const f of readdirSync(gh)) if (f.endsWith('.md')) add(join('.github', f));
    const tpl = join(gh, 'ISSUE_TEMPLATE');
    if (existsSync(tpl)) for (const f of readdirSync(tpl)) if (/\.ya?ml$/.test(f)) add(join('.github', 'ISSUE_TEMPLATE', f));
  }
  // docs/（递归）
  const walk = (dir, rel) => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(dir, e.name);
      const r = join(rel, e.name);
      if (e.isDirectory()) walk(p, r);
      else if (e.name.endsWith('.md')) add(r);
    }
  };
  if (existsSync(join(ROOT, 'docs'))) walk(join(ROOT, 'docs'), 'docs');

  if (scanAll) {
    const walk2 = (dir, rel) => {
      let ents;
      try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        const p = join(dir, e.name);
        const r = join(rel, e.name);
        if (e.isDirectory()) walk2(p, r);
        else if (e.name.endsWith('.md')) add(r);
      }
    };
    for (const d of ['framework', 'experiments', 'tools']) {
      if (existsSync(join(ROOT, d))) walk2(join(ROOT, d), d);
    }
  }
  return [...new Set(out)];
}

/** 通配符 → 正则；只在 `/` 之间匹配，不跨层 */
function globToRe(pat) {
  const esc = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp('^' + esc + '$');
}

/** 在仓库里找符合 pattern 的文件（相对路径） */
function globExists(pattern) {
  const re = globToRe(pattern);
  const walk = (dir, rel, depth) => {
    if (depth > 6) return false;
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return false; }
    for (const e of ents) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (walk(join(dir, e.name), r, depth + 1)) return true; }
      else if (re.test(r)) return true;
    }
    return false;
  };
  return walk(ROOT, '', 0);
}

/**
 * 这一处引用是不是在讲**别的仓库**？
 *
 * 2026-11-21 实测：`docs/analysis/2026-11-01-structural-diagnosis.md:3` 里写
 *
 *     ② `D:\Projects\dsh-fcl-android-launcher` 的真实使用现场…
 *     ③ **该项目的** `docs/DEV-PLAN.md` §3
 *
 * `DEV-PLAN.md` 属于那个项目，不是本仓库。把它判成断链是误报。
 *
 * 判据：取引用所在的那一行，若同一行里出现了
 *   - 别的盘符路径（`X:\` 或 `X:/`）
 *   - 或「该项目 / 另一个项目 / 那个仓库」这类指代
 * 就认为它指向外部，跳过。
 *
 * 只取「同一行」是刻意的：跨行推断会引入大量噪声，
 * 而这类引用几乎都是在一句话里说清楚的。
 */
function isExternalRef(text, index) {
  const lineStart = text.lastIndexOf('\n', index) + 1;
  let lineEnd = text.indexOf('\n', index);
  if (lineEnd < 0) lineEnd = text.length;
  const line = text.slice(lineStart, lineEnd);
  if (/[A-Za-z]:[\\/]/.test(line)) return true;                       // 别的盘符路径
  if (/(该项目|另一个项目|那个仓库|其他项目|外部项目|本项目外)/.test(line)) return true;
  return false;
}

const REF_PATHS = [
  // `framework/x.md` / `tools/x.mjs` —— 反引号包裹的仓库内路径
  { id: 'P1', re: /`((?:framework|tools|docs|experiments|\.github)\/[^`\s]+)`/g, base: ROOT },
  // [文字](docs/x.md) —— 普通 markdown 相对链接（排除 http / 锚点）
  { id: 'P2', re: /\[[^\]]*\]\(((?:framework|tools|docs|experiments|\.github|[A-Za-z0-9_-]+)[^)\s]*\.(?:md|mjs|yml|yaml|json|png))\)/g, base: ROOT },
];

const docs = collectDocs();
if (docs.length === 0) {
  console.error('[预期失败] 一份文档都没收集到——路径可能变了');
  process.exit(2);
}

const problems = [];
let refCount = 0;

for (const doc of docs) {
  const text = readFileSync(join(ROOT, doc), 'utf8');
  for (const { id, re } of REF_PATHS) {
    // 每次用新正则实例，避免 lastIndex 残留
    const rr = new RegExp(re.source, re.flags);
    for (const m of text.matchAll(rr)) {
      let target = m[1];
      // 去掉锚点
      const hash = target.indexOf('#');
      if (hash >= 0) target = target.slice(0, hash);
      if (!target || /^https?:/i.test(target)) continue;

      // ── 2026-11-21 收紧：三类不是"路径"的东西，不能当断链 ──
      //
      // 第一版没做这些排除，抽出 13 条"断链"，逐个看全是误报。
      // 一个误报率高的检查第一天就会被关掉，所以判据必须保守。

      // ① `file.md:185` —— 带行号的引用，行号不是路径的一部分
      target = target.replace(/:\d+(?:-\d+)?$/, '');

      // ② `docs/reports/round{N}/`、`round{RN}` —— 模板占位符
      //    它们是"调用点长这样"，不是"这个目录存在"
      if (/[{}]/.test(target)) continue;

      // ③ 以 `/` 结尾的是目录占位约定（`docs/reports/round1/` 这种"放这里"），
      //    不是断言该目录此刻存在。只要父目录存在就不再追究。
      const isDirHint = target.endsWith('/');
      const probe = isDirHint ? target.replace(/\/+$/, '') : target;

      // ④ 指向别的仓库的引用不是断链（见 isExternalRef 的注释）
      if (isExternalRef(text, m.index)) continue;

      refCount++;

      const fromDoc = resolve(dirname(join(ROOT, doc)), probe);
      const fromRoot = resolve(ROOT, probe);
      const hasWildcard = probe.includes('*');

      let ok;
      if (hasWildcard) {
        ok = globExists(probe.replace(/^\.\//, ''));
      } else {
        ok = (existsSync(fromDoc) && statSync(fromDoc).isFile())
          || (existsSync(fromRoot) && statSync(fromRoot).isFile())
          || (existsSync(fromRoot) && statSync(fromRoot).isDirectory())
          || (existsSync(fromDoc) && statSync(fromDoc).isDirectory())
          // 目录提示（以 / 结尾）：父目录存在即可
          || (isDirHint && existsSync(dirname(fromRoot)));
      }

      if (!ok) {
        problems.push({ id, doc, target: probe, msg: `${doc} 引用了 \`${probe}\`，但该路径不存在` });
      }
    }
  }
}

// ── 分母为 0 不等于通过 ──
if (refCount === 0) {
  console.error('[预期失败] 一条仓库内路径引用都没抽到——正则可能失效了');
  process.exit(2);
}

const ok = problems.length === 0;

if (jsonOut) {
  console.log(JSON.stringify({ ok, docs: docs.length, refs: refCount, problems }, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log('\n文档内路径引用检查\n');
console.log(`  扫描文档   ${docs.length} 份${scanAll ? '（含 framework/ experiments/）' : ''}`);
console.log(`  路径引用   ${refCount} 处`);
console.log('');
if (ok) {
  console.log('  ✓ 所有仓库内路径引用均可达');
} else {
  console.log(`  ✗ ${problems.length} 处断链：`);
  for (const p of problems) console.log(`    [${p.id}] ${p.msg}`);
}
console.log('');
process.exit(ok ? 0 : 1);
