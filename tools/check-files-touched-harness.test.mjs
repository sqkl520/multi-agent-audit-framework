#!/usr/bin/env node
/**
 * check-files-touched-harness.test.mjs — 用合成 dsh session 日志测「files_touched vs 真实写操作」对账
 *
 * 被测对象：tools/check-files-touched-harness.mjs（R21 新建）。
 *
 * ── 它要堵的是什么 ──────────────────────────────────────────────────
 * R19 把 `files_touched` 与 `git status` 做了双向对账，R20 又给它补了修复基线。
 * 但两者都还是 `git status`——R20 §三点诚实结论原文：
 *
 *   「下一个层次必须换观测面（harness 记录 tool call 与文件写入），而不是继续往
 *     state.json 加字段——每个新字段都是一个新省略点。」
 *
 * `git status` 回答的是「相对 HEAD 有没有差异」，那是**状态**；
 * harness 的 `tool/call` 回答的是「这个 session 有没有真的调过 write/edit，调了几次、
 * 写的是哪个绝对路径」，那是**动作**，而且是 per-call 粒度的。
 * 一个文件在修复前就脏、本轮一个字没碰，`git status` 说它变了；harness 日志说没人写过它。
 * 后者才是「这个实例改没改」的直接证据。
 *
 * ── 测试形态 ───────────────────────────────────────────────────────
 * 沿用 check-fix-instances-harness.test.mjs：
 *   - 纯 node，无第三方依赖
 *   - execFileSync 调**真实脚本**，不 mock
 *   - fixture 写到 mkdtempSync 临时目录，结束后删掉
 *   - 合成 session 日志用 zlib.zstdCompressSync 压成 session.v4.jsonl.zstd
 *
 * 另加一类：`normalizePath(p, targetRepo)` 的**单元**测试。
 * 它是本工具最容易出 bug 的地方（harness 记绝对路径、files_touched 写相对路径，
 * Windows 大小写不敏感 / Linux 敏感），所以单独测、并且两条平台规则都测。
 *
 * ── 真实数据自证 ───────────────────────────────────────────────────
 * 若 <HOME>/.dsh/sessions 存在，额外跑真实 session a40f0162
 * （68 次 write/edit、18 个不同文件）。目录不存在时 SKIP，不计失败。
 *
 * 运行：node tools/check-files-touched-harness.test.mjs
 * 退出码：0 = 全绿 / 1 = 有失败
 */

import { execFileSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'check-files-touched-harness.mjs');
const REAL_ROOT = '<HOME>/.dsh/sessions';
const REAL_A40 = 'session-a40f0162-d036-49ca-8677-efb40f821c06';

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

/** 被测模块。按纪律先写测试后写实现，所以这里可能导入失败——
 *  失败不该让整个文件崩掉，否则拿不到逐条用例的失败信息。 */
let mod = null;
try {
  mod = await import('./check-files-touched-harness.mjs');
} catch (e) {
  console.log(`  （暂时无法导入被测模块：${e.code ?? e.message} —— 实现尚未写出，属预期）`);
}
const norm = (p, repo, ci) => mod?.normalizePath?.(p, repo, ci);

// ────────────────────────────────────────────────────────────────────
// fixture
// ────────────────────────────────────────────────────────────────────

/** 一个 dsh session 的事件序列。字段位置照真实日志：
 *  `session` 事件的 id / cwd / delegationDepth / parentSession 在**顶层**；
 *  `tool/call` 的文件路径在 `.data.arguments`（JSON 字符串）里。
 *  `shells`：额外记录 shell 工具调用（R23 的「删除动作」证据走这里）。 */
function sessionEvents({ id, depth = 0, parent = null, cwd = 'C:\\ws', tools = ['read', 'write', 'edit'], writes = [], shells = [], steps = 3 }) {
  const ev = [{
    type: 'session', version: 4, id, cwd, delegationDepth: depth,
    ...(parent ? { parentSession: parent } : {}),
    ...(depth > 0 ? { origin: 'subagent' } : {}),
  }];
  if (tools) ev.push({ type: 'request/header', data: { header: { tools: tools.map((n) => ({ name: n })) } } });
  for (let i = 1; i <= steps; i++) ev.push({ type: 'step/start', data: { turn: 1, step: i } });
  let n = 0;
  for (const w of writes) {
    const name = w.tool ?? 'write';
    const args = name === 'edit'
      ? { file_path: w.path, old_string: 'a', new_string: 'b' }
      : { file_path: w.path, content: '// x\n' };
    ev.push({ type: 'tool/call', data: { turn: 1, step: 1, callId: `call-${n++}`, name, arguments: JSON.stringify(args) } });
  }
  for (const s of shells) {
    const name = s.tool ?? 'pwsh';
    ev.push({ type: 'tool/call', data: { turn: 1, step: 1, callId: `call-${n++}`, name, arguments: JSON.stringify({ command: s.command }) } });
  }
  return ev;
}

