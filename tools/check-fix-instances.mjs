#!/usr/bin/env node
/**
 * check-fix-instances.mjs — 修复实例与「最终报告的裁决索引表」交叉比对
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * R5 在 `experiments/hilltop-dsh/FIX-R5-report.md` §5.1 给 `stop-hook.mjs:200-227`
 * 列了四种绕法，其中最要命的一条是：
 *
 *   `spawned_fix_agents` 与 `fix_contracts` 都是主Agent自述，
 *   两个自述互相对账不产生外部约束力。
 *
 * 这正是 `run-state.md:49` 已经点明的问题——「它记录的就不再是派发事实，
 * 而是主 Agent 对自己工作的印象，和被审计的对象是同一个人」。
 *
 * 四种绕法与它们为何能过：
 *
 * | 绕法 | 为什么能过 |
 * |---|---|
 * | 5 条 finding 全填 5 个不同 `fix_agent_id`，实际 1 个 session 做完 | `spawned_fix_agents` 是自述，hook 无法验证 5 个 id 对应 5 个真实实例 |
 * | **5 条 finding 只登记 1 条 `fix_contract`，其余不登记** | `findingIds.size == 1`，判据不触发 |
 * | 把所有 finding 的 `target_files` 写成同一个文件 | 合并规则「集合相等」是主Agent自己填的 |
 * | 环境无 `subagent` 能力 | 报 `discipline_log` 即算合规 |
 *
 * 前三种全部是「自述内部对账」，所以本脚本的核心不是再加一条自述规则，
 * 而是引入**外部基准**：`framework/artifacts/final-report.md:83` 定义的
 * 「A. 裁决索引表（附加）」——由锐评相位产生、指向 `artifact_ref` 的权威清单。
 * 它与 `state.json` 是两条独立路径，少登记一条在那里藏不住。
 *
 * 只有「`fix_contracts` 集合 ⊇ 裁决表里的 UPHELD 集合」这一条挡得住「少登记」。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *   node check-fix-instances.mjs --state <state.json> --report <final-report.md>
 *                                [--json] [--strict]
 *
 *   --state    `state.json`。读 `fix_contracts[]`、`discipline_log[]`、
 *              `budget.spawned_fix_agents`、`phase`、`path_mode`。
 *   --report   最终报告 markdown。解析「A. 裁决索引表」那张表，
 *              取 `finding_id` 与 `裁决` 两列。
 *   --json     输出机器可读 JSON。
 *   --strict   把 `fix_contract_not_upheld` 的 WARN 升级为 FAIL。
 *              默认 WARN 是因为极少数情况下「裁决表漏更新」比「多修一条」更常见；
 *              但交付闸门应当开启——否则「顺手多修」可以静默穿过。
 *   --help / -h 打印本说明，退出 0。
 *
 * ── 规则（每条独立命名）──────────────────────────────────────────────
 *   state_missing                     state.json 不存在                          exit 2
 *   state_invalid                     state.json 解析失败 / 不是对象             exit 2
 *   report_missing                    最终报告不存在                             exit 2
 *   report_unparsable                 报告里找不到「裁决索引表」                 exit 2
 *   not_fix_path                      path_mode !== FIX → 跳过全部检查           exit 0
 *   upheld_without_fix_contract       **核心**：UPHELD 未进入任何 fix_contract    FAIL（永远）
 *   fix_contract_not_upheld           登记了非 UPHELD 的 finding                 WARN（表里有）/ FAIL（表里没有）
 *   merged_without_record             一个 fix_agent_id 承担多条但无合规合并申报 FAIL
 *   merge_target_files_mismatch       合并申报的 shared_target_files ≠ 实际并集  FAIL
 *   spawned_count_mismatch            spawned_fix_agents ≠ distinct(fix_agent_id) FAIL
 *   spawned_count_absent              spawned_fix_agents 缺失/非数字 → 按 0 处理 FAIL
 *   phase_not_wave4_or_wave5          FIX 路径但相位不在 wave4/wave5            WARN
 *
 * 退出码：0 = 通过（允许 WARN） / 1 = 有 FAIL / 2 = 配置错误
 *
 * ── 两个必须回答的边界问题（写进代码，不只是写进报告）──────────────────
 *
 * 问题 1：「没有任何 fix_contract」与「没有任何 UPHELD」分别算什么？
 *   - `path_mode == FIX`、`fix_contracts` 为空、裁决表有 5 条 UPHELD
 *       → 这是规则 4 的 5 条 FAIL。一条都没派发，不是「没东西可修」。
 *   - `path_mode == FIX`、裁决表里 0 条 UPHELD（全部 DOWNGRADED/REJECTED）
 *       → 合法，exit 0。没有要修的东西，`fix_contracts` 空是正确状态。
 *     这两者只差「裁决表里有没有 UPHELD」，而裁决表是外部基准——
 *     所以这里绝不能把「空」一律当合法，也绝不能一律当违规。
 *
 * 问题 2：「同一侧为空」的对称检查。
 *   - `fix_contracts` 有 3 条、裁决表 0 条 UPHELD
 *       → 规则 5 对每一条都 FAIL（「在表里但裁决不是 UPHELD」或「不在表里」）。
 *     单向的 `⊇` 是不够的：只查「UPHELD 有没有被登记」会漏掉
 *     「登记了一堆不存在的 id」——那和少登记一样能让账本与事实脱节。
 *
 * ── 它不检查什么 ─────────────────────────────────────────────────────
 *   5 个 `fix_agent_id` 是否对应 5 个**真实**的 session（需要 harness 侧证据，
 *   账本里没有）；修复质量；`target_files` 是否真的覆盖了缺陷——
 *   那要读代码。本脚本只保证「登记集合」与「外部裁决」一致。
 */

