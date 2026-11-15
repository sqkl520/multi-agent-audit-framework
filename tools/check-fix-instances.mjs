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
 *                                [--artifacts-dir <dir>] [--json] [--strict]
 *
 *   --state    `state.json`。读 `fix_contracts[]`、`discipline_log[]`、
 *              `budget.spawned_fix_agents`、`phase`、`path_mode`。
 *   --report   最终报告 markdown。解析「A. 裁决索引表」那张表，
 *              取 `finding_id` / `裁决` / `出处` 三列。
 *   --artifacts-dir  锐评产物所在目录（默认与 `--report` 同目录）。
 *              用来交叉校验「出处」列：不看裁决表说什么，看出处的文件里说了什么。
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
 *   ── R10 新增：裁决表 × 出处文件的交叉校验（洞 3）──────────────────
 *   verdict_ref_missing               裁决表某行「出处」为空/不是路径          FAIL（降级模式下也是）
 *   verdict_ref_not_found             「出处」指向的文件在 --artifacts-dir 下不存在 FAIL（降级模式下降为 WARN）
 *   verdict_mismatch_with_source      **核心**：出处文件里的裁决 ≠ 裁决表里的裁决 FAIL（降级模式下降为 WARN）
 *   verdict_source_missing_finding    出处文件里找不到该 finding_id             FAIL（降级模式下降为 WARN）
 *   verdict_crosscheck_degraded       没有锐评产物可供交叉校验 → 本检查退化为
 *                                     只验索引表内部一致性                    WARN
 *
 *   为什么需要后四条（R7 §4「洞 3」的实测）：
 *
 *     HOLE-3 裁决表自填 DOWNGRADED + fix_contracts 空
 *            -> R6 exit 0 | upheld 0 | rules []
 *
 *   `upheld_without_fix_contract` 把 `final-report.md` 当外部基准，但那份报告
 *   在流程上仍由主 Agent 落盘——把 8 条 HIGH 全改成 DOWNGRADED，`upheld` 集合
 *   变空，`missing = 0`，本脚本 exit 0。**外部基准也要有出处。**
 *
 *   `framework/artifacts/final-report.md:89` 已经写死了这条铁律：
 *   「主 Agent 只做排序、加索引、加统计，不得改写任何子 Agent 的措辞、
 *     严重性或裁决结论。每一行的「出处」必须是 `artifact_ref`，
 *     指向能复核该结论的原始文件。」
 *
 *   所以交叉校验的判据不是「裁决表自洽」，而是「裁决表的每一行都能在
 *   它自己声明的出处文件里找到同一个裁决」。裁决表与出处是两份独立文件，
 *   改一份不改另一份就会红。
 *
 * ── 退出码：0 = 通过（允许 WARN） / 1 = 有 FAIL / 2 = 配置错误
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
 *
 *   **R10 之后仍不检查**（必须写在代码里，否则下一个人会以为洞 3 已封死）：
 *   裁决表与 Arbiter 产物**是否由同一个主 Agent 伪造**。交叉校验把「改一份」
 *   变成「改两份且保持一致」，把洞 3 的成本从 1 处提高到 2 处，但两份文件
 *   都落在主 Agent 可写的路径上。真正的封堵需要 Arbiter 产物由子会话直写、
 *   主 Agent 只读（或 harness 侧的写入日志）。见 FIX-R10-report.md §5。
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve, isAbsolute, join, relative } from 'node:path';

// ────────────────────────────────────────────────────────────────────
// 参数
// ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {
    state: null, report: null, artifactsDir: null, json: false, strict: false, help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--state') out.state = argv[++i];
    else if (a === '--report') out.report = argv[++i];
    else if (a === '--artifacts-dir') out.artifactsDir = argv[++i];
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
                               [--artifacts-dir <dir>] [--json] [--strict]

参数:
  --state    state.json（fix_contracts / discipline_log / budget.spawned_fix_agents /
             phase / path_mode）
  --report   最终报告 markdown（解析「A. 裁决索引表」，取 finding_id / 裁决 / 出处 三列）
  --artifacts-dir  锐评产物所在目录（默认与 --report 同目录）。用于按「出处」列
             交叉校验裁决：不看裁决表说什么，看出处的文件里说了什么。
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

