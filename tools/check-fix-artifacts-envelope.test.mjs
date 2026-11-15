#!/usr/bin/env node
/**
 * check-fix-artifacts-envelope.test.mjs — 修复产物信封闸门的自测
 *
 * 这个检查器守的是 R11 §8.2 指出的证据链**第 1 环**：
 *
 *   产物有没有信封（1） → 有没有人调校验器（2） → 路径存在吗（3）→ 内容对得上主张吗（4）
 *
 * 2026-11-15 那次事故的 6 份修复产物（experiments/hilltop-dsh/repair/done-*.md）
 * **全部没有 JSON 信封**。于是 check-payload 的每一条规则——包括「红测日志必须在
 * target/ 之外」「证据文件必须存在」——一次都没在它们身上跑过。
 * 不是规则错了，是规则**无法观测到这些产物**。
 *
 * 所以这里钉住的是「看不见」这件事本身：
 *   - 一份都没有信封的目录 → **逐份**报 FAIL，不是报「覆盖率 0%」
 *   - 空目录 → exit 2（配置错误，绝不能当成「全部合规」）
 *   - role 写成 audit / 缺 disposition → FAIL（信封在，但不是修复产物的信封）
 *   - 合法产物 → exit 0（包括多发现形态 dispositions[]）
 *
 * 全部用合成 fixture，不依赖 experiments/ 下的真实数据——
 * 真实数据会随修复漂移（有人补上信封后本测试就该继续绿），而规则不该随它漂移。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-fix-artifacts-envelope.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

// ── fixture 构造 ──────────────────────────────────────────────────
const VALID_PAYLOAD = (over = {}) => ({
  finding_id: 'F1',
  disposition: 'FIXED',
  test_path: 'src/test/FooTest.java',
  red_log_path: 'experiments/red-F1.log',
  files_touched: [{ path: 'src/Foo.java', change_summary: '修了' }],
  verification_commands: [{ command: 'mvn test', result: 'passed', output_snippet: 'ok' }],
  affected_issues: [],
  residual_risks: [],
  ...over,
});

const envelope = ({ role = 'fix', payload = VALID_PAYLOAD(), schema_version = 'output-contract-v1' } = {}) =>
  JSON.stringify({
    schema_version,
    agent_id: 'fix-agent-1',
    role,
    status: 'SUCCESS',
    contract_valid: true,
    artifact_path: 'out/round1-04-fix-1.md',
    payload,
    error: null,
  }, null, 2);

/** 产物正文 + 末尾信封。env 为 null 时**不写信封**（重演真实事故）。 */
const artifact = (env, body = '# 修复产物\n\n改了什么、为什么。\n') =>
  env === null ? `${body}\n## 风险\n\n- 无。\n` : `${body}\n\`\`\`json\n${env}\n\`\`\`\n`;