import { readFileSync, existsSync } from 'node:fs';

// ────────────────────────────────────────────────────────────────────
// 参数
// ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { state: null, report: null, json: false, strict: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') out.state = argv[++i];
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--strict') out.strict = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.bad = a;
  }
  return out;
}

const HELP = `
check-fix-instances.mjs — 修复实例与最终报告裁决索引表的交叉比对

用法:
  node check-fix-instances.mjs --state <state.json> --report <final-report.md>
                               [--json] [--strict]

参数:
  --state    state.json（fix_contracts / discipline_log / budget.spawned_fix_agents /
             phase / path_mode）
  --report   最终报告 markdown（解析「A. 裁决索引表」，取 finding_id 与 裁决 两列）
  --json     输出机器可读 JSON
  --strict   把 fix_contract_not_upheld 的 WARN 升级为 FAIL（交付闸门应开启）
  --help, -h 显示本说明

检查的规则（每条独立命名）:
  state_missing                  state.json 不存在                         exit 2
  state_invalid                  state.json 解析失败                       exit 2
  report_missing                 最终报告不存在                            exit 2
  report_unparsable              找不到「裁决索引表」                       exit 2
  not_fix_path                   path_mode !== FIX → 跳过，exit 0
  upheld_without_fix_contract    UPHELD 未进入任何 fix_contract             FAIL（永远）
  fix_contract_not_upheld        登记了非 UPHELD / 表里没有的 finding       WARN / FAIL
  merged_without_record          一个实例承担多条却无合规 FIX_INSTANCE_MERGED FAIL
  merge_target_files_mismatch    合并申报的 shared_target_files ≠ 实际并集    FAIL
  spawned_count_mismatch         spawned_fix_agents ≠ distinct(fix_agent_id) FAIL
  spawned_count_absent           spawned_fix_agents 缺失 → 按 0 处理并报错     FAIL
  phase_not_wave4_or_wave5       FIX 路径但相位不在 wave4/wave5              WARN

裁决索引表（framework/artifacts/final-report.md:83）:
  ## A. 裁决索引表（附加）

  | finding_id | 严重性 | 维度 | 位置 | 裁决 | 出处 |
  |---|---|---|---|---|---|
  | ... | HIGH | concurrency | \`path:line\` | UPHELD | \`round{N}-03-critique-arbiter.md\` |

  表头必须同时含 finding_id 与 裁决（或 verdict）两列。
  这是 UPHELD 发现的**外部基准**：它与 state.json 由两条独立路径产生，
  所以「少登记一条」在这里才藏不住。没有它，一切对账都只是自述内部自洽。

合并申报（framework/templates/wave4-fix.md:86-98，写在 discipline_log）:
  {
    "kind": "FIX_INSTANCE_MERGED",
    "merged_finding_ids": ["finding-012", "finding-013"],
    "reason": "...",
    "shared_target_files": ["src/dispatch/pipeline.ts"],
    "mechanically_checkable": "两条 finding 的 target_files 排序后逐元素相等"
  }

退出码: 0 = 通过（允许 WARN） / 1 = 有 FAIL / 2 = 配置错误
`;

const ARGS = parseArgs(process.argv);
if (ARGS.help) { console.log(HELP); process.exit(0); }
if (ARGS.bad) {
  console.error(`未知参数: ${ARGS.bad}\n${HELP}`);
  process.exit(2);
}
if (!ARGS.state || !ARGS.report) {
  console.error(`缺少必填参数（--state 与 --report 都要给）。\n${HELP}`);
  process.exit(2);
}

// ────────────────────────────────────────────────────────────────────
// 结果收集
// ────────────────────────────────────────────────────────────────────
const problems = [];
const add = (level, rule, msg, extra = {}) => problems.push({ level, rule, msg, ...extra });
const fail = (rule, msg, extra) => add('FAIL', rule, msg, extra);
const warn = (rule, msg, extra) => add('WARN', rule, msg, extra);

/** 配置错误：打印后直接 exit 2，绝不允许降级成「账本自洽」。 */
function configError(rule, msg, extra = {}) {
  problems.push({ level: 'CONFIG', rule, msg, ...extra });
  if (ARGS.json) {
    console.log(JSON.stringify({
      state: ARGS.state, report: ARGS.report,
      totals: null, problems, exitCode: 2,
    }, null, 2));
  } else {
    console.error(`\n[配置错误] ${rule}`);
    console.error(`  ${msg}\n`);
  }
  process.exit(2);
}

