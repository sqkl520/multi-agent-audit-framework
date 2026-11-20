#!/usr/bin/env node
/**
 * check-disposition-coverage.test.mjs — 发现去向对账器的自测
 *
 * 这个检查器守的是本次审计里最贵的一条教训：
 *   38 条发现，7 份产物，全部契约合规，最后只有 6 条被处理，31 条从未进入任何任务书。
 *   没有任何一个环节失职——因为它们**只要求计数，不要求逐条表态**。
 *
 * 所以用例集中在：
 *   - 少一条必须点名（不是「覆盖率 81%」，而是「这 3 条没有 disposition」）
 *   - 产物内 id 重复必须报错（实测：7 条 id 改成一个，check-payload 仍报 ✅）
 *   - 去向表杜撰 id 必须报错（防「表填满了但内容是编的」）
 *   - 不修的必须写理由（防「全填 WONT_FIX，理由空」）
 *   - HIGH 被 DEFERRED 必须有醒目警告（防「全填 DEFERRED 就过」）
 *   - 去向表不存在是配置错误（exit 2），不能伪装成「覆盖率高」
 *
 * 全部用合成 fixture，不依赖 experiments/ 下的真实数据——
 * 真实数据会随修复漂移，而规则不该随它漂移。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-disposition-coverage.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

// ── fixture 构造 ──────────────────────────────────────────────────
const finding = (id, severity = 'MEDIUM', extra = {}) => ({
  finding_id: id,
  severity,
  dimension: 'logic',
  evidence: { file: 'src/Foo.java', line: 10, quote: 'x' },
  inference: { claim: `${id} 的主张`, basis: 'b', alternatives: [] },
  status: 'CONFIRMED',
  ...extra,
});

const artifactMd = (agentId, findings) => {
  const env = {
    schema_version: '1.0',
    agent_id: agentId,
    role: 'audit',
    status: 'DONE',
    contract_valid: true,
    artifact_path: `out/${agentId}.md`,
    payload: { findings, searched_scope: { files: [] }, self_checks: [] },
    error: null,
  };
  return `# ${agentId} 审计产物\n\n摘要文字。\n\n\`\`\`json\n${JSON.stringify(env, null, 2)}\n\`\`\`\n`;
};

/**
 * 造一个临时工作区。
 *   artifacts: { 文件名: finding[] }
 *   ledger:    markdown 文本 | null（不写文件）
 */
