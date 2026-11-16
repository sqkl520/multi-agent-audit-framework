#!/usr/bin/env node
/**
 * check-rule-ledger.test.mjs — 自测 check-rule-ledger.mjs
 *
 * 反向用例是重点：一个只报「一切正常」的仪表，和没有仪表是一样的。
 * 所以要证明它**真的会因为一条新写的无出口规则而变红**，并且
 * **不会因为存量 987 条无出口规则而变红**（后者是设计意图，不是缺陷）。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'check-rule-ledger.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${extra ? ' — ' + extra : ''}`); fail++; }
};

/**
 * 造一个最小假框架：只有 tools/check-rule-ledger.mjs + framework/ 下几个 .md。
 * 必须在临时目录里跑，否则会扫到真仓库的 1000+ 条规则句，噪声淹没用例。
 */
function makeFramework({ docs = {}, tools = [], git = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'rule-ledger-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  mkdirSync(join(dir, 'framework'), { recursive: true });
  cpSync(SRC, join(dir, 'tools', 'check-rule-ledger.mjs'));
  for (const [name, body] of Object.entries(docs)) {
    const p = join(dir, 'framework', name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  // 假工具：提供脚本名与 rule 名供对账
  for (const t of tools) writeFileSync(join(dir, 'tools', t.name), t.body);
  if (git) {
    const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
    g('init', '-q');
    g('config', 'user.email', 't@t');
    g('config', 'user.name', 't');
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
  }
  return dir;
}

function run(dir, args = []) {
  try {
    const out = execFileSync(process.execPath, [join(dir, 'tools', 'check-rule-ledger.mjs'), ...args],
      { encoding: 'utf8', cwd: dir, stdio: 'pipe' });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

// ─────────────────────────────────────────────────────────────
console.log('\ncase 1: 存量无出口规则 → 默认模式 exit 0（仪表不判存量）');
{
  const dir = makeFramework({
    docs: { 'a.md': '# A\n\n这里必须做一件事。\n\n这里不得做另一件事。\n' },
    tools: [{ name: 'noop.mjs', body: "// nothing\n" }],
  });
  const r = run(dir);
  ok('exit 0', r.code === 0, `code=${r.code}`);
  ok('报出 2 条规则句', /规则句总数\s+2/.test(r.out), r.out);
  ok('报出 0 有出口', /有机器出口\s+0/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 2: 规则句点名了真实存在的脚本 → 算有出口');
{
  const dir = makeFramework({
    docs: { 'a.md': '# A\n\n必须跑 tools/real.mjs 验证。\n' },
    tools: [{ name: 'real.mjs', body: "// real\n" }],
  });
  const r = run(dir);
  ok('exit 0', r.code === 0);
  ok('有出口 = 1', /有机器出口\s+1/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 3: 规则句点名了真实存在的 rule 名 → 算有出口');
{
  const dir = makeFramework({
    docs: { 'a.md': '# A\n\n必须满足 files_touched_not_found 这条。\n' },
    tools: [{ name: 'v.mjs', body: "errors.push({ rule: 'files_touched_not_found' });\n" }],
  });
  const r = run(dir);
  ok('exit 0', r.code === 0);
  ok('有出口 = 1', /有机器出口\s+1/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 4: DISCRETIONARY 带理由 → 算有出口');
{
  const dir = makeFramework({
    docs: { 'a.md': '# A\n\n必须读懂这一节。DISCRETIONARY: 这是阅读指引，不是可判定的行为约束，无法机械化\n' },
  });
  const r = run(dir);
  ok('exit 0', r.code === 0, r.out);
  ok('有出口 = 1', /有机器出口\s+1/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 5: DISCRETIONARY 没理由 → FAIL（不能靠加个词就过）');
{
  const dir = makeFramework({
    docs: { 'a.md': '# A\n\n必须做某件事。DISCRETIONARY\n' },
  });
  const r = run(dir);
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('报 discretionary_without_reason', /discretionary_without_reason/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 6: 代码块里的「必须」不算规则句（避免示例噪声）');
{
  const dir = makeFramework({
    docs: { 'a.md': '# A\n\n```\n必须写在代码里的字\n```\n' },
  });
  const r = run(dir);
  ok('exit 0', r.code === 0);
  ok('规则句总数 = 0', /规则句总数\s+0/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 7: --gate 抓住本轮新增的无出口规则句');
{
  const dir = makeFramework({
    docs: { 'a.md': '# A\n\n老规则必须这样做。\n' },
    git: true,
  });
  // 追加一条新规则，不点任何工具
  writeFileSync(join(dir, 'framework', 'a.md'), '# A\n\n老规则必须这样做。\n\n新规则必须覆盖所有边界。\n');
  const r = run(dir, ['--gate', '--since', 'HEAD']);
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('报 new_rule_without_validator', /new_rule_without_validator/.test(r.out), r.out);
  ok('只点名新那条', /新规则必须覆盖所有边界/.test(r.out) && !/老规则必须这样做/.test(r.out.split('没有机器出口')[1] ?? ''), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 8: --gate 不动存量（老的无出口规则不该被算成新违规）');
{
  const dir = makeFramework({
    docs: { 'a.md': '# A\n\n老规则必须这样做。\n' },
    git: true,
  });
  // 只改一个无关的行
  writeFileSync(join(dir, 'framework', 'a.md'), '# A（标题改了）\n\n老规则必须这样做。\n');
  const r = run(dir, ['--gate', '--since', 'HEAD']);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('没有 new_rule_without_validator', !/new_rule_without_validator/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 9: 没有 framework/*.md → exit 2（分母为 0 不等于通过）');
{
  const dir = mkdtempSync(join(tmpdir(), 'rule-ledger-empty-'));
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(SRC, join(dir, 'tools', 'check-rule-ledger.mjs'));
  const r = run(dir);
  ok('exit 2', r.code === 2, `code=${r.code}`);
  ok('提示分母为 0', /分母为 0/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 10: --gate 在非 git 目录 → exit 2（拿不到基线就必须报错，不能静默放行）');
{
  const dir = makeFramework({ docs: { 'a.md': '# A\n\n必须做。\n' } });
  const r = run(dir, ['--gate', '--since', 'HEAD']);
  ok('exit 2', r.code === 2, `code=${r.code}`);
  ok('说明为何放行等于不存在', /静默放行等于这道闸门不存在/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 11: 引用块里的规则也算（框架大量用 > 引用写规则）');
{
  const dir = makeFramework({
    docs: { 'a.md': '# A\n\n> **注意**：这里必须是只读角色。\n' },
  });
  const r = run(dir);
  ok('规则句总数 = 1', /规则句总数\s+1/.test(r.out), r.out);
  rmSync(dir, { recursive: true, force: true });
}

console.log('\ncase 12: --json 输出结构完整');
{
  const dir = makeFramework({
    docs: { 'a.md': '# A\n\n必须做。\n' },
  });
  const r = run(dir, ['--json']);
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* */ }
  ok('可解析 JSON', j !== null, r.out.slice(0, 200));
  ok('含六个字段', j && ['rule_sentences', 'with_exit', 'without_exit', 'exit_rate_pct', 'violations', 'gated'].every((k) => k in j));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