/** <root>/<projectDir>/<sessionDir>/session.v4.jsonl.zstd */
function makeRoot(projectDir, sessions) {
  const root = mkdtempSync(join(tmpdir(), 'ft-harness-'));
  for (const s of sessions) {
    const sd = join(root, projectDir, s.dir);
    mkdirSync(sd, { recursive: true });
    const body = s.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(sd, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')));
  }
  return root;
}

/** 一份 fix 产物的 JSON 信封（与 check-fix-artifacts-envelope 的探针口径一致）。 */
function envelope({ agentId = 'fix-agent-1', files = [], role = 'fix', findingId = 'F1' }) {
  return JSON.stringify({
    schema_version: 'output-contract-v1',
    agent_id: agentId,
    role,
    status: 'SUCCESS',
    contract_valid: true,
    artifact_path: 'done-1.md',
    payload: {
      finding_id: findingId,
      disposition: 'FIXED',
      test_path: 'src/T.java',
      red_log_path: 'red/red.log',
      files_touched: files.map((p) => ({ path: p, change_summary: '改了' })),
    },
    error: null,
  }, null, 2);
}

/** 造产物目录。artifacts = [{ name, text }] */
function makeArtifactDir(artifacts) {
  const dir = mkdtempSync(join(tmpdir(), 'ft-artifacts-'));
  for (const a of artifacts) writeFileSync(join(dir, a.name), a.text);
  return dir;
}

function artifactOf({ agentId, files, name = 'done-1.md', role = 'fix' }) {
  return { name, text: `# 修复产物\n\n\`\`\`json\n${envelope({ agentId, files, role })}\n\`\`\`\n` };
}

/** state.json 的最小形状（只保留本检查器读的字段）。 */
function stateOf({ repo, artifactDir, contracts = [], phase = 'wave4' }) {
  return {
    schema_version: 'run-state-v1',
    trace_id: 'trace-r21-test',
    round_id: 'round1',
    path_mode: 'FIX',
    phase,
    status: 'RUNNING',
    target_repo: repo,
    report: { dir_ready: true, dir_path: artifactDir },
    budget: { total_cap: 60, spent: 10, spawned_fix_agents: contracts.length },
    discipline_log: [],
    fix_contracts: contracts.map((c, i) => ({
      finding_id: c.finding_id ?? `F${i + 1}`,
      fix_agent_id: c.fix_agent_id,
      registered_at: '2026-11-15T10:00:00Z',
      defect_statement: '当 X 时 Y 会发生，预期是 Z',
      target_files: c.target_files ?? ['src/main/java/X.java'],
    })),
  };
}

function writeState(st) {
  const dir = mkdtempSync(join(tmpdir(), 'ft-state-'));
  const p = join(dir, 'state.json');
  writeFileSync(p, JSON.stringify(st, null, 2));
  return { dir, path: p };
}

function run(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out, err: '', data: safeJson(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    return { code: typeof e.status === 'number' ? e.status : -1, out, err: e.stderr?.toString() ?? '', data: safeJson(out) };
  }
}
function safeJson(s) { try { return JSON.parse(s); } catch { return null; } }

const rulesOf = (r, level) => (r.data?.problems ?? [])
  .filter((p) => (level ? p.level === level : true)).map((p) => p.rule);
const hasRule = (r, rule, level) => (r.data?.problems ?? [])
  .some((p) => p.rule === rule && (!level || p.level === level));
const msgOf = (r, rule) => (r.data?.problems ?? []).find((p) => p.rule === rule)?.message ?? '';

// ════════════════════════════════════════════════════════════════════
// 0 · normalizePath —— 最容易出 bug 的地方，单独测
// ════════════════════════════════════════════════════════════════════
console.log('\n=== 0：路径归一化（绝对 / 相对 / 大小写 / 越界）===');

const REPO = 'D:/Server/Some Repo';
{
  expect('0.1 绝对路径 → 相对 target_repo', norm?.(`${REPO}/src/main/A.java`, REPO)?.rel === 'src/main/A.java',
    JSON.stringify(norm?.(`${REPO}/src/main/A.java`, REPO)));
  expect('0.2 反斜杠绝对路径 → 正斜杠相对路径',
    norm?.('D:\\Server\\Some Repo\\src\\main\\A.java', REPO)?.rel === 'src/main/A.java',
    JSON.stringify(norm?.('D:\\Server\\Some Repo\\src\\main\\A.java', REPO)));
  expect('0.3 相对路径原样（去掉前导 ./）', norm?.('./src/main/A.java', REPO)?.rel === 'src/main/A.java',
    JSON.stringify(norm?.('./src/main/A.java', REPO)));
  expect('0.4 大小写不敏感（Windows）：盘符与目录名大小写不同仍匹配',
    norm?.('d:/server/SOME repo/src/A.java', REPO, true)?.rel === 'src/A.java',
    JSON.stringify(norm?.('d:/server/SOME repo/src/A.java', REPO, true)));
  expect('0.5 大小写敏感（Linux 语义）：同样的输入**不**匹配，判为仓库外',
    norm?.('d:/server/SOME repo/src/A.java', REPO, false)?.ok === false,
    JSON.stringify(norm?.('d:/server/SOME repo/src/A.java', REPO, false)));
  expect('0.6 大小写敏感时 key 不折叠（A.java ≠ a.java）',
    norm?.('src/A.java', REPO, false)?.key !== norm?.('src/a.java', REPO, false)?.key);
  expect('0.7 大小写不敏感时 key 折叠（A.java == a.java）',
    norm?.('src/A.java', REPO, true)?.key === norm?.('src/a.java', REPO, true)?.key);
  expect('0.8 仓库外的绝对路径 → ok:false / outside_repo',
    norm?.('D:/other/place/X.java', REPO)?.ok === false
      && norm?.('D:/other/place/X.java', REPO)?.reason === 'outside_repo',
    JSON.stringify(norm?.('D:/other/place/X.java', REPO)));
  expect('0.9 路径前缀不能靠字符串前缀蒙混（Some Repo2 不算在 Some Repo 里）',
    norm?.('D:/Server/Some Repo2/src/A.java', REPO)?.ok === false,
    JSON.stringify(norm?.('D:/Server/Some Repo2/src/A.java', REPO)));
  expect('0.10 绝对路径但没给 target_repo → ok:false（不瞎猜）',
    norm?.('D:/x/A.java', null)?.ok === false,
    JSON.stringify(norm?.('D:/x/A.java', null)));
  expect('0.11 ../ 越界 → ok:false / escapes_repo',
    norm?.('../outside/A.java', REPO)?.ok === false,
    JSON.stringify(norm?.('../outside/A.java', REPO)));
  expect('0.12 空串 / 非字符串 → ok:false',
    norm?.('', REPO)?.ok === false && norm?.(null, REPO)?.ok === false);
  expect('0.13 尾斜杠被去掉（目录形态的路径也能对齐）',
    norm?.(`${REPO}/src/`, REPO)?.rel === 'src',
    JSON.stringify(norm?.(`${REPO}/src/`, REPO)));
}

// ════════════════════════════════════════════════════════════════════
// 1 · 配置错误与 harness 探测
// ════════════════════════════════════════════════════════════════════
console.log('\n=== 1：配置错误与 harness 探测（无日志不能假装绿，别家 harness 不能卡死）===');

{
  const art = makeArtifactDir([artifactOf({ files: ['src/A.java'] })]);
  const st = writeState(stateOf({ repo: REPO, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));

  const missingRoot = run(['--state', st.path, '--sessions', join(st.dir, 'no-such-root'), '--json']);
  expect('1.1 sessions root 不存在 → exit 2', missingRoot.code === 2, `code=${missingRoot.code}`);
  expect('1.2 报 sessions_root_missing', /sessions_root_missing/.test(missingRoot.err + missingRoot.out));

  const noState = run(['--state', join(st.dir, 'nope.json'), '--sessions', st.dir, '--json']);
  expect('1.3 state.json 不存在 → exit 2', noState.code === 2, `code=${noState.code}`);
  expect('1.4 报 state_missing', /state_missing/.test(noState.err + noState.out));

  const usage = run(['--json']);
  expect('1.5 缺必填参数 → exit 2（用法错误不是通过）', usage.code === 2, `code=${usage.code}`);

  const emptyRoot = mkdtempSync(join(tmpdir(), 'ft-empty-'));
  try {
    const r = run(['--state', st.path, '--sessions', emptyRoot, '--json']);
    expect('1.6 无 dsh 格式日志 → exit 0（unsupported_harness 不卡死别家 harness）', r.code === 0, `code=${r.code}`);
    expect('1.7 报 unsupported_harness WARN', hasRule(r, 'unsupported_harness', 'WARN'), JSON.stringify(rulesOf(r)));
    expect('1.8 不因「没证据」判 FAIL', (r.data?.problems ?? []).every((p) => p.level !== 'FAIL'), JSON.stringify(rulesOf(r, 'FAIL')));
  } finally { rmSync(emptyRoot, { recursive: true, force: true }); }

  const bogus = run(['--state', st.path, '--sessions', st.dir, '--session-id', 'session-deadbeef-0000-0000-0000-000000000000', '--json']);
  expect('1.9 指定 session 找不到 → exit 2', bogus.code === 2, `code=${bogus.code}`);
  expect('1.10 报 session_not_found', /session_not_found/.test(bogus.err + bogus.out));

  rmSync(st.dir, { recursive: true, force: true });
  rmSync(art, { recursive: true, force: true });
}

// ════════════════════════════════════════════════════════════════════
// 2 · 核心：声称 vs 实际写操作
// ════════════════════════════════════════════════════════════════════
console.log('\n=== 2：核心对账（声称侧 = files_touched，实际侧 = write/edit 记录）===');

{
  const SID = 'session-aaaa0001-0000-0000-0000-000000000001';
  const files = ['src/main/java/com/x/A.java', 'src/main/java/com/x/B.java'];
  const root = makeRoot('--D-Tmp-r21--', [{
    dir: SID,
    events: sessionEvents({ id: SID, writes: files.map((p) => ({ path: `${REPO}/${p}` })) }),
  }]);
  const art = makeArtifactDir([artifactOf({ files })]);
  const st = writeState(stateOf({ repo: REPO, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('2.1 声称 == 实际 → exit 0', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('2.2 无 FAIL', (r.data?.problems ?? []).every((p) => p.level !== 'FAIL'), JSON.stringify(rulesOf(r, 'FAIL')));
    expect('2.3 JSON 里记录 write/edit 调用数 = 2', r.data?.writeEditCalls === 2, String(r.data?.writeEditCalls));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

{
  // 2.4 overclaim：声明了一个从没被 write/edit 碰过的文件（它在仓库里存在、甚至可能已经脏）
  const SID = 'session-aaaa0002-0000-0000-0000-000000000002';
  const root = makeRoot('--D-Tmp-r21--', [{
    dir: SID,
    events: sessionEvents({ id: SID, writes: [{ path: `${REPO}/src/main/java/com/x/A.java` }] }),
  }]);
  const art = makeArtifactDir([artifactOf({ files: ['src/main/java/com/x/A.java', 'src/main/java/com/x/Ghost.java'] })]);
  const st = writeState(stateOf({ repo: REPO, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('2.4 声称有、harness 没写过 → exit 1', r.code === 1, `code=${r.code}`);
    expect('2.5 报 files_touched_overclaimed_by_harness（FAIL）', hasRule(r, 'files_touched_overclaimed_by_harness', 'FAIL'), JSON.stringify(rulesOf(r)));
    expect('2.6 消息点名 Ghost.java', msgOf(r, 'files_touched_overclaimed_by_harness').includes('Ghost.java'), msgOf(r, 'files_touched_overclaimed_by_harness').slice(0, 160));
    expect('2.7 消息写明「从未对它们调用过 write/edit」',
      /从未对它们调用过 write\/edit/.test(msgOf(r, 'files_touched_overclaimed_by_harness')), msgOf(r, 'files_touched_overclaimed_by_harness').slice(0, 200));
    expect('2.8 已写的 A.java 不在此条里', !msgOf(r, 'files_touched_overclaimed_by_harness').includes('A.java'), msgOf(r, 'files_touched_overclaimed_by_harness').slice(0, 200));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

{
  // 2.9 under-report：实例写了 3 个源码，只登记 1 个
  const SID = 'session-aaaa0003-0000-0000-0000-000000000003';
  const written = [
    'src/main/java/com/x/A.java',
    'src/main/java/com/x/B.java',
    'src/main/java/com/x/C.java',
  ];
  const root = makeRoot('--D-Tmp-r21--', [{
    dir: SID, events: sessionEvents({ id: SID, writes: written.map((p) => ({ path: `${REPO}/${p}` })) }),
  }]);
  const art = makeArtifactDir([artifactOf({ files: [written[0]] })]);
  const st = writeState(stateOf({ repo: REPO, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('2.9 写了 3 个源码只登记 1 个 → exit 1', r.code === 1, `code=${r.code}`);
    expect('2.10 报 files_touched_underreported_by_harness（FAIL）', hasRule(r, 'files_touched_underreported_by_harness', 'FAIL'), JSON.stringify(rulesOf(r)));
    const m = msgOf(r, 'files_touched_underreported_by_harness');
    expect('2.11 消息写明「harness 记录本次会话写了 2 个源码文件」', /harness 记录本次会话写了 2 个源码文件/.test(m), m.slice(0, 200));
    expect('2.12 消息列出 B.java 与 C.java，不列已登记的 A.java',
      m.includes('B.java') && m.includes('C.java') && !/\bA\.java/.test(m), m.slice(0, 400));
    expect('2.13 消息说明这是外部基准判的、不是 git 差值猜的',
      /不是 git 差值|外部基准/.test(m), m.slice(0, 400));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

{
  // 2.14 只写了非源码（产物 .md）→ 不报（产物不算源码）
  const SID = 'session-aaaa0004-0000-0000-0000-000000000004';
  const root = makeRoot('--D-Tmp-r21--', [{
    dir: SID,
    events: sessionEvents({
      id: SID,
      writes: [
        { path: `${REPO}/src/main/java/com/x/A.java` },
        { path: `${REPO}/repair-artifacts/done-1.md` },
        { path: `${REPO}/experiments/run/notes.md` },
      ],
    }),
  }]);
  const art = makeArtifactDir([artifactOf({ files: ['src/main/java/com/x/A.java'] })]);
  const st = writeState(stateOf({ repo: REPO, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('2.14 写产物 / 非源码未登记 → exit 0（不报）', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('2.15 不报 underreported', !hasRule(r, 'files_touched_underreported_by_harness'), JSON.stringify(rulesOf(r)));
    expect('2.16 也不报 overclaimed', !hasRule(r, 'files_touched_overclaimed_by_harness'), JSON.stringify(rulesOf(r)));
    expect('2.17 JSON 里统计到被忽略的非源码写入数 ≥ 2',
      (r.data?.ignoredNonSourceWrites ?? 0) >= 2, String(r.data?.ignoredNonSourceWrites));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

{
  // 2.18 绝对 / 相对路径混用 → 归一化后正确匹配（这是最容易出 bug 的路径）
  const SID = 'session-aaaa0005-0000-0000-0000-000000000005';
  const root = makeRoot('--D-Tmp-r21--', [{
    dir: SID,
    events: sessionEvents({
      id: SID,
      writes: [
        { path: 'D:\\Server\\Some Repo\\src\\main\\java\\com\\x\\A.java' },  // 反斜杠 + 大写盘符
        { path: 'd:/server/some repo/src/main/java/com/x/B.java' },           // 小写
        { tool: 'edit', path: `${REPO}/src/main/resources/a.yml` },           // edit 工具
      ],
    }),
  }]);
  const art = makeArtifactDir([artifactOf({
    files: ['src/main/java/com/x/A.java', 'src/main/java/com/x/B.java', 'src/main/resources/a.yml'],
  })]);
  const st = writeState(stateOf({ repo: REPO, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('2.18 绝对/相对/大小写混用 → exit 0（归一化正确）', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r, 'FAIL'))}`);
    expect('2.19 不报 overclaimed', !hasRule(r, 'files_touched_overclaimed_by_harness'), msgOf(r, 'files_touched_overclaimed_by_harness').slice(0, 300));
    expect('2.20 edit 工具也被计入（write/edit 都要看）', r.data?.writeEditCalls === 3, String(r.data?.writeEditCalls));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

// ════════════════════════════════════════════════════════════════════
// 2b · 「本次会话」的边界（最危险的设计点：太窄 → 假 FAIL，太宽 → 放水）
// ════════════════════════════════════════════════════════════════════
console.log('\n=== 2b：扫描边界（同 project 多顶层 session / 子 session / 别的 project）===');

{
  // 2.21 子 session 的写入也算「本次会话写的」——只看主 session 会漏掉真正的修复动作
  const SID = 'session-aaaa0006-0000-0000-0000-000000000006';
  const CHILD = 'aaaa0006-0000-0000-0000-0000000000c6';
  const root = makeRoot('--D-Tmp-r21--', [
    { dir: SID, events: sessionEvents({ id: SID, writes: [] }) },
    {
      dir: CHILD,
      events: sessionEvents({
        id: CHILD, depth: 1, parent: SID,
        writes: [{ path: `${REPO}/src/main/java/com/x/A.java` }],
      }),
    },
  ]);
  const art = makeArtifactDir([artifactOf({ files: ['src/main/java/com/x/A.java'] })]);
  const st = writeState(stateOf({ repo: REPO, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('2.21 写入发生在子 session → 仍算本次会话（exit 0）', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('2.22 JSON 里 sessionsScanned ≥ 2', (r.data?.sessionsScanned ?? 0) >= 2, String(r.data?.sessionsScanned));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

{
  // 2.23 **真实形状**：同一个 project 目录下有两个顶层 session（Hilltop Village 就是），
  //      各自的产物合在同一批账里。省略 --session-id 时必须把两个都算进来，
  //      否则另一边的 files_touched 会被整体判成 overclaim —— 结构性假 FAIL。
  const S1 = 'session-aaaa0007-0000-0000-0000-000000000007';
  const S2 = 'session-aaaa0007-0000-0000-0000-000000000008';
  const root = makeRoot('--D-Tmp-r21--', [
    { dir: S1, events: sessionEvents({ id: S1, writes: [{ path: `${REPO}/src/main/java/com/x/A.java` }] }) },
    { dir: S2, events: sessionEvents({ id: S2, writes: [{ path: `${REPO}/src/main/java/com/x/B.java` }] }) },
  ]);
  const art = makeArtifactDir([
    artifactOf({ files: ['src/main/java/com/x/A.java'], name: 'done-1.md' }),
    artifactOf({ files: ['src/main/java/com/x/B.java'], name: 'done-2.md' }),
  ]);
  const st = writeState(stateOf({ repo: REPO, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('2.23 同 project 两个顶层 session 的写入合并后 → exit 0', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('2.24 actualScope = project', r.data?.actualScope === 'project', String(r.data?.actualScope));
    expect('2.25 sessionsScanned = 2', r.data?.sessionsScanned === 2, String(r.data?.sessionsScanned));

    // 反证：显式 --session-id 把口径收窄到 S1 之后，B.java 就是 overclaim
    const r2 = run(['--state', st.path, '--sessions', root, '--session-id', S1, '--json']);
    expect('2.26 显式 --session-id 收窄口径 → actualScope = session', r2.data?.actualScope === 'session', String(r2.data?.actualScope));
    expect('2.27 收窄后 B.java 被判 overclaim（口径不同、结论不同，必须可区分）',
      r2.code === 1 && msgOf(r2, 'files_touched_overclaimed_by_harness').includes('B.java'),
      `code=${r2.code} ${msgOf(r2, 'files_touched_overclaimed_by_harness').slice(0, 200)}`);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

{
  // 2.28 边界不能太宽：别的 project 目录（别的 cwd、别的项目）的写入绝不能算进来
  const SID = 'session-aaaa0008-0000-0000-0000-000000000009';
  const OTHER = 'session-cccc9999-0000-0000-0000-000000000009';
  const root = makeRoot('--D-Tmp-r21--', [
    { dir: SID, events: sessionEvents({ id: SID, writes: [] }) },
  ]);
  // 另一个 project 目录（同 root 下、不同 projectDir）
  {
    const sd = join(root, '--D-Tmp-other--', OTHER);
    mkdirSync(sd, { recursive: true });
    const body = sessionEvents({ id: OTHER, writes: [{ path: `${REPO}/src/main/java/com/x/A.java` }] })
      .map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(sd, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')));
  }
  const art = makeArtifactDir([artifactOf({ files: ['src/main/java/com/x/A.java'] })]);
  const st = writeState(stateOf({ repo: REPO, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--project-dir', '--D-Tmp-r21--', '--json']);
    expect('2.28 别的 project 的写入不算本次 → A.java 判 overclaim', r.code === 1, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('2.29 sessionsScanned 只含本 project 的那一个', r.data?.sessionsScanned === 1, String(r.data?.sessionsScanned));
    expect('2.30 不把别的 project 的 session 扫进来',
      !(r.data?.scannedSessionIds ?? []).includes(OTHER), JSON.stringify(r.data?.scannedSessionIds));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

// ════════════════════════════════════════════════════════════════════
// 3 · 归属（R19 §(b)：files_touched 没有 agent_id 维度）
// ════════════════════════════════════════════════════════════════════
console.log('\n=== 3：归属——fix_agent_id 能映射到子 session 时，逐实例对账 ===');

{
  const SID = 'session-bbbb0001-0000-0000-0000-000000000001';
  const C1 = 'bbbb0001-0000-0000-0000-0000000000c1';
  const root = makeRoot('--D-Tmp-r21--', [
    { dir: SID, events: sessionEvents({ id: SID, writes: [] }) },
    {
      dir: C1, events: sessionEvents({
        id: C1, depth: 1, parent: SID,
        writes: [{ path: `${REPO}/src/main/java/com/x/A.java` }, { path: `${REPO}/src/main/java/com/x/B.java` }],
      }),
    },
  ]);
  // fix_agent_id 就是子 session id；它只登记了 A.java → B.java 归属不上
  const art = makeArtifactDir([
    artifactOf({ agentId: C1, files: ['src/main/java/com/x/A.java'], name: 'done-1.md' }),
    artifactOf({ agentId: 'someone-else', files: ['src/main/java/com/x/B.java'], name: 'done-2.md' }),
  ]);
  const st = writeState(stateOf({
    repo: REPO, artifactDir: art,
    contracts: [{ fix_agent_id: C1, finding_id: 'F1' }],
  }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('3.1 子 session 的写入未被它自己的 files_touched 覆盖 → exit 1', r.code === 1, `code=${r.code}`);
    expect('3.2 报 agent_attribution_mismatch（FAIL）', hasRule(r, 'agent_attribution_mismatch', 'FAIL'), JSON.stringify(rulesOf(r)));
    expect('3.3 消息点名 B.java 与那个子 session id',
      msgOf(r, 'agent_attribution_mismatch').includes('B.java')
      && msgOf(r, 'agent_attribution_mismatch').includes(C1),
      msgOf(r, 'agent_attribution_mismatch').slice(0, 300));
    expect('3.4 全局对账不报 underreported（B.java 被另一份产物登记了）',
      !hasRule(r, 'files_touched_underreported_by_harness'), JSON.stringify(rulesOf(r)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

{
  // 3.5 逐实例完全对得上 → 放行
  const SID = 'session-bbbb0002-0000-0000-0000-000000000002';
  const C1 = 'bbbb0002-0000-0000-0000-0000000000c2';
  const C2 = 'bbbb0002-0000-0000-0000-0000000000c3';
  const root = makeRoot('--D-Tmp-r21--', [
    { dir: SID, events: sessionEvents({ id: SID, writes: [] }) },
    { dir: C1, events: sessionEvents({ id: C1, depth: 1, parent: SID, writes: [{ path: `${REPO}/src/A.java` }] }) },
    { dir: C2, events: sessionEvents({ id: C2, depth: 1, parent: SID, writes: [{ path: `${REPO}/src/B.java` }] }) },
  ]);
  const art = makeArtifactDir([
    artifactOf({ agentId: C1, files: ['src/A.java'], name: 'done-1.md' }),
    artifactOf({ agentId: C2, files: ['src/B.java'], name: 'done-2.md' }),
  ]);
  const st = writeState(stateOf({
    repo: REPO, artifactDir: art,
    contracts: [{ fix_agent_id: C1, finding_id: 'F1' }, { fix_agent_id: C2, finding_id: 'F2' }],
  }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('3.5 两个实例各自对得上 → exit 0', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('3.6 JSON 里 mappedAgents = 2', r.data?.attribution?.mapped === 2, JSON.stringify(r.data?.attribution));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

{
  // 3.7 fix_agent_id 是逻辑名（映射不到 session）→ 降级 WARN，不判 FAIL
  const SID = 'session-bbbb0003-0000-0000-0000-000000000003';
  const root = makeRoot('--D-Tmp-r21--', [
    { dir: SID, events: sessionEvents({ id: SID, writes: [{ path: `${REPO}/src/A.java` }] }) },
  ]);
  const art = makeArtifactDir([artifactOf({ agentId: 'fix-agent-1', files: ['src/A.java'] })]);
  const st = writeState(stateOf({
    repo: REPO, artifactDir: art, contracts: [{ fix_agent_id: 'fix-agent-1' }],
  }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('3.7 映射不到 session → exit 0', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r, 'FAIL'))}`);
    expect('3.8 报 agent_attribution_unavailable（WARN，降级必须可见）',
      hasRule(r, 'agent_attribution_unavailable', 'WARN'), JSON.stringify(rulesOf(r)));
    expect('3.9 不报 agent_attribution_mismatch', !hasRule(r, 'agent_attribution_mismatch'), JSON.stringify(rulesOf(r)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

// ════════════════════════════════════════════════════════════════════
// 4 · 降级纪律
// ════════════════════════════════════════════════════════════════════
console.log('\n=== 4：降级纪律（拿不到外部信息 ≠ 账本写错了）===');

{
  // 4.1 没有 fix 信封 → claimed 为空，跳过核心判据但 WARN（不能静默）
  const SID = 'session-cccc0001-0000-0000-0000-000000000001';
  const root = makeRoot('--D-Tmp-r21--', [{
    dir: SID, events: sessionEvents({ id: SID, writes: [{ path: `${REPO}/src/A.java` }] }),
  }]);
  const art = makeArtifactDir([{ name: 'done-1.md', text: '# 没有信封的产物\n\n正文。\n' }]);
  const st = writeState(stateOf({ repo: REPO, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('4.1 没有 fix 信封 → exit 0（缺信封由 check-fix-artifacts-envelope 拦，不在这里重复开火）', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r, 'FAIL'))}`);
    expect('4.2 但必须 WARN no_claimed_files（「没查」与「通过」可区分）', hasRule(r, 'no_claimed_files', 'WARN'), JSON.stringify(rulesOf(r)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

{
  // 4.3 target_repo 缺失 → 用 session 的 cwd 兜底（绝对路径仍然能归一化）
  const SID = 'session-cccc0002-0000-0000-0000-000000000002';
  const root = makeRoot('--D-Tmp-r21--', [{
    dir: SID, events: sessionEvents({
      id: SID, cwd: REPO.replace(/\//g, '\\'), writes: [{ path: `${REPO}/src/A.java` }],
    }),
  }]);
  const art = makeArtifactDir([artifactOf({ files: ['src/A.java'] })]);
  const st = writeState(stateOf({ repo: undefined, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('4.3 target_repo 缺失但 session 有 cwd → exit 0（不因此判 overclaim）', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r, 'FAIL'))}`);
    expect('4.4 记一条 INFO 说明基准取自 session cwd', hasRule(r, 'repo_from_session_cwd'), JSON.stringify(rulesOf(r)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

{
  // 4.5 声称侧写了仓库外的绝对路径 → 不判 overclaim，只 WARN（假 FAIL 比漏报更糟）
  const SID = 'session-cccc0003-0000-0000-0000-000000000003';
  const root = makeRoot('--D-Tmp-r21--', [{
    dir: SID, events: sessionEvents({ id: SID, writes: [{ path: `${REPO}/src/A.java` }] }),
  }]);
  const art = makeArtifactDir([artifactOf({ files: ['src/A.java', 'D:/elsewhere/B.java'] })]);
  const st = writeState(stateOf({ repo: REPO, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('4.5 仓库外的绝对路径 → exit 0', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r, 'FAIL'))}`);
    expect('4.6 报 unnormalizable_claimed_path（WARN）', hasRule(r, 'unnormalizable_claimed_path', 'WARN'), JSON.stringify(rulesOf(r)));
    expect('4.7 不报 overclaimed', !hasRule(r, 'files_touched_overclaimed_by_harness'), JSON.stringify(rulesOf(r)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

{
  // 4.8 多发现形态：payload.dispositions[].files_touched 也要收
  const SID = 'session-cccc0004-0000-0000-0000-000000000004';
  const root = makeRoot('--D-Tmp-r21--', [{
    dir: SID, events: sessionEvents({
      id: SID, writes: [{ path: `${REPO}/src/A.java` }, { path: `${REPO}/src/B.java` }],
    }),
  }]);
  const multi = JSON.stringify({
    schema_version: 'output-contract-v1', agent_id: 'fix-agent-1', role: 'fix', status: 'SUCCESS',
    contract_valid: true, artifact_path: 'done-9.md',
    payload: {
      target_finding_ids: ['F1', 'F2'],
      dispositions: [
        { finding_id: 'F1', disposition: 'FIXED', files_touched: [{ path: 'src/A.java', change_summary: 'x' }] },
        { finding_id: 'F2', disposition: 'FIXED', files_touched: [{ path: 'src/B.java', change_summary: 'y' }] },
      ],
    },
    error: null,
  }, null, 2);
  const art = makeArtifactDir([{ name: 'done-9.md', text: `# 多发现\n\n\`\`\`json\n${multi}\n\`\`\`\n` }]);
  const st = writeState(stateOf({ repo: REPO, artifactDir: art, contracts: [{ fix_agent_id: 'fix-agent-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('4.8 dispositions[].files_touched 被收进 claimed → exit 0', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('4.9 claimedFiles 覆盖两个文件', (r.data?.claimedFiles ?? 0) >= 2, String(r.data?.claimedFiles));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

// ════════════════════════════════════════════════════════════════════
// 5 · 真实数据自证（日志不在本机时 SKIP，不计失败）
// ════════════════════════════════════════════════════════════════════
console.log('\n=== 5：真实 dsh session 自证（a40f0162）===');

if (!existsSync(REAL_ROOT)) {
  console.log(`  SKIP: ${REAL_ROOT} 不存在——真实 session 日志不在这台机器上（不计失败）`);
} else {
  const art = makeArtifactDir([artifactOf({
    files: [
      'src/main/java/com/hilltopvillage/config/ConfigManager.java',
      'src/main/java/com/hilltopvillage/mechanics/NodeListener.java',
    ],
  })]);
  const st = writeState(stateOf({ repo: undefined, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', REAL_ROOT, '--session-id', REAL_A40, '--json']);
    expect('5.1 能定位到真实 session', r.data?.session?.id === REAL_A40, String(r.data?.session?.id ?? r.err.slice(0, 200)));
    expect('5.2 write/edit 调用数 = 68', r.data?.writeEditCalls === 68, String(r.data?.writeEditCalls));
    expect('5.3 不同被写文件数 = 18', r.data?.actualFiles === 18, String(r.data?.actualFiles));
    expect('5.4 只登记 2 个 → 报 underreported（真实 under-reporting）',
      hasRule(r, 'files_touched_underreported_by_harness', 'FAIL') && r.code === 1,
      `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    console.log(`    → a40f0162: calls=${r.data?.writeEditCalls} files=${r.data?.actualFiles} `
      + `claimed=${r.data?.claimedFiles} exit=${r.code}`);
  } finally { rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

// ════════════════════════════════════════════════════════════════════
// 6 · R23：探针甄别（写了又删 ≠ 未登记的修复改动）
// ════════════════════════════════════════════════════════════════════
//
// 实战暴露的盲区（field-test-1，2026-11-16）：主 session 为验证修复建了 8 个
// `*ProbeTest.java` 探针、用完删掉，`files_touched` 没登记它们——这是**对的**，
// 因为仓库最终状态里没有它们。但 R21 把「harness 记录的所有源码写入」都当成
// 「修复改动」，于是报 1 FAIL。
//
// 判据：write/edit 记录 **且** 文件现在不存在 → `probe_files_deleted`（INFO，不判
// under-reported）；文件现在存在 → 真改动，仍 FAIL。
//
// 这一节必须用**真实存在**的临时仓库：文件真的落在磁盘上，「现在还在不在」才有意义。
console.log('\n=== 6：探针甄别（写入后删除的一过性文件不算 under-reported）===');

const slash = (p) => String(p).replace(/\\/g, '/');

/** 真实存在的临时仓库：files 里的相对路径会被真的写到磁盘上。 */
function makeRealRepo(files = []) {
  const dir = mkdtempSync(join(tmpdir(), 'ft-realrepo-'));
  for (const f of files) {
    const p = join(dir, f);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, '// real file\n');
  }
  return dir;
}

/** 指定路径的任务运行器（用于跑另一个工具 check-payload）。 */
function runScript(script, args) {
  try {
    const out = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out, err: '', data: safeJson(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    return { code: typeof e.status === 'number' ? e.status : -1, out, err: e.stderr?.toString() ?? '', data: safeJson(out) };
  }
}

{
  // 6.1-6.3 文件现在存在 + 未登记 → FAIL（现有行为不变，不能因为加了甄别就放水）
  const SID = 'session-dddd0001-0000-0000-0000-000000000001';
  const A = 'src/main/java/com/x/A.java';
  const B = 'src/main/java/com/x/B.java';
  const repo = slash(makeRealRepo([A, B]));
  const root = makeRoot('--D-Tmp-r23--', [{
    dir: SID, events: sessionEvents({ id: SID, writes: [{ path: `${repo}/${A}` }, { path: `${repo}/${B}` }] }),
  }]);
  const art = makeArtifactDir([artifactOf({ files: [A] })]);
  const st = writeState(stateOf({ repo, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('6.1 写了、文件现在存在、未登记 → 仍 exit 1', r.code === 1, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('6.2 仍报 files_touched_underreported_by_harness（FAIL）',
      hasRule(r, 'files_touched_underreported_by_harness', 'FAIL'), JSON.stringify(rulesOf(r)));
    expect('6.3 点名的正是留在仓库里的 B.java',
      msgOf(r, 'files_touched_underreported_by_harness').includes('B.java'),
      msgOf(r, 'files_touched_underreported_by_harness').slice(0, 200));
    expect('6.4 存在性可判定时不报 probe_files_deleted',
      !hasRule(r, 'probe_files_deleted'), JSON.stringify(rulesOf(r)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
}

{
  // 6.5-6.9 写了源码、文件现在不存在、**且有删除动作**、未登记
  //          → exit 0 + INFO（不判 under-reported）
  const SID = 'session-dddd0002-0000-0000-0000-000000000002';
  const A = 'src/main/java/com/x/A.java';
  const P = 'src/test/java/com/x/ProbeTest.java';
  const repo = slash(makeRealRepo([A]));   // ProbeTest.java 从未落盘 → 写完就删
  const root = makeRoot('--D-Tmp-r23--', [{
    dir: SID,
    events: sessionEvents({
      id: SID,
      writes: [{ path: `${repo}/${A}` }, { path: `${repo}/${P}` }],
      // 真实形状（field-test-1 用的就是 Remove-Item）
      shells: [{ command: `Remove-Item '${repo}/${P}' -Force` }],
    }),
  }]);
  const art = makeArtifactDir([artifactOf({ files: [A] })]);
  const st = writeState(stateOf({ repo, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('6.5 探针写了又删、未登记 → exit 0', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('6.6 不报 underreported（仓库最终状态里没有这个文件）',
      !hasRule(r, 'files_touched_underreported_by_harness'), JSON.stringify(rulesOf(r)));
    expect('6.7 报 probe_files_deleted（INFO 级，不是 FAIL）',
      hasRule(r, 'probe_files_deleted', 'INFO'), JSON.stringify(rulesOf(r)));
    expect('6.8 INFO 里点名 ProbeTest.java 并写明不参与对账',
      msgOf(r, 'probe_files_deleted').includes('ProbeTest.java')
      && /不参与/.test(msgOf(r, 'probe_files_deleted')),
      msgOf(r, 'probe_files_deleted').slice(0, 300));
    expect('6.9 JSON 里 probe_files_deleted 记录了这个探针',
      (r.data?.probeFilesDeleted ?? []).some((p) => p.includes('ProbeTest.java')),
      JSON.stringify(r.data?.probeFilesDeleted));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
}

{
  // 6.10-6.13 混合：5 个写了，3 个删了、2 个留着，只登记 1 个
  //            → FAIL 只点名「留着且未登记」的那个；删掉的进 INFO
  const SID = 'session-dddd0003-0000-0000-0000-000000000003';
  const A = 'src/main/java/com/x/A.java';
  const B = 'src/main/java/com/x/B.java';
  const probes = ['src/test/java/com/x/P1Test.java', 'src/test/java/com/x/P2Test.java', 'src/test/java/com/x/P3Test.java'];
  const repo = slash(makeRealRepo([A, B]));
  const root = makeRoot('--D-Tmp-r23--', [{
    dir: SID,
    events: sessionEvents({
      id: SID,
      writes: [A, B, ...probes].map((p) => ({ path: `${repo}/${p}` })),
      // 3 个探针各有一条删除动作（bash 风格，验证多动词识别）
      shells: probes.map((p) => ({ tool: 'bash', command: `rm -f "${repo}/${p}"` })),
    }),
  }]);
  const art = makeArtifactDir([artifactOf({ files: [A] })]);
  const st = writeState(stateOf({ repo, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    const m = msgOf(r, 'files_touched_underreported_by_harness');
    expect('6.10 5 写 / 3 删 / 2 留、只登记 1 个 → exit 1', r.code === 1, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('6.11 FAIL 消息只点名留下的 B.java，不点已删除的探针',
      m.includes('B.java') && !/P1Test\.java|P2Test\.java|P3Test\.java/.test(m), m.slice(0, 300));
    expect('6.12 INFO 列出 3 个已删除的探针',
      ['P1Test.java', 'P2Test.java', 'P3Test.java'].every((n) => msgOf(r, 'probe_files_deleted').includes(n)),
      msgOf(r, 'probe_files_deleted').slice(0, 300));
    expect('6.13 probeFilesDeleted 恰好 3 个',
      (r.data?.probeFilesDeleted ?? []).length === 3, JSON.stringify(r.data?.probeFilesDeleted));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
}

{
  // 6.14-6.16 全部写了又删、没留任何未登记文件 → exit 0，INFO 列出全部
  const SID = 'session-dddd0004-0000-0000-0000-000000000004';
  const KEEP = 'src/main/java/com/x/Keep.java';
  const probes = ['src/test/java/com/x/Q1Test.java', 'src/test/java/com/x/Q2Test.java', 'src/test/java/com/x/Q3Test.java'];
  const repo = slash(makeRealRepo([KEEP]));
  const root = makeRoot('--D-Tmp-r23--', [{
    dir: SID,
    events: sessionEvents({
      id: SID,
      writes: [KEEP, ...probes].map((p) => ({ path: `${repo}/${p}` })),
      shells: probes.map((p) => ({ command: `Remove-Item '${repo}/${p}' -Force` })),
    }),
  }]);
  const art = makeArtifactDir([artifactOf({ files: [KEEP] })]);
  const st = writeState(stateOf({ repo, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('6.14 写了 4 个、3 个删掉、留下的那个已登记 → exit 0', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('6.15 INFO 列出全部 3 个已删除文件',
      (r.data?.probeFilesDeleted ?? []).length === 3, JSON.stringify(r.data?.probeFilesDeleted));
    expect('6.16 消息提醒「若认为不该删，检查是否误删」',
      /误删/.test(msgOf(r, 'probe_files_deleted')), msgOf(r, 'probe_files_deleted').slice(-200));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
}

{
  // 6.17-6.20 **边界（方向不能搞混）**：files_touched 登记了一个已删除的文件
  //            → 这是 R18 的 files_touched_not_found 该抓的，
  //              本规则（只看「写了的、没登记的」）既不放过也不代劳。
  const SID = 'session-dddd0005-0000-0000-0000-000000000005';
  const A = 'src/main/java/com/x/A.java';
  const GONE = 'src/main/java/com/x/Gone.java';
  const repo = slash(makeRealRepo([A]));      // Gone.java 不在磁盘上
  const root = makeRoot('--D-Tmp-r23--', [{
    dir: SID, events: sessionEvents({ id: SID, writes: [{ path: `${repo}/${A}` }, { path: `${repo}/${GONE}` }] }),
  }]);
  const fixArt = artifactOf({ files: [A, GONE] });
  const art = makeArtifactDir([fixArt]);
  const st = writeState(stateOf({ repo, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('6.17 登记的已删除文件不由本规则判 under-reported（方向不同）',
      !hasRule(r, 'files_touched_underreported_by_harness'), JSON.stringify(rulesOf(r)));
    expect('6.18 也不误判成 overclaim（harness 确实写过它）',
      !hasRule(r, 'files_touched_overclaimed_by_harness'), JSON.stringify(rulesOf(r)));
    expect('6.19 本规则整体 exit 0（谁的责任谁负）', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r, 'FAIL'))}`);
    const cp = runScript(join(HERE, 'check-payload.mjs'),
      [join(art, 'done-1.md'), '--role', 'fix', '--repo', repo, '--artifact-dir', art, '--json']);
    expect('6.20 R18 的 files_touched_not_found 仍然抓它（两件事没被合并）',
      (cp.data?.errors ?? []).some((e) => e.rule === 'files_touched_not_found'),
      JSON.stringify((cp.data?.errors ?? []).map((e) => e.rule)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
}

{
  // 6.21-6.22 降级纪律：target_repo 本身不是目录 → 存在性不可判定
  //            **不能**因此把「未登记的源码写入」静默放过（那会重新打开 under-reporting 的口子）
  const SID = 'session-dddd0006-0000-0000-0000-000000000006';
  const ghostRepo = 'D:/No/Such/Repo/R23';
  const root = makeRoot('--D-Tmp-r23--', [{
    dir: SID, events: sessionEvents({ id: SID, writes: [{ path: `${ghostRepo}/src/A.java` }, { path: `${ghostRepo}/src/B.java` }] }),
  }]);
  const art = makeArtifactDir([artifactOf({ files: ['src/A.java'] })]);
  const st = writeState(stateOf({ repo: ghostRepo, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('6.21 基准目录不存在 → 仍判 under-reported（不静默放过）',
      hasRule(r, 'files_touched_underreported_by_harness', 'FAIL') && r.code === 1,
      `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('6.22 并 WARN file_existence_unknown（降级必须可见，不能假装甄别过）',
      hasRule(r, 'file_existence_unknown', 'WARN'), JSON.stringify(rulesOf(r)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); }
}

{
  // 6.23-6.25 **关键反证**：文件现在不存在，但日志里**没有任何删除动作**。
  //    光看「文件不在」分辨不出「写完删了」和「那条 write 根本没落盘 / 基准指错了」。
  //    后者照旧判 under-reported —— 否则「别让文件落盘」就成了绕过手段。
  //    （这正是 stop-hook.test.mjs case 50 / R21-B 的形状。）
  const SID = 'session-dddd0007-0000-0000-0000-000000000007';
  const A = 'src/main/java/com/x/A.java';
  const SNEAKY = 'src/main/java/com/x/Sneaky.java';
  const repo = slash(makeRealRepo([A]));    // Sneaky.java 不在磁盘上，也没有删除记录
  const root = makeRoot('--D-Tmp-r23--', [{
    dir: SID, events: sessionEvents({ id: SID, writes: [{ path: `${repo}/${A}` }, { path: `${repo}/${SNEAKY}` }] }),
  }]);
  const art = makeArtifactDir([artifactOf({ files: [A] })]);
  const st = writeState(stateOf({ repo, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('6.23 文件不在、但无删除动作 → 仍 exit 1（不能靠「不落盘」绕过）',
      r.code === 1, `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('6.24 仍报 underreported 并点名 Sneaky.java',
      hasRule(r, 'files_touched_underreported_by_harness', 'FAIL')
      && msgOf(r, 'files_touched_underreported_by_harness').includes('Sneaky.java'),
      msgOf(r, 'files_touched_underreported_by_harness').slice(0, 300));
    expect('6.25 不报 probe_files_deleted（缺删除证据就不认）',
      !hasRule(r, 'probe_files_deleted'), JSON.stringify(rulesOf(r)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
}

{
  // 6.26-6.28 写了、没删（还在磁盘上）、但日志里**有**一条别的删除命令提到它 ——
  //    「文件在」优先于「有删除记录」：仓库最终状态里有它，就是改动。
  //    （防止只认日志、不看磁盘造成漏报。）
  const SID = 'session-dddd0008-0000-0000-0000-000000000008';
  const A = 'src/main/java/com/x/A.java';
  const B = 'src/main/java/com/x/B.java';
  const repo = slash(makeRealRepo([A, B]));
  const root = makeRoot('--D-Tmp-r23--', [{
    dir: SID,
    events: sessionEvents({
      id: SID,
      writes: [{ path: `${repo}/${A}` }, { path: `${repo}/${B}` }],
      // 曾经删过、后来又写回来了：日志里有删除动作，但文件现在在
      shells: [{ command: `Remove-Item '${repo}/${B}' -Force` }],
    }),
  }]);
  const art = makeArtifactDir([artifactOf({ files: [A] })]);
  const st = writeState(stateOf({ repo, artifactDir: art, contracts: [{ fix_agent_id: 'fix-1' }] }));
  try {
    const r = run(['--state', st.path, '--sessions', root, '--json']);
    expect('6.26 文件现在存在（即便曾有删除记录）→ 仍判 under-reported',
      hasRule(r, 'files_touched_underreported_by_harness', 'FAIL') && r.code === 1,
      `code=${r.code} ${JSON.stringify(rulesOf(r))}`);
    expect('6.27 点名的正是仍留在仓库里的 B.java',
      msgOf(r, 'files_touched_underreported_by_harness').includes('B.java'),
      msgOf(r, 'files_touched_underreported_by_harness').slice(0, 200));
    expect('6.28 不报 probe_files_deleted', !hasRule(r, 'probe_files_deleted'), JSON.stringify(rulesOf(r)));
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(st.dir, { recursive: true, force: true }); rmSync(art, { recursive: true, force: true }); rmSync(repo, { recursive: true, force: true }); }
}

// ════════════════════════════════════════════════════════════════════
// 7 · 真实数据自证（field-test-1：8 个探针写了又删 → 0 FAIL + INFO）
// ════════════════════════════════════════════════════════════════════
console.log('\n=== 7：真实数据自证（field-test-1 / session 99da3b3f 的 8 个探针）===');

const FT_STATE = '<TARGET_REPO>/.work/round1/state.json';
const FT_REPO = '<TARGET_REPO>';
const FT_SESSION = 'session-99da3b3f-7a50-4935-9098-81e4f1accf29';
const FT_PROBES = [
  'src/test/java/com/hilltopvillage/doc/F6DocStructureProbeTest.java',
  'src/test/java/com/hilltopvillage/doc/F6IndependentProbeTest.java',
  'src/test/java/com/hilltopvillage/shop/F1TruncationProbeTest.java',
  'src/test/java/com/hilltopvillage/shop/F2VerificationProbeTest.java',
  'src/test/java/com/hilltopvillage/shop/F3VerifyProbeTest.java',
  'src/test/java/com/hilltopvillage/shop/F4IndependentProbeTest.java',
  'src/test/java/com/hilltopvillage/shop/F4bGhostSlotProbeTest.java',
  'src/test/java/com/hilltopvillage/shop/ShopListenerPurchaseMessageProbeTest.java',
];

if (!existsSync(REAL_ROOT) || !existsSync(FT_STATE) || !existsSync(FT_REPO)) {
  console.log('  SKIP: 真实 field-test-1 账本 / 目标仓库 / dsh 日志不在这台机器上（不计失败）');
} else if (FT_PROBES.some((p) => existsSync(join(FT_REPO, p)))) {
  console.log('  SKIP: 那 8 个探针文件又被建出来了——「已删除」的前提不成立（不计失败）');
} else {
  const r = run(['--state', FT_STATE, '--sessions', REAL_ROOT, '--session-id', FT_SESSION, '--json']);
  expect('7.1 真实账本能跑通（不是配置错误）', r.data?.exitCode !== undefined, r.err.slice(0, 200));
  expect('7.2 8 个探针写后已删 → 0 FAIL / exit 0', r.code === 0, `code=${r.code} ${JSON.stringify(rulesOf(r, 'FAIL'))}`);
  expect('7.3 8 个探针全部进 probe_files_deleted',
    (r.data?.probeFilesDeleted ?? []).length === 8, String((r.data?.probeFilesDeleted ?? []).length));
  expect('7.4 一个都不算 under-reported',
    !hasRule(r, 'files_touched_underreported_by_harness'), JSON.stringify(rulesOf(r)));
  console.log(`    → field-test-1: calls=${r.data?.writeEditCalls} files=${r.data?.actualFiles} `
    + `probes=${(r.data?.probeFilesDeleted ?? []).length} exit=${r.code}`);
}

console.log(`\n合计: ${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