function fixture(artifacts, ledger) {
  const root = mkdtempSync(join(tmpdir(), 'dc-test-'));
  const out = join(root, 'out');
  mkdirSync(out, { recursive: true });
  for (const [name, findings] of Object.entries(artifacts)) {
    writeFileSync(join(out, name), artifactMd(name.replace(/\.md$/, ''), findings));
  }
  if (ledger !== null) writeFileSync(join(root, 'ledger.md'), ledger);
  return {
    root,
    out,
    ledgerPath: join(root, 'ledger.md'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// 默认加 --json：绝大多数用例要检查规则名与计数，而不是人读排版。
// 需要验证人读输出的 case 显式传 { json: false }。
function run(fx, extraArgs = [], opts = {}) {
  const jsonArgs = opts.json === false ? [] : ['--json'];
  const args = [TOOL, '--artifacts', fx.out, '--ledger', fx.ledgerPath, ...jsonArgs, ...extraArgs];
  try {
    const out = execFileSync(process.execPath, args, { encoding: 'utf8' });
    return { code: 0, stdout: out, data: tryJson(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    return { code: e.status, stdout: out, stderr: e.stderr?.toString() ?? '', data: tryJson(out) };
  }
}

function tryJson(s) {
  const i = s.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

const rules = (r) => (r.data?.problems ?? []).map((p) => p.rule);
const hasRule = (r, rule) => rules(r).includes(rule);
const problemWith = (r, rule) => (r.data?.problems ?? []).find((p) => p.rule === rule);

// 去向表构造：rows = [[id, disposition, reason], ...]
function ledgerTable(rows, header = ['finding_id', 'disposition', '依据']) {
  const lines = [
    '# 发现去向表',
    '',
    `| ${header.join(' | ')} |`,
    `|${header.map(() => '---').join('|')}|`,
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
  ];
  return lines.join('\n');
}

const ok = (n) => `第 ${n} 处证据`;

console.log('\n=== 发现去向对账器自测 ===\n');

// ── case 1：全覆盖 → exit 0 ───────────────────────────────────────
console.log('case 1: 每条 finding 都有去向 → exit 0');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1'), finding('F2', 'HIGH')],
    'round2-ai-audit.md': [finding('R2-AI-001', 'HIGH')],
  }, ledgerTable([
    ['round1-core::F1', 'DEFERRED', '未纳入任何修复任务书，待下一轮'],
    ['round1-core::F2', 'FIXED', '#7'],
    ['round2-ai::R2-AI-001', 'FIXED', '#6'],
  ]));
  const r = run(fx);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  expect('合计 3 条全部表态', r.data?.totals?.unaccounted === 0, JSON.stringify(r.data?.totals));
  expect('没有 FAIL', !(r.data?.problems ?? []).some((p) => p.level === 'FAIL'),
    JSON.stringify(r.data?.problems));
  fx.cleanup();
}

// ── case 2：缺 1 条 → exit 1，且错误消息必须点名那条 id ──────────
console.log('case 2: 漏掉 1 条 → exit 1，并点名该 id（不是只报百分比）');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1'), finding('F2')],
    'round2-ai-audit.md': [finding('R2-AI-001')],
  }, ledgerTable([
    ['round1-core::F1', 'DEFERRED', '未纳入任何修复任务书，待下一轮'],
    ['round2-ai::R2-AI-001', 'FIXED', '#6'],
    // round1-core::F2 刻意漏掉
  ]));
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 finding_without_disposition', hasRule(r, 'finding_without_disposition'),
    JSON.stringify(rules(r)));
  const p = problemWith(r, 'finding_without_disposition');
  expect('错误消息点名 round1-core::F2', /round1-core::F2/.test(JSON.stringify(p ?? {})),
    JSON.stringify(p));
  expect('未表态计数 = 1', r.data?.totals?.unaccounted === 1, JSON.stringify(r.data?.totals));
  fx.cleanup();
}

// ── case 3：产物内 finding_id 重复 → exit 1 ─────────────────────
// 实测过：把 7 条 finding 的 id 改成完全相同，check-payload 仍报「✅ 契约合规」。
console.log('case 3: 同一份产物里 finding_id 重复 → exit 1（否则下游挂接会静默串线）');
{
  const fx = fixture({
    'round3-C-audit.md': [finding('F1'), finding('F1'), finding('F1')],
  }, ledgerTable([
    ['round3-C::F1', 'DEFERRED', '未纳入任何修复任务书，待下一轮'],
  ]));
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 duplicate_finding_id_in_artifacts', hasRule(r, 'duplicate_finding_id_in_artifacts'),
    JSON.stringify(rules(r)));
  const p = problemWith(r, 'duplicate_finding_id_in_artifacts');
  expect('说明丢了 2 条', /3|2/.test(JSON.stringify(p ?? {})), JSON.stringify(p));
  expect('去重后计数 1，但如实报告原始 3 条',
    r.data?.totals?.findings === 1 && r.data?.totals?.rawFindings === 3,
    JSON.stringify(r.data?.totals));
  fx.cleanup();
}

// ── case 4：去向表杜撰一个产物里不存在的 id → exit 1 ─────────────
console.log('case 4: 去向表里有、产物里没有 → exit 1（防杜撰）');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1')],
  }, ledgerTable([
    ['round1-core::F1', 'DEFERRED', '未纳入任何修复任务书，待下一轮'],
    ['round1-core::F9', 'FIXED', '#42'],
  ]));
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 disposition_without_finding', hasRule(r, 'disposition_without_finding'),
    JSON.stringify(rules(r)));
  expect('点名杜撰的 id', /F9/.test(JSON.stringify(problemWith(r, 'disposition_without_finding') ?? {})),
    JSON.stringify(problemWith(r, 'disposition_without_finding')));
  fx.cleanup();
}