裁决表 × 出处文件的交叉校验（R10 · 堵 R7 报告的「洞 3」）:
  verdict_ref_missing            「出处」列为空 / 不是路径                  FAIL（降级时也是）
  verdict_ref_not_found          「出处」指向的文件不存在                   FAIL（降级时 WARN）
  verdict_mismatch_with_source   出处文件里的裁决 ≠ 裁决表里的裁决           FAIL（降级时 WARN）
  verdict_source_missing_finding 出处文件里找不到该 finding_id              FAIL（降级时 WARN）
  verdict_crosscheck_degraded    没有锐评产物 → 退化为只验索引表内部一致性    WARN

  洞 3 的形态（R7 §4 实测）：裁决索引表 8 条 HIGH 全填 DOWNGRADED，
  upheld 集合变空，missing = 0，exit 0——而那份裁决表就是主 Agent 自己写的。
  修法：final-report.md:89 的铁律要求每一行的「出处」指向能复核该结论的原始产物。
  于是判据变成「裁决表每一行的裁决，必须能在它自己声明的出处文件里找到同一个裁决」。
  两份独立文件改一份不改另一份 → 必红。

  降级纪律：--artifacts-dir 不存在或为空时，verdict_ref_not_found /
  verdict_mismatch_with_source / verdict_source_missing_finding 降为 WARN，
  并在输出中明示「没有锐评产物可供交叉校验，本检查退化为只验索引表内部一致性」。
  理由与 R8 的 unsupported_harness 同一纪律：不能因为产物目录缺失就把流程卡死。
  verdict_ref_missing 不降级——它不需要任何产物就能判，且「没写要核实什么」
  本身就是索引表的完整性缺陷。

裁决索引表（framework/artifacts/final-report.md:83）:
  ## A. 裁决索引表（附加）

  | finding_id | 严重性 | 维度 | 位置 | 裁决 | 出处 |
  |---|---|---|---|---|---|
  | ... | HIGH | concurrency | \`path:line\` | UPHELD | \`round{N}-03-critique-arbiter.md\` |

  表头必须同时含 finding_id 与 裁决（或 verdict）两列；有「出处」列时启用交叉校验。
  这是 UPHELD 发现的**外部基准**：它与 state.json 由两条独立路径产生，
  所以「少登记一条」在这里才藏不住。没有它，一切对账都只是自述内部自洽。

出处文件（锐评相位 Arbiter 产物）的两种合法形态，都会被读取：
  1. 末尾的 JSON 信封（output-contract §0/§2.3）：
     payload.critique_role = "arbiter"，
     payload.verdicts[] = [{ finding_id, verdict: UPHELD|DOWNGRADED|REVOKED, reason }]
  2. 正文里的 markdown 裁决表（表头含 finding_id 与 裁决/verdict 两列）

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
 * 裁决归一化。UPHELD 是唯一的「该修」结论。
 *
 * R10 提到模块作用域：交叉校验要用**同一个**归一化函数读出处文件，
 * 否则「索引表的 DOWNGRADED」和「出处文件的 DOWNGRADED」会因为
 * 写法差异（`**DOWNGRADED**` / `downgraded` / `DOWNGRADED（严重性高估）`）
 * 被判成不一致——那是假阳性，会让人直接关掉这条检查。
 */
function normVerdict(raw) {
  const v = String(raw ?? '').replace(/[`*]/g, '').trim().toUpperCase();
  if (!v) return 'UNKNOWN';
  if (v.includes('UPHELD')) return 'UPHELD';
  if (v.includes('DOWNGRADED')) return 'DOWNGRADED';
  if (v.includes('REJECTED')) return 'REJECTED';
  if (v.includes('REVOKED')) return 'REVOKED';
  if (v.includes('WONT_FIX') || v === '不修') return 'WONT_FIX';
  return v;
}

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
 * R10 起同时取「出处」列（若表头有），用于与锐评产物交叉校验。
 *
 * 返回 { rows: [{ id, verdict, raw, ref, refRaw, lineNo }], heading, hasRefColumn }
 * 或 null。
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
  // 「出处」列。final-report.md:83 的模板列名是 `出处`；契约（handoff-schema）里
  // 对应的字段名是 `artifact_ref`。两种写法都认。
  //
  // 注意候选词里**不能**放裸 `ref`：`arbiter_artifact_ref` 会命中，
  // 但更危险的是任何含 "ref" 的列（如 `reference_count`）都会被误认成出处列，
  // 于是整张表的「出处」解析全错。用带上界的长词。
  const REF_COLS = ['出处', 'artifact_ref', 'artifactref', '来源', 'source_artifact', '证据来源'];

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
        if (idCol >= 0 && vCol >= 0 && idCol !== vCol) {
          const rCol = findCol(cells, REF_COLS);
          header = { id: idCol, verdict: vCol, ref: rCol >= 0 && rCol !== idCol && rCol !== vCol ? rCol : -1 };
        }
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
      rows.push({
        id: rawId,
        raw: rawVerdict,
        refRaw: header.ref >= 0 ? (cells[header.ref] ?? '') : null,
        lineNo: li + 1,
      });
    }
    return header ? { rows, header } : null;
  };

  // 优先：标题之后那一段。没有标题则从头扫。
  const primaryFrom = headingLine >= 0 ? headingLine + 1 : 0;
  let found = scan(primaryFrom, lines.length);
  if (found === null && headingLine > 0) found = scan(0, headingLine);
  if (found === null) return null;

  return {
    heading: headingLine >= 0 ? lines[headingLine].trim() : null,
    hasRefColumn: found.header.ref >= 0,
    rows: found.rows.map((r) => ({
      ...r,
      verdict: normVerdict(r.raw),
      ref: r.refRaw === null ? null : normalizeRef(r.refRaw),
    })),
  };
}

