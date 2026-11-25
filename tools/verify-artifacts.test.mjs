#!/usr/bin/env node
/**
 * 自测：用构造的样本验证 verify-artifacts.mjs 真的能抓到问题。
 *
 * 一个从没抓到过已知缺陷的校验器，和没有校验器是一样的。
 * 这里每个 case 都是「已知该失败 → 必须失败」或「已知该通过 → 必须通过」。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const VERIFIER = join(HERE, 'verify-artifacts.mjs');

let passCount = 0, failCount = 0;

// 2026-11-09：salvageFromMarkdown 改为默认关闭（--legacy-salvage 才启用），
// 因为根因已修（契约 §0 要求 JSON 信封），保留它会给「不写 JSON」留后路。
// 但旧测试用例构造的是 Markdown 散文产物——那些正是 legacy 路径要处理的形态。
// 所以这里给所有用例默认带上 --legacy-salvage，保留对历史兼容能力的测试。
function run(repo, artifacts, extra = []) {
  const base = extra.includes('--no-legacy') ? extra.filter(x => x !== '--no-legacy') : ['--legacy-salvage', ...extra];
  try {
    const out = execFileSync('node', [VERIFIER, '--repo', repo, '--artifacts', artifacts, '--json', ...base], {
      encoding: 'utf8',
    });
    return { code: 0, json: JSON.parse(out) };
  } catch (e) {
    // 退出码非 0 时 stdout 仍有内容
    try {
      return { code: e.status ?? 1, json: JSON.parse(e.stdout) };
    } catch {
      return { code: e.status ?? 1, json: null, raw: e.stdout };
    }
  }
}

function expect(name, cond, detail = '') {
  if (cond) { passCount++; console.log(`  ✓ ${name}`); }
  else { failCount++; console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function hasFinding(json, level, check) {
  return (json?.findings ?? []).some((f) => f.level === level && f.check === check);
}

function getFinding(json, level, check) {
  return (json?.findings ?? []).find((f) => f.level === level && f.check === check);
}

// ────────────────────────────────────────────────────────────────────
// 搭一个最小项目
// ────────────────────────────────────────────────────────────────────
function makeFixture(opts) {
  const root = mkdtempSync(join(tmpdir(), 'va-test-'));
  const repo = join(root, 'repo');
  const arts = join(root, 'artifacts');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(arts, { recursive: true });

  writeFileSync(join(repo, 'src', 'app.js'), [
    'function dispatch(id) {',
    '  const w = workers.get(id);',
    '  if (!w) throw new Error(`not found ${id}`);',
    '  return w;',
    '}',
  ].join('\n'));

  const artifactFile = join(arts, 'round1-02-audit-slice-01-logic.md');
  writeFileSync(artifactFile, opts.artifactBody ?? 'placeholder');

  const envelope = {
    schema_version: 'output-contract-v1',
    agent_id: 'a1',
    role: opts.role ?? 'audit',
    status: opts.status ?? 'SUCCESS',
    contract_valid: true,
    // 不能用 ?? —— artifactPath 显式传 null 时要保留 null，而不是回退到默认值
    artifact_path: Object.prototype.hasOwnProperty.call(opts, 'artifactPath') ? opts.artifactPath : artifactFile,
    payload: opts.payload ?? {},
    error: null,
  };

  writeFileSync(join(arts, 'result.md'),
    '# result\n\n```json\n' + JSON.stringify(envelope, null, 2) + '\n```\n');

  if (opts.state) {
    writeFileSync(join(arts, 'state.json'), JSON.stringify(opts.state, null, 2));
  }

  return { root, repo, arts, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

// ────────────────────────────────────────────────────────────────────
console.log('\n=== verify-artifacts.mjs 自测 ===\n');

// case 1: 全部合法 → 应通过
console.log('case 1: 门 0 回显正确 → 应 PASS');
{
  const f = makeFixture({
    payload: {
      slice_id: 'slice-01',
      findings: [{
        finding_id: 'F1',
        severity: 'HIGH',
        evidence: { file: 'src/app.js', line: 2, quote: 'const w = workers.get(id);' },
        inference: { claim: 'x', basis: 'y', alternatives: [] },
        status: 'CONFIRMED',
      }],
    },
  });
  const r = run(f.repo, f.arts);
  expect('退出码 0', r.code === 0, `got ${r.code}`);
  expect('G0 判 PASS', hasFinding(r.json, 'PASS', 'G0'), JSON.stringify(getFinding(r.json, 'FAIL', 'G0')));
  f.cleanup();
}

// case 2: quote 是编的 → 应 FAIL
console.log('case 2: 门 0 quote 在源文件里不存在（编造）→ 应 FAIL');
{
  const f = makeFixture({
    payload: {
      slice_id: 'slice-01',
      findings: [{
        finding_id: 'F1',
        severity: 'CRITICAL',
        evidence: { file: 'src/app.js', line: 2, quote: 'const worker = this.workers.get(agentId);' },
        inference: { claim: 'x', basis: 'y', alternatives: [] },
        status: 'CONFIRMED',
      }],
    },
  });
  const r = run(f.repo, f.arts);
  expect('退出码 1', r.code === 1, `got ${r.code}`);
  expect('G0 判 FAIL', hasFinding(r.json, 'FAIL', 'G0'));
  f.cleanup();
}

// case 3: evidence.file 不存在 → 应 FAIL
console.log('case 3: evidence.file 指向不存在的文件 → 应 FAIL');
{
  const f = makeFixture({
    payload: {
      findings: [{
        finding_id: 'F1',
        evidence: { file: 'src/ghost.js', line: 1, quote: 'anything' },
        inference: { claim: 'x', basis: 'y', alternatives: [] },
        status: 'CONFIRMED',
      }],
    },
  });
  const r = run(f.repo, f.arts);
  expect('G0 判 FAIL', hasFinding(r.json, 'FAIL', 'G0'));
  f.cleanup();
}

// case 4: 行号越界 → 应 FAIL
console.log('case 4: evidence.line 超出文件行数 → 应 FAIL');
{
  const f = makeFixture({
    payload: {
      findings: [{
        finding_id: 'F1',
        evidence: { file: 'src/app.js', line: 999, quote: 'x' },
        inference: { claim: 'x', basis: 'y', alternatives: [] },
        status: 'CONFIRMED',
      }],
    },
  });
  const r = run(f.repo, f.arts);
  const g0 = getFinding(r.json, 'FAIL', 'G0');
  expect('G0 判 FAIL', !!g0);
  expect('报出行数问题', /超出文件行数/.test(g0?.message ?? ''), g0?.message);
  f.cleanup();
}

// case 5: artifact_path 指向不存在的文件 → 应 FAIL
console.log('case 5: SUCCESS 但 artifact_path 文件不存在 → 应 FAIL');
{
  const f = makeFixture({
    artifactPath: '/nonexistent/path/round1-foo.md',
    payload: { findings: [{ finding_id: 'F1', evidence: { file: 'src/app.js', line: 1, quote: 'function dispatch(id) {' }, inference: { claim: 'x', basis: 'y', alternatives: [] }, status: 'CONFIRMED' }] },
  });
  const r = run(f.repo, f.arts);
  expect('G2 判 FAIL', hasFinding(r.json, 'FAIL', 'G2'));
  f.cleanup();
}

// case 6: artifact_path 缺失 → 应 FAIL
console.log('case 6: SUCCESS 但 artifact_path 为 null → 应 FAIL');
{
  const f = makeFixture({
    artifactPath: null,
    payload: { findings: [{ finding_id: 'F1', evidence: { file: 'src/app.js', line: 1, quote: 'function dispatch(id) {' }, inference: { claim: 'x', basis: 'y', alternatives: [] }, status: 'CONFIRMED' }] },
  });
  const r = run(f.repo, f.arts);
  expect('G2 判 FAIL', hasFinding(r.json, 'FAIL', 'G2'));
  f.cleanup();
}

// case 7: artifact 空文件 → 应 FAIL
console.log('case 7: artifact_path 指向空文件 → 应 FAIL');
{
  const root = mkdtempSync(join(tmpdir(), 'va-test-'));
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/app.js'), 'const x = 1;\n');
  const arts = join(root, 'artifacts'); mkdirSync(arts, { recursive: true });
  const empty = join(arts, 'empty.md'); writeFileSync(empty, '');
  writeFileSync(join(arts, 'r.md'), '```json\n' + JSON.stringify({
    schema_version: 'output-contract-v1', agent_id: 'a', role: 'audit', status: 'SUCCESS',
    contract_valid: true, artifact_path: empty, error: null,
    payload: { findings: [{ finding_id: 'F', evidence: { file: 'src/app.js', line: 1, quote: 'const x = 1;' }, inference: { claim: 'c', basis: 'b', alternatives: [] }, status: 'CONFIRMED' }] },
  }) + '\n```\n');
  const r = run(repo, arts);
  expect('G2 判 FAIL', hasFinding(r.json, 'FAIL', 'G2'));
  rmSync(root, { recursive: true, force: true });
}

// case 8: lead_count 与实际不符 → 应 FAIL
console.log('case 8: lead_count 自述数字与实际不符 → 应 FAIL');
{
  const f = makeFixture({
    role: 'sweep',
    payload: {
      slice_id: 's1',
      reachability: 'PROD',
      files_read: ['src/app.js'],
      leads: [{ lead_id: 'L1', suspected_dimension: 'logic', file: 'src/app.js', line: 1, quote: 'x', why_suspicious: 'y', confidence: 'LOW' }],
      lead_count: 5,
      dimension_histogram: { logic: 5, concurrency: 0, security: 0, 'error-handling': 0, 'data-consistency': 0, contract: 0 },
    },
  });
  const r = run(f.repo, f.arts);
  expect('G5 判 FAIL', hasFinding(r.json, 'FAIL', 'G5'));
  f.cleanup();
}

// case 9: audit findings 空数组 → 应 FAIL
console.log('case 9: audit 的 findings 是空数组 → 应 FAIL');
{
  const f = makeFixture({ role: 'audit', payload: { slice_id: 's1', findings: [] } });
  const r = run(f.repo, f.arts);
  expect('G5 判 FAIL', hasFinding(r.json, 'FAIL', 'G5'));
  f.cleanup();
}

// case 10: 账本裁量未申报 → 应 FAIL
console.log('case 10: 派发标了裁量指派维度但 discipline_log 无记录 → 应 FAIL');
{
  const f = makeFixture({
    payload: { findings: [{ finding_id: 'F1', evidence: { file: 'src/app.js', line: 1, quote: 'function dispatch(id) {' }, inference: { claim: 'x', basis: 'y', alternatives: [] }, status: 'CONFIRMED' }] },
    state: {
      budget: { planned_sweep_agents: 2, spawned_deep_dive: 1, failed_sweep: 0, failed_deep_dive: 0 },
      wave2_completed: [
        { agent_id: 'a1', slice_id: 'slice-07', task: 'deep_dive', dimension: 'logic', final_status: 'SUCCESS', artifact_path: 'x.md', dimension_assigned_by_discretion: true },
      ],
      discipline_log: [],
    },
  });
  const r = run(f.repo, f.arts);
  expect('G4 判 FAIL', hasFinding(r.json, 'FAIL', 'G4'));
  f.cleanup();
}

// case 11: mechanical_check 为空 → 应 FAIL
console.log('case 11: discipline_log 缺 mechanical_check → 应 FAIL');
{
  const f = makeFixture({
    payload: { findings: [{ finding_id: 'F1', evidence: { file: 'src/app.js', line: 1, quote: 'function dispatch(id) {' }, inference: { claim: 'x', basis: 'y', alternatives: [] }, status: 'CONFIRMED' }] },
    state: {
      budget: {},
      wave2_completed: [],
      discipline_log: [{ seq: 1, wave: 'wave-2a', discretion_type: 'FIFO_REORDER', action: 'x', basis: 'y', mechanical_check: '' }],
    },
  });
  const r = run(f.repo, f.arts);
  const g4 = getFinding(r.json, 'FAIL', 'G4');
  expect('G4 判 FAIL', !!g4);
  expect('报出 mechanical_check', /mechanical_check/.test(g4?.message ?? ''), g4?.message);
  f.cleanup();
}

// case 12: 空白差异 → 应 WARN 而非 FAIL
console.log('case 12: quote 只有缩进/空白差异 → 应 WARN（不算 FAIL）');
{
  const f = makeFixture({
    payload: {
      findings: [{
        finding_id: 'F1',
        evidence: { file: 'src/app.js', line: 2, quote: 'const    w    =    workers.get(id);' },
        inference: { claim: 'x', basis: 'y', alternatives: [] },
        status: 'CONFIRMED',
      }],
    },
  });
  const r = run(f.repo, f.arts);
  expect('G0 判 WARN', hasFinding(r.json, 'WARN', 'G0'), JSON.stringify(getFinding(r.json, 'FAIL', 'G0')));
  expect('退出码 0（非 strict）', r.code === 0, `got ${r.code}`);
  f.cleanup();
}

// case 13: 跨行 quote → 应通过
console.log('case 13: quote 跨多行 → 应通过');
{
  const f = makeFixture({
    payload: {
      findings: [{
        finding_id: 'F1',
        evidence: {
          file: 'src/app.js', line: 2,
          quote: 'const w = workers.get(id);\n  if (!w) throw new Error(`not found ${id}`);',
        },
        inference: { claim: 'x', basis: 'y', alternatives: [] },
        status: 'CONFIRMED',
      }],
    },
  });
  const r = run(f.repo, f.arts);
  expect('G0 未判 FAIL', !hasFinding(r.json, 'FAIL', 'G0'));
  f.cleanup();
}

// case 14: 产物 JSON 语法错误 → 应 FAIL
console.log('case 14: 产物里的 JSON 块语法错误 → 应 FAIL');
{
  const root = mkdtempSync(join(tmpdir(), 'va-test-'));
  const repo = join(root, 'repo'); mkdirSync(repo, { recursive: true });
  const arts = join(root, 'artifacts'); mkdirSync(arts, { recursive: true });
  writeFileSync(join(arts, 'bad.md'), '```json\n{ "role": "audit", BROKEN\n```\n');
  const r = run(repo, arts);
  expect('G6 判 FAIL', hasFinding(r.json, 'FAIL', 'G6'), JSON.stringify(r.json?.findings));
  rmSync(root, { recursive: true, force: true });
}

// case 15: 找不到 state.json → 应 SKIP 而不是 FAIL
console.log('case 15: 无 state.json → 应 SKIP 而非 FAIL');
{
  const f = makeFixture({
    payload: { findings: [{ finding_id: 'F1', evidence: { file: 'src/app.js', line: 1, quote: 'function dispatch(id) {' }, inference: { claim: 'x', basis: 'y', alternatives: [] }, status: 'CONFIRMED' }] },
  });
  const r = run(f.repo, f.arts);
  expect('G4 判 SKIP', hasFinding(r.json, 'SKIP', 'G4'));
  expect('G4 未判 FAIL', !hasFinding(r.json, 'FAIL', 'G4'));
  f.cleanup();
}

// case 16: /d/ 风格路径（Git Bash）→ 必须能正确解析，不能误报不存在
console.log('case 16: artifact_path 用 Git Bash 风格 /d/... → 应正确解析');
{
  const f = makeFixture({
    payload: { findings: [{ finding_id: 'F1', evidence: { file: 'src/app.js', line: 1, quote: 'function dispatch(id) {' }, inference: { claim: 'x', basis: 'y', alternatives: [] }, status: 'CONFIRMED' }] },
  });
  // 把产物里的 artifact_path 改写成 /d/... 形态（Git Bash 常见输出）
  const artPath = join(f.arts, 'round1-02-audit-slice-01-logic.md');
  const gitBashPath = artPath.replace(/^([A-Za-z]):\\/, (_m, d) => `/${d.toLowerCase()}/`).replace(/\\/g, '/');
  const resultFile = join(f.arts, 'result.md');
  const text = readFileSync(resultFile, 'utf8').replace(
    /"artifact_path":\s*"[^"]*"/,
    `"artifact_path": ${JSON.stringify(gitBashPath)}`
  );
  writeFileSync(resultFile, text);

  const r = run(f.repo, f.arts);
  const g2fail = getFinding(r.json, 'FAIL', 'G2');
  expect('G2 未误报（/d/ 路径被正确归一化）', !g2fail, g2fail?.message);
  f.cleanup();
}

// case 17: 产物写成 Markdown 散文而非 JSON 信封 → 应降级抽取并验证，而非静默 SKIP
console.log('case 17: 产物是 Markdown 散文（无 JSON 信封）→ 应降级抽取 G7 + 验证 quote');
{
  const root = mkdtempSync(join(tmpdir(), 'va-test-'));
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/app.js'), 'function dispatch(id) {\n  const w = workers.get(id);\n  if (!w) throw new Error(`nf ${id}`);\n}\n');
  const arts = join(root, 'artifacts'); mkdirSync(arts, { recursive: true });
  // 模拟实测中 agent 写的 Markdown 格式（file 与 line 同一行）
  writeFileSync(join(arts, 'round1-02-sweep-slice-01.md'), [
    '# slice-01 宽扫',
    '',
    '## Leads',
    '',
    '### L1 — logic / HIGH',
    '- **file**: `src/app.js` **line 2**',
    '- **quote**: `  const w = workers.get(id);`',
    '- **why**: 可疑',
    '',
    '### L2 — error-handling / MEDIUM',
    '- **file**: `src/app.js` **line 3**',
    '- **quote**: `  if (!w) throw new Error(`nf ${id}`);`',
    '- **why**: 含内嵌反引号，测试截断',
  ].join('\n'));

  const r = run(repo, arts);
  expect('G7 报降级抽取', hasFinding(r.json, 'WARN', 'G7'), JSON.stringify((r.json?.findings ?? []).map(f => f.check + ':' + f.level)));
  const g7 = getFinding(r.json, 'WARN', 'G7');
  expect('抽到 2 条', /2 条/.test(g7?.message ?? ''), g7?.message);
  expect('G0 未判 FAIL（quote 都真实）', !hasFinding(r.json, 'FAIL', 'G0'),
    JSON.stringify(getFinding(r.json, 'FAIL', 'G0')));
  rmSync(root, { recursive: true, force: true });
}

// case 18: Markdown 里 quote 含内嵌反引号 → 不能被截断
console.log('case 18: quote 含内嵌反引号 → 不被截断，仍能匹配');
{
  const root = mkdtempSync(join(tmpdir(), 'va-test-'));
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/a.js'), 'const m = `hello ${name}`;\n');
  const arts = join(root, 'artifacts'); mkdirSync(arts, { recursive: true });
  writeFileSync(join(arts, 'r.md'), [
    '### L1 — logic / HIGH',
    '- **file**: `src/a.js` **line 1**',
    '- **quote**: `const m = `hello ${name}`;`',
  ].join('\n'));
  const r = run(repo, arts);
  expect('G0 未判 FAIL', !hasFinding(r.json, 'FAIL', 'G0'),
    JSON.stringify(getFinding(r.json, 'FAIL', 'G0')));
  rmSync(root, { recursive: true, force: true });
}

// case 19: Markdown 但引用的 quote 是编的 → 降级抽取后仍应 FAIL
console.log('case 19: Markdown 产物里的 quote 是编造的 → 降级抽取后仍 FAIL');
{
  const root = mkdtempSync(join(tmpdir(), 'va-test-'));
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/app.js'), 'const real = 1;\n');
  const arts = join(root, 'artifacts'); mkdirSync(arts, { recursive: true });
  writeFileSync(join(arts, 'r.md'), [
    '### L1 — logic / HIGH',
    '- **file**: `src/app.js` **line 1**',
    '- **quote**: `const totallyMadeUp = 999;`',
  ].join('\n'));
  const r = run(repo, arts);
  expect('G0 判 FAIL', hasFinding(r.json, 'FAIL', 'G0'),
    JSON.stringify((r.json?.findings ?? []).map(f => f.check + ':' + f.level)));
  rmSync(root, { recursive: true, force: true });
}

// case 20: 完全没有内容的空骨架 → 应 SKIP 而非 FAIL
console.log('case 20: 空骨架（无线索无信封）→ 必须判 FAIL，不能静默 SKIP');
{
  // 2026-11-14 改：原期望是「无 FAIL，只 SKIP」。
  // 但「全 SKIP」意味着所有检查都被跳过、于是没有任何检查失败——
  // 一份产物都没验证到却报绿，和「目录配错了」长得一模一样。
  // 实测过空目录得到 `0 FAIL / 0 PASS / 6 SKIP` → exit 0。
  // 现在：没有信封也没有降级线索 = 什么都没验证 = FAIL。
  const root = mkdtempSync(join(tmpdir(), 'va-test-'));
  const repo = join(root, 'repo'); mkdirSync(repo, { recursive: true });
  const arts = join(root, 'artifacts'); mkdirSync(arts, { recursive: true });
  writeFileSync(join(arts, 'skeleton.md'), '# slice-01 宽扫\n\n（进行中）\n');
  const r = run(repo, arts);
  expect('G0 判 FAIL（什么都没验证不等于通过）', hasFinding(r.json, 'FAIL', 'G0'),
    JSON.stringify((r.json?.findings ?? []).filter((f) => f.check === 'G0')));
  expect('无 G7（抽不到东西就不报）', !hasFinding(r.json, 'WARN', 'G7'));
  rmSync(root, { recursive: true, force: true });
}

// case 21: quote 带 grep 的 filename:line: 前缀 → 剥掉装饰后仍须匹配正文
console.log('case 21: quote 是 grep 整行输出（含 filename:line 前缀）→ 应通过');
{
  const root = mkdtempSync(join(tmpdir(), 'va-test-'));
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/app.js'), 'const a = 1;\nconst b = 2;\n');
  const arts = join(root, 'artifacts'); mkdirSync(arts, { recursive: true });
  writeFileSync(join(arts, 'r.md'), [
    '### L1 — logic / HIGH',
    '- **file**: `src/app.js` **line 2**',
    '- **quote**: `index.html:2:  const b = 2;`',
  ].join('\n'));
  const r = run(repo, arts);
  expect('G0 未判 FAIL（前缀不算错）', !hasFinding(r.json, 'FAIL', 'G0'),
    JSON.stringify(getFinding(r.json, 'FAIL', 'G0')));
  rmSync(root, { recursive: true, force: true });
}

// case 22: 带 grep 前缀但正文是编的 → 剥掉前缀后仍应 FAIL
console.log('case 22: quote 带 grep 前缀且正文编造 → 仍应 FAIL');
{
  const root = mkdtempSync(join(tmpdir(), 'va-test-'));
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/app.js'), 'const a = 1;\n');
  const arts = join(root, 'artifacts'); mkdirSync(arts, { recursive: true });
  writeFileSync(join(arts, 'r.md'), [
    '### L1 — logic / HIGH',
    '- **file**: `src/app.js` **line 1**',
    '- **quote**: `index.html:1:  const TOTALLY_FAKE = 999;`',
  ].join('\n'));
  const r = run(repo, arts);
  expect('G0 判 FAIL（剥前缀不是放宽标准）', hasFinding(r.json, 'FAIL', 'G0'),
    JSON.stringify((r.json?.findings ?? []).map(f => f.check + ':' + f.level)));
  rmSync(root, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────
// 2026-11-09 新增：默认模式下「没有 JSON 信封」必须报 FAIL，而不是悄悄 salvage
// ────────────────────────────────────────────────────────────────────

console.log('case 23: 默认模式下产物没有 JSON 信封 → 必须 FAIL（不允许悄悄猜）');
{
  const root = mkdtempSync(join(tmpdir(), 'va-test-'));
  const repo = join(root, 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src/a.js'), 'const x = 1;\n');
  const arts = join(root, 'artifacts'); mkdirSync(arts, { recursive: true });
  // 写一个「有线索但没信封」的产物
  writeFileSync(join(arts, 'r.md'), [
    '### L1 — logic / HIGH',
    '- **file**: `src/a.js` **line 1**',
    '- **quote**: `const x = 1;`',
  ].join('\n'));

  const r = run(repo, arts, ['--no-legacy']);
  const g7 = getFinding(r.json, 'FAIL', 'G7');
  expect('G7 判 FAIL', !!g7, JSON.stringify((r.json?.findings ?? []).map(f => f.check + ':' + f.level)));
  expect('提示要用 check-payload', /check-payload/.test(g7?.detail?.检查 ?? ''), JSON.stringify(g7?.detail));
  expect('退出码 1', r.code === 1, `got ${r.code}`);
  rmSync(root, { recursive: true, force: true });
}

console.log('case 24: 交付物（final-report / ledger）不受 JSON 信封要求约束');
{
  const root = mkdtempSync(join(tmpdir(), 'va-test-'));
  const repo = join(root, 'repo'); mkdirSync(repo, { recursive: true });
  const arts = join(root, 'artifacts'); mkdirSync(arts, { recursive: true });
  writeFileSync(join(arts, 'round1-final-report.md'), '# round1 审计报告\n\n## 0. 一句话结论\n无\n');
  writeFileSync(join(arts, 'round1-ledger.md'), '# round1 账本\n\n## 1. 切片状态表\n');

  const r = run(repo, arts, ['--no-legacy']);
  const g7fail = (r.json?.findings ?? []).filter(f => f.check === 'G7' && f.level === 'FAIL');
  expect('交付物不被要求 JSON 信封', g7fail.length === 0,
    JSON.stringify(g7fail.map(f => f.message)));
  rmSync(root, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────
// 2026-11-10 红队 A6：删掉 quote 字段不能绕过门 0
// ────────────────────────────────────────────────────────────────────
console.log('case 36: 缺 quote 的 evidence 必须判 G0 FAIL，不能 SKIP');
{
  const dir = mkdtempSync(join(tmpdir(), 'v36-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.js'), 'const a = 1;\n');
  const env = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'audit',
    status: 'SUCCESS', contract_valid: true,
    artifact_path: join(dir, 'a.md'),
    payload: {
      slice_id: 's1',
      searched_scope: { files_read: ['src/a.js'], files_in_slice: 1, dimension_checklist: ['分支'] },
      findings: [{
        finding_id: 'f1', dimension: 'logic', severity: 'CRITICAL',
        evidence: { file: 'src/a.js', line: 1 },
        inference: { claim: 'c', basis: 'b', alternatives: ['x', 'y'] },
        status: 'CONFIRMED',
      }],
      self_checks: {
        identifier_reconcile: { status: 'DONE' },
        self_check_audit: { status: 'DONE' },
        runtime_validation: { status: 'DONE' },
      },
    },
    error: null,
  };
  const md = '# x\n\n```json\n' + JSON.stringify(env, null, 2) + '\n```\n';
  writeFileSync(join(dir, 'a.md'), md);
  const r = run(repo, dir);
  expect('G0 判 FAIL', hasFinding(r.json, 'FAIL', 'G0'));
  expect('G0 不再 SKIP', !hasFinding(r.json, 'SKIP', 'G0'));
  expect('退出码非 0', r.code !== 0);
  // 2026-11-25：上面三条只要求「有某个 G0 FAIL」。实测（变异测试 M4）：
  // 把**逐条**那条 fail（`evidence 缺 quote：…（<path>）`）删掉后，574 行的**汇总**
  // fail（`门 0 回显: 0/0 通过，1 条 evidence 缺 file 或 quote`）仍然会报，
  // 于是这三条断言全绿——**逐条诊断信息没有任何测试覆盖**。
  //
  // 逐条那条才是 Agent 能据以修正的东西：它点名是哪一个 finding、缺哪个字段、在哪个文件。
  // 只剩汇总行的话，agent 只知道「有人缺了」，不知道是谁。
  // 注意：断言必须比「消息里含 evidence 缺 和 quote」更严——**汇总行**的消息
  // 也长这样（`门 0 回显: 0/0 通过，1 条 evidence 缺 file 或 quote`），
  // 第一版我按那个模式写，变异后依然全绿。逐条那条的唯一特征短语是
  // 「的发现必须有 file:line + quote」——汇总行没有这句。
  //
  // 2026-11-26 又补一层：断言必须同时要求**点名文件**（`（<path>）`），
  // 因为「它点名是哪一个 finding、缺哪个字段、在哪个文件」才是这条消息的可操作价值。
  // 上一版只匹配前半句，把 `（${path}）` 删掉仍然全绿。
  expect('逐条诊断信息存在且点名文件（「…file:line + quote（<path>）」）',
    (r.json?.findings ?? []).some((f) => f.check === 'G0'
      && /的发现必须有 file:line \+ quote（.+）/.test(f.message ?? '')),
    JSON.stringify((r.json?.findings ?? []).filter((f) => f.check === 'G0').map((f) => f.message)));
  rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────
// 2026-11-10 蓝队 R1：合法的 NO_EVIDENCE_FOUND 不得被判 G0 FAIL
// ────────────────────────────────────────────────────────────────────
console.log('case 37: 合法的 NO_EVIDENCE_FOUND（evidence 全 null）不得被判违规');
{
  const dir = mkdtempSync(join(tmpdir(), 'v37-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.js'), 'const a = 1;\n');
  const env = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'audit',
    status: 'SUCCESS', contract_valid: true,
    artifact_path: join(dir, 'a.md'),
    payload: {
      slice_id: 's1',
      searched_scope: { files_read: ['src/a.js'], files_in_slice: 1, dimension_checklist: ['分支'] },
      findings: [{
        finding_id: 'f1', dimension: 'logic', severity: null,
        evidence: { file: null, line: null, quote: null },   // 契约要求的合法写法
        inference: {
          claim: '本切片未发现满足门 0 的问题',
          basis: '已读取全部切片文件并检查条件分支与循环边界，未发现可用证据',
          alternatives: [],
        },
        status: 'NO_EVIDENCE_FOUND',
      }],
      self_checks: {
        identifier_reconcile: { status: 'DONE' },
        self_check_audit: { status: 'DONE' },
        runtime_validation: { status: 'DONE' },
      },
    },
    error: null,
  };
  writeFileSync(join(dir, 'a.md'), '# x\n\n```json\n' + JSON.stringify(env, null, 2) + '\n```\n');
  const r = run(repo, dir);
  expect('G0 不判 FAIL（合法空证据）', !hasFinding(r.json, 'FAIL', 'G0'),
    JSON.stringify(getFinding(r.json, 'FAIL', 'G0')));
  expect('退出码 0', r.code === 0);
  rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────
// 2026-11-10 蓝队 A5：artifact_path 不能指向被审仓库内的源码
// ────────────────────────────────────────────────────────────────────
console.log('case 38: artifact_path 指向被审仓库内的源码 → G2 FAIL');
{
  const dir = mkdtempSync(join(tmpdir(), 'v38-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'const t=1;\n');
  const env = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'sweep',
    status: 'SUCCESS', contract_valid: true,
    artifact_path: join(repo, 'src', 'a.ts'),   // 指向源码，不是产物
    payload: {
      slice_id: 'slice-01', reachability: 'PROD', files_read: ['src/a.ts'],
      leads: [], lead_count: 0,
      dimension_histogram: { logic: 0, concurrency: 0, security: 0, 'error-handling': 0, 'data-consistency': 0, contract: 0 },
    },
    error: null,
  };
  const md = '# x\n\n```json\n' + JSON.stringify(env) + '\n```\n';
  writeFileSync(join(dir, 'a.md'), md);
  const r = run(repo, dir);
  expect('G2 判 FAIL', hasFinding(r.json, 'FAIL', 'G2'));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 39: 两个 Agent 复用同一产物 → G2 FAIL');
{
  const dir = mkdtempSync(join(tmpdir(), 'v39-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'const t=1;\n');
  const shared = join(dir, 'shared.md');
  writeFileSync(shared, '# 同一份产物\n');
  const mkEnv = (id) => ({
    schema_version: 'output-contract-v1', agent_id: id, role: 'sweep',
    status: 'SUCCESS', contract_valid: true, artifact_path: shared,
    payload: {
      slice_id: 'slice-01', reachability: 'PROD', files_read: ['src/a.ts'],
      leads: [], lead_count: 0,
      dimension_histogram: { logic: 0, concurrency: 0, security: 0, 'error-handling': 0, 'data-consistency': 0, contract: 0 },
    },
    error: null,
  });
  for (const [name, id] of [['a1.md', 'agent-1'], ['a2.md', 'agent-2']]) {
    writeFileSync(join(dir, name), '# x\n\n```json\n' + JSON.stringify(mkEnv(id)) + '\n```\n');
  }
  const r = run(repo, dir);
  expect('G2 判 FAIL', hasFinding(r.json, 'FAIL', 'G2'));
  expect('报出复用', (r.json?.findings ?? []).some((f) => /同一产物/.test(f.msg ?? f.message ?? '')));
  rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────
// 2026-11-10 蓝队 A6：门 0 的 fuzzy / loose 漏洞
// ────────────────────────────────────────────────────────────────────
console.log('case 40: quote 在附近但不声称的那一行 → G0 FAIL');
{
  const dir = mkdtempSync(join(tmpdir(), 'v40-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.js'), 'line one\nconst total = acct.balance - amt;\nline three\nline four\n');
  const env = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'audit',
    status: 'SUCCESS', contract_valid: true, artifact_path: join(dir, 'a.md'),
    payload: {
      slice_id: 's', searched_scope: { files_read: ['src/a.js'], files_in_slice: 1, dimension_checklist: ['x'] },
      findings: [{
        finding_id: 'F1', dimension: 'logic', severity: 'HIGH',
        evidence: { file: 'src/a.js', line: 4, quote: 'const total = acct.balance - amt;' },
        inference: { claim: 'x', basis: 'y', alternatives: [] }, status: 'CONFIRMED',
      }],
      self_checks: {
        identifier_reconcile: { status: 'DONE' }, self_check_audit: { status: 'DONE' },
        runtime_validation: { status: 'DONE' },
      },
    }, error: null,
  };
  writeFileSync(join(dir, 'a.md'), '# x\n\n```json\n' + JSON.stringify(env) + '\n```\n');
  const r = run(repo, dir);
  expect('G0 判 FAIL', hasFinding(r.json, 'FAIL', 'G0'));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 41: quote 省略运算符（fuzzy）→ G0 FAIL');
{
  const dir = mkdtempSync(join(tmpdir(), 'v41-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.js'), 'line one\nconst total = acct.balance - amt;\nline three\n');
  const env = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'audit',
    status: 'SUCCESS', contract_valid: true, artifact_path: join(dir, 'a.md'),
    payload: {
      slice_id: 's', searched_scope: { files_read: ['src/a.js'], files_in_slice: 1, dimension_checklist: ['x'] },
      findings: [{
        finding_id: 'F1', dimension: 'logic', severity: 'HIGH',
        evidence: { file: 'src/a.js', line: 2, quote: 'const total acct.balance amt' },
        inference: { claim: 'x', basis: 'y', alternatives: [] }, status: 'CONFIRMED',
      }],
      self_checks: {
        identifier_reconcile: { status: 'DONE' }, self_check_audit: { status: 'DONE' },
        runtime_validation: { status: 'DONE' },
      },
    }, error: null,
  };
  writeFileSync(join(dir, 'a.md'), '# x\n\n```json\n' + JSON.stringify(env) + '\n```\n');
  const r = run(repo, dir);
  expect('G0 判 FAIL', hasFinding(r.json, 'FAIL', 'G0'));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 42: quote 过短（1 字符）→ G0 FAIL');
{
  const dir = mkdtempSync(join(tmpdir(), 'v42-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.js'), 'x = 1;\n');
  const env = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'audit',
    status: 'SUCCESS', contract_valid: true, artifact_path: join(dir, 'a.md'),
    payload: {
      slice_id: 's', searched_scope: { files_read: ['src/a.js'], files_in_slice: 1, dimension_checklist: ['x'] },
      findings: [{
        finding_id: 'F1', dimension: 'logic', severity: 'HIGH',
        evidence: { file: 'src/a.js', line: 1, quote: 'x' },
        inference: { claim: 'x', basis: 'y', alternatives: [] }, status: 'CONFIRMED',
      }],
      self_checks: {
        identifier_reconcile: { status: 'DONE' }, self_check_audit: { status: 'DONE' },
        runtime_validation: { status: 'DONE' },
      },
    }, error: null,
  };
  writeFileSync(join(dir, 'a.md'), '# x\n\n```json\n' + JSON.stringify(env) + '\n```\n');
  const r = run(repo, dir);
  expect('G0 判 FAIL', hasFinding(r.json, 'FAIL', 'G0'));
  rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────
// 注释不是证据（2026-11-12 门 0 红队实测）
// ────────────────────────────────────────────────────────────────────

console.log('\ncase 门0-注释：quote 行号准确但整行是注释 → FAIL');
{
  // 实测：`// 不安全版本：容量检查写错` 行号准确、引文逐字存在，
  // 旧版门 0 判 PASS——但注释是作者的描述，不是代码的行为。
  const repo = mkdtempSync(join(tmpdir(), 'va-c-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'q.js'), [
    '// src/q.js',
    'export class Q {',
    '  // 不安全版本：容量检查写错',
    '  enqueue(t) {',
    '    if (this.items.length > 10) return false;',
    '    this.items.push(t);',
    '    return true;',
    '  }',
    '}',
  ].join('\n'));

  const dir = mkdtempSync(join(tmpdir(), 'va-a-'));
  const env = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'audit',
    status: 'SUCCESS', contract_valid: true, artifact_path: join(dir, 'a.md'),
    payload: {
      slice_id: 's1', files: ['src/q.js'], line_count: 9,
      searched_scope: {
        files_read: ['src/q.js'], files_in_slice: 1, shared_dependencies_read: [],
        dimension_checklist: ['条件分支'],
      },
      findings: [{
        finding_id: 'F1', dimension: 'logic', severity: 'HIGH',
        evidence: { file: 'src/q.js', line: 3, quote: '// 不安全版本：容量检查写错' },
        inference: { claim: '容量检查有缺陷', basis: '注释说这里不安全', alternatives: [] },
        status: 'CONFIRMED',
      }],
      self_checks: {
        identifier_reconcile: { status: 'DONE', note: '对账了 import 列表，无缺失' },
        self_check_audit: { status: 'DONE', note: '抽验了自检脚本的断言' },
        runtime_validation: { status: 'DONE', note: '跑了 12 次 enqueue 验证边界' },
      },
    },
    error: null,
  };
  writeFileSync(join(dir, 'a.md'), '# x\n\n```json\n' + JSON.stringify(env) + '\n```\n');
  const r = run(repo, dir);
  expect('G0 判 FAIL', hasFinding(r.json, 'FAIL', 'G0'));
  rmSync(repo, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 门0-注释：缺陷本身是「注释与实现不符」→ 不误伤（PASS）');
{
  // 反向对照。若这条被拦，说明注释禁令做得太宽，会惩罚合法发现——
  // 「JSDoc 声称返回 boolean 但无 return」这类缺陷的注释正是被审对象本身。
  const repo = mkdtempSync(join(tmpdir(), 'va-c2-'));
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'q.js'), [
    '// src/q.js',
    'export class Q {',
    '  /** 清空队列，@returns {boolean} 总是 true */',
    '  clear() {',
    '    this.items.length = 0;',
    '  }',
    '}',
  ].join('\n'));

  const dir = mkdtempSync(join(tmpdir(), 'va-a2-'));
  const env = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'audit',
    status: 'SUCCESS', contract_valid: true, artifact_path: join(dir, 'a.md'),
    payload: {
      slice_id: 's1', files: ['src/q.js'], line_count: 7,
      searched_scope: {
        files_read: ['src/q.js'], files_in_slice: 1, shared_dependencies_read: [],
        dimension_checklist: ['返回值语义'],
      },
      findings: [{
        finding_id: 'F1', dimension: 'contract', severity: 'LOW',
        evidence: { file: 'src/q.js', line: 3, quote: '/** 清空队列，@returns {boolean} 总是 true */' },
        inference: {
          claim: 'JSDoc 注释声称返回 boolean，但 clear() 的实现没有 return —— 注释与实现不符',
          basis: '注释写了 @returns {boolean}，第 4-6 行的方法体没有任何 return 语句',
          alternatives: ['调用方约定不使用返回值'],
        },
        status: 'CONFIRMED',
      }],
      self_checks: {
        identifier_reconcile: { status: 'DONE', note: '对账了 import 列表，无缺失' },
        self_check_audit: { status: 'DONE', note: '抽验了 JSDoc 与实现的一致性' },
        runtime_validation: { status: 'DONE', note: '调了 clear() 看返回值是 undefined' },
      },
    },
    error: null,
  };
  writeFileSync(join(dir, 'a.md'), '# x\n\n```json\n' + JSON.stringify(env) + '\n```\n');
  const r = run(repo, dir);
  expect('G0 不判 FAIL', !hasFinding(r.json, 'FAIL', 'G0'));
  rmSync(repo, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
}