// ── case 5：WONT_FIX 理由太短 → exit 1 ──────────────────────────
console.log('case 5: WONT_FIX 但「依据」少于 10 字 → exit 1');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1')],
  }, ledgerTable([
    ['round1-core::F1', 'WONT_FIX', '不修'],
  ]));
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 disposition_missing_reason', hasRule(r, 'disposition_missing_reason'),
    JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 6：DEFERRED 也要理由（否则「暂缓」就是垃圾桶）──────────
console.log('case 6: DEFERRED 但「依据」为空 → exit 1');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1')],
  }, ledgerTable([['round1-core::F1', 'DEFERRED', '']]));
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 disposition_missing_reason', hasRule(r, 'disposition_missing_reason'),
    JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 7：HIGH 被 DEFERRED → 醒目警告（这是「全填 DEFERRED」的唯一刹车）──
console.log('case 7: HIGH 被 DEFERRED → 有且只有 high_severity_unaccounted 警告');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1', 'HIGH'), finding('F2', 'LOW')],
  }, ledgerTable([
    ['round1-core::F1', 'DEFERRED', '等 #7 合并后一起处理'],
    ['round1-core::F2', 'DEFERRED', '未纳入任何修复任务书，待下一轮'],
  ]));
  const r = run(fx, ['--json']);
  expect('退出码 0（警告不阻断，但必须看得见）', r.code === 0, `实际 ${r.code}`);  const warn = (r.data?.problems ?? []).find((p) => p.rule === 'high_severity_unaccounted');
  expect('报 high_severity_unaccounted', !!warn, JSON.stringify(rules(r)));
  expect('级别是 WARN 而非 FAIL', warn?.level === 'WARN', warn?.level);
  expect('点名那条 HIGH', /round1-core::F1/.test(JSON.stringify(warn ?? {})), JSON.stringify(warn));
  expect('计数 = 1', warn?.high_unaccounted === 1, String(warn?.high_unaccounted));
  fx.cleanup();
}

// ── case 8：去向表不存在 → exit 2（配置错误，不是覆盖率问题）────
console.log('case 8: 去向表文件不存在 → exit 2，且不得假装「全绿」');
{
  const fx = fixture({ 'round1-core-audit.md': [finding('F1')] }, null);
  const r = run(fx);
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('报 ledger_missing', hasRule(r, 'ledger_missing'), JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 9：非法 disposition → exit 1 ───────────────────────────
console.log('case 9: disposition 不在四枚举内 → exit 1');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1')],
  }, ledgerTable([['round1-core::F1', 'LATER', '以后再说吧，反正现在不急']]));
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 invalid_disposition', hasRule(r, 'invalid_disposition'), JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 10：去向表里同一 id 两行 → exit 1 ─────────────────────
console.log('case 10: 去向表同一 id 出现两次 → exit 1（后一行会悄悄覆盖前一行）');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1')],
  }, ledgerTable([
    ['round1-core::F1', 'DEFERRED', '未纳入任何修复任务书，待下一轮'],
    ['round1-core::F1', 'FIXED', '#9'],
  ]));
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 ledger_duplicate_id', hasRule(r, 'ledger_duplicate_id'), JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 11：跨产物同名 id 必须用 scope 限定，裸 id 视为歧义 ────
// 真实数据就是这种形态：F1 同时出现在 4 份产物里，裸 id 无法确定指哪一条。
console.log('case 11: 裸 id 在 4 份产物里撞名 → 必须报歧义，不能随便挑一条算覆盖');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1')],
    'round2-arena-audit.md': [finding('F1')],
    'round2-mechanics-audit.md': [finding('F1')],
    'round3-C-audit.md': [finding('F1')],
  }, ledgerTable([
    ['F1', 'DEFERRED', '未纳入任何修复任务书，待下一轮'],
  ]));
  const r = run(fx);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 ambiguous_finding_reference', hasRule(r, 'ambiguous_finding_reference'),
    JSON.stringify(rules(r)));
  expect('4 条都仍算未表态', r.data?.totals?.unaccounted === 4, JSON.stringify(r.data?.totals));
  fx.cleanup();
}