/** 在临时目录里造一批产物；files: { 文件名: 内容 } */
function fixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'fix-env-test-'));
  const dir = join(root, 'repair');
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return { root, dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 跑检查器，拿退出码 + stdout/stderr。stderr 必须捕获，否则 --help 用例会把整页说明漏进总检输出。 */
function run(args) {
  const opts = { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] };
  try {
    const stdout = execFileSync(process.execPath, [TOOL, ...args], opts);
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

/** 跑 --json 版本并解析。 */
function runJson(args) {
  const r = run([...args, '--json']);
  let data = null;
  try { data = JSON.parse(r.stdout); } catch { /* 留给断言报 */ }
  return { ...r, data };
}

const rulesOf = (data, level) => (data?.artifacts ?? [])
  .flatMap((a) => (a.rules ?? []).filter((r) => level === undefined || r.level === level).map((r) => r.rule));
const globalRules = (data, level) => (data?.problems ?? [])
  .filter((p) => level === undefined || p.level === level).map((p) => p.rule);

console.log('\n=== 修复产物信封闸门自测 ===\n');

console.log('case 1: --help 必须退出 0，并说明「有意保留历史产物」时怎么办');
{
  const r = run(['--help']);
  expect('退出码 0', r.code === 0, `实际 ${r.code}`);
  expect('提到 --dir', /--dir/.test(r.stdout), r.stdout.slice(0, 200));
  // 降级纪律：这个检查器故意不提供「忽略无信封产物」的开关。
  // 唯一出路是把历史产物挪进子目录并用 --dir 指向别处——必须在 help 里写明。
  expect('写明子目录 / --dir 的处置方式', /子目录/.test(r.stdout) && /--dir/.test(r.stdout));
}

console.log('case 2: --dir 不存在 → exit 2（配置错误，不是通过）');
{
  const r = runJson(['--dir', join(tmpdir(), 'definitely-not-here-' + Date.now())]);
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('报 dir_missing', globalRules(r.data).includes('dir_missing'), JSON.stringify(r.data?.problems));
}

console.log('case 3: 目录里一份修复产物都没有 → exit 2（空目录不能算全部合规）');
{
  const f = fixture({ 'REPAIR-LOG.md': '# 日志\n\n不是产物。\n' });
  const r = runJson(['--dir', f.dir]);
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
  expect('报 no_fix_artifacts', globalRules(r.data).includes('no_fix_artifacts'), JSON.stringify(r.data?.problems));
  f.cleanup();
}

console.log('case 4: 合法的单发现修复产物 → exit 0');
{
  const f = fixture({ 'done-1.md': artifact(envelope()) });
  const r = runJson(['--dir', f.dir]);
  expect('退出码 0', r.code === 0, `实际 ${r.code}: ${JSON.stringify(r.data?.problems ?? r.stderr)}`);
  expect('无 FAIL', rulesOf(r.data, 'FAIL').length === 0, JSON.stringify(rulesOf(r.data, 'FAIL')));
  expect('扫到 1 份产物', (r.data?.artifacts ?? []).length === 1, String(r.data?.artifacts?.length));
  f.cleanup();
}

console.log('case 5: 重演 2026-11-15 事故——6 份产物全部没有信封 → 必须 6 条 FAIL');
{
  const files = {};
  for (let i = 1; i <= 6; i++) files[`done-${i}.md`] = artifact(null);
  const f = fixture(files);
  const r = runJson(['--dir', f.dir]);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  const without = rulesOf(r.data, 'FAIL').filter((x) => x === 'artifact_without_envelope');
  // 核心：逐份点名，不是「通过率 0%」这种能被一句「已知问题」带过的汇总
  expect('6 条 artifact_without_envelope', without.length === 6, `实际 ${without.length}: ${JSON.stringify(rulesOf(r.data, 'FAIL'))}`);
  expect('每份产物都在报告里', (r.data?.artifacts ?? []).length === 6, String(r.data?.artifacts?.length));
  expect('单份产物只报一次（不重复刷屏）', (r.data?.artifacts ?? []).every((a) => a.rules.filter((x) => x.rule === 'artifact_without_envelope').length <= 1));
  f.cleanup();
}

console.log('case 6: 信封 JSON 解析失败 → FAIL envelope_invalid');
{
  // 截断的信封：真实产物常见形态（写完被截断、或 `"...",` 后直接结束）
  const broken = `# 修复产物\n\n\`\`\`json\n${envelope().slice(0, -30)}\n\`\`\`\n`;
  const f = fixture({ 'done-1.md': broken });
  const r = runJson(['--dir', f.dir]);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 envelope_invalid', rulesOf(r.data, 'FAIL').includes('envelope_invalid'), JSON.stringify(rulesOf(r.data, 'FAIL')));
  f.cleanup();
}

console.log('case 7: 信封 role 写成 audit → FAIL envelope_wrong_role');
{
  const f = fixture({ 'done-1.md': artifact(envelope({ role: 'audit' })) });
  const r = runJson(['--dir', f.dir]);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 envelope_wrong_role', rulesOf(r.data, 'FAIL').includes('envelope_wrong_role'), JSON.stringify(rulesOf(r.data, 'FAIL')));
  f.cleanup();
}

console.log('case 8: payload 里没有 disposition → FAIL envelope_missing_disposition（复用 R3 契约）');
{
  const p = VALID_PAYLOAD();
  delete p.disposition;
  const f = fixture({ 'done-1.md': artifact(envelope({ payload: p })) });
  const r = runJson(['--dir', f.dir]);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 envelope_missing_disposition',
    rulesOf(r.data, 'FAIL').includes('envelope_missing_disposition'), JSON.stringify(rulesOf(r.data, 'FAIL')));
  f.cleanup();
}

console.log('case 9: 多发现形态 dispositions[] 是权威清单，不能被判「缺 disposition」');
{
  const ok = fixture({
    'done-1.md': artifact(envelope({
      payload: {
        target_finding_ids: ['F1', 'F2'],
        dispositions: [
          { finding_id: 'F1', disposition: 'FIXED', test_path: 'a', red_log_path: 'b' },
          { finding_id: 'F2', disposition: 'DEFERRED', disposition_reason: '下一轮一并处理，因为它依赖 F1 的合并' },
        ],
        files_touched: [],
      },
    })),
  });
  const r1 = runJson(['--dir', ok.dir]);
  expect('多发现合法 → 退出码 0', r1.code === 0, `实际 ${r1.code}: ${JSON.stringify(rulesOf(r1.data, 'FAIL'))}`);
  ok.cleanup();

  // 空数组不是「一条都没表态」的合法写法——它就是没有 disposition
  const empty = fixture({
    'done-1.md': artifact(envelope({ payload: { dispositions: [], files_touched: [] } })),
  });
  const r2 = runJson(['--dir', empty.dir]);
  expect('dispositions=[] → FAIL', r2.code === 1 && rulesOf(r2.data, 'FAIL').includes('envelope_missing_disposition'),
    `${r2.code} ${JSON.stringify(rulesOf(r2.data, 'FAIL'))}`);
  empty.cleanup();

  // 数组里某一条漏了 disposition，同样要被点名（第二条静默蒸发是最隐蔽的失败）
  const partial = fixture({
    'done-1.md': artifact(envelope({
      payload: {
        dispositions: [{ finding_id: 'F1', disposition: 'FIXED' }, { finding_id: 'F2' }],
        files_touched: [],
      },
    })),
  });
  const r3 = runJson(['--dir', partial.dir]);
  expect('dispositions 内某条缺 disposition → FAIL',
    r3.code === 1 && rulesOf(r3.data, 'FAIL').includes('envelope_missing_disposition'),
    `${r3.code} ${JSON.stringify(rulesOf(r3.data, 'FAIL'))}`);
  partial.cleanup();
}

console.log('case 10: 文件名不符合 *-04-fix-*.md / done-*.md → WARN（不阻塞）');
{
  const f = fixture({ 'wave4-fix.md': artifact(envelope()) });
  const r = runJson(['--dir', f.dir, '--pattern', '*.md']);
  expect('退出码 0（WARN 不阻塞）', r.code === 0, `实际 ${r.code}: ${JSON.stringify(rulesOf(r.data, 'FAIL'))}`);
  expect('报 artifact_name_not_conforming', rulesOf(r.data, 'WARN').includes('artifact_name_not_conforming'),
    JSON.stringify(rulesOf(r.data, 'WARN')));
  f.cleanup();

  // 合规名字不该被警告
  const g = fixture({ 'round1-04-fix-3.md': artifact(envelope()) });
  const r2 = runJson(['--dir', g.dir]);
  expect('round1-04-fix-3.md 不警告', !rulesOf(r2.data, 'WARN').includes('artifact_name_not_conforming'),
    JSON.stringify(rulesOf(r2.data, 'WARN')));
  expect('默认 pattern 能扫到 *-fix-*.md', (r2.data?.artifacts ?? []).length === 1);
  g.cleanup();
}

console.log('case 11: 有 json 代码块但不是信封（正文里的示例数据）→ 仍判 artifact_without_envelope');
{
  const body = '# 修复\n\n示例数据：\n\n```json\n{ "a": 1 }\n```\n\n没有信封。\n';
  const f = fixture({ 'done-1.md': body });
  const r = runJson(['--dir', f.dir]);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('报 artifact_without_envelope', rulesOf(r.data, 'FAIL').includes('artifact_without_envelope'),
    JSON.stringify(rulesOf(r.data, 'FAIL')));
  f.cleanup();
}

console.log('case 12: 混合目录——好的放行，坏的逐份点名');
{
  const f = fixture({
    'done-1.md': artifact(envelope()),
    'done-2.md': artifact(null),
    'done-3.md': artifact(envelope({ role: 'verify' })),
  });
  const r = runJson(['--dir', f.dir]);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  expect('恰好 2 条 FAIL', rulesOf(r.data, 'FAIL').length === 2, JSON.stringify(rulesOf(r.data, 'FAIL')));
  const byFile = Object.fromEntries((r.data?.artifacts ?? []).map((a) => [a.file, a.rules.map((x) => x.rule)]));
  expect('done-1.md 无规则触发', (byFile['done-1.md'] ?? []).length === 0, JSON.stringify(byFile));
  expect('done-2.md 报无信封', (byFile['done-2.md'] ?? []).includes('artifact_without_envelope'), JSON.stringify(byFile));
  expect('done-3.md 报 role 错', (byFile['done-3.md'] ?? []).includes('envelope_wrong_role'), JSON.stringify(byFile));
  f.cleanup();
}

console.log('case 13: --pattern 可重复，只扫选中的文件');
{
  const f = fixture({
    'round1-04-fix-1.md': artifact(envelope()),
    'round1-05-verify-1.md': artifact(null),
  });
  const r = runJson(['--dir', f.dir, '--pattern', '*-04-fix-*.md']);
  expect('只扫 1 份', (r.data?.artifacts ?? []).length === 1, String(r.data?.artifacts?.length));
  expect('退出码 0', r.code === 0, `实际 ${r.code}`);

  // 选不中任何东西 = 配置错误，不是「全部合规」
  const r2 = runJson(['--dir', f.dir, '--pattern', '*-nothing-*.md']);
  expect('选不中任何文件 → exit 2', r2.code === 2, `实际 ${r2.code}`);
  f.cleanup();
}

console.log('case 14: 参数错误 → exit 2');
{
  const r = run(['--dir']);
  expect('--dir 无值 → 2', r.code === 2, `实际 ${r.code}`);
  const f = fixture({ 'done-1.md': artifact(envelope()) });
  const r2 = run(['--dir', f.dir, '--bogus']);
  expect('未知参数 → 2', r2.code === 2, `实际 ${r2.code}`);
  f.cleanup();
}

console.log('case 15: 子目录不扫描，但必须报 WARN（不能静默白名单）');
{
  const root = mkdtempSync(join(tmpdir(), 'fix-env-sub-'));
  const dir = join(root, 'repair');
  mkdirSync(join(dir, 'legacy'), { recursive: true });
  writeFileSync(join(dir, 'done-1.md'), artifact(envelope()));
  writeFileSync(join(dir, 'legacy', 'done-old.md'), artifact(null));
  const r = runJson(['--dir', dir]);
  expect('退出码 0（子目录不阻塞）', r.code === 0, `实际 ${r.code}`);
  // 这是目录级 WARN（不挂某一份产物），所以查 problems 而非 artifacts[].rules
  expect('报 subdirectory_not_scanned', globalRules(r.data, 'WARN').includes('subdirectory_not_scanned'),
    JSON.stringify(globalRules(r.data, 'WARN')));
  expect('子目录里的产物不进分母', (r.data?.artifacts ?? []).length === 1, String(r.data?.artifacts?.length));
  rmSync(root, { recursive: true, force: true });
}

console.log('case 16: 尾随逗号容错解析 → 放行但必须留 WARN（不能静默改写）');
{
  const withComma = envelope().replace(/\n}$/, ',\n}');
  const f = fixture({ 'done-1.md': artifact(withComma) });
  const r = runJson(['--dir', f.dir]);
  expect('退出码 0', r.code === 0, `实际 ${r.code}: ${JSON.stringify(rulesOf(r.data, 'FAIL'))}`);
  expect('报 json_trailing_comma_fixed', rulesOf(r.data, 'WARN').includes('json_trailing_comma_fixed'),
    JSON.stringify(rulesOf(r.data, 'WARN')));
  f.cleanup();
}

console.log('case 17: --json 输出结构可解析且带 totals');
{
  const f = fixture({ 'done-1.md': artifact(null) });
  const r = runJson(['--dir', f.dir]);
  expect('可解析', r.data !== null, r.stdout.slice(0, 200));
  expect('totals.fail >= 1', (r.data?.totals?.fail ?? 0) >= 1, JSON.stringify(r.data?.totals));
  expect('exitCode 写在输出里', r.data?.exitCode === 1, String(r.data?.exitCode));
  f.cleanup();
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