// ────────────────────────────────────────────────────────────────────
// 3b · 出处解析的容错
//
// final-report.md:87 的模板写的是 `round{N}-03-critique-arbiter.md`：
// 带反引号、带花括号占位符。真实报告里还会有 `./x.md`、相对 artifacts 目录的
// 子路径、甚至带 `<OUTDIR>/` 前缀的写法。这些都必须能解析到同一个文件，
// 否则这条检查在真实数据上会全量误报 not_found，然后被当成噪音关掉。
// ────────────────────────────────────────────────────────────────────

/** 去掉反引号/粗体/空白。`（见上文）` 这类散文指代留给 looksLikePath 判死。 */
function normalizeRef(raw) {
  return String(raw ?? '').replace(/[`*]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * 「出处」是否像一个文件路径。
 *
 * 这一条把 `（见上文）` / `同上` / `详见报告` 这类散文指代判成 missing，
 * 而不是 not_found——它们的病因不同：前者是「没写要核实什么」，
 * 后者是「写的那个东西不存在」。混在一起报会让人去错方向找文件。
 */
function looksLikePath(s) {
  if (!s) return false;
  if (/\s/.test(s)) return false;                       // 路径里不该有空白
  if (/[　-〿一-鿿＀-￯]/.test(s)) return false; // 中文/全角标点
  if (/^[<（(].*[>）)]$/.test(s)) return false;         // `<OUTDIR>`、`(见下)`
  return /\.[A-Za-z0-9]{1,8}$/.test(s);                 // 需要有扩展名
}

/** 相对 artifacts 目录的路径清单（posix 分隔符），深度受限。 */
function listFilesRecursive(dir, base = dir, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) listFilesRecursive(p, base, depth + 1, out);
    else if (e.isFile()) out.push(relative(base, p).replace(/\\/g, '/'));
  }
  return out;
}

/** `{N}` / `{round}` 这类占位符 → 任意非分隔符片段，用于在产物目录里找同名文件。 */
function refGlobToRegExp(ref) {
  const parts = ref.split(/(\{[^}]*\})/);
  let body = '';
  for (const part of parts) {
    if (/^\{[^}]*\}$/.test(part)) body += '[^/]+';
    else body += part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`(^|/)${body}$`);
}

/**
 * 把「出处」解析成实际文件路径。
 * 返回 { path, how } 或 null（= not_found）。
 *
 * 三条路径都要试，因为真实报告里三种写法都出现过：
 *   1. 相对 --artifacts-dir
 *   2. 相对最终报告所在目录（--artifacts-dir 的默认值就是它）
 *   3. 绝对路径（`handoff-schema` 允许 `artifact_ref` 是绝对路径）
 * 都失败时，若出处里有 `{...}` 占位符，再按通配在产物目录里找一次。
 */
function resolveRefPath(ref, artifactsDir, reportDir) {
  const candidates = [];
  if (isAbsolute(ref)) candidates.push(ref);
  if (artifactsDir) candidates.push(join(artifactsDir, ref));
  if (reportDir) candidates.push(join(reportDir, ref));
  for (const p of candidates) {
    try { if (existsSync(p) && statSync(p).isFile()) return { path: p, how: 'direct' }; } catch { /* 忽略 */ }
  }
  if (artifactsDir && /[{}]/.test(ref)) {
    let rx;
    try { rx = refGlobToRegExp(ref); } catch { return null; }
    const hit = listFilesRecursive(artifactsDir).find((rel) => rx.test(rel));
    if (hit) return { path: join(artifactsDir, hit), how: 'glob' };
  }
  return null;
}

/**
 * 从一份锐评产物里读出 `finding_id → 裁决`。
 *
 * 两种形态都要读，因为契约与模板各写了一半：
 *   1. 末尾的 JSON 信封（output-contract §0 要求「最后一个代码块必须是 JSON 信封」
 *      §2.3 定义 `payload.verdicts[] = [{ finding_id, verdict, reason }]`，
 *      `critique_role: "arbiter"` 时 verdict 取 UPHELD / DOWNGRADED / REVOKED）
 *   2. 正文里的 markdown 裁决表（表头含 finding_id 与 裁决/verdict）
 *
 * 只认信封会让「格式退化但结论完整」的产物被判成「结论被篡改」——
 * 那是把格式问题误报成诚信问题。只认表格则会漏掉最权威的结构化字段。
 * 所以两个都读，JSON 优先；两者对同一条给出不同裁决时单独 WARN。
 *
 * 返回 { verdicts: Map<id, verdict>, raw: Map<id, string>, sources: string[],
 *        conflicts: [{ id, json, table }] }
 */
function readSourceVerdicts(filePath) {
  let text;
  try { text = readFileSync(filePath, 'utf8'); } catch { return null; }

  const verdicts = new Map();
  const raw = new Map();
  const sources = [];
  const conflicts = [];

  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (blocks.length > 0) {
    try {
      const env = JSON.parse(blocks[blocks.length - 1][1]);
      const list = env?.payload?.verdicts;
      if (Array.isArray(list)) {
        for (const v of list) {
          const id = typeof v?.finding_id === 'string' ? v.finding_id.trim() : '';
          if (!id) continue;
          verdicts.set(id, normVerdict(v.verdict));
          raw.set(id, String(v.verdict ?? ''));
        }
        if (verdicts.size > 0) {
          sources.push(env?.payload?.critique_role === 'arbiter' ? 'json_envelope(arbiter)' : 'json_envelope');
        }
      }
    } catch { /* 信封坏了 → 退回正文表格 */ }
  }

  const idx = parseVerdictIndex(text);
  if (idx && idx.rows.length > 0) {
    for (const row of idx.rows) {
      if (verdicts.has(row.id) && verdicts.get(row.id) !== row.verdict) {
        conflicts.push({ id: row.id, json: verdicts.get(row.id), table: row.verdict });
      } else if (!verdicts.has(row.id)) {
        verdicts.set(row.id, row.verdict);
        raw.set(row.id, row.raw);
      }
    }
    sources.push('markdown_table');
  }

  return { verdicts, raw, sources, conflicts };
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
// 6b · 裁决表 × 出处文件：R7「洞 3」的补丁
//
// 上面的规则 5 把 `final-report.md` 当外部基准。但 R7 §4 实测：
//
//   HOLE-3 裁决表自填 DOWNGRADED + fix_contracts 空 -> exit 0 | upheld 0 | rules []
//
// 裁决表本身也是主 Agent 落盘的。把 8 条 HIGH 全改成 DOWNGRADED，
// `upheldIds` 变空，`missing = 0`，本脚本一条规则都不触发。
//
// `final-report.md:89` 的铁律给了现成的解法：
//   「每一行的「出处」必须是 artifact_ref，指向能复核该结论的原始文件。」
// 于是判据从「裁决表自洽」升级为「裁决表的每一行都能在它自己声明的
// 出处文件里找到同一个裁决」。裁决表与锐评产物是两份独立文件，
// 改一份不改另一份必红——洞 3 的成本从 1 处提高到 2 处。
//
// 降级纪律（与 R8 的 unsupported_harness 同源）：
//   没有锐评产物可比对时退化为「只验索引表内部一致性」，而不是把流程卡死。
//   注意降级判据是「整个产物目录里没有任何一份能读出裁决的产物」，
//   不是「某一行的出处解析失败」——后者是 verdict_ref_not_found，必须红。
//   否则「把 arbiter 文件删掉」就成了新的绕法。
// ────────────────────────────────────────────────────────────────────
const reportDir = dirname(resolve(ARGS.report));
const artifactsDir = ARGS.artifactsDir ? resolve(ARGS.artifactsDir) : reportDir;
const reportAbs = resolve(ARGS.report);
const stateAbs = resolve(ARGS.state);

const sourceCache = new Map();   // 绝对路径 → readSourceVerdicts 结果
let artifactFiles = 0;           // 产物目录里「确实是产物」的文件数（排除报告与账本本身）
let critiqueArtifacts = 0;       // 其中能读出裁决的份数

{
  let isDir = false;
  try { isDir = existsSync(artifactsDir) && statSync(artifactsDir).isDirectory(); } catch { isDir = false; }
  if (isDir) {
    for (const rel of listFilesRecursive(artifactsDir)) {
      if (!/\.(md|markdown|txt|json)$/i.test(rel)) continue;
      const p = resolve(join(artifactsDir, rel));
      // 最终报告与 state.json 不是「产物」——它们是本次检查的两个输入。
      // 不排除的话，默认路径（--report 同目录）下永远至少算 1 份产物，
      // 于是「没有锐评产物」这一情况永远不会被识别为降级，
      // 所有引用悬空的轮次都会红成一片。
      if (p === reportAbs || p === stateAbs) continue;
      artifactFiles++;
      let parsed = null;
      try { parsed = readSourceVerdicts(p); } catch { parsed = null; }
      if (parsed) sourceCache.set(p, parsed);
      if (parsed && parsed.verdicts.size > 0) critiqueArtifacts++;
    }
  }
}

// ── 降级的判据是「目录不存在或为空」，不是「里面没有可读的裁决」──
//
// 这个区别很要紧。若用后者，「把出处全指向审计产物」就成了新的绕法：
// 审计产物存在（目录不空，按铁律理应被核对），但它们没有 verdicts 字段，
// 于是整轮被判成「无法交叉校验」而只报 WARN——那正是要堵的洞。
// 用前者：只要目录里有产物，逐行就必判；指错产物报 verdict_source_missing_finding
// （「索引表说这条被裁决过，但出处文件里没有它」），这才是准确的病因。
const crosscheck = artifactFiles > 0 ? 'ENABLED' : 'DEGRADED';
const refLevel = crosscheck === 'ENABLED' ? 'FAIL' : 'WARN';

let verdictRefs = 0;
let refsMissing = 0;
let refsNotFound = 0;
let sourceMissing = 0;
let mismatches = 0;
const emittedSourceConflicts = new Set();   // 出处文件绝对路径（同一文件的冲突只报一次）

if (!index.hasRefColumn) {
  // 整列都没有。这不是「某一行忘了写」，是「这一轮的报告结构不合铁律」。
  // 仍然 FAIL：降级只豁免「无法核实」，不豁免「没有可核实的东西」。
  refsMissing++;
  fail('verdict_ref_missing',
    '裁决索引表**没有「出处」列**（表头需要含 出处 / artifact_ref）'
    + '——framework/artifacts/final-report.md:89 的铁律要求每一行都指向能复核该结论的原始文件。'
    + '没有这一列，裁决表就是一份无法被外部核对的自我声明，'
    + '而这正是 R7「洞 3」的形态（裁决表说 DOWNGRADED，无人能查）',
    { finding_id: null, reason: 'no_ref_column' });
} else if (crosscheck === 'DEGRADED') {
  warn('verdict_crosscheck_degraded',
    `没有锐评产物可供交叉校验，本检查退化为只验索引表内部一致性。\n`
    + `  产物目录: ${artifactsDir}${existsSync(artifactsDir) ? '（存在但为空）' : '（不存在）'}\n`
    + `  索引表有 ${index.rows.length} 行的裁决**未经任何外部核对**——`
    + `它们的真伪取决于「主 Agent 是否愿意如实抄写」，本脚本此刻查不出来。`
    + `（与 R8 的 unsupported_harness 同一纪律：缺能力时报 WARN 并明示，不把流程卡死。）`,
    { artifacts_dir: artifactsDir, rows: index.rows.length });
}

for (const row of index.rows) {
  const where = `裁决索引表第 ${row.lineNo} 行（${row.id}）`;

  if (!index.hasRefColumn) break;   // 上面已整表报过，逐行再报只是噪音

  if (!looksLikePath(row.ref)) {
    refsMissing++;
    fail('verdict_ref_missing',
      `${where}的「出处」为空或不是文件路径（原文: ${JSON.stringify(row.refRaw ?? '')}）`
      + '——这一行的裁决没有任何可复核的来源。'
      + '出处必须指向锐评相位的 Arbiter 产物（例如 `round1-03-critique-arbiter.md`），'
      + '「见上文」「同上」这类散文指代不算出处（无法机械核对）',
      { finding_id: row.id, line: row.lineNo, raw: row.refRaw ?? null });
    continue;
  }

  if (crosscheck === 'DEGRADED') continue;   // 已整表 WARN，逐行不再重复

  const hit = resolveRefPath(row.ref, artifactsDir, reportDir);
  if (!hit) {
    refsNotFound++;
    add(refLevel, 'verdict_ref_not_found',
      `${where}的「出处」指向的文件不存在: ${row.ref}`
      + `（已在 ${artifactsDir} 与报告同目录下查找${/[{}]/.test(row.ref) ? '，并按占位符通配查找' : ''}）`
      + '——出处悬空时，这一行的裁决无法被任何外部文件复核，'
      + '它等价于「主 Agent 自己说这条降级了，但没人能查」',
      { finding_id: row.id, line: row.lineNo, ref: row.ref, artifacts_dir: artifactsDir });
    continue;
  }

  let parsed = sourceCache.get(resolve(hit.path));
  if (!parsed) {
    try { parsed = readSourceVerdicts(hit.path); } catch { parsed = null; }
    if (parsed) sourceCache.set(resolve(hit.path), parsed);
  }
  const actual = parsed?.verdicts.get(row.id);
  if (!actual) {
    sourceMissing++;
    add(refLevel, 'verdict_source_missing_finding',
      `${where}的出处 ${row.ref} 里**找不到 ${row.id} 的裁决**`
      + `（该文件可读出的裁决 ${parsed?.verdicts.size ?? 0} 条`
      + `${parsed?.sources.length ? `，来源形态: ${parsed.sources.join(' / ')}` : '，没有可识别的裁决结构'}）`
      + '——索引表声称这条被裁决过，但出处文件里没有它。'
      + '要么出处指向了错的产物（例如指向审计产物：它只有 findings，没有裁决），'
      + '要么这条裁决是索引表自己编的',
      { finding_id: row.id, line: row.lineNo, ref: row.ref, path: hit.path,
        source_verdicts: [...(parsed?.verdicts.keys() ?? [])].slice(0, 20) });
    continue;
  }

  verdictRefs++;

  // 出处文件自身的 JSON 信封与正文表格打架：这不是索引表的问题，但不能静默取一个。
  // 按文件去重——38 行共用一个出处文件时，同一个冲突只该报一次（否则报告被噪音淹没）。
  const conflictKey = resolve(hit.path);
  if (!emittedSourceConflicts.has(conflictKey)) {
    emittedSourceConflicts.add(conflictKey);
    for (const c of parsed.conflicts ?? []) {
      warn('verdict_source_self_conflict',
        `出处文件 ${row.ref} 内部不自洽：${c.id} 的 JSON 信封写 ${c.json}，正文表格写 ${c.table}`
        + '——本检查取 JSON 信封（output-contract §2.3 的结构化字段优先），但这份产物本身应当重写',
        { path: hit.path, finding_id: c.id, json: c.json, table: c.table });
    }
  }

  if (actual !== row.verdict) {
    mismatches++;
    add(refLevel, 'verdict_mismatch_with_source',
      `${where}的裁决与出处不一致：索引表写 **${row.verdict}**，`
      + `出处 ${row.ref} 写 **${actual}**`
      + (parsed.raw.get(row.id) ? `（出处原文: ${JSON.stringify(parsed.raw.get(row.id))}）` : '')
      + '。\n'
      + '  framework/artifacts/final-report.md:89 的铁律：主 Agent **只做排序、加索引、加统计**，'
      + '不得改写任何子 Agent 的裁决结论。\n'
      + (actual === 'UPHELD' && row.verdict !== 'UPHELD'
        ? '  这一条正是 R7「洞 3」的核心形态：把 UPHELD 在索引表里改成 DOWNGRADED，'
          + '`upheld` 集合变空、`missing` 变 0，于是 `upheld_without_fix_contract` 整个不触发。'
          + '出处文件说它该修，所以它必须进入修复登记。'
        : '  索引表与出处必须逐字一致；改一处不改另一处，说明裁决表被手工改写过了。'),
      { finding_id: row.id, line: row.lineNo, ref: row.ref,
        report_verdict: row.verdict, source_verdict: actual, source_path: hit.path });
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
  // R10：裁决表 × 出处文件的交叉校验
  crosscheck,          // ENABLED / DEGRADED
  artifactFiles,       // 产物目录里的产物份数（降级判据）
  critiqueArtifacts,   // 其中能读出裁决的份数
  hasRefColumn: index.hasRefColumn,
  verdictRefs,         // 成功在出处里核对到的行数
  refsMissing,
  refsNotFound,
  sourceMissing,
  mismatches,
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
console.log(`  合并申报: ${mergeRecords.length} 条 FIX_INSTANCE_MERGED`);
console.log(`  出处交叉校验: ${crosscheck === 'ENABLED'
  ? `已启用（产物目录 ${artifactsDir}，产物 ${artifactFiles} 份，可读出裁决 ${critiqueArtifacts} 份，已核对 ${verdictRefs} 行）`
  : `已降级为 WARN（产物目录 ${artifactsDir} 不存在或为空）`}\n`);

const order = { FAIL: 0, WARN: 1, CONFIG: 2, PASS: 3 };
const tag = { FAIL: '✗', WARN: '!', CONFIG: '✗', PASS: '✓' };
for (const p of [...problems].sort((a, b) => order[a.level] - order[b.level])) {
  console.log(`${tag[p.level]} [${p.rule}] ${p.msg}`);
}

console.log(`\n合计: ${upheldIds.size} 条 UPHELD / 已登记 ${accounted} / 未登记 ${missing.length}`
  + ` / 实例 ${instances.size} / spawned ${spawned}`);
console.log(`合计: ${accounted} PASS / ${counts.FAIL ?? 0} FAIL / ${counts.WARN ?? 0} WARN`);
console.log(`合计: 出处核对 ${verdictRefs} / 出处缺失 ${refsMissing} / 出处悬空 ${refsNotFound}`
  + ` / 来源无此条 ${sourceMissing} / 裁决不一致 ${mismatches}\n`);

if (exitCode === 0) {
  if ((counts.WARN ?? 0) > 0) {
    console.log(`结论：${upheldIds.size} 条 UPHELD 全部进入了修复登记，但有 ${counts.WARN} 条警告（见上）。`);
    console.log('这些是「已知且被记录」的风险，不再属于「静默丢失」——但收口前应逐条确认。\n');
  } else if (upheldIds.size === 0) {
    console.log('结论：裁决索引表里没有 UPHELD 发现，没有要修的东西——'
      + 'fix_contracts 为空是正确的，不是「一条都没修」。'
      + (crosscheck === 'ENABLED'
        ? `\n      ${verdictRefs} 行裁决已在出处文件里逐条核对一致。\n`
        : '\n      （注意：没有锐评产物可供交叉校验，这个「0 条」是索引表自述。）\n'));
  } else {
    console.log(`结论：${upheldIds.size} 条 UPHELD 全部已登记，实例计数自洽，合并申报可复核。\n`);
  }
} else if (mismatches > 0 || sourceMissing > 0 || refsNotFound > 0 || refsMissing > 0) {
  console.log('结论：裁决索引表与它自己声明的出处对不上（见上）。');
  console.log('索引表说 DOWNGRADED、出处说 UPHELD，就是 R7「洞 3」的形态：'
    + '把裁决表改成全降级，`upheld` 集合变空，`upheld_without_fix_contract` 整个不触发。');
  console.log('出处文件是主 Agent 不能单方面改写的那一侧——它说什么，修复登记就得跟什么。\n');
} else if (missing.length > 0) {
  console.log(`结论：${missing.length} 条 UPHELD 从未进入任何修复登记。`);
  console.log('它们可能从未进入任何任务书——这正是「38 条只修 6 条」丢失的地方，'
    + '而这一次它被外部基准抓到了。\n');
} else {
  console.log('结论：登记侧与裁决表对不上，或实例计数 / 合并申报不自洽（见上）。');
  console.log('UPHELD 覆盖率不是这里的瓶颈——需要处理的是上面点名的那些行。\n');
}
process.exit(exitCode);