// ── case 12：同一 fixture 用 scope 限定后就全绿（要求不是不可能满足的）──
console.log('case 12: 同样的产物，改用 scope::id 即可全绿');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1')],
    'round2-arena-audit.md': [finding('F1')],
    'round2-mechanics-audit.md': [finding('F1')],
    'round3-C-audit.md': [finding('F1')],
  }, ledgerTable([
    ['round1-core::F1', 'DEFERRED', '未纳入任何修复任务书，待下一轮'],
    ['round2-arena::F1', 'DEFERRED', '未纳入任何修复任务书，待下一轮'],
    ['round2-mechanics::F1', 'DEFERRED', '未纳入任何修复任务书，待下一轮'],
    ['round3-C::F1', 'DEFERRED', '未纳入任何修复任务书，待下一轮'],
  ]));
  const r = run(fx);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  expect('4 条全部表态', r.data?.totals?.accounted === 4, JSON.stringify(r.data?.totals));
  fx.cleanup();
}

// ── case 13：NEW_FINDING 允许不在产物内（修复中发现的第 39 条）──
console.log('case 13: NEW_FINDING 允许 id 不在产物里，但必须被单独计数');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1')],
  }, ledgerTable([
    ['round1-core::F1', 'FIXED', '#1'],
    ['#8', 'NEW_FINDING', '修复 #3 时新发现：重载入口不消费 loadFromFile 返回值'],
  ]));
  const r = run(fx);
  expect('退出码 0（不是杜撰）', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  expect('NEW_FINDING 被计数', r.data?.totals?.newFindings === 1, JSON.stringify(r.data?.totals));
  expect('没有 disposition_without_finding', !hasRule(r, 'disposition_without_finding'),
    JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 14：产物目录不存在 / 解析失败 → exit 2 ────────────────
console.log('case 14: 产物目录不存在 → exit 2');
{
  const fx = fixture({ 'round1-core-audit.md': [finding('F1')] },
    ledgerTable([['round1-core::F1', 'FIXED', '#1']]));
  try {
    execFileSync(process.execPath,
      [TOOL, '--artifacts', join(fx.root, 'nope'), '--ledger', fx.ledgerPath, '--json'],
      { encoding: 'utf8' });
    expect('退出码 2', false, '实际 0');
  } catch (e) {
    expect('退出码 2', e.status === 2, `实际 ${e.status}`);
  }
  fx.cleanup();
}

console.log('case 15: 产物里的 JSON 信封坏了 → exit 2，不能当成「没有 finding」');
{
  const fx = fixture({}, ledgerTable([]));
  writeFileSync(join(fx.out, 'broken-audit.md'), '# 坏产物\n\n```json\n{ "payload": { "findings": [ }\n```\n');
  const r = run(fx);
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('报 artifact_json_invalid', hasRule(r, 'artifact_json_invalid'), JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 16：产物里有 finding 迹象但没有信封 → exit 2（分母不可信）─────
console.log('case 16: 描述了 finding 却没有信封 → exit 2（否则分母悄悄变小）');
{
  // 2026-11-20 改：判据从「任何 .md 都必须有信封」收紧为
  // 「**描述了 finding 的** .md 必须有信封」。
  //
  // 原判据在真实产物目录上过于粗暴：交付物（审计总报告、去向表、任务书）
  // 本来就不带 findings 信封，混在同一层会让整次检查 exit 2 ——
  // 实测 `.run-hv/AUDIT-REPORT.md` 和 `TASK3.md` 都撞在这里。
  //
  // 但不变式不能松：只要一份 .md 里出现 finding 的数据形状，
  // 它就必须带信封，否则那批 finding 会静默漏出分母。
  const fx = fixture({ 'round1-core-audit.md': [finding('F1')] },
    ledgerTable([['round1-core::F1', 'FIXED', '#1']]));
  writeFileSync(join(fx.out, 'round9-orphan-audit.md'),
    '# 忘了贴信封的产物\n\n| finding_id | severity |\n|---|---|\n| F9 | HIGH |\n\n正文。\n');
  const r = run(fx);
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('报 artifact_without_envelope', hasRule(r, 'artifact_without_envelope'),
    JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 16b：不含 finding 迹象的交付物不得误伤 ──────────────────
console.log('case 16b: 交付物（无 finding 迹象、无信封）→ 跳过而不是 FAIL');
{
  const fx = fixture({ 'round1-core-audit.md': [finding('F1')] },
    ledgerTable([['round1-core::F1', 'DEFERRED', '本不少理由足够长']]));
  writeFileSync(join(fx.out, 'round1-final-report.md'),
    '# 最终报告\n\n这一轮审了 3 个切片，结论见各产物。\n');
  writeFileSync(join(fx.out, 'TASK3.md'),
    '对 13 条已确认的发现做深挖。\n\n## 硬约束\n1. 只读。\n');
  const r = run(fx);
  expect('不因交付物/任务书 exit 2', r.code !== 2, `实际 ${r.code}\n${JSON.stringify(rules(r))}`);
  expect('不报 artifact_without_envelope', !hasRule(r, 'artifact_without_envelope'),
    JSON.stringify(rules(r)));
  fx.cleanup();
}

// ── case 17：人类可读输出必须带 ✓ / ✗ / 合计 ──────────────────
console.log('case 17: 默认输出样式与既有校验器一致（✓ / ✗ / 合计）');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1'), finding('F2')],
  }, ledgerTable([['round1-core::F1', 'FIXED', '#1']]));
  const r = run(fx, [], { json: false });
  expect('含 ✗', /✗/.test(r.stdout), r.stdout.slice(0, 200));
  expect('含 合计', /合计/.test(r.stdout), r.stdout.slice(-200));
  expect('含「条 finding」计数', /38|2 条/.test(r.stdout), r.stdout.slice(-200));
  fx.cleanup();
}

// ── case 18：--help 必须自述去向表格式与枚举 ──────────────────
console.log('case 18: --help 说明去向表格式与四枚举');
{
  try {
    const out = execFileSync(process.execPath, [TOOL, '--help'], { encoding: 'utf8' });
    expect('含 finding_id / disposition 列名', /finding_id/.test(out) && /disposition/.test(out), out.slice(0, 200));
    for (const e of ['FIXED', 'WONT_FIX', 'DEFERRED', 'NEW_FINDING']) {
      expect(`枚举含 ${e}`, out.includes(e), out.slice(0, 200));
    }
    expect('含 --artifacts 与 --ledger', /--artifacts/.test(out) && /--ledger/.test(out));
  } catch (e) {
    expect('--help exit 0', false, `实际 ${e.status}`);
  }
}

// ── case 19：--strict-high 把「HIGH 被 DEFERRED」升级为 FAIL ────
// 默认 WARN 是有意的（DEFERRED 有时是对的选择），但它意味着
// 「全部填 DEFERRED」可以把任何交付判成绿。这个开关是那个漏洞的刹车。
console.log('case 19: --strict-high 下 HIGH 被 DEFERRED → exit 1');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1', 'HIGH')],
  }, ledgerTable([['round1-core::F1', 'DEFERRED', '等 #7 合并后一起处理']]));
  const r = run(fx, ['--strict-high']);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  const p = (r.data?.problems ?? []).find((x) => x.rule === 'high_severity_unaccounted');
  expect('规则升级为 FAIL', p?.level === 'FAIL', p?.level);
  fx.cleanup();
}

