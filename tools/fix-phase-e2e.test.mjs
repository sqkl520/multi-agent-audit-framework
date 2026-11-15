#!/usr/bin/env node
/**
 * fix-phase-e2e.test.mjs — 「修复相位退化」故障模式的端到端集成测试
 *
 * ── 它重演的是什么 ───────────────────────────────────────────────────
 * 2026-11-14 experiments/hilltop-dsh 的一次真实审计：
 *   7 份产物、38 条发现（8 HIGH / 22 MEDIUM / 8 LOW），全部契约合规。
 * 派修复时：
 *   - 主 Agent 用**单个 session、196 step、303 次工具调用**全部串行做完；
 *   - `subagent` 调用 **0 次**；
 *   - 只修了 6 条（15.8%），31 条从未进入任何任务书；
 *   - 2 条 HIGH（round2-mechanics::F3、round3-A::A-01）至今仍在代码里。
 * 而框架当时**全程没有任何工具报错**。
 *
 * 根因不是「Agent 不听话」，是三道判据同时缺位：
 *   1. `phase` 枚举没有 wave4/wave5 → stop-hook 在修复相位完全不触发（R1）
 *   2. fix 角色的契约只要求 files_touched → 不要求逐条表态（R3）
 *   3. 没有任何工具对账「38 条发现 vs 实际派发/登记」（R4、R6）
 *
 * 本测试用合成 fixture 重演这次事故，逐层证明每一道防线现在都会响。
 * 它**不测**每个工具的细节规则（那些由各自的 .test.mjs 覆盖）；
 * 它测的是「把真实事故的形态整个喂进去，有没有任何一层放行」。
 *
 * ── 为什么用合成 fixture 而不是 experiments/ 下的真实数据 ─────────────
 * 真实数据会随修复漂移；而判据不该随它漂移。
 * 合成 fixture 的 id / 数量 / 严重性分布严格对齐那次事故：
 *   7 份产物 → 7 个 .md；38 条 finding；8 HIGH。
 * 其中「事故里仍留在代码里的 2 条 HIGH」在场景 A 里正好是未被登记的那 2 条。
 *
 * ── 三个场景 ────────────────────────────────────────────────────────
 *   A  重演事故：串行 + 少修 + 红测日志在 target/  → 四层必须全部报警
 *   B  按规则修好：逐条派发 + 去向往返表填满 + 红测日志移出 target/ → 四层全绿
 *   C  绕过尝试：去向表 38 条全填 DEFERRED、fix_contracts 为空
 *      → 覆盖率 100% 但仍被 R6 拦下（证明两层互补，不是冗余）
 *
 * 运行：node tools/fix-phase-e2e.test.mjs    （退出码 0 = 全绿）
 *
 * 风格沿用仓库既有自测（stop-hook.test.mjs / check-disposition-coverage.test.mjs）：
 * 纯 node、不引第三方依赖、execFileSync 调真实脚本、不 mock。
 * 每个场景把 fixture 写到系统临时目录，结束即删。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const STOP_HOOK = join(HERE, 'stop-hook.mjs');
const CHECK_STATE = join(HERE, 'check-state.mjs');
const CHECK_PAYLOAD = join(HERE, 'check-payload.mjs');
const CHECK_DISPOSITION = join(HERE, 'check-disposition-coverage.mjs');
const CHECK_FIX_INSTANCES = join(HERE, 'check-fix-instances.mjs');

// ── 断言框架（与仓库其他自测同款）───────────────────────────────────
let pass = 0, fail = 0;
/**
 * expect 的 label 必须写明「哪一层防线 / 哪个工具」。
 * 测试失败时，报告要能直接回答「哪道门没关上」，而不是只显示一个 false。
 */
