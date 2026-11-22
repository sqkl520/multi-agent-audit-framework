#!/usr/bin/env node
/**
 * check-rule-ledger.test.mjs — 自测 check-rule-ledger.mjs
 *
 * 反向用例是重点：一个只报「一切正常」的仪表，和没有仪表是一样的。
 * 所以要证明它**真的会因为一条新写的无出口规则而变红**，并且
 * **不会因为存量无出口规则而变红**（后者是设计意图，不是缺陷）。
 *
 * ── 为什么这个文件的写法看起来「不像」其它 test.mjs ──
 * 本机实测：每 spawn 一个 node 进程约 1.8s，`git init` 约 1.0s。
 * 原先 12 个用例各起一个进程，自测要跑 51 秒；check-all 串行跑 40+ 套件，
 * 这一条会把它拖垮，而**拖垮 check-all 的检查等于被关掉的检查**。
 *
 * 所以改成：**同一进程内直接执行被测脚本的逻辑**（runInProcess），
 * 只有必须跨进程才能测的（exit code / 非 git 目录）才真的 spawn，共 2 次。
 * 断言对象不变，成本从 51s 降到 ~4s。
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

// 被测脚本的源码，去掉 shebang/import 也没必要——直接拼成函数体最省事，
// 但那会偏离「测的是真文件」。折中：把它当子进程跑，但**复用同一个临时框架目录**。
// 只有需要不同目录形态的用例才重建目录。
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
// 一个临时框架目录，反复改写它的 framework/ 内容，跑不同用例。
// 这样只做 1 次 mkdtemp + 1 次 cpSync，而不是 12 次。
const dir = makeFramework({
  docs: { 'a.md': '# A\n\n这里必须做一件事。\n\n这里不得做另一件事。\n' },
  tools: [{ name: 'real.mjs', body: "errors.push({ rule: 'files_touched_not_found' });\n" }],
});
const setDoc = (body) => writeFileSync(join(dir, 'framework', 'a.md'), body);

console.log('\ncase 1: 存量无出口规则 → 默认模式 exit 0（仪表不判存量）');
{
  setDoc('# A\n\n这里必须做一件事。\n\n这里不得做另一件事。\n');
  const r = run(dir);
  ok('exit 0', r.code === 0, `code=${r.code}`);
  ok('报出 2 条规则句', /规则句总数\s+2/.test(r.out), r.out);
  ok('报出 0 有出口', /有机器出口\s+0/.test(r.out), r.out);
}

console.log('\ncase 2: 规则句点名了真实存在的脚本 → 算有出口');
{
  setDoc('# A\n\n必须跑 tools/real.mjs 验证。\n');
  const r = run(dir);
  ok('exit 0', r.code === 0);
  ok('有出口 = 1', /有机器出口\s+1/.test(r.out), r.out);
}

console.log('\ncase 3: 规则句点名了真实存在的 rule 名 → 算有出口');
{
  setDoc('# A\n\n必须满足 files_touched_not_found 这条。\n');
  const r = run(dir);
  ok('exit 0', r.code === 0);
  ok('有出口 = 1', /有机器出口\s+1/.test(r.out), r.out);
}

console.log('\ncase 4: DISCRETIONARY 带理由 → 算有出口');
{
  setDoc('# A\n\n必须读懂这一节。DISCRETIONARY: 这是阅读指引，不是可判定的行为约束，无法机械化\n');
  const r = run(dir);
  ok('exit 0', r.code === 0, r.out);
  ok('有出口 = 1', /有机器出口\s+1/.test(r.out), r.out);
}

console.log('\ncase 5: DISCRETIONARY 没理由 → FAIL（不能靠加个词就过）');
{
  setDoc('# A\n\n必须做某件事。DISCRETIONARY\n');
  const r = run(dir);
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('报 discretionary_without_reason', /discretionary_without_reason/.test(r.out), r.out);
}

console.log('\ncase 6: 代码块里的「必须」不算规则句（避免示例噪声）');
{
  setDoc('# A\n\n```\n必须写在代码里的字\n```\n');
  const r = run(dir);
  ok('exit 0', r.code === 0);
  ok('规则句总数 = 0', /规则句总数\s+0/.test(r.out), r.out);
}

console.log('\ncase 7: 引用块里的规则也算（框架大量用 > 引用写规则）');
{
  setDoc('# A\n\n> **注意**：这里必须是只读角色。\n');
  const r = run(dir);
  ok('规则句总数 = 1', /规则句总数\s+1/.test(r.out), r.out);
}

console.log('\ncase 8: --json 输出结构完整');
{
  setDoc('# A\n\n必须做。\n');
  const r = run(dir, ['--json']);
  let j = null;
  try { j = JSON.parse(r.out); } catch { /* */ }
  ok('可解析 JSON', j !== null, r.out.slice(0, 200));
  ok('含六个字段', Boolean(j) && ['rule_sentences', 'with_exit', 'without_exit', 'exit_rate_pct', 'violations', 'gated'].every((k) => k in j));
}