// ── case 20：围栏代码块里的示例行不得被当成真实行 ──────────────
// 真实去向表里贴一段「该怎么写」的示例很常见（示例表本身就这么做）。
// 若把围栏内容当成数据行，会凭空多出 NEW_FINDING 计数或假杜撰报错。
console.log('case 20: 围栏代码块里的示例表行被忽略');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1')],
  }, [
    '# 去向表',
    '',
    '| finding_id | disposition | 依据 |',
    '|---|---|---|',
    '| round1-core::F1 | FIXED | #1 |',
    '',
    '下面这段是写法示例，不是真实行：',
    '',
    '```',
    '| finding_id | disposition | 依据 |',
    '|---|---|---|',
    '| #8 | NEW_FINDING | 修复时新发现的第 39 条，不存在的示例 |',
    '```',
    '',
  ].join('\n'));
  const r = run(fx);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  expect('围栏里的 NEW_FINDING 未被计数', r.data?.totals?.newFindings === 0,
    JSON.stringify(r.data?.totals));
  expect('只有 1 行真实数据', r.data?.ledgerRows === 1, String(r.data?.ledgerRows));
  fx.cleanup();
}

// ── case 21：产物在子目录里 → 必须递归收进分母（不再 exit 2）──
console.log('case 21: 子目录里的产物必须进分母（原实现是 exit 2，等于拒绝对真实产物跑）');
{
  // 2026-11-20 改：原来「发现有子目录就 exit 2」，理由是对的（子目录产物不进
  // 分母 = 凭空白名单），但处置错了 —— 拒绝跑等于把「覆盖率算不全」换成
  // 「根本没有覆盖率」。仓库唯一一次真实审计 .run-hv 的产物天然在
  // findings/ critiques/ deep/ 三个子目录里，于是这个检查器对它 exit 2，
  // **最该跑的一次跑不了**。
  //
  // 现在递归遍历，用相对路径作产物标识（避免同名文件互相覆盖）。
  const fx = fixture({ 'round1-core-audit.md': [finding('F1')] },
    ledgerTable([['round1-core::F1', 'FIXED', '#1'], ['round9-x::F2', 'DEFERRED', '理由要足够长才行']]));
  mkdirSync(join(fx.out, 'round9'), { recursive: true });
  writeFileSync(join(fx.out, 'round9', 'round9-x-audit.md'), artifactMd('round9-x', [finding('F2')]));
  const r = run(fx);
  expect('不得因有子目录而 exit 2', r.code !== 2, `实际 ${r.code}\n${JSON.stringify(rules(r))}`);
  expect('不报 artifacts_contain_subdirectories', !hasRule(r, 'artifacts_contain_subdirectories'),
    JSON.stringify(rules(r)));
  expect('子目录里的 finding 进了分母',
    (r.data?.total_findings ?? r.data?.parsed ?? 2) === 2
      || /2 条 finding/.test(r.stdout ?? '') || /finding[^\n]*2/.test(r.stdout ?? ''),
    (r.stdout ?? JSON.stringify(r.data ?? {})).slice(-300));
  fx.cleanup();
}