const expect = (label, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail ? ' — ' + detail : ''}`); }
};

// ── 调用真实脚本（不 mock）─────────────────────────────────────────
/** 跑一个 node 脚本，返回 { code, stdout, stderr }。execFileSync 在非 0 时抛异常。 */
function runNode(script, args, { input } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return {
      code: typeof e.status === 'number' ? e.status : 1,
      stdout: e.stdout?.toString() ?? '',
      stderr: e.stderr?.toString() ?? '',
    };
  }
}

/** 从「前面可能混着人读输出」的 stdout 里取出 JSON。 */
function tryJson(s) {
  const i = s.indexOf('{');
  if (i < 0) return null;
  try { return JSON.parse(s.slice(i)); } catch { return null; }
}

const rules = (r) => (r.data?.problems ?? []).map((p) => p.rule);
const hasRule = (r, rule) => rules(r).includes(rule);
const probWith = (r, rule) => (r.data?.problems ?? []).find((p) => p.rule === rule);

// ────────────────────────────────────────────────────────────────────
// 事故数据：7 份产物 / 38 条 finding / 8 HIGH
//
// scope 由文件名去掉 `-audit.md` 得来（与 check-disposition-coverage 一致），
// 所以 `round2-mechanics-audit.md` → scope `round2-mechanics`。
// evidence.file 尽量对齐真实仓库；一处例外：A-04 归到 ConfigManager.java，
// 这是为了在场景 B 里构造一个「两条 HIGH 的 target_files 完全相同」的合法合并，
// 让 FIX_INSTANCE_MERGED 分支被真正走到（见场景 B 的说明）。
// ────────────────────────────────────────────────────────────────────
const INCIDENT = {
  'round1-core': [
    ['F1', 'MEDIUM', 'src/util/VictoryWaves.java', 88],
    ['F2', 'MEDIUM', 'src/util/VictoryWaves.java', 141],
    ['F3', 'MEDIUM', 'src/util/Msg.java', 33],
  ],
  'round2-ai': [
    ['R2-AI-001', 'HIGH', 'src/ai/ExplodeBeetleGoal.java', 241],
    ['R2-AI-002', 'HIGH', 'src/ai/AirdropSpawnGoal.java', 237],
    ['R2-AI-003', 'MEDIUM', 'src/ai/MobGoal.java', 77],
    ['R2-AI-004', 'MEDIUM', 'src/ai/MobGoal.java', 91],
    ['R2-AI-005', 'LOW', 'src/ai/HookClawHunterGoal.java', 180],
  ],
  'round2-arena': [
    ['F1', 'MEDIUM', 'src/arena/ArenaManager.java', 210],
    ['F2', 'LOW', 'src/arena/MultiArenaManager.java', 523],
    ['F3', 'MEDIUM', 'src/arena/Arena.java', 64],
    ['F4', 'MEDIUM', 'src/arena/Arena.java', 118],
  ],
  'round2-mechanics': [
    ['F1', 'HIGH', 'src/mechanics/TabListManager.java', 298],
    ['F2', 'HIGH', 'src/mechanics/NodeListener.java', 229],
    ['F3', 'HIGH', 'src/mechanics/NodeSystem.java', 381],
    ['F4', 'MEDIUM', 'src/mechanics/NodeSystem.java', 402],
    ['F5', 'MEDIUM', 'src/mechanics/NodeListener.java', 260],
  ],
  'round3-A': [
    ['A-01', 'HIGH', 'src/config/ConfigManager.java', 1636],
    ['A-02', 'MEDIUM', 'src/config/ConfigManager.java', 1702],
    ['A-03', 'MEDIUM', 'src/config/ConfigManager.java', 1744],
    ['A-04', 'HIGH', 'src/config/ConfigManager.java', 149],
    ['A-05', 'MEDIUM', 'src/config/ConfigManager.java', 1788],
    ['A-06', 'MEDIUM', 'src/config/ConfigManager.java', 1810],
    ['A-07', 'MEDIUM', 'src/config/ConfigManager.java', 1833],
  ],
  'round3-B': [
    ['B-01', 'HIGH', 'src/admin/ArenaResetService.java', 280],
    ['B-02', 'MEDIUM', 'src/admin/ArenaResetService.java', 301],
    ['B-03', 'MEDIUM', 'src/admin/AdminCommand.java', 145],
    ['B-04', 'LOW', 'src/command/SetupWizard.java', 547],
    ['B-05', 'MEDIUM', 'src/command/SetupWizard.java', 612],
    ['B-06', 'LOW', 'src/command/HilltopTabCompleter.java', 75],
    ['B-07', 'MEDIUM', 'src/command/HilltopTabCompleter.java', 121],
  ],
  'round3-C': [
    ['F1', 'MEDIUM', 'src/shop/ShopManager.java', 88],
    ['F2', 'MEDIUM', 'src/shop/ShopManager.java', 120],
    ['F3', 'MEDIUM', 'src/shop/ShopPricing.java', 44],
    ['F4', 'LOW', 'src/shop/ShopConfigLoader.java', 165],
    ['F5', 'LOW', 'src/shop/ShopListener.java', 162],
    ['F6', 'LOW', 'src/doc/CommandsDocumentGenerator.java', 189],
    ['F7', 'LOW', 'src/doc/CommandsDocumentGenerator.java', 441],
  ],
};

// 由 INCIDENT 派生出的扁平列表 / 集合
const ALL_FINDINGS = Object.entries(INCIDENT).flatMap(([scope, rows]) =>
  rows.map(([id, severity, file, line]) => ({ scope, id, severity, file, line, key: `${scope}::${id}` })));
const HIGH_IDS = ALL_FINDINGS.filter((f) => f.severity === 'HIGH').map((f) => f.key);

// 事故里真实派发的 6 条（全部是 HIGH），以及**至今仍在代码里的 2 条 HIGH**。
// 这个选取让场景 A 的「未登记 2 条 HIGH」正好等于诊断报告里点名的那 2 条。
const REGISTERED_IN_INCIDENT = [
  'round2-ai::R2-AI-001',
  'round2-ai::R2-AI-002',
  'round2-mechanics::F1',
  'round2-mechanics::F2',
  'round3-A::A-04',
  'round3-B::B-01',
];
const STILL_LIVE_HIGH = ['round2-mechanics::F3', 'round3-A::A-01'];

// ── fixture 写入器 ─────────────────────────────────────────────────
/** 审计产物：末尾一个 ```json 信封，payload.findings[] 供 R4 统计分母。 */
function auditArtifactMd(scope, rows) {
  const findings = rows.map(([id, severity, file, line]) => ({
    finding_id: id,
    severity,
    dimension: 'logic',
    evidence: { file, line, quote: `${id} 的逐字证据` },
    inference: { claim: `${id} 的主张`, basis: 'b', alternatives: [] },
    status: 'CONFIRMED',
  }));
  const env = {
    schema_version: 'output-contract-v1',
    agent_id: `${scope}-audit`,
    role: 'audit',
    status: 'SUCCESS',
    contract_valid: true,
    artifact_path: `<OUTDIR>/${scope}-audit.md`,
    payload: { findings, self_checks: [{ scope_covered: 'DONE' }], searched_scope: { files: [] } },
    error: null,
  };
  return `# ${scope} 审计产物\n\n摘要文字（重演 hilltop-dsh 事故的合成数据）。\n\n\`\`\`json\n${JSON.stringify(env, null, 2)}\n\`\`\`\n`;
}