// ────────────────────────────────────────────────────────────────────
// 1 · 读 state.json
// ────────────────────────────────────────────────────────────────────
if (!existsSync(ARGS.state)) {
  configError('state_missing',
    `state.json 不存在: ${ARGS.state}\n`
    + '  没有账本就无法对账——但这不等于「没有违规」，只等于无从判断。');
}

let state;
try {
  state = JSON.parse(readFileSync(ARGS.state, 'utf8'));
} catch (e) {
  configError('state_invalid', `state.json 解析失败: ${e.message}`);
}
if (!state || typeof state !== 'object' || Array.isArray(state)) {
  configError('state_invalid',
    `state.json 顶层不是对象（实际是 ${Array.isArray(state) ? 'array' : typeof state}）——`
    + '解析不出账本就不能当作「没有 fix_contract」，否则分母会悄悄变成 0');
}

const pathMode = typeof state.path_mode === 'string' ? state.path_mode.trim().toUpperCase() : '';
const phase = typeof state.phase === 'string' ? state.phase.trim() : '';
const contracts = Array.isArray(state.fix_contracts) ? state.fix_contracts : [];
const discipline = Array.isArray(state.discipline_log) ? state.discipline_log : [];

// ────────────────────────────────────────────────────────────────────
// 2 · 规则 · not_fix_path：审计路径不跑本检查器
//
// 这条必须在读报告之前。审计路径根本没有 wave4/wave5，
// 也没有 fix_contracts 这个东西；在那里报「UPHELD 未登记修复」
// 是把审计要求硬套成修复要求——所有 AUDIT_ONLY 轮次都会红，于是没人看。
// ────────────────────────────────────────────────────────────────────
if (pathMode !== 'FIX') {
  const totals = { upheld: 0, registered: 0, missing: 0, spawned: 0, instances: 0, merges: 0, reportRows: 0 };
  if (ARGS.json) {
    console.log(JSON.stringify({
      state: ARGS.state, report: ARGS.report,
      skipped: 'not_fix_path', path_mode: state.path_mode ?? null,
      totals, problems, exitCode: 0,
    }, null, 2));
    process.exit(0);
  }
  console.log('\n=== 修复实例对账 ===\n');
  console.log(`  账本: ${ARGS.state}`);
  console.log(`  路径模式: ${state.path_mode ?? '（缺失）'}\n`);
  console.log('✓ [not_fix_path] 这不是 FIX 路径，跳过全部检查。');
  console.log('  裁决索引表与 fix_contracts 的交叉比对只对修复路径有意义；');
  console.log('  AUDIT_ONLY 轮次没有修复相位，在这里报错只会让所有审计轮次变红。\n');
  console.log('合计: 0 UPHELD / 已登记 0 / 未登记 0 / 实例 0');
  console.log('合计: 0 PASS / 0 FAIL / 0 WARN\n');
  process.exit(0);
}

// ────────────────────────────────────────────────────────────────────
// 3 · 读最终报告，解析「A. 裁决索引表」
// ────────────────────────────────────────────────────────────────────
if (!existsSync(ARGS.report)) {
  configError('report_missing',
    `最终报告不存在: ${ARGS.report}\n`
    + '  没有裁决索引表就没有外部基准，本检查器的所有结论都会退化成'
    + '「自述与自述一致」——那正是 R5 指出的问题，不能接受。');
}

const reportText = readFileSync(ARGS.report, 'utf8');

/**
 * 解析裁决索引表。
 *
 * 识别条件（任务书规定）：表头必须同时含 `finding_id` 与 `裁决`（或 `verdict`）两列。
 * 只靠「有张表」是不够的：最终报告里有元信息表、覆盖率表、缺陷族表，
 * 随便挑一张会把「数值」当成「裁决」。
 *
 * 优先取「A. 裁决索引表」标题之后的第一张合规表；若没有那个标题
 * （有的轮次把表放在别的位置），退化为「第一张表头合规的表」。
 * 两者都找不到 → report_unparsable（exit 2），而不是「0 条 UPHELD」。
 *
 * 返回 { rows: [{ id, verdict, raw, lineNo }], heading: string|null } 或 null。
 */