// ── case 22：两个文件解析出同一 scope → exit 2（后一份会覆盖前一份）──
console.log('case 22: 两个产物文件映射到同一 scope → exit 2');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1')],
    'round1-core.md': [finding('F1')],   // 去掉 -audit 后同名
  }, ledgerTable([['round1-core::F1', 'FIXED', '#1']]));
  const r = run(fx);
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('报 artifact_scope_collision', hasRule(r, 'artifact_scope_collision'),
    JSON.stringify(rules(r)));
  fx.cleanup();
}

// ────────────────────────────────────────────────────────────────────
// R9 / 洞 2：HIGH 填 WONT_FIX 曾能洗掉 high_severity_unaccounted
//
// R7 实测（experiments/hilltop-dsh/FIX-R7-report.md §4 洞 2）：
//   8 条 HIGH 全填 WONT_FIX + 默认            -> exit 0 | highUnaccounted 0 | 无警告
//   8 条 HIGH 全填 WONT_FIX + --strict-high   -> exit 0 | highUnaccounted 0 | 无警告
// 根因：判据只认 DEFERRED / 无去向，WONT_FIX 根本没进判据。
//
// 处置：不把 WONT_FIX 混进 high_severity_unaccounted（两者性质不同），
// 而是单开 high_severity_wont_fix——WONT_FIX 主张「这不是缺陷」，
// 比 DEFERRED 的「下轮修」更强，所以它需要自己的一条可见规则。
// ────────────────────────────────────────────────────────────────────

const HIGH8 = ['F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8'];