/** 修复产物：role=fix，disposition 契约的载体。 */
function fixArtifactMd({ agentId, findingId, redLogPath }) {
  const env = {
    schema_version: 'output-contract-v1',
    agent_id: agentId,
    role: 'fix',
    status: 'SUCCESS',
    contract_valid: true,
    artifact_path: `<OUTDIR>/${agentId}.md`,
    payload: {
      finding_id: findingId,
      disposition: 'FIXED',
      test_path: 'tools/red-green.test.mjs',
      red_log_path: redLogPath,
      files_touched: [{ path: 'src/a.java', change_summary: '捕获异常并上抛，不再吞掉' }],
      verification_commands: [{ command: 'node tools/red-green.test.mjs', result: 'passed' }],
      residual_risks: [],
    },
    error: null,
  };
  return `# ${agentId} 修复产物\n\n正文。\n\n\`\`\`json\n${JSON.stringify(env, null, 2)}\n\`\`\`\n`;
}

/** 修复前置登记（wave4-fix.md §2 的字段）。 */
const fixContract = (findingId, agentId, { targetFiles = ['src/a.java'] } = {}) => ({
  finding_id: findingId,
  fix_agent_id: agentId,
  registered_at: '2026-11-15T10:00:00Z',
  defect_statement: '当 X 时 Y 会发生，预期是 Z',
  disproof_condition: 'node tools/red-green.test.mjs 应从红转绿',
  baseline_result: 'exit=1，断言失败（红）',
  rollback_command: 'git checkout -- src/a.java',
  test_path: 'tools/red-green.test.mjs',
  target_files: targetFiles,
});

/** 合并申报（wave4-fix.md §0.3）。 */
const mergedRecord = (mergedFindingIds, sharedTargetFiles) => ({
  kind: 'FIX_INSTANCE_MERGED',
  merged_finding_ids: mergedFindingIds,
  reason: '两条 finding 的 target_files 完全相同，同一函数同一根因',
  shared_target_files: sharedTargetFiles,
  mechanically_checkable: '两条 finding 的 target_files 排序后逐元素相等',
});

/**
 * state.json。
 * current_plan 的 current_step 故意设为「超过总步数」，让 stop-hook 的
 * 「相位尚未闭合」判据不触发——这样场景 A 里它唯一的拦阻理由就是
 * 「多缺陷单实例串行」，断言才能精确指到那道门。
 */
function stateOf({ contracts, spawned, discipline = [] }) {
  return {
    schema_version: 'run-state-v1',
    trace_id: 'trace-hilltop-replay',
    round_id: 'round1',
    path_mode: 'FIX',
    phase: 'wave4',
    status: 'RUNNING',
    slices: {
      'round2-mechanics': { state: 'DONE', artifact_paths: ['out/round2-mechanics-audit.md'] },
    },
    budget: { total_cap: 60, spent: 10, reserved_for_downstream: 20, spawned_fix_agents: spawned },
    discipline_log: discipline,
    fix_contracts: contracts,
    current_plan: {
      phase: 'wave4',
      steps: [
        { action: '逐条派发修复实例', done_when: '每条 UPHELD 都有 fix_contract' },
        { action: '收集产物并回填裁决', done_when: '全部产物通过 check-payload' },
      ],
      exit_condition: '所有 fix_contract 都有 verdict',
      current_step: 3,
    },
    in_flight: [],
  };
}

/** 最终报告的「A. 裁决索引表」。rows = [[finding_id, 裁决, 严重性], ...] */
function finalReportMd(rows) {
  const lines = [
    '# round1 最终报告',
    '',
    '## 1. 元信息',
    '',
    '| 字段 | 值 |',
    '|---|---|',
    '| 路径模式 | FIX |',
    '',
    '## A. 裁决索引表（附加）',
    '',
    '| finding_id | 严重性 | 维度 | 位置 | 裁决 | 出处 |',
    '|---|---|---|---|---|---|',
    ...rows.map(([id, verdict, severity]) =>
      `| ${id} | ${severity} | logic | \`src/a.java:10\` | ${verdict} | \`round1-03-critique-arbiter.md\` |`),
    '',
    '## 2. 覆盖说明',
    '',
    '正文。',
    '',
  ];
  return lines.join('\n');
}

