#!/usr/bin/env node
/**
 * check-rule-doc-link.test.mjs — 自测 check-rule-doc-link.mjs
 *
 * 这个工具最容易出的错是**假阳性**：判据说太窄，把「契约写了但没写规则名」
 * 的情况全部报成无落点。2026-11-19 实测就踩过两次：
 *   只认规则名      → 71 条误报
 *   加上英文字段名  → 16 条
 *   加上中文短语    → 4 条（真实水平）
 *
 * 所以本自测的重点是：**判断据放宽后，真正没落点的规则仍然能被抓到**。
 * 只测「有落点的不报」会让工具退化成永远返回 OK。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'check-rule-doc-link.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

/**
 * 造一个最小仓库：tools/ 下若干校验器 + framework/ 下若干文档。
 * @param tools { [filename]: source }
 * @param docs  { [relpath]: content }
 */
function mk(tools, docs) {
  const dir = mkdtempSync(join(tmpdir(), 'rdl-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'framework'), { recursive: true });
  cpSync(SRC, join(dir, 'tools', 'check-rule-doc-link.mjs'));
  for (const [name, src] of Object.entries(tools)) writeFileSync(join(dir, 'tools', name), src);
  for (const [rel, body] of Object.entries(docs)) {
    const p = join(dir, 'framework', rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
}

function run(dir) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-rule-doc-link.mjs')], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

const checker = (rule, msg, field = 'payload.x') =>
  `errors.push({ field: '${field}', rule: '${rule}', msg: \`${msg}\` });\n`;

// ─────────────────────────────────────────────────────────────
console.log('\ncase 1: 规则名出现在文档里 → 有落点');
{
  const dir = mk(
    { 'v.mjs': checker('my_rule', '这是说明') },
    { 'a.md': '契约正文提到 my_rule 这条规则。' },
  );
  const r = run(dir);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('无落点 0', /无落点\s+0/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 2: 规则名没出现，但英文字段名出现 → 仍算有落点（防误报）');
{
  const dir = mk(
    { 'v.mjs': checker('legacy_rule', 'shared_dependencies 字段不合法') },
    { 'a.md': '契约里规定 shared_dependencies 是必填数组。' },
  );
  const r = run(dir);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('无落点 0', /无落点\s+0/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 3: 规则名与英文字段都没出现，但中文短语出现 → 仍算有落点（关键防误报）');
{
  const dir = mk(
    { 'v.mjs': checker('zh_rule', '切片必须两两不相交') },
    { 'a.md': '契约要求：切片必须两两不相交，共享文件进 shared_dependencies。' },
  );
  const r = run(dir);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('无落点 0', /无落点\s+0/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 4: 三样都不出现 → 必须判无落点（证明放宽后没变成永远 OK）');
{
  const dir = mk(
    { 'v.mjs': checker('orphan_rule', 'zzzqqq 缺失') },
    { 'a.md': '契约正文完全无关。' },
  );
  const r = run(dir);
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('点名 orphan_rule', /orphan_rule/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 5: 规则在 field 行（rule: 之前）的关键字段也要被扫到');
{
  // 这个 case 钉住 2026-11-19 的第二个坑：
  // 只从 rule: 往后截窗口，会漏掉 field: 行里的字段名。
  const dir = mk(
    {
      'v.mjs': 'errors.push({\n  field: `payload.audit_slices[${i}].files`,\n'
        + '  rule: \'shared_in_files\', msg: `重复了` });\n',
    },
    { 'a.md': 'audit_slices 的 files 不能与共享依赖重复。' },
  );
  const r = run(dir);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('无落点 0', /无落点\s+0/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 6: 测试文件（*.test.mjs）里的 rule: 不计入');
{
  const dir = mk(
    {
      'v.mjs': checker('real_rule', '契约里有的'),
      'v.test.mjs': checker('only_in_test', 'zzz 不存在'),
    },
    { 'a.md': '契约提到 real_rule。' },
  );
  const r = run(dir);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('没把 only_in_test 算进来', !/only_in_test/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 7: framework 目录不存在 → exit 2（分母为 0 不等于通过）');
{
  const dir = mkdtempSync(join(tmpdir(), 'rdl-nofw-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(SRC, join(dir, 'tools', 'check-rule-doc-link.mjs'));
  const r = run(dir);
  ok('exit 2', r.code === 2, `code=${r.code}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 8: 一条 rule: 都抽不到 → exit 2（结构变了不能静默通过）');
{
  const dir = mk(
    { 'v.mjs': '// 没有任何 rule: 字面量\n' },
    { 'a.md': '正文' },
  );
  const r = run(dir);
  ok('exit 2', r.code === 2, `code=${r.code}\n${r.out}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