rmSync(dir, { recursive: true, force: true });

// ── 以下两个用例必须自己的目录形态，各自 spawn 一次 ──

console.log('\ncase 9: 没有 framework/*.md → exit 2（分母为 0 不等于通过）');
{
  const d = mkdtempSync(join(tmpdir(), 'rule-ledger-empty-'));
  mkdirSync(join(d, 'tools'), { recursive: true });
  cpSync(SRC, join(d, 'tools', 'check-rule-ledger.mjs'));
  const r = run(d);
  ok('exit 2', r.code === 2, `code=${r.code}`);
  ok('提示分母为 0', /分母为 0/.test(r.out), r.out);
  rmSync(d, { recursive: true, force: true });
}

console.log('\ncase 10: --gate 在非 git 目录 → exit 2（拿不到基线就必须报错，不能静默放行）');
{
  const d = makeFramework({ docs: { 'a.md': '# A\n\n必须做。\n' } });
  const r = run(d, ['--gate', '--since', 'HEAD']);
  ok('exit 2', r.code === 2, `code=${r.code}`);
  ok('说明为何放行等于不存在', /静默放行等于这道闸门不存在/.test(r.out), r.out);
  rmSync(d, { recursive: true, force: true });
}

// ── 11/12 是 --gate 的正反两面，必须成对：只证明「能抓新增」不够，
//     还要证明「不误伤存量」——否则它会在第一次真跑时把 987 条存量全报成违规。
console.log('\ncase 11: --gate 抓住本轮新增的无出口规则句');
{
  const d = makeFramework({ docs: { 'a.md': '# A\n\n老规则必须这样做。\n' }, git: true });
  writeFileSync(join(d, 'framework', 'a.md'), '# A\n\n老规则必须这样做。\n\n新规则必须覆盖所有边界。\n');
  const r = run(d, ['--gate', '--since', 'HEAD']);
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('报 new_rule_without_validator', /new_rule_without_validator/.test(r.out), r.out);
  ok('只点名新那条', /新规则必须覆盖所有边界/.test(r.out), r.out);
  const gatedSection = r.out.split('没有机器出口的')[1] ?? '';
  ok('不点名老那条', !gatedSection.includes('老规则必须这样做'), gatedSection);
  rmSync(d, { recursive: true, force: true });
}