/** 发现去向表。rows = [[finding_id, disposition, reason], ...] */
function ledgerMd(rows) {
  return [
    '# 发现去向表',
    '',
    '| finding_id | disposition | 依据 |',
    '|---|---|---|',
    ...rows.map((r) => `| ${r.join(' | ')} |`),
    '',
  ].join('\n');
}

/** 建立一个临时工作区：artifacts/ 放 7 份审计产物，fix-out/ 放修复产物。 */
function makeWorkspace() {
  const root = mkdtempSync(join(tmpdir(), 'fix-e2e-'));
  const artifacts = join(root, 'artifacts');
  const fixOut = join(root, 'fix-out');
  mkdirSync(artifacts, { recursive: true });
  mkdirSync(fixOut, { recursive: true });
  for (const [scope, rows] of Object.entries(INCIDENT)) {
    writeFileSync(join(artifacts, `${scope}-audit.md`), auditArtifactMd(scope, rows));
  }
  return {
    root,
    artifacts,
    fixOut,
    statePath: join(root, 'state.json'),
    reportPath: join(root, 'final-report.md'),
    ledgerPath: join(root, 'ledger.md'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

// ────────────────────────────────────────────────────────────────────
// 场景 A：重演真实事故
// ────────────────────────────────────────────────────────────────────
console.log('\n=== 场景 A：重演真实事故（单实例串行 6 条 / 去向表空白 / 红测日志在 target/）===');
console.log('    重演的是：7 份产物 38 条发现、8 条 HIGH 全 UPHELD，却只有 6 条登记、spawned=1、');
console.log('    去向表一行未填、其中一条修复把红测日志写进了 target/。\n');
{
  const ws = makeWorkspace();
  try {
    // ── state.json：6 条登记（真实修了 6 条）、单实例、spawned=1 ──
    const contracts = REGISTERED_IN_INCIDENT.map((fid) => fixContract(fid, 'fix-session-1'));
    writeFileSync(ws.statePath, JSON.stringify(stateOf({ contracts, spawned: 1 }), null, 2));

    // ── final-report.md：8 条 HIGH 全部 UPHELD ──
    writeFileSync(ws.reportPath, finalReportMd(HIGH_IDS.map((id) => [id, 'UPHELD', 'HIGH'])));

    // ── 去向表：空表（主 Agent 从未逐条表态）──
    writeFileSync(ws.ledgerPath, ledgerMd([]));

    // ── 6 份修复产物，其中第一份把红测日志写进了 target/ ──
    const fixFiles = contracts.map((c, i) => {
      const redLogPath = i === 0 ? 'target/red.log' : `experiments/round1/red-${c.finding_id}.log`;
      const p = join(ws.fixOut, `${c.fix_agent_id}-${i}.md`);
      writeFileSync(p, fixArtifactMd({ agentId: `fix-${i + 1}`, findingId: c.finding_id, redLogPath }));
      return p;
    });
    const badFix = fixFiles[0];

    // ── 断言 1：R1 · stop-hook 抓「多缺陷单实例串行」──
    const hook = runNode(STOP_HOOK, ['--state', ws.statePath], { input: '{}' });
    expect('A1 [R1/stop-hook] 拒绝结束回合（exit 2）', hook.code === 2,
      `实际 exit ${hook.code}；stderr=${hook.stderr.slice(0, 300)}`);
    expect('A1 [R1/stop-hook] 理由含「多条独立缺陷在单个实例里串行完成」',
      /多条独立缺陷在单个实例里串行完成/.test(hook.stderr), hook.stderr.slice(0, 400));
    expect('A1 [R1/stop-hook] 理由指出面板下限（T0/T1/T2）', /面板下限/.test(hook.stderr),
      hook.stderr.slice(0, 400));
    expect('A1 [R1/stop-hook] 拦阻理由不是「相位尚未闭合」而是串行（判据可定位）',
      !/相位尚未闭合/.test(hook.stderr), hook.stderr.slice(0, 400));

    // ── 断言 2：R6 · 裁决表（外部基准）抓「UPHELD 少登记」──
    const fi = runNode(CHECK_FIX_INSTANCES, ['--state', ws.statePath, '--report', ws.reportPath, '--json']);
    const fiData = tryJson(fi.stdout);
    const fiR = { data: fiData };
    const missingProb = probWith(fiR, 'upheld_without_fix_contract');
    expect('A2 [R6/check-fix-instances] exit 1', fi.code === 1, `实际 exit ${fi.code}`);
    expect('A2 [R6] 报出规则 upheld_without_fix_contract', hasRule(fiR, 'upheld_without_fix_contract'),
      JSON.stringify(rules(fiR)));
    expect('A2 [R6] 未登记计数恰好是 2', fiData?.totals?.missing === 2,
      JSON.stringify(fiData?.totals));
    expect('A2 [R6] 点名仍在代码里的 round2-mechanics::F3',
      /round2-mechanics::F3/.test(missingProb?.msg ?? ''), missingProb?.msg?.slice(0, 400));
    expect('A2 [R6] 点名仍在代码里的 round3-A::A-01',
      /round3-A::A-01/.test(missingProb?.msg ?? ''), missingProb?.msg?.slice(0, 400));
    expect('A2 [R6] 不点名已登记的 round2-ai::R2-AI-001',
      !/round2-ai::R2-AI-001/.test(missingProb?.msg ?? ''), missingProb?.msg?.slice(0, 400));
    expect('A2 [R6] 消息里明确「缺口 2 条」', /缺口 2 条/.test(missingProb?.msg ?? ''),
      missingProb?.msg?.slice(0, 400));

    // ── 断言 3：R4 · 去向往返表抓「38 条从未表态」──
    const dc = runNode(CHECK_DISPOSITION, ['--artifacts', ws.artifacts, '--ledger', ws.ledgerPath, '--json']);
    const dcData = tryJson(dc.stdout);
    const dcR = { data: dcData };
    expect('A3 [R4/check-disposition-coverage] exit 1', dc.code === 1, `实际 exit ${dc.code}`);
    expect('A3 [R4] 分母是 38 条 finding', dcData?.totals?.findings === 38,
      JSON.stringify(dcData?.totals));
    expect('A3 [R4] 38 条全部未表态', dcData?.totals?.unaccounted === 38,
      JSON.stringify(dcData?.totals));
    const unacc = (dcData?.problems ?? []).filter((p) => p.rule === 'finding_without_disposition');
    expect('A3 [R4] 逐条报 finding_without_disposition（38 条，不是只报一个百分比）',
      unacc.length === 38, `实际 ${unacc.length} 条`);
    expect('A3 [R4] 逐条消息里点名 HIGH（round3-B::B-01）',
      unacc.some((p) => /round3-B::B-01/.test(p.msg ?? '')), '未在逐条消息里找到 B-01');

    // ── 断言 4：R3 · check-payload 抓「红测日志在 target/」──
    const cp = runNode(CHECK_PAYLOAD, [badFix, '--role', 'fix', '--json']);
    const cpData = tryJson(cp.stdout);
    const cpR = { data: { problems: cpData?.errors ?? [] } };
    expect('A4 [R3/check-payload] exit 非 0（契约违规）', cp.code !== 0, `实际 exit ${cp.code}`);
    expect('A4 [R3] 报出规则 red_log_in_target', hasRule(cpR, 'red_log_in_target'),
      JSON.stringify(rules(cpR)));
    const redProb = cpData?.errors?.find((e) => e.rule === 'red_log_in_target');
    expect('A4 [R3] 消息指出会被 mvn clean 删掉',
      /mvn clean/.test(redProb?.msg ?? ''), redProb?.msg?.slice(0, 300));

    // ── 断言 5（附加）：R6 同时抓「一个实例吞掉 6 条且无合并申报」──
    expect('A5 [R6] 同时报 merged_without_record（单实例吞 6 条且未申报合并）',
      hasRule(fiR, 'merged_without_record'), JSON.stringify(rules(fiR)));
  } finally {
    ws.cleanup();
  }
}

// ────────────────────────────────────────────────────────────────────
// 场景 B：按规则修好 → 四层全绿
// ────────────────────────────────────────────────────────────────────
console.log('\n=== 场景 B：按规则修好（逐条派发 + 去向表填满 + 红测日志移出 target/）===');
console.log('    同样 38 条发现：8 条 HIGH 全部登记、8 个实例、去向表 38 行填满、');
console.log('    红测日志放到 experiments/ 下。四道门必须全部放行。\n');
{
  const ws = makeWorkspace();
  try {
    // 任务书的形态：8 条 UPHELD HIGH → 8 条契约 / 8 个 distinct fix_agent_id / spawned=8。
    // 同时申报一条 FIX_INSTANCE_MERGED（A-01 + A-04 同文件），把「合并容器」写进账本。
    // 注意：本形态下两条仍各有自己的 fix_agent_id，合并记录处于「已申报但未实际使用」状态；
    // 真正让合并生效的形态在 B7 里单独验证。
    const MERGE_FILES = ['src/config/ConfigManager.java'];
    const literalContracts = HIGH_IDS.map((id, i) => fixContract(id, `fix-${i + 1}`, {
      targetFiles: id.startsWith('round3-A') ? MERGE_FILES : [`src/${id.replace(/[^a-z0-9]/gi, '')}.java`],
    }));
    const literalDiscipline = [mergedRecord(['round3-A::A-01', 'round3-A::A-04'], MERGE_FILES)];
    writeFileSync(ws.statePath,
      JSON.stringify(stateOf({ contracts: literalContracts, spawned: 8, discipline: literalDiscipline }), null, 2));
    writeFileSync(ws.reportPath, finalReportMd(HIGH_IDS.map((id) => [id, 'UPHELD', 'HIGH'])));

    // 去向表：8 条 HIGH 标 FIXED，其余 30 条 DEFERRED（依据 ≥10 字）
    const ledgerRows = ALL_FINDINGS.map((f) => (f.severity === 'HIGH'
      ? [f.key, 'FIXED', '已修，红测转绿']
      : [f.key, 'DEFERRED', '本轮不修：需先完成前置重构，下一轮统一评估']));
    writeFileSync(ws.ledgerPath, ledgerMd(ledgerRows));

    // 修复产物：8 条，红测日志全部移到 experiments/ 下
    for (const [i, c] of literalContracts.entries()) {
      const redLogPath = `experiments/round1/red-${c.finding_id.replace(/::/g, '-')}.log`;
      writeFileSync(join(ws.fixOut, `fix-${i + 1}.md`),
        fixArtifactMd({ agentId: `fix-${i + 1}`, findingId: c.finding_id, redLogPath }));
    }
    const goodFix = join(ws.fixOut, 'fix-5.md'); // 对应仍在代码里的 F3

    // ── B0（附加）：R1 的另一半 —— check-state 认可 wave4 + 契约完整 ──
    const cs = runNode(CHECK_STATE, [ws.statePath, '--json']);
    const csData = tryJson(cs.stdout);
    expect('B0 [R1/check-state] exit 0（wave4 合法 + 8 条契约字段完整）', cs.code === 0,
      `实际 exit ${cs.code}；${JSON.stringify(csData?.errors?.map((e) => e.rule))}`);

    // ── B1：stop-hook 放行（逐条派发，不再串行）──
    const hook = runNode(STOP_HOOK, ['--state', ws.statePath], { input: '{}' });
    expect('B1 [R1/stop-hook] exit 0（8 个实例 > 1，不再判串行）', hook.code === 0,
      `实际 exit ${hook.code}；stderr=${hook.stderr.slice(0, 300)}`);

    // ── B2：R6 放行（裁决表 8 条 UPHELD 全部登记；实例数与 spawned 一致）──
    const fi = runNode(CHECK_FIX_INSTANCES, ['--state', ws.statePath, '--report', ws.reportPath, '--json']);
    const fiData = tryJson(fi.stdout);
    expect('B2 [R6/check-fix-instances] exit 0', fi.code === 0,
      `实际 exit ${fi.code}；problems=${JSON.stringify(fiData?.problems?.map((p) => p.rule))}`);
    expect('B2 [R6] 未登记数为 0', fiData?.totals?.missing === 0, JSON.stringify(fiData?.totals));
    expect('B2 [R6] 没有 FAIL', !(fiData?.problems ?? []).some((p) => p.level === 'FAIL'),
      JSON.stringify(fiData?.problems));

    // ── B3：R4 放行（38 条全部表态，且没有 HIGH 悬空）──
    const dc = runNode(CHECK_DISPOSITION, ['--artifacts', ws.artifacts, '--ledger', ws.ledgerPath, '--json']);
    const dcData = tryJson(dc.stdout);
    expect('B3 [R4/check-disposition-coverage] exit 0', dc.code === 0,
      `实际 exit ${dc.code}；problems=${JSON.stringify(dcData?.problems?.map((p) => p.rule))}`);
    expect('B3 [R4] 38 条全部已表态', dcData?.totals?.unaccounted === 0, JSON.stringify(dcData?.totals));
    expect('B3 [R4] 没有 HIGH 悬空', dcData?.totals?.highUnaccounted === 0,
      JSON.stringify(dcData?.totals));

    // ── B4：R3 放行（红测日志在 target/ 之外）──
    const cp = runNode(CHECK_PAYLOAD, [goodFix, '--role', 'fix', '--json']);
    const cpData = tryJson(cp.stdout);
    expect('B4 [R3/check-payload] exit 0（FIXED + test_path + target/ 外红测日志）', cp.code === 0,
      `实际 exit ${cp.code}；errors=${JSON.stringify(cpData?.errors?.map((e) => e.rule))}`);
    expect('B4 [R3] 明确 ok=true', cpData?.ok === true, JSON.stringify(cpData?.errors));

    // ── B5（附加）：spawned 记错 → R6 抓住 ──
    // 8 条契约 / 8 个 agent，却声称派发了 9 个实例：多记的一方没有任何契约支撑。
    const liePath = join(ws.root, 'state-lie.json');
    writeFileSync(liePath,
      JSON.stringify(stateOf({ contracts: literalContracts, spawned: 9, discipline: literalDiscipline }), null, 2));
    const lie = runNode(CHECK_FIX_INSTANCES, ['--state', liePath, '--report', ws.reportPath, '--json']);
    const lieData = tryJson(lie.stdout);
    expect('B5 [R6] spawned=9 但只有 8 个 distinct agent → exit 1（机器化对账抓自述不一致）',
      lie.code === 1 && (lieData?.problems ?? []).some((p) => p.rule === 'spawned_count_mismatch'),
      `实际 exit ${lie.code}；problems=${JSON.stringify(lieData?.problems?.map((p) => p.rule))}`);

    // ── B6（附加）：真正的合并（2 条共用一个实例，且已申报）→ 也必须全绿 ──
    // 这是 wave4-fix.md §0.3 唯一允许的合并形态。若只测 8/8，合并代码路径等于没被走过。
    const mergedContracts = [
      ...HIGH_IDS.filter((id) => !id.startsWith('round3-A')).map((id, i) => fixContract(id, `m-${i + 1}`, {
        targetFiles: [`src/${id.replace(/[^a-z0-9]/gi, '')}.java`],
      })),
      fixContract('round3-A::A-01', 'm-merge', { targetFiles: MERGE_FILES }),
      fixContract('round3-A::A-04', 'm-merge', { targetFiles: MERGE_FILES }),
    ];
    const mergeStatePath = join(ws.root, 'state-realmerge.json');
    writeFileSync(mergeStatePath, JSON.stringify(
      stateOf({ contracts: mergedContracts, spawned: 7, discipline: literalDiscipline }), null, 2));
    const mergeRun = runNode(CHECK_FIX_INSTANCES,
      ['--state', mergeStatePath, '--report', ws.reportPath, '--json']);
    const mergeData = tryJson(mergeRun.stdout);
    expect('B6 [R6] 真实合并（8 条 → 7 实例，已申报）→ exit 0',
      mergeRun.code === 0,
      `实际 exit ${mergeRun.code}；problems=${JSON.stringify(mergeData?.problems?.map((p) => p.rule))}`);

    // ── B7（附加）：同一份真实合并，抽掉申报 → 立刻判 merged_without_record ──
    const noMergePath = join(ws.root, 'state-nomerge.json');
    writeFileSync(noMergePath, JSON.stringify(
      stateOf({ contracts: mergedContracts, spawned: 7, discipline: [] }), null, 2));
    const noMerge = runNode(CHECK_FIX_INSTANCES,
      ['--state', noMergePath, '--report', ws.reportPath, '--json']);
    const noMergeData = tryJson(noMerge.stdout);
    expect('B7 [R6] 无 FIX_INSTANCE_MERGED → exit 1（合并必须申报）',
      noMerge.code === 1 && (noMergeData?.problems ?? []).some((p) => p.rule === 'merged_without_record'),
      `实际 exit ${noMerge.code}；problems=${JSON.stringify(noMergeData?.problems?.map((p) => p.rule))}`);
  } finally {
    ws.cleanup();
  }
}

// ────────────────────────────────────────────────────────────────────
// 场景 C：绕过尝试 —— 把去向表全填 DEFERRED
// ────────────────────────────────────────────────────────────────────
console.log('\n=== 场景 C：绕过尝试（去向表 38 条全填 DEFERRED，fix_contracts 为空）===');
console.log('    这是最贴近真实动机的形态：只要「每条都有个去向」，覆盖率就是 100%。');
console.log('    本场景证明 R4 会放行但点名 HIGH，而 R6 仍然拦下——两层互补，不是冗余。\n');
{
  const ws = makeWorkspace();
  try {
    // fix_contracts 为空（一条都没派发）
    writeFileSync(ws.statePath, JSON.stringify(stateOf({ contracts: [], spawned: 0 }), null, 2));
    writeFileSync(ws.reportPath, finalReportMd(HIGH_IDS.map((id) => [id, 'UPHELD', 'HIGH'])));

    // 38 条全 DEFERRED。依据刻意只写到刚好满足 R4 的 ≥10 字门槛——
    // 这样 coverage 会 exit 0，把「填满表就能过」的假象完整暴露出来。
    // （若只写「暂缓」两个字，会被 disposition_missing_reason 先拦下，见 C4。）
    writeFileSync(ws.ledgerPath,
      ledgerMd(ALL_FINDINGS.map((f) => [f.key, 'DEFERRED', '暂缓：本轮不处理，等下一轮统一评估'])));

    // ── C1：R4 放行 —— 覆盖率 100% ──
    const dc = runNode(CHECK_DISPOSITION, ['--artifacts', ws.artifacts, '--ledger', ws.ledgerPath, '--json']);
    const dcData = tryJson(dc.stdout);
    expect('C1 [R4/check-disposition-coverage] exit 0（覆盖率 100%）', dc.code === 0,
      `实际 exit ${dc.code}；problems=${JSON.stringify(dcData?.problems?.map((p) => p.rule))}`);
    expect('C1 [R4] 未表态数为 0', dcData?.totals?.unaccounted === 0, JSON.stringify(dcData?.totals));
    expect('C1 [R4] 合计 38 条全部已表态', dcData?.totals?.accounted === 38,
      JSON.stringify(dcData?.totals));

    // ── C2：但 R4 必须醒目警告 8 条 HIGH 悬空，并逐条点名 ──
    const highProb = probWith({ data: dcData }, 'high_severity_unaccounted');
    expect('C2 [R4] 输出里有 high_severity_unaccounted 警告', Boolean(highProb),
      JSON.stringify(dcData?.problems?.map((p) => p.rule)));
    expect('C2 [R4] 警告级别是 WARN（默认不阻断，但必须可见）', highProb?.level === 'WARN',
      highProb?.level);
    expect('C2 [R4] 警告写明「8 条 HIGH」', /8 条 HIGH/.test(highProb?.msg ?? ''),
      highProb?.msg?.slice(0, 300));
    for (const key of HIGH_IDS) {
      if (!new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(highProb?.msg ?? '')) {
        expect(`C2 [R4] 警告点名 HIGH ${key}`, false, highProb?.msg?.slice(0, 500));
      }
    }
    expect('C2 [R4] 8 条 HIGH 全部被点名', HIGH_IDS.every((k) =>
      new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).test(highProb?.msg ?? '')),
      highProb?.msg?.slice(0, 500));

    // ── C3：R6 仍然拦下 —— 去向表填满绕不过「真的派发」──
    const fi = runNode(CHECK_FIX_INSTANCES, ['--state', ws.statePath, '--report', ws.reportPath, '--json']);
    const fiData = tryJson(fi.stdout);
    const fiR = { data: fiData };
    expect('C3 [R6/check-fix-instances] exit 1（去向表满也救不了没派发）', fi.code === 1,
      `实际 exit ${fi.code}`);
    expect('C3 [R6] 报 upheld_without_fix_contract', hasRule(fiR, 'upheld_without_fix_contract'),
      JSON.stringify(rules(fiR)));
    expect('C3 [R6] 未登记计数是 8（全部 UPHELD HIGH）', fiData?.totals?.missing === 8,
      JSON.stringify(fiData?.totals));
    expect('C3 [R6] 点名 round2-mechanics::F3（填了 DEFERRED 也照样点名）',
      /round2-mechanics::F3/.test(probWith(fiR, 'upheld_without_fix_contract')?.msg ?? ''),
      probWith(fiR, 'upheld_without_fix_contract')?.msg?.slice(0, 400));

    // ── C4（附加）：R4 还有一道更硬的门 —— 字面意义上的「暂缓」太短会被拦 ──
    const shortLedger = join(ws.root, 'ledger-short.md');
    writeFileSync(shortLedger,
      ledgerMd(ALL_FINDINGS.map((f) => [f.key, 'DEFERRED', '暂缓'])));
    const short = runNode(CHECK_DISPOSITION, ['--artifacts', ws.artifacts, '--ledger', shortLedger, '--json']);
    const shortData = tryJson(short.stdout);
    expect('C4 [R4] 依据只写「暂缓」→ exit 1，报 disposition_missing_reason',
      short.code === 1 && (shortData?.problems ?? []).some((p) => p.rule === 'disposition_missing_reason'),
      `实际 exit ${short.code}；problems=${JSON.stringify(shortData?.problems?.map((p) => p.rule))}`);

    // ── C5（附加）：交付闸门开 --strict-high 时，HIGH 悬空直接升级为 FAIL ──
    const strict = runNode(CHECK_DISPOSITION,
      ['--artifacts', ws.artifacts, '--ledger', ws.ledgerPath, '--strict-high', '--json']);
    const strictData = tryJson(strict.stdout);
    expect('C5 [R4] --strict-high 下同一条去向表 → exit 1（HIGH 悬空升级为 FAIL）',
      strict.code === 1 && (strictData?.problems ?? []).some(
        (p) => p.rule === 'high_severity_unaccounted' && p.level === 'FAIL'),
      `实际 exit ${strict.code}；problems=${JSON.stringify(strictData?.problems?.map((p) => p.rule))}`);

    // ── C6（附加）：R1 的另一半 —— fix_contracts 空时 check-state 也拒绝 ──
    const cs = runNode(CHECK_STATE, [ws.statePath, '--json']);
    const csData = tryJson(cs.stdout);
    expect('C6 [R1/check-state] fix_contracts 为空 → exit 1，报 fix_contracts_required',
      cs.code === 1 && (csData?.errors ?? []).some((e) => e.rule === 'fix_contracts_required'),
      `实际 exit ${cs.code}；errors=${JSON.stringify(csData?.errors?.map((e) => e.rule))}`);

    // ── C7（附加）：stop-hook 也拦「修复相位什么都没登记」──
    const hook = runNode(STOP_HOOK, ['--state', ws.statePath], { input: '{}' });
    expect('C7 [R1/stop-hook] 修复相位 fix_contracts 为空 → exit 2',
      hook.code === 2 && /fix_contracts 为空/.test(hook.stderr),
      `实际 exit ${hook.code}；stderr=${hook.stderr.slice(0, 300)}`);
  } finally {
    ws.cleanup();
  }
}

// ── 汇总 ────────────────────────────────────────────────────────────
console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
if (fail > 0) {
  console.log('有防线没响。上面每个 ✗ 的 [R?/工具名] 就是没关上的那道门。\n');
}
process.exit(fail > 0 ? 1 : 0);