console.log('case 23: 8 条 HIGH 全填 WONT_FIX（理由够长）→ 默认 WARN，且必须逐条点名');
{
  const fx = fixture({
    'round1-core-audit.md': HIGH8.map((id) => finding(id, 'HIGH')),
  }, ledgerTable(HIGH8.map((id, i) => [`round1-core::${id}`, 'WONT_FIX',
    `这是设计意图，第 ${i + 1} 处 src/ConfigManager.java:${100 + i} 的校验由调用方负责，不修`])));
  const r = run(fx);
  expect('退出码 0（WARN 不阻断）', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  const p = problemWith(r, 'high_severity_wont_fix');
  expect('报 high_severity_wont_fix', !!p, JSON.stringify(rules(r)));
  expect('级别是 WARN 而非 FAIL', p?.level === 'WARN', p?.level);
  expect('计数 = 8', p?.high_wont_fix === 8, String(p?.high_wont_fix));
  for (const id of HIGH8) {
    expect(`逐条点名 round1-core::${id}`,
      new RegExp(`round1-core::${id}(?![0-9])`).test(JSON.stringify(p ?? {})),
      JSON.stringify(p?.msg));
  }
  expect('消息里带理由摘录（读者能判断，而不是只看到个数）',
    /这是设计意图/.test(String(p?.msg ?? '')), String(p?.msg));
  expect('解释为什么 WONT_FIX 要单开一条规则',
    /DEFERRED/.test(String(p?.msg ?? '')) && /WONT_FIX/.test(String(p?.msg ?? '')), String(p?.msg));
  expect('totals.highWontFix = 8', r.data?.totals?.highWontFix === 8,
    JSON.stringify(r.data?.totals));
  expect('WONT_FIX 不混进 high_severity_unaccounted', !hasRule(r, 'high_severity_unaccounted'),
    JSON.stringify(rules(r)));
  fx.cleanup();
}

console.log('case 24: 8 条 HIGH 全填 DEFERRED → 仍然报 high_severity_unaccounted（既有行为不变）');
{
  const fx = fixture({
    'round1-core-audit.md': HIGH8.map((id) => finding(id, 'HIGH')),
  }, ledgerTable(HIGH8.map((id) => [`round1-core::${id}`, 'DEFERRED',
    '未纳入任何修复任务书，等下一轮统一评估'])));
  const r = run(fx);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  const p = problemWith(r, 'high_severity_unaccounted');
  expect('仍然报 high_severity_unaccounted', !!p, JSON.stringify(rules(r)));
  expect('计数仍然是 8', p?.high_unaccounted === 8, String(p?.high_unaccounted));
  expect('不误报到 high_severity_wont_fix', !hasRule(r, 'high_severity_wont_fix'),
    JSON.stringify(rules(r)));
  expect('totals.highWontFix = 0', r.data?.totals?.highWontFix === 0,
    JSON.stringify(r.data?.totals));
  fx.cleanup();
}

console.log('case 25: HIGH 填 FIXED → 不报任何 HIGH 相关警告');
{
  const fx = fixture({
    'round1-core-audit.md': HIGH8.map((id) => finding(id, 'HIGH')),
  }, ledgerTable(HIGH8.map((id) => [`round1-core::${id}`, 'FIXED', `#${id.slice(1)} 已修，红测通过`])));
  const r = run(fx);
  expect('退出码 0', r.code === 0, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  expect('没有 high_severity_wont_fix', !hasRule(r, 'high_severity_wont_fix'), JSON.stringify(rules(r)));
  expect('没有 high_severity_unaccounted', !hasRule(r, 'high_severity_unaccounted'),
    JSON.stringify(rules(r)));
  expect('没有 FAIL', !(r.data?.problems ?? []).some((p) => p.level === 'FAIL'),
    JSON.stringify(r.data?.problems));
  expect('highWontFix / highUnaccounted 都是 0',
    r.data?.totals?.highWontFix === 0 && r.data?.totals?.highUnaccounted === 0,
    JSON.stringify(r.data?.totals));
  fx.cleanup();
}

console.log('case 26: HIGH 填 WONT_FIX 但理由太短 → 同时报 disposition_missing_reason 与 high_severity_wont_fix');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1', 'HIGH')],
  }, ledgerTable([['round1-core::F1', 'WONT_FIX', '设计如此']]));
  const r = run(fx);
  expect('报 disposition_missing_reason', hasRule(r, 'disposition_missing_reason'),
    JSON.stringify(rules(r)));
  expect('HIGH 的 WONT_FIX 仍然可见（薄理由不能让它消失）', hasRule(r, 'high_severity_wont_fix'),
    JSON.stringify(rules(r)));
  fx.cleanup();
}