function parseVerdictIndex(text) {
  const lines = text.split(/\r?\n/);

  // 围栏代码块里的内容不是表格行——它是给人看的示例。
  // final-report.md 的模板片段本身就带一张示例表（含 `| ... |` 行），
  // 不跳过的话会凭空多出一条 id 叫 "..." 的 UPHELD finding。
  const fenced = new Set();
  let inFence = false;
  for (let li = 0; li < lines.length; li++) {
    if (/^\s*(```|~~~)/.test(lines[li])) { inFence = !inFence; fenced.add(li); continue; }
    if (inFence) fenced.add(li);
  }

  const cell = (s) => String(s).replace(/\*\*/g, '').replace(/`/g, '').trim();
  const splitRow = (line) => {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map(cell);
  };
  const isSeparator = (cells) => cells.length > 0
    && cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '');

  const findCol = (cells, candidates) => {
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i].toLowerCase();
      if (candidates.some((x) => c === x || c.includes(x))) return i;
    }
    return -1;
  };

  const ID_COLS = ['finding_id', 'finding id', 'findingid', 'finding', '发现', '编号', 'id'];
  const VERDICT_COLS = ['裁决', 'verdict'];

  // 第一遍：记录「A. 裁决索引表」标题的行号，用来做优先级。
  let headingLine = -1;
  for (let li = 0; li < lines.length; li++) {
    if (fenced.has(li)) continue;
    if (/裁决索引表|verdict\s*index|^#+\s*A[.、．]/i.test(lines[li])) { headingLine = li; break; }
  }

  /** 从 from 行开始扫出一张合规表。 */
  const scan = (from, until) => {
    let header = null;
    const rows = [];
    for (let li = from; li < until; li++) {
      if (fenced.has(li)) continue;
      const line = lines[li];
      if (!line.includes('|')) continue;
      const cells = splitRow(line);
      if (isSeparator(cells)) continue;

      if (!header) {
        const idCol = findCol(cells, ID_COLS);
        const vCol = findCol(cells, VERDICT_COLS);
        // 两列都要命中，且不能是同一列——这是「裁决索引表」的机械定义。
        if (idCol >= 0 && vCol >= 0 && idCol !== vCol) header = { id: idCol, verdict: vCol };
        continue;
      }

      // 表头之后若又出现一张新表头，说明这张表结束了（下一节有自己的表）。
      const maybeId = findCol(cells, ID_COLS);
      const maybeV = findCol(cells, VERDICT_COLS);
      if (maybeId >= 0 && maybeV >= 0 && maybeId !== maybeV) break;

      const rawId = cells[header.id] ?? '';
      const rawVerdict = cells[header.verdict] ?? '';
      if (!rawId) continue;
      // 模板占位行：`| ... |`、`| — |`。它们不是 finding，
      // 当成数据行会报「杜撰了 id 叫 ... 的 finding」。
      if (/^(\.{2,}|…+|—+|-+|\.+)$/.test(rawId)) continue;
      rows.push({ id: rawId, raw: rawVerdict, lineNo: li + 1 });
    }
    return header ? rows : null;
  };

  // 优先：标题之后那一段。没有标题则从头扫。
  const primaryFrom = headingLine >= 0 ? headingLine + 1 : 0;
  let rows = scan(primaryFrom, lines.length);
  if (rows === null && headingLine > 0) rows = scan(0, headingLine);
  if (rows === null) return null;

  /** 裁决归一化。UPHELD 是唯一的「该修」结论。 */
  const normVerdict = (raw) => {
    const v = String(raw).replace(/[`*]/g, '').trim().toUpperCase();
    if (!v) return 'UNKNOWN';
    if (v.includes('UPHELD')) return 'UPHELD';
    if (v.includes('DOWNGRADED')) return 'DOWNGRADED';
    if (v.includes('REJECTED')) return 'REJECTED';
    if (v.includes('REVOKED')) return 'REVOKED';
    if (v.includes('WONT_FIX') || v === '不修') return 'WONT_FIX';
    return v;
  };

  return {
    heading: headingLine >= 0 ? lines[headingLine].trim() : null,
    rows: rows.map((r) => ({ ...r, verdict: normVerdict(r.raw) })),
  };
}

const index = parseVerdictIndex(reportText);
if (!index) {
  configError('report_unparsable',
    `${ARGS.report} 里找不到「A. 裁决索引表」（需要表头同时含 finding_id 与 裁决/verdict 两列）\n`
    + '  裁决索引表是 UPHELD 发现的权威清单，由锐评相位产生、与 state.json 是两条独立路径。\n'
    + '  没有它，本检查器只能比对「主Agent的两份自述」，而那正是 R5 证明无效的东西。');
}

// 同一 id 出现两次会让「UPHELD 集合」与「登记集合」的对账失真：
// 后一行会覆盖前一行，而覆盖方向取决于裁决表里的顺序。
const verdictById = new Map();
for (const row of index.rows) {
  if (verdictById.has(row.id)) {
    // 不单独开规则（任务书只给了 10 条），但必须让它可见：
    // 用 FAIL 报在核心规则名下会误导（问题不在登记），所以记 WARN。
    warn('report_duplicate_row',
      `裁决索引表第 ${row.lineNo} 行的 finding_id "${row.id}" 与更早的一行重复`
      + '——后一行会覆盖前一行，UPHELD 集合因此取决于行序。请合并为一行',
      { finding_id: row.id, line: row.lineNo });
  }
  verdictById.set(row.id, row.verdict);
}

const upheldIds = new Set(
  [...verdictById].filter(([, v]) => v === 'UPHELD').map(([id]) => id)
);

// ────────────────────────────────────────────────────────────────────
// 4 · 登记侧索引
// ────────────────────────────────────────────────────────────────────
const registeredIds = new Set();
const contractsById = new Map();   // finding_id → [contract]
for (const c of contracts) {
  const fid = typeof c?.finding_id === 'string' ? c.finding_id.trim() : '';
  if (!fid) {
    // 没有 finding_id 的契约无法参与任何对账。它既不算「登记了某条」，
    // 也不能被忽略——忽略等于一条 finding 凭空消失。
    fail('fix_contract_without_finding_id',
      'fix_contracts 里有一条没有 finding_id，无法与裁决索引表对账——'
      + '这条修复不会被任何下游相位消费，rollback_command 也无人可用',
      { fix_agent_id: c?.fix_agent_id ?? null });
    continue;
  }
  registeredIds.add(fid);
  if (!contractsById.has(fid)) contractsById.set(fid, []);
  contractsById.get(fid).push(c);
}

// ────────────────────────────────────────────────────────────────────
// 5 · 核心规则 · upheld_without_fix_contract
//
// 这是本脚本存在的唯一理由，也是唯一一条**永远 FAIL** 的规则：
// 它不接受 --strict 的赦免，因为它的判据来自外部文件，不是主Agent能自证的。
//
// 边界（见文件头「问题 1」「问题 2」）：
//   - fix_contracts 为空 + 5 条 UPHELD → 这里产出 5 条 FAIL（合并成一条消息列出全部 id）
//   - 0 条 UPHELD + fix_contracts 为空 → 循环体不执行 → exit 0（合法）
//   - 0 条 UPHELD + 3 条 fix_contracts → 由规则 5 逐条 FAIL（对称侧）
// ────────────────────────────────────────────────────────────────────
const missing = [...upheldIds].filter((id) => !registeredIds.has(id));

if (missing.length > 0) {
  fail('upheld_without_fix_contract',
    `${missing.length} 条 UPHELD 发现没有进入任何修复登记：${missing.join('、')}。`
    + '它们不是因为「判定不修」而缺席（那需要 WONT_FIX），而是根本没被派发——'
    + '`final-report.md` 的裁决索引表是外部基准，`state.json` 少登记一条，'
    + '`stop-hook` 的 `findingIds.size` 就少 1，判据可能整个不触发。\n'
    + `  已登记 ${registeredIds.size} 条，UPHELD ${upheldIds.size} 条，缺口 ${missing.length} 条。`
    + (registeredIds.size <= 1
      ? `\n  注意：登记侧只有 ${registeredIds.size} 条——这正是「只登记 1 条，判据不触发」的形态。`
      : ''),
    { missing, missing_count: missing.length, upheld_count: upheldIds.size, registered_count: registeredIds.size });
}

// ────────────────────────────────────────────────────────────────────
// 6 · fix_contract_not_upheld：登记侧的对称检查
//
// 只查 `⊇` 不够。若 fix_contracts 里有裁决表根本不存在的 id，
// 「登记集合」与「事实集合」同样脱节——只是方向相反（多 / 错，而非少）。
// 分两种，因为它们的成因和处理方式不同：
//   在表里但裁决 ≠ UPHELD  → 修了不该修的（多半是裁决表没同步，故 WARN，--strict 升级）
//   不在表里               → 杜撰或 id 拼错（FAIL，没有别的解释）
// ────────────────────────────────────────────────────────────────────
let notUpheldWarn = 0;
let notUpheldFail = 0;
for (const fid of registeredIds) {
  if (upheldIds.has(fid)) continue;
  if (verdictById.has(fid)) {
    notUpheldWarn++;
    const verdict = verdictById.get(fid);
    add(ARGS.strict ? 'FAIL' : 'WARN', 'fix_contract_not_upheld',
      `"${fid}" 已登记修复，但裁决索引表里它的裁决是 ${verdict}，不是 UPHELD`
      + `——修了不该修的。要么裁决表该更新（那是锐评相位的问题），`
      + `要么这条修复本身是多余的写入（爆炸半径白白扩大）`
      + (ARGS.strict ? '（--strict：已升级为 FAIL）' : ''),
      { finding_id: fid, verdict, reason: 'verdict_not_upheld' });
  } else {
    notUpheldFail++;
    fail('fix_contract_not_upheld',
      `"${fid}" 已登记修复，但裁决索引表里**没有这条 finding**`
      + `——不在表里只有两种解释：id 拼错（拼错的登记不会被任何相位消费），`
      + `或者凭空杜撰（那会让「修了几条」这个数字失去外部依据）。`
      + `表中现有 ${upheldIds.size} 条 UPHELD`,
      { finding_id: fid, reason: 'absent_from_report' });
  }
}

// ────────────────────────────────────────────────────────────────────
// 7 · merged_without_record：一个实例承担多条 finding 必须留痕
//
// wave4-fix.md §0.3：「没有这条记录 = CONTRACT_VIOLATION」。
// 这一步必须按 fix_agent_id 分组，因为「合并」在账本上的唯一表现
// 就是「多个 finding_id 共享同一个 fix_agent_id」。
//
// 注意：这一条仍然在自述内部。它能抓「无申报的合并」，
// 抓不到「5 个 id 对应 1 个真实 session」（见文件头表格第 1 行）。
// ────────────────────────────────────────────────────────────────────
const mergeRecords = discipline
  .filter((d) => d && String(d.kind ?? '').toUpperCase() === 'FIX_INSTANCE_MERGED')
  .map((d) => ({
    raw: d,
    ids: Array.isArray(d.merged_finding_ids)
      ? [...new Set(d.merged_finding_ids.filter((x) => typeof x === 'string').map((x) => x.trim()))]
      : null,
  }));

const byAgent = new Map();   // fix_agent_id（或缺失标记）→ Set<finding_id>
for (const [fid, list] of contractsById) {
  for (const c of list) {
    const agent = typeof c.fix_agent_id === 'string' && c.fix_agent_id.trim()
      ? c.fix_agent_id.trim()
      : '__MISSING_AGENT_ID__';
    if (!byAgent.has(agent)) byAgent.set(agent, new Set());
    byAgent.get(agent).add(fid);
  }
}

// 注意两边类型不同：`ids` 是 Set（来自 fix_contracts 分组），
// `r.ids` 是数组（来自 merged_finding_ids）。比较前必须都归一成集合——
// 直接 `a.size === b.size` 会让数组的 undefined 与 Set 的长度比，
// 结果是「永远不相等」，于是每一组合规合并都会被误报成未申报。
const toSet = (x) => (x instanceof Set ? x : new Set(x));
const eqSet = (a, b) => {
  const A = toSet(a), B = toSet(b);
  return A.size === B.size && [...A].every((x) => B.has(x));
};
const intersects = (a, b) => {
  const A = toSet(a), B = toSet(b);
  return [...A].some((x) => B.has(x));
};

for (const [agent, ids] of byAgent) {
  if (ids.size <= 1) continue;   // 一个实例一条 finding，默认形态，无需申报

  const agentLabel = agent === '__MISSING_AGENT_ID__' ? '（fix_agent_id 缺失）' : agent;
  const match = mergeRecords.find((r) => r.ids && eqSet(r.ids, ids));
  if (match) continue;

  const near = mergeRecords.filter((r) => r.ids && intersects(r.ids, ids));
  const actual = [...ids].sort().join('、');
  if (near.length > 0) {
    fail('merged_without_record',
      `fix_agent_id "${agentLabel}" 承担了 ${ids.size} 条 finding（${actual}），`
      + `但 discipline_log 里 FIX_INSTANCE_MERGED 的 merged_finding_ids 与之**不一致**`
      + `（${near.map((r) => `[${r.ids.join('、')}]`).join(' / ')}）。`
      + `wave4-fix.md §0.3 要求记录的集合与该实例实际承担的集合相等——`
      + `少写一条就等于把那条 finding 藏进了一次「合规」的合并里`,
      { fix_agent_id: agentLabel, actual, recorded: near.map((r) => r.ids) });
  } else {
    fail('merged_without_record',
      `fix_agent_id "${agentLabel}" 承担了 ${ids.size} 条 finding（${actual}），`
      + `但 discipline_log 里没有对应的 FIX_INSTANCE_MERGED 记录。`
      + `wave4-fix.md §0.3：默认一条 finding 一个实例，合并必须申报；`
      + `**没有这条记录 = CONTRACT_VIOLATION**，该实例的全部输出作废并回滚`
      + (agent === '__MISSING_AGENT_ID__'
        ? '。而且这条连 fix_agent_id 都没有，根本无法证明它被派发过'
        : ''),
      { fix_agent_id: agentLabel, actual });
  }
}

// ────────────────────────────────────────────────────────────────────
// 8 · merge_target_files_mismatch：合并判据是「集合相等」不是「有交集」
//
// wave4-fix.md §0.3 的第 1 条：多条 finding 的 target_files **完全重叠**
// （集合**相等**，不是「有交集」）。§0.3 同时要求
// `shared_target_files` 与它「排序后逐元素相等」——这是让「合并是否合规」
// 变成字符串比较的唯一途径，不需要任何内容判断。
//
// 反例（真实绕法第 3 种）：把所有 finding 的 target_files 写成同一个文件，
// 于是集合相等成立、合并「合法」。这条规则抓不到它——因为账本里两个集合
// 确实相等。能抓的只有「申报的 shared_target_files 与账本里的 target_files
// 不一致」，也就是申报本身写错了。**这一点必须诚实写在报告里。**
// ────────────────────────────────────────────────────────────────────
const normFiles = (arr) => (Array.isArray(arr) ? arr : [])
  .filter((x) => typeof x === 'string')
  .map((x) => x.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
  .filter(Boolean);
const sortedUnique = (arr) => [...new Set(arr)].sort();
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

for (const rec of mergeRecords) {
  const label = rec.ids ? rec.ids.join('、') : '（merged_finding_ids 缺失或不是数组）';

  if (!rec.ids || rec.ids.length === 0) {
    fail('merge_target_files_mismatch',
      'discipline_log 里有一条 FIX_INSTANCE_MERGED 没有 merged_finding_ids，无法复核它的合并依据'
      + '——合并是「可被机械复核的申报」，不是口袋条款',
      { merged_finding_ids: rec.raw?.merged_finding_ids ?? null });
    continue;
  }

  if (!Array.isArray(rec.raw?.shared_target_files)) {
    fail('merge_target_files_mismatch',
      `FIX_INSTANCE_MERGED [${label}] 没有 shared_target_files 数组`
      + '——没有它就无法机械复核「集合相等」，合并退化成一句自述',
      { merged_finding_ids: rec.ids });
    continue;
  }

  const declaredSorted = sortedUnique(normFiles(rec.raw.shared_target_files));

  // 逐条 finding 比，而不是比并集。判据是「这一条的 target_files 排序后与申报逐元素相等」，
  // 逐条比才能让报错指出**是哪一条**不相等——报「并集不一致」等于让人去猜该改哪行。
  for (const fid of rec.ids) {
    const list = contractsById.get(fid) ?? [];

    if (list.length === 0) {
      fail('merge_target_files_mismatch',
        `FIX_INSTANCE_MERGED [${label}] 点名的 "${fid}" 在 fix_contracts 里不存在`
        + '——合并的机械依据无处可查（id 拼错，或这条 finding 从未被派发）',
        { merged_finding_ids: rec.ids, finding_id: fid });
      continue;
    }

    for (const c of list) {
      if (!Array.isArray(c.target_files) || c.target_files.length === 0) {
        fail('merge_target_files_mismatch',
          `FIX_INSTANCE_MERGED [${label}] 中 "${fid}" 的 fix_contract 没有 target_files`
          + '——合并的唯一合法依据是「target_files 集合相等」，没有这个字段就无法复核，'
          + '合并退化成一句自述',
          { merged_finding_ids: rec.ids, finding_id: fid });
        continue;
      }

      const actual = sortedUnique(normFiles(c.target_files));
      if (!sameList(actual, declaredSorted)) {
        fail('merge_target_files_mismatch',
          `FIX_INSTANCE_MERGED [${label}] 中 "${fid}" 的 shared_target_files 与它的`
          + ' target_files **不相等**（判据是排序后逐元素相等，不是「有交集」）。\n'
          + `  申报: ${declaredSorted.length ? declaredSorted.join('、') : '（空）'}\n`
          + `  实际: ${actual.join('、')}\n`
          + '  只重叠一部分时必须分开派发：target_files 的交集非空不是合并的许可证',
          { merged_finding_ids: rec.ids, finding_id: fid, declared: declaredSorted, actual });
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 9 · spawned_fix_agents 的两个计数规则
//
// run-state.md:49 的原话：「字段缺失时一律按 0 处理：账本没记录等于没发生。」
// 所以缺失不是「跳过这条检查」，是「按 0 记，然后必然对不上」。
// 给「忘了记账」一条免罚通道，正是 round31「账本记 22、产物 ≥47」的成因。
//
// 这两个规则互斥：缺失时只报 spawned_count_absent，不再重复报 mismatch
// （否则一个成因报两次，读的人会以为有两个问题）。
// ────────────────────────────────────────────────────────────────────
const instances = new Set(
  contracts
    .map((c) => (typeof c?.fix_agent_id === 'string' ? c.fix_agent_id.trim() : ''))
    .filter(Boolean)
);
const rawSpawned = state.budget?.spawned_fix_agents;
const hasSpawned = typeof rawSpawned === 'number' && Number.isFinite(rawSpawned);
const spawned = hasSpawned ? rawSpawned : 0;

if (!hasSpawned) {
  fail('spawned_count_absent',
    `budget.spawned_fix_agents 缺失或不是数字（实际: ${JSON.stringify(rawSpawned ?? null)}）`
    + `——按 0 处理。run-state.md:49：「账本没记录等于没发生」，不能给「忘了记账」免罚。`
    + `本次账本里登记了 ${contracts.length} 条 fix_contract / ${instances.size} 个 distinct fix_agent_id，`
    + `而「实际派发数」是 0——差额 ${instances.size} 条没有任何外部依据证明它们被派发过`,
    { spawned_raw: rawSpawned ?? null, instances: instances.size });
} else if (spawned !== instances.size) {
  fail('spawned_count_mismatch',
    `budget.spawned_fix_agents = ${spawned}，但 fix_contracts 里 distinct fix_agent_id 有 ${instances.size} 个`
    + `（${[...instances].join('、')}）——两个数字必须一致：`
    + `前者是「实际派发的实例数」，后者是「登记时声称的实例数」。`
    + (spawned < instances.size
      ? '现在少记的一方是 spawned_fix_agents：说明有实例的派发没记账（账本记 N、实际 ≥M）。'
      : '现在多记的一方是 spawned_fix_agents：说明有实例派发了却没有任何 fix_contract 登记。'),
    { spawned, instances: instances.size });
}

// ────────────────────────────────────────────────────────────────────
// 10 · phase_not_wave4_or_wave5
//
// `path_mode=FIX` 但相位还在 wave3/wave2b：可能只是还没到修复相位，
// 所以是 WARN。但必须能看见——否则「FIX 路径从头到尾没进 wave4」
// 会以「全绿」的形式静默通过。
// ────────────────────────────────────────────────────────────────────
if (phase !== 'wave4' && phase !== 'wave5') {
  warn('phase_not_wave4_or_wave5',
    `path_mode=FIX，但 phase="${phase || '（缺失）'}" 不在 wave4 / wave5`
    + '——可能还没到修复相位，也可能是相位推进被跳过了。'
    + '这两种情况下 `fix_contracts` 的语义完全不同，所以本检查只警告、不阻断',
    { phase });
}

// ────────────────────────────────────────────────────────────────────
// 11 · 输出
// ────────────────────────────────────────────────────────────────────
const counts = problems.reduce((a, p) => { a[p.level] = (a[p.level] ?? 0) + 1; return a; }, {});
const accounted = [...upheldIds].filter((id) => registeredIds.has(id)).length;

const exitCode = (counts.FAIL ?? 0) > 0 ? 1 : ((counts.CONFIG ?? 0) > 0 ? 2 : 0);
const totals = {
  reportRows: index.rows.length,
  upheld: upheldIds.size,
  registered: registeredIds.size,
  accounted,
  missing: missing.length,
  spawned,
  instances: instances.size,
  merges: mergeRecords.length,
  contractRows: contracts.length,
  notUpheldWarn,
  notUpheldFail,
};

if (ARGS.json) {
  console.log(JSON.stringify({
    state: ARGS.state,
    report: ARGS.report,
    path_mode: state.path_mode ?? null,
    phase: state.phase ?? null,
    totals,
    problems,
    exitCode,
  }, null, 2));
  process.exit(exitCode);
}

console.log('\n=== 修复实例对账 ===\n');
console.log(`  账本:     ${ARGS.state}`);
console.log(`  最终报告: ${ARGS.report}`);
console.log(`  裁决表:   ${index.heading ?? '（未定位到标题，按表头识别）'}`
  + `，${index.rows.length} 行，其中 UPHELD ${upheldIds.size} 条`);
console.log(`  账本侧:   ${contracts.length} 条 fix_contract / `
  + `${instances.size} 个 distinct fix_agent_id / spawned_fix_agents=${spawned}`
  + (hasSpawned ? '' : '（缺失，按 0）'));
console.log(`  合并申报: ${mergeRecords.length} 条 FIX_INSTANCE_MERGED\n`);

const order = { FAIL: 0, WARN: 1, CONFIG: 2, PASS: 3 };
const tag = { FAIL: '✗', WARN: '!', CONFIG: '✗', PASS: '✓' };
for (const p of [...problems].sort((a, b) => order[a.level] - order[b.level])) {
  console.log(`${tag[p.level]} [${p.rule}] ${p.msg}`);
}

console.log(`\n合计: ${upheldIds.size} 条 UPHELD / 已登记 ${accounted} / 未登记 ${missing.length}`
  + ` / 实例 ${instances.size} / spawned ${spawned}`);
console.log(`合计: ${accounted} PASS / ${counts.FAIL ?? 0} FAIL / ${counts.WARN ?? 0} WARN\n`);

if (exitCode === 0) {
  if ((counts.WARN ?? 0) > 0) {
    console.log(`结论：${upheldIds.size} 条 UPHELD 全部进入了修复登记，但有 ${counts.WARN} 条警告（见上）。`);
    console.log('这些是「已知且被记录」的风险，不再属于「静默丢失」——但收口前应逐条确认。\n');
  } else if (upheldIds.size === 0) {
    console.log('结论：裁决索引表里没有 UPHELD 发现，没有要修的东西——'
      + 'fix_contracts 为空是正确的，不是「一条都没修」。\n');
  } else {
    console.log(`结论：${upheldIds.size} 条 UPHELD 全部已登记，实例计数自洽，合并申报可复核。\n`);
  }
} else if (missing.length > 0) {
  console.log(`结论：${missing.length} 条 UPHELD 从未进入任何修复登记。`);
  console.log('它们可能从未进入任何任务书——这正是「38 条只修 6 条」丢失的地方，'
    + '而这一次它被外部基准抓到了。\n');
} else {
  console.log('结论：登记侧与裁决表对不上，或实例计数 / 合并申报不自洽（见上）。');
  console.log('UPHELD 覆盖率不是这里的瓶颈——需要处理的是上面点名的那些行。\n');
}
process.exit(exitCode);