// ────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────
// 2026-11-14：files_read 的对象形态（sweep 契约标准形态）曾让校验器崩溃
// ────────────────────────────────────────────────────────────────────
console.log('case 49: files_read 元素是对象 {path,lines,quote} → 不得崩溃');
{
  // sweep 契约 §2.2a 规定 files_read 是 [{path, lines, quote}]，而 verify-artifacts
  // 此前把元素直接喂给 path.isAbsolute（只接受字符串），于是**对 sweep 产物直接
  // 抛 TypeError: The "path" argument must be of type string**。
  // 这不是判错，是崩溃——崩溃时连「哪些能机械验证」都拿不到。
  const dir = mkdtempSync(join(tmpdir(), 'v49-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'const t=1;\n');
  const env = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'sweep',
    status: 'SUCCESS', contract_valid: true,
    artifact_path: join(dir, 'a.md'),
    payload: {
      slice_id: 'slice-01', reachability: 'PROD',
      files_read: [{ path: 'src/a.ts', lines: 1, quote: 'const t=1;' }],
      leads: [], lead_count: 0,
      dimension_histogram: { logic: 0, concurrency: 0, security: 0, 'error-handling': 0, 'data-consistency': 0, contract: 0 },
    },
    error: null,
  };
  writeFileSync(join(dir, 'a.md'), '# x\n\n```json\n' + JSON.stringify(env, null, 2) + '\n```\n');

  let crashed = false;
  let r = null;
  try { r = run(repo, dir); } catch { crashed = true; }
  expect('不崩溃', !crashed);
  expect('G1 不误报文件不存在', !hasFinding(r?.json, 'FAIL', 'G1'),
    JSON.stringify(getFinding(r?.json, 'FAIL', 'G1')));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 50: files_read 填目录 → G1 必须判 FAIL（目录不是「读过的文件」）');
{
  // 2026-11-14 红队实测：existsSync 对目录也返回 true，于是 files_read: ["src"]
  // 和 ["."] 都能通过 G1。这比「填不存在的文件」更难发现——路径看着是合法的，
  // 但「读了 src 目录」这句话本身没有意义。
  const dir = mkdtempSync(join(tmpdir(), 'v50-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.ts'), 'const t=1;\n');
  const env = {
    schema_version: 'output-contract-v1', agent_id: 'a1', role: 'sweep',
    status: 'SUCCESS', contract_valid: true,
    artifact_path: join(dir, 'a.md'),
    payload: {
      slice_id: 'slice-01', reachability: 'PROD',
      files_read: ['src'],   // 目录，不是文件
      leads: [], lead_count: 0,
      dimension_histogram: { logic: 0, concurrency: 0, security: 0, 'error-handling': 0, 'data-consistency': 0, contract: 0 },
    },
    error: null,
  };
  writeFileSync(join(dir, 'a.md'), '# x\n\n```json\n' + JSON.stringify(env, null, 2) + '\n```\n');
  const r = run(repo, dir);
  expect('G1 判 FAIL', hasFinding(r.json, 'FAIL', 'G1'),
    JSON.stringify(getFinding(r.json, 'FAIL', 'G1')));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 51: 波次产物改名成 -final-report.md → 不得靠改名豁免 G7');
{
  // 2026-11-14 批判实测：交付物豁免是按**文件名**判的，改名即可绕过（exit 1 → 0），
  // 内容一字未改。也就是说「有没有写 JSON 信封」这件事由文件名决定，而不是内容。
  // 修：除文件名外还要求内容里没有波次产物的机器字段。
  const dir = mkdtempSync(join(tmpdir(), 'v51-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.js'), 'const a=1;\n');
  const art = join(dir, 'arts');
  mkdirSync(art, { recursive: true });

  // 内容是波次产物（有 slice_id），但文件名伪装成交付物，且没有 JSON 信封
  writeFileSync(join(art, 'round1-final-report.md'),
    '# 假冒交付物\n\n正文里写着 slice_id: "S1"，lead_count: 3，但没有 JSON 信封。\n');

  const r = run(repo, art);
  const g7 = (r.json?.findings ?? []).filter((f) => f.check === 'G7');
  expect('G7 必须报警（不能静默豁免）',
    g7.some((f) => f.level === 'WARN' || f.level === 'FAIL'),
    JSON.stringify(g7));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 52: 真交付物（无机器字段）→ 仍应豁免 G7，不得误伤');
{
  const dir = mkdtempSync(join(tmpdir(), 'v52-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.js'), 'const a=1;\n');
  const art = join(dir, 'arts');
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, 'round1-ledger.md'),
    '# 账本\n\n这是给人读的账本，没有机器字段，不该被要求 JSON 信封。\n');

  const r = run(repo, art);
  const g7fail = (r.json?.findings ?? []).filter((f) => f.check === 'G7' && f.level === 'FAIL');
  expect('真交付物不判 G7 FAIL', g7fail.length === 0, JSON.stringify(g7fail));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 53: 尾逗号容错改写 quote → 编造的 quote 不得判 G0 PASS');
{
  // 2026-11-20 修：旧实现无条件 `.replace(/,(\s*[}\]])/g,'$1')` 改写整段 JSON，
  // 包括字符串内部。实测源文件是 `if (a) { return {x}; }`、quote 写成
  // `if (a) { return {x,}; }`（逐字不存在），门 0 报「1/1 通过」。
  // 这正好摧毁门 0 的存在理由：诚实引用可能被判伪造，编造引用被判真实。
  const dir = mkdtempSync(join(tmpdir(), 'v53-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'comma.js'), 'if (a) { return {x}; }\n');
  const art = join(dir, 'arts');
  mkdirSync(art, { recursive: true });
  // 手工写产物：JSON 带尾逗号（触发容错），quote 含 `{x,}`（源文件里不存在）
  writeFileSync(join(art, 'round1-02-audit-core-logic.md'), [
    '# audit', '', '```json', '{',
    '  "schema_version": "output-contract-v1",',
    '  "agent_id": "a1",',
    '  "role": "audit",',
    '  "status": "SUCCESS",',
    '  "contract_valid": true,',
    '  "artifact_path": "' + join(art, 'round1-02-audit-core-logic.md').replace(/\\/g, '/') + '",',
    '  "payload": { "findings": [ {',
    '    "finding_id": "F1", "status": "CONFIRMED", "file": "src/comma.js", "line": 1,',
    '    "evidence": { "file": "src/comma.js", "line": 1, "quote": "if (a) { return {x,}; }" },',
    '    "inference": { "claim": "c", "basis": "probe basis long enough", "alternatives": ["n"] }',
    '  },] },',
    '}', '```', '',
  ].join('\n'));

  const r = run(repo, art);
  const g0pass = (r.json?.findings ?? []).filter((f) => f.check === 'G0' && f.level === 'PASS');
  const g0warn = (r.json?.findings ?? []).filter((f) => f.check === 'G0' && f.level === 'WARN');
  expect('编造的 quote 不得判 G0 PASS', g0pass.length === 0, JSON.stringify(g0pass));
  expect('必须报成「无法核验」', g0warn.length > 0, JSON.stringify((r.json?.findings ?? []).map((f) => `${f.level}:${f.check}`)));
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 54: 全 SKIP（0 PASS / 0 FAIL）→ 必须 exit 4，不得报「通过」');
{
  // 2026-11-20 修：`envelopes.length === 0` 的守卫只挡住「一份产物都没有」。
  // 一份格式合法、但所有检查都无从下手的信封能穿过它，得到
  //   「合计: 0 FAIL / 0 WARN / 0 PASS / 6 SKIP」+ EXIT=0
  // 也就是把「无从验证」报告成「验证通过」。判 4（验证仪问题），不是 1（产物违规）。
  const dir = mkdtempSync(join(tmpdir(), 'v54-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.js'), 'const a=1;\n');
  const art = join(dir, 'arts');
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, 'round1-02-sweep-a.md'),
    '# sweep\n\n```json\n' + JSON.stringify({
      schema_version: 'output-contract-v1',
      agent_id: 'a1',
      role: 'sweep',
      status: 'PERMANENT_FAILURE',
      attempt: 1,
    }, null, 2) + '\n```\n');

  const r = run(repo, art);
  expect('退出码 4', r.code === 4, `实际 ${r.code}`);
  // 用 --json 时人类提示走 stderr，所以这里核实「PASS=0 且 SKIP>0」这个判据本身
  const findings = r.json?.findings ?? [];
  const nPass = findings.filter((f) => f.level === 'PASS').length;
  const nSkip = findings.filter((f) => f.level === 'SKIP').length;
  expect('0 PASS 且 >0 SKIP（这正是 exit 4 的判据）', nPass === 0 && nSkip > 0, `pass=${nPass} skip=${nSkip}`);
  rmSync(dir, { recursive: true, force: true });
}

console.log('case 55: 非 .md 产物必须被报出来，不得静默丢弃');
{
  // 2026-11-20 修：实测一个从不被检查的 `.json` + 一个合规 `.md` 会被报告成
  // 「0 FAIL / 1 PASS」，输出里连一句「有文件被忽略」都没有。
  // 仓库唯一一次真实审计（.run-hv）是 65 个 .json，被报成「扫描 5 个文件」。
  const dir = mkdtempSync(join(tmpdir(), 'v55-'));
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  writeFileSync(join(repo, 'src', 'a.js'), 'const a=1;\n');
  const art = join(dir, 'arts');
  mkdirSync(art, { recursive: true });
  writeFileSync(join(art, 'never-checked.json'),
    JSON.stringify({ findings: [{ fake: 'this file is never validated' }] }));
  writeFileSync(join(art, 'round1-02-sweep-a.md'),
    '# sweep\n\n```json\n' + JSON.stringify({
      schema_version: 'output-contract-v1', agent_id: 'a1', role: 'sweep',
      status: 'PERMANENT_FAILURE', attempt: 1,
    }, null, 2) + '\n```\n');

  const r = run(repo, art);
  const warns = (r.json?.findings ?? []).filter((f) => f.level === 'WARN' && /非 \.md|未被检查/.test(f.message));
  expect('报出被忽略的文件数', warns.length > 0, JSON.stringify((r.json?.findings ?? []).map((f) => f.message?.slice(0, 60))));
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n=== 结果: ${passCount} 通过 / ${failCount} 失败 ===\n`);
process.exit(failCount > 0 ? 1 : 0);
