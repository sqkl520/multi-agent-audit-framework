#!/usr/bin/env node
/**
 * lint-terminology.test.mjs — 自测 lint-terminology.mjs
 *
 * 反向用例是重点。一个只会报「术语一致」的检查器，和没有检查器是一样的。
 * 特别是这三条必须被证明：
 *   1. 变体写法真的会红（否则它只是个统计器）
 *   2. `accepted` 里的写法**不会**红（否则合法写法被误伤，人会直接关掉它）
 *   3. 代码块里的写法不参与检查（否则示例代码会疯狂误报）
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'lint-terminology.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

/** 造一个最小 framework 目录，只含给定文件。 */
function mkfw(files) {
  const dir = mkdtempSync(join(tmpdir(), 'term-'));
  const fw = join(dir, 'framework');
  const tools = join(dir, 'tools');
  mkdirSync(fw, { recursive: true });
  mkdirSync(tools, { recursive: true });
  cpSync(SRC, join(tools, 'lint-terminology.mjs'));
  for (const [rel, body] of Object.entries(files)) {
    const p = join(fw, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return { dir, fw };
}

function run(dir, fw) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'lint-terminology.mjs'), '--framework', fw], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

// ─────────────────────────────────────────────────────────────
console.log('\ncase 1: 只用规范写法 → exit 0');
{
  const { dir, fw } = mkfw({ 'a.md': '# 标题\n\n所有子 Agent 在产出前加载。\n' });
  const r = run(dir, fw);
  ok('exit 0', r.code === 0, `code=${r.code}`);
  ok('无违规', !/项违规/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 2: 变体写法「子Agent」→ 必须 FAIL');
{
  const { dir, fw } = mkfw({ 'a.md': '# 标题\n\n所有子Agent在产出前加载。\n' });
  const r = run(dir, fw);
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('报 T1_variant_spelling', /T1_variant_spelling/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 3: accepted 写法 `subagent` → 不得 FAIL（否则合法写法被误伤）');
{
  const { dir, fw } = mkfw({ 'a.md': '# 标题\n\n调用 `subagent` 工具派发。\n' });
  const r = run(dir, fw);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('无违规', !/项违规/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 4: 代码块里的变体不参与检查');
{
  const { dir, fw } = mkfw({ 'a.md': '# 标题\n\n```\n子Agent 出现在示例代码里\n```\n' });
  const r = run(dir, fw);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 5: 「门 0」变体「门0」→ 必须 FAIL');
{
  const { dir, fw } = mkfw({ 'a.md': '# 标题\n\n必须先过门0。\n' });
  const r = run(dir, fw);
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('报 T1_variant_spelling', /T1_variant_spelling/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 6: 「Gate 0」是 accepted，不得 FAIL');
{
  const { dir, fw } = mkfw({ 'a.md': '# 标题\n\nQuote "Gate 0" from the paper.\n' });
  const r = run(dir, fw);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 7: 需要派发的模板却不提 subagent → WARN（不是 FAIL）');
{
  // 注意：只有 MUST_MENTION_SUBAGENT 里的模板才会被检查。
  // 2026-11-19 修正：最初 6 个 wave 模板全查，跑出 4 条警告——但那 4 个是
  // 「执行体视角」的作业指导（描述「你被派来之后怎么做」），本来就不该提派发。
  // 判据改成「这个模板是否包含派发决策」后，只剩 wave2a-sweep 与 wave4-fix。
  const { dir, fw } = mkfw({
    'templates/wave2a-sweep.md': '# 宽扫\n\n本模板只做宽扫。\n',
  });
  const r = run(dir, fw);
  ok('exit 0（WARN 不阻断）', r.code === 0, `code=${r.code}`);
  ok('报 T3 警告', /T3_template_silent_about_subagent|项警告/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 7b: 不需要派发的模板（如 wave5-verify）沉默 → 不得 WARN');
{
  // 反向对照：证明 T3 的判据确实收窄了，不是把警告全关掉。
  const { dir, fw } = mkfw({
    'templates/wave5-verify.md': '# 验收\n\n你被派来验收一条修复。\n',
  });
  const r = run(dir, fw);
  ok('exit 0', r.code === 0, `code=${r.code}`);
  ok('没有 T3 警告', !/T3_template_silent_about_subagent/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 8: framework 目录不存在 → exit 2（分母为 0 不等于通过）');
{
  const dir = mkdtempSync(join(tmpdir(), 'term-empty-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(SRC, join(dir, 'tools', 'lint-terminology.mjs'));
  const r = run(dir, join(dir, 'nonexistent'));
  ok('exit 2', r.code === 2, `code=${r.code}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 9: framework 存在但一个 .md 都没有 → exit 2');
{
  const dir = mkdtempSync(join(tmpdir(), 'term-nomd-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'framework'), { recursive: true });
  cpSync(SRC, join(dir, 'tools', 'lint-terminology.mjs'));
  const r = run(dir, join(dir, 'framework'));
  ok('exit 2', r.code === 2, `code=${r.code}`);
  ok('提示分母为 0', /分母为 0/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 10: --json 输出结构完整');
{
  const { dir, fw } = mkfw({ 'a.md': '# T\n\n子Agent 混用了。\n' });
  let j = null;
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'lint-terminology.mjs'), '--framework', fw, '--json'], { encoding: 'utf8' });
    j = JSON.parse(out);
  } catch (e) {
    try { j = JSON.parse(e.stdout ?? ''); } catch { /* */ }
  }
  ok('可解析 JSON', j !== null);
  ok('含关键字段', Boolean(j) && ['ok', 'terms', 'fail_count', 'warn_count', 'findings'].every((k) => k in j));
  ok('terms 里有 canonical_count 与 accepted_count',
    Boolean(j?.terms?.[0]) && 'canonical_count' in j.terms[0] && 'accepted_count' in j.terms[0]);
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