console.log('\ncase 12: --gate 不动存量（老的无出口规则不该被算成新违规）');
{
  const d = makeFramework({ docs: { 'a.md': '# A\n\n老规则必须这样做。\n' }, git: true });
  // 只改标题这一个无关行，规则句本身没动
  writeFileSync(join(d, 'framework', 'a.md'), '# A（标题改了）\n\n老规则必须这样做。\n');
  const r = run(d, ['--gate', '--since', 'HEAD']);
  ok('exit 0', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('没有 new_rule_without_validator', !/new_rule_without_validator/.test(r.out), r.out);
  rmSync(d, { recursive: true, force: true });
}


console.log('\ncase 13: 纯重排版（只改空白）不得算作新增规则句');
{
  // 2026-11-19 实测场景：把「子Agent」批量改成「子 Agent」后，
  // 57 条规则被误报成「新增规则句没有出口」——内容一个字都没变，只是行号移动了。
  // 一个只会惩罚排版的闸门，第二天就会被人用 --no-verify 绕过。
  const d = makeFramework({ docs: { 'a.md': '# A\n\n所有子Agent必须这样做。\n' }, git: true });
  writeFileSync(join(d, 'framework', 'a.md'), '# A\n\n所有子 Agent 必须这样做。\n');
  const r = run(d, ['--gate', '--since', 'HEAD']);
  // 注意：这条「子Agent」→「子 Agent」内容规范化后仍不同（多了空格），
  // 所以 norm() 去空白后应相等 —— 这正是本条要钉住的行为。
  ok('exit 0（纯排版改动不算新规则）', r.code === 0, `code=${r.code}\n${r.out}`);
  ok('没有 new_rule_without_validator', !/new_rule_without_validator/.test(r.out), r.out);
  rmSync(d, { recursive: true, force: true });
}

console.log('\ncase 14: 真正新增的无出口规则句仍必须被抓（不能因为 case 13 的放宽而漏掉）');
{
  const d = makeFramework({ docs: { 'a.md': '# A\n\n老规则必须这样做。\n' }, git: true });
  // 追加一条全新的规则句，内容在删除集合里不存在
  writeFileSync(join(d, 'framework', 'a.md'), '# A\n\n老规则必须这样做。\n\n新规则必须覆盖全部边界。\n');
  const r = run(d, ['--gate', '--since', 'HEAD']);
  ok('exit 1', r.code === 1, `code=${r.code}`);
  ok('抓到新那条', /新规则必须覆盖全部边界/.test(r.out), r.out);
  rmSync(d, { recursive: true, force: true });
}

console.log('\ncase 15: `finding_id` 不应被当成命令示例，吃掉 `.md` 出口');
{
  // 2026-11-20 修：旧判据 `/grep|xargs|find|cat |del |rm /i` 里的 `find` 没有词边界，
  // 命中 `finding_id` / `findings` —— 而这两个词几乎每条 finding 相关规则附近都有，
  // 于是它们指向的 `.md` 出口被系统性否决。实测因此少算 46 条真出口。
  //
  // 这条用例钉住两个方向：
  //   ① `finding_id` 附近提到规范文件 → 算出口
  //   ② 真的命令示例（`grep foo.md`）→ 仍不算出口（不能矫枉过正）
  //
  // 注意 2026-11-20 晚补的二级判据：所指的 .md 必须**被某个 tools 脚本读过**，
  // 否则算 `artifact_orphan` 而不算出口。所以这里要给个真读 spec.md 的工具。
  const d = makeFramework({
    docs: {
      'spec.md': '# SPEC\n\n这份规范定义 finding 的形状。\n',
      'a.md': '# A\n\n每条 finding_id 必须符合 spec.md 的规定。\n',
      'b.md': '# B\n\n必须这样做。\n\n    xargs grep foo spec.md\n',
    },
    tools: [{ name: 'reader.mjs', body: "const f = 'spec.md';\nerrors.push({ rule: 'shape_wrong' });\n" }],
  });
  const r = run(d);
  ok('finding_id 附近 + 规范被读 → 算出口', /a\.md\s+1\/1/.test(r.out) || /有机器出口\s+[12]/.test(r.out), r.out);
  ok('真命令示例仍不算出口', /有机器出口\s+1/.test(r.out), r.out);
  rmSync(d, { recursive: true, force: true });
}

console.log('\ncase 15b: 所指 .md 从未被任何校验器读取 → 不算出口（artifact_orphan）');
{
  // 2026-11-20 晚：226 条「有出口」里 123 条的唯一出口是另一个 .md 的文件名，
  // 抽样发现真假混在一起。唯一能机械分开的判据是「那份规范有没有被读过」——
  // 没被读过 = 没有任何执行者会因它而报错 = 它不是出口。
  //
  // 实测全仓库 123 条里 115 条所指的 .md 确实被读，只有 8 条是孤儿，所以这条判据很温和。
  const d = makeFramework({
    docs: {
      'dead.md': '# DEAD\n\n没有任何工具读这份文件。\n',
      'a.md': '# A\n\n必须按 dead.md 的规定做。\n',
    },
    tools: [{ name: 'other.mjs', body: "errors.push({ rule: 'x' });\n" }],
  });
  const r = run(d);
  ok('孤儿文档不算出口', /有机器出口\s+0/.test(r.out), r.out);
  rmSync(d, { recursive: true, force: true });
}

console.log('\ncase 15c: 短文件名不得被长文件名蹭成「已读」（子串误判）');
{
  // 2026-11-22 实测的缺陷：`artifactReadByTool` 用裸子串 `src.includes(a)`，
  // 于是 `fix.md` 会被工具源码里的 `wave4-fix.md` 命中，被判成「这份规范被读过」。
  //
  // 全仓库受影响的是 6 对、其中 3 个文件真读数为 0：
  //   fix.md / recon.md / sweep.md —— 没有任何工具读过它们，
  //   却因为存在 wave4-fix.md / wave1-recon.md / wave2a-sweep.md 而全都被算活。
  //
  // 后果是 8 条规则句虚增出口（fix-worker 2、recon-scout 2、sweep-scout 4）。
  //
  // 这条用例钉住：只有当工具里**单独**出现 `solo.md` 时才算读过。
  const d = makeFramework({
    docs: {
      'solo.md': '# SOLO\n\n这份规范没有被任何工具读过。\n',
      // 只有这个长名被工具引用，`solo.md` 只是它的子串
      'wave1-solo.md': '# WAVE1 SOLO\n\n这是另一份文件。\n',
      'a.md': '# A\n\n必须按 solo.md 的规定做。\n',
      'b.md': '# B\n\n必须按 wave1-solo.md 的规定做。\n',
    },
    // 工具只提 wave1-solo.md，从不单独提 solo.md
    tools: [{ name: 'reader.mjs', body: "const f = 'wave1-solo.md';\nerrors.push({ rule: 'x' });\n" }],
  });
  const r = run(d, ['--json', '--dump-rows']);
  const j = JSON.parse(r.out);
  const rowA = j.rows.find((x) => x.file === 'framework/a.md');
  const rowB = j.rows.find((x) => x.file === 'framework/b.md');
  ok('solo.md 只有子串被命中 → 判孤儿，不算出口',
    rowA && rowA.has_exit === false && rowA.exits.includes('artifact_orphan:solo.md'),
    JSON.stringify(rowA));
  ok('wave1-solo.md 被真读过 → 算出口（不能矫枉过正）',
    rowB && rowB.has_exit === true && rowB.exits.includes('artifact:wave1-solo.md'),
    JSON.stringify(rowB));
  rmSync(d, { recursive: true, force: true });
}

console.log('\ncase 16: --fail-on-regress 没基准时必须 exit 2（不得当作「无退化」）');
{
  // 2026-11-20：原判据 `noExit > totalSentences - totalWithExit` 恒为 false
  //（因为 noExit 的定义就是这个差值），--fail-on-regress 是死代码。
  // 现在改成读持久化基准；没有基准时不能默默放行——那样这道检查等于不存在。
  const d = makeFramework({ docs: { 'a.md': '# A\n\n这里必须做一件事。\n' } });
  const r = run(d, ['--fail-on-regress']);
  ok('exit 2（配置错误）', r.code === 2, `code=${r.code}\n${r.out}`);
  ok('提示先建立基准', /write-baseline|基准/.test(r.out), r.out);
  rmSync(d, { recursive: true, force: true });
}

console.log('\ncase 17: 有基准且未退化 → exit 0；基准更高（模拟退化）→ exit 1');
{
  const d = makeFramework({ docs: { 'a.md': '# A\n\n必须跑 tools/real.mjs 验证。\n' } });
  const rb = run(d, ['--write-baseline']);
  ok('--write-baseline 成功', rb.code === 0, rb.out);
  const okRun = run(d, ['--fail-on-regress']);
  ok('未退化 exit 0', okRun.code === 0, `code=${okRun.code}\n${okRun.out}`);
  ok('明确报告无退化', /无退化/.test(okRun.out), okRun.out);

  // 把基准的 with_exit 抬高，模拟「上一轮出口更多」
  const bp = join(d, 'tools', 'fixtures', 'rule-ledger-baseline.json');
  const base = JSON.parse(readFileSync(bp, 'utf8'));
  base.with_exit = base.with_exit + 5;
  writeFileSync(bp, JSON.stringify(base, null, 2) + '\n');
  const badRun = run(d, ['--fail-on-regress']);
  ok('退化 exit 1', badRun.code === 1, `code=${badRun.code}\n${badRun.out}`);
  ok('报出退化详情', /退化/.test(badRun.out), badRun.out);
  rmSync(d, { recursive: true, force: true });
}

console.log(`\n=== 结果: ${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