console.log('case 27: --strict-high 把 HIGH 的 WONT_FIX 从 WARN 升级为 FAIL');
{
  const fx = fixture({
    'round1-core-audit.md': HIGH8.map((id) => finding(id, 'HIGH')),
  }, ledgerTable(HIGH8.map((id, i) => [`round1-core::${id}`, 'WONT_FIX',
    `这是设计意图，第 ${i + 1} 处 src/ConfigManager.java:${100 + i} 的校验由调用方负责，不修`])));
  const r = run(fx, ['--strict-high']);
  expect('退出码 1', r.code === 1, `实际 ${r.code} / ${r.stdout.slice(-400)}`);
  const p = problemWith(r, 'high_severity_wont_fix');
  expect('规则升级为 FAIL', p?.level === 'FAIL', p?.level);
  expect('计数仍是 8', p?.high_wont_fix === 8, String(p?.high_wont_fix));
  fx.cleanup();
}

console.log('case 28: HIGH 的 WONT_FIX 理由过短（≥10 但 <40 字）→ 额外报 high_wont_fix_reason_thin');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1', 'HIGH')],
  }, ledgerTable([['round1-core::F1', 'WONT_FIX', '文案已告知，属设计意图']]));
  const r = run(fx);
  expect('不报 disposition_missing_reason（已过 10 字底线）',
    !hasRule(r, 'disposition_missing_reason'), JSON.stringify(rules(r)));
  expect('报 high_wont_fix_reason_thin', hasRule(r, 'high_wont_fix_reason_thin'),
    JSON.stringify(rules(r)));
  const p = problemWith(r, 'high_wont_fix_reason_thin');
  expect('级别是 WARN', p?.level === 'WARN', p?.level);
  expect('点名那条 HIGH 与字数', /round1-core::F1/.test(JSON.stringify(p ?? {}))
    && /11/.test(JSON.stringify(p ?? {})), JSON.stringify(p));
  fx.cleanup();
}

console.log('case 29: MEDIUM 的 WONT_FIX 不触发 HIGH 专属规则（门槛只对 HIGH 抬高）');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1', 'MEDIUM'), finding('F2', 'LOW')],
  }, ledgerTable([
    ['round1-core::F1', 'WONT_FIX', '文案已告知，属设计意图'],
    ['round1-core::F2', 'WONT_FIX', '不修'],
  ]));
  const r = run(fx);
  expect('不报 high_severity_wont_fix', !hasRule(r, 'high_severity_wont_fix'), JSON.stringify(rules(r)));
  expect('不报 high_wont_fix_reason_thin', !hasRule(r, 'high_wont_fix_reason_thin'),
    JSON.stringify(rules(r)));
  expect('LOW 的 2 字理由仍按既有规则 FAIL', hasRule(r, 'disposition_missing_reason'),
    JSON.stringify(rules(r)));
  fx.cleanup();
}

console.log('case 30: 人读输出必须写明 HEAD 的 WONT_FIX 条数（不能只在 JSON 里）');
{
  const fx = fixture({
    'round1-core-audit.md': [finding('F1', 'HIGH')],
  }, ledgerTable([['round1-core::F1', 'WONT_FIX',
    '这是设计意图，src/ConfigManager.java:42 的校验由调用方负责，不修']]));
  const r = run(fx, [], { json: false });
  expect('exit 0', r.code === 0, `实际 ${r.code}`);
  expect('输出含 high_severity_wont_fix', /high_severity_wont_fix/.test(r.stdout), r.stdout.slice(-600));
  expect('点名叫得上 id', /round1-core::F1/.test(r.stdout), r.stdout.slice(-600));
  expect('结论里点出 HIGH 的 WONT_FIX 条数', /WONT_FIX/.test(r.stdout), r.stdout.slice(-600));
  fx.cleanup();
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
