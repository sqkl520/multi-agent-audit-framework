#!/usr/bin/env node
/**
 * check-disposition-coverage.mjs — 每一条发现是否都被「表态」过一次
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * 一次真实审计（experiments/hilltop-dsh）：7 份产物、38 条发现
 * （8 HIGH / 22 MEDIUM / 8 LOW），最后只修了 6 条，**31 条从未进入任何任务书**，
 * 其中 2 条 HIGH 至今仍在生产代码里。全程没有任何工具报错。
 *
 * 原因不是某个环节失职，而是**没有环节被要求做这件事**：
 *   - `SUMMARY.md` 只管计数（「38 条」），它是索引，不是清单；
 *   - `task-repair.md` 只管派活，全文 `grep finding_id` = 0 次；
 *   - 两者之间缺的正是「每一条都必须被表态一次」。
 *
 * 7 份产物的 JSON 信封里 `findings[].finding_id` 都在，
 * `check-payload.mjs` 的报错文案甚至写着「下游锐评/修复/verify 都靠它挂接」，
 * 但**没有任何工具验证这个挂接真的发生过**。本脚本补的就是这一段。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *   node check-disposition-coverage.mjs --artifacts <目录> --ledger <文件> [--json] [--strict-high]
 *
 *   --artifacts    审计产物目录。逐个 .md 解析**末尾的 ```json 信封**，
 *                  取 `payload.findings[]`（也接受顶层 `findings[]`）。
 *   --ledger       发现去向表（markdown 表格）。
 *   --json         输出机器可读 JSON。
 *   --strict-high  把「HIGH 未闭合」类规则从 WARN 升级为 FAIL，共三条：
 *                    high_severity_unaccounted   HIGH 被 DEFERRED / 无去向
 *                    high_severity_wont_fix      HIGH 被判 WONT_FIX
 *                    high_wont_fix_reason_thin   HIGH 的 WONT_FIX 理由撑不住
 *                  默认是 WARN，因为 DEFERRED 有时确实是正确决定；
 *                  但「全填 DEFERRED」能骗过默认模式，交付闸门应当开这个开关。
 *                  （R9：WONT_FIX 原本完全不在判据里，全填 WONT_FIX 连
 *                    --strict-high 都无感——因为规则根本没被触发。）
 *   --help / -h    打印本说明，退出 0。
 *
 * ── 去向表格式 ───────────────────────────────────────────────────────
 * 一张 markdown 表格，三列（列名大小写不敏感，也接受中文别名）：
 *
 *   | finding_id | disposition | 依据 |
 *   |---|---|---|
 *   | round1-core::F2 | FIXED | #7 |
 *   | round3-A::A-04/a | WONT_FIX | 文案已告知，设计意图 |
 *   | round2-mechanics::F3 | DEFERRED | 等 #7 合并后一起处理 |
 *
 *   finding_id  发现有三种写法（按推荐顺序）：
 *                 scope::id   —— 推荐。scope = 产物文件名去掉 `-audit.md`
 *                                （例：round2-mechanics-audit.md → round2-mechanics）
 *                 scope/id    —— 同上，兼容斜杠写法
 *                 裸 id       —— 仅当该 id 在全部产物里**唯一**时才接受；
 *                                跨产物撞名会报 ambiguous_finding_reference
 *               id 允许带子主张后缀（`A-04/a`、`A-04.b`），对账时按
 *               基础 id（A-04）归属，后缀只用于人读与将来更细的核对。
 *   disposition 闭集：FIXED | WONT_FIX | DEFERRED | NEW_FINDING
 *   「依据」    WONT_FIX / DEFERRED 必填，去空白后 ≥ 10 字；
 *               **HIGH 的 WONT_FIX 另外要求 ≥ 40 字**（见下）；
 *               FIXED 建议写修复编号或 commit；NEW_FINDING 必须能用它追溯到来源。
 *
 *   为什么 HIGH 的 WONT_FIX 要比 MEDIUM/LOW 更严：
 *     DEFERRED 承认「这是缺陷，只是这轮不修」，它自带一个未来的检查点；
 *     WONT_FIX 主张「这不是缺陷」，一旦写下就再没有任何后续动作会回头看它。
 *     对 HIGH 而言，这是整条流程里唯一「关闭一个高风险项且不产生遗留工作」的写法，
 *     也正是绕开 high_severity_unaccounted 最省事的路径（R7 洞 2 实测）。
 *     一条「本案不成立」的判断，若没有可复核的落点（文件 / 行号 / 规则ID），
 *     读者只能选择相信或不信——那不是论证，是断言。所以：HIGH 的 WONT_FIX
 *     理由需 ≥ 40 字，且须含一个可复核指涉（路径 / 行号 / 反引号标识符 / #编号）。
 *
 * ── 它断言什么（每条规则独立命名）────────────────────────────────────
 *   ledger_missing                     去向表文件不存在                       exit 2
 *   artifacts_missing                  产物目录不存在                         exit 2
 *   artifact_json_invalid              信封 JSON 解析失败                     exit 2
 *   artifact_without_envelope          产物 .md 里找不到可解析的信封          exit 2
 *   artifact_without_findings          信封里没有 findings 数组               exit 2
 *   ledger_unparsable                  去向表里找不到表头                     exit 2
 *   duplicate_finding_id_in_artifacts  **同一份**产物内 finding_id 重复       FAIL
 *   cross_artifact_id_collision        跨产物裸 id 撞名（要求 scope 限定）    WARN
 *   ambiguous_finding_reference        去向表用裸 id，但它对应多条发现        FAIL
 *   ledger_duplicate_id                去向表同一 id 出现两次                 FAIL
 *   finding_without_disposition        **核心**：产物里有、去向表里没有       FAIL（逐条）
 *   disposition_without_finding        去向表里有、产物里没有（非 NEW_FINDING）FAIL
 *   invalid_disposition                不在四枚举内                           FAIL
 *   disposition_missing_reason         WONT_FIX/DEFERRED 的依据 < 10 字       FAIL
 *   high_severity_unaccounted          HIGH 被 DEFERRED 或无 disposition      WARN
 *   high_severity_wont_fix             HIGH 被判 WONT_FIX（逐条列 id+理由）   WARN
 *   high_wont_fix_reason_thin          HIGH 的 WONT_FIX 理由 < 40 字或无可复核指涉  WARN
 *
 *   后三条在 --strict-high 下全部升级为 FAIL。
 *
 * 退出码：0 = 全部表态（允许 WARN） / 1 = 有覆盖率问题 / 2 = 配置错误
 *
 * ── 它不检查什么 ─────────────────────────────────────────────────────
 *   disposition 填得对不对（DEFERRED 的理由是否成立、FIXED 是否真有测试）——
 *   那要读代码和测试，脚本不碰。本脚本只保证「没有一条静默消失」。
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, basename, extname, relative } from 'node:path';

const DISPOSITIONS = ['FIXED', 'WONT_FIX', 'DEFERRED', 'NEW_FINDING'];
const REASON_REQUIRED = new Set(['WONT_FIX', 'DEFERRED']);
const MIN_REASON_CHARS = 10;

// R9 · 洞 2（experiments/hilltop-dsh/FIX-R7-report.md §4）：
//   `high_severity_unaccounted` 的原判据是「HIGH 处于 DEFERRED 或无去向」。
//   把 8 条 HIGH 全填 WONT_FIX（理由写够 20 字），警告完全消失——
//   连 --strict-high 也救不回来，因为规则根本没被触发。
//   WONT_FIX 比 DEFERRED 更省事（不需要 next_round、不需要重处置条件），
//   所以它是绕开这条防线的更优路径。这里为它单开一条规则。
const MIN_HIGH_WONT_FIX_CHARS = 40;

// 「可复核指涉」：读者能顺着它去查，而不是只能相信写的人。
//   路径/行号（src/a/B.java、main.rs:42）、反引号标识符、#编号、
//   以及惯例写法的 文件名.扩展名。刻意不放宽到「任意英文单词」——
//   否则「设计如此 by design」这种空话也能命中。
const HIGH_WONT_FIX_ANCHOR = /(?:[\w.-]+\/[\w./-]+|[\w.-]+\.(?:java|kt|ts|js|mjs|py|go|rs|c|cpp|h|json|ya?ml|md|xml|gradle|properties))(?::\d+)?|`[^`]+`|#\d+/;

// ────────────────────────────────────────────────────────────────────
// 参数
// ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { artifacts: null, ledger: null, json: false, strictHigh: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--artifacts') out.artifacts = argv[++i];
    else if (a === '--ledger') out.ledger = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--strict-high') out.strictHigh = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out.bad = a;
  }
  return out;
}

const HELP = `
check-disposition-coverage.mjs — 每条发现是否都被表态过一次

用法:
  node check-disposition-coverage.mjs --artifacts <目录> --ledger <文件> [--json] [--strict-high]

参数:
  --artifacts    审计产物目录（解析每个 .md 末尾的 \`\`\`json 信封，取 payload.findings[]）
  --ledger       发现去向表（markdown 表格）
  --json         输出机器可读 JSON
  --strict-high  把「HIGH 未闭合」类规则从 WARN 升级为 FAIL（交付闸门应开启）：
                   high_severity_unaccounted  HIGH 被 DEFERRED / 无去向
                   high_severity_wont_fix     HIGH 被判 WONT_FIX
                   high_wont_fix_reason_thin  HIGH 的 WONT_FIX 理由撑不住
  --help, -h     显示本说明

去向表格式（markdown 表格，列名大小写不敏感）:

  | finding_id | disposition | 依据 |
  |---|---|---|
  | round1-core::F2 | FIXED | #7 |
  | round3-A::A-04/a | WONT_FIX | 文案已告知，设计意图 |
  | round2-mechanics::F3 | DEFERRED | 等 #7 合并后一起处理 |

  finding_id 写法：
    scope::id    推荐。scope = 产物文件名去掉 -audit.md
                 （round2-mechanics-audit.md → round2-mechanics）
    scope/id     同上，兼容斜杠
    裸 id        仅当该 id 在全部产物里唯一时接受；撞名会报 ambiguous_finding_reference
    id 可带子主张后缀（A-04/a、A-04.b），对账按基础 id 归属

  disposition 枚举（四选一）:
    FIXED       已修（依据写修复编号 / commit / 测试）
    WONT_FIX    裁决不修（依据 ≥ ${MIN_REASON_CHARS} 字，必须写为什么）
                **若该条是 HIGH**：依据 ≥ ${MIN_HIGH_WONT_FIX_CHARS} 字，且须含一个可复核指涉
                （文件路径 / 行号 / 反引号标识符 / #编号）。
                WONT_FIX 声称「这不是缺陷」，比 DEFERRED 的「下轮修」更强，
                而 HIGH 的 WONT_FIX 是唯一「关掉高风险项且不留下任何后续工作」的写法，
                因此 HIGH 的 WONT_FIX 会被单列为 high_severity_wont_fix 警告。
    DEFERRED    暂缓（依据 ≥ ${MIN_REASON_CHARS} 字，必须写等什么）
    NEW_FINDING 修复过程中新发现（允许 id 不在原产物里）

退出码: 0 = 全部表态（允许 WARN） / 1 = 有覆盖率问题 / 2 = 配置错误
`;

const ARGS = parseArgs(process.argv);
if (ARGS.help) { console.log(HELP); process.exit(0); }
if (ARGS.bad) {
  console.error(`未知参数: ${ARGS.bad}\n${HELP}`);
  process.exit(2);
}
if (!ARGS.artifacts || !ARGS.ledger) {
  console.error(`缺少必填参数。\n${HELP}`);
  process.exit(2);
}

// ────────────────────────────────────────────────────────────────────
// 结果收集
// ────────────────────────────────────────────────────────────────────
const problems = [];
const add = (level, rule, msg, extra = {}) => problems.push({ level, rule, msg, ...extra });
const fail = (rule, msg, extra) => add('FAIL', rule, msg, extra);
const warn = (rule, msg, extra) => add('WARN', rule, msg, extra);

/** 配置错误：打印后直接 exit 2，绝不允许降级成「覆盖率高」。 */
function configError(rule, msg, extra = {}) {
  const p = { level: 'CONFIG', rule, msg, ...extra };
  problems.push(p);
  if (ARGS.json) {
    console.log(JSON.stringify({
      artifacts: ARGS.artifacts, ledger: ARGS.ledger,
      totals: null, problems, exitCode: 2,
    }, null, 2));
  } else {
    console.error(`\n[配置错误] ${rule}`);
    console.error(`  ${msg}\n`);
  }
  process.exit(2);
}

// ────────────────────────────────────────────────────────────────────
// 1 · 读取产物目录，解析信封
// ────────────────────────────────────────────────────────────────────
if (!existsSync(ARGS.artifacts)) {
  configError('artifacts_missing', `产物目录不存在: ${ARGS.artifacts}`);
}
if (!statSync(ARGS.artifacts).isDirectory()) {
  configError('artifacts_missing', `--artifacts 不是目录: ${ARGS.artifacts}`);
}

// 2026-11-20 改：递归收集，不再拒绝子目录。
//
// 原来的做法是「发现有子目录就 exit 2」，理由是「子目录里的产物不会被
// 顶层 readdirSync 看到，于是既没进分母也没触发 artifact_without_envelope——
// 整份产物凭空消失，覆盖率照样 100%」。**这个担心是对的，但处置是错的**：
// 拒绝跑，等于把「覆盖率算不全」换成了「根本没有覆盖率」。
//
// 实测代价：仓库里唯一一次真实 dsh 审计（`.run-hv`）的产物天然在
// `findings/` `critiques/` `deep/` 三个子目录里。本检查器对它 exit 2，
// 而它恰恰是唯一能拦住「38 条发现只修 6 条、框架全程无工具报错」的检查器
//（FIX-R1-R18-SUMMARY.md:10）。也就是说：**最该跑的一次，它跑不了。**
//
// 现在递归遍历，用**相对路径**作为产物标识（避免不同子目录的同名文件互相覆盖）。
const relFiles = [];
const walkArtifacts = (dir, depth = 0) => {
  if (depth > 4) return;      // 防御：产物目录不会更深，避免误入 node_modules
  let ents;
  try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walkArtifacts(p, depth + 1);
    else if (/\.(md|markdown)$/i.test(e.name)) relFiles.push(relative(ARGS.artifacts, p).replace(/\\/g, '/'));
  }
};
walkArtifacts(ARGS.artifacts);

const mdFiles = relFiles
  .filter((f) => {
    // 2026-11-20：交付物不是「波次产物」，不该被要求带 findings 信封。
    //   final-report 是给人读的汇总，ledger 是去向表本身，UNFIXED/README 同理。
    // 判据用**文件名形状**而非路径：真实审计里它们常常和 findings/ 并列在同一层。
    // 这与 verify-artifacts 的交付物豁免同源（那边是 `-(final-report|ledger)\.md$`）。
    const b = basename(f).toLowerCase();
    if (/(^|-)final-report\.md$/.test(b)) return false;
    if (/(^|-)ledger\.md$/.test(b)) return false;
    if (/^(readme|unfixed|summary|notes|index)\.md$/.test(b)) return false;
    return true;
  })
  .sort();

if (mdFiles.length === 0) {
  configError('artifacts_missing', `产物目录里没有任何 .md（含子目录）: ${ARGS.artifacts}`);
}

/** 从 markdown 正文里取出最后一个可用的 ```json 信封。 */
function extractEnvelope(text) {
  const blocks = [...text.matchAll(/```json[^\n]*\n([\s\S]*?)```/gi)].map((m) => m[1]);
  if (blocks.length === 0) return { ok: false, reason: 'no_envelope' };

  // 从后往前找：真实产物把信封放在末尾；前面可能还有示例 JSON 块。
  let lastParseError = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    let j;
    try { j = JSON.parse(blocks[i]); }
    catch (e) { lastParseError = e.message; continue; }
    const payload = (j && typeof j === 'object' && j.payload) ? j.payload : j;
    // 2026-11-20 修：此前只认 `payload.findings`，于是**critique 产物永远进不了对账**。
    //
    // critique 承载的是对每条发现的裁决（`payload.verdicts[]`，见
    // output-contract/critique.md §2.3），它不产出新发现，但它决定已有发现的去向。
    // 只认 findings 的后果是：一个塞满 verdicts 的 critiques/ 目录会被判成
    // 「no_findings → 无法作为对账分母」，于是锐评波的产物从未参与过去向核对。
    //
    // 现在两种都认，并在返回值里标明是哪一种，供下游区分「发现源」与「裁决源」。
    if (payload && Array.isArray(payload.findings)) {
      return { ok: true, envelope: j, payload, blockIndex: i, kind: 'findings', items: payload.findings };
    }
    if (payload && Array.isArray(payload.verdicts)) {
      return { ok: true, envelope: j, payload, blockIndex: i, kind: 'verdicts', items: payload.verdicts };
    }
  }
  if (lastParseError) return { ok: false, reason: 'bad_json', detail: lastParseError };
  return { ok: false, reason: 'no_findings' };
}

/** 产物文件名 → scope。round1-core-audit.md → round1-core */
function scopeOf(file) {
  const stem = basename(file, extname(file));
  return stem.replace(/-audit$/i, '');
}

const artifacts = [];   // { file, scope, agentId, findings: [{ finding_id, severity, ... }] }
const skippedDeliverables = [];  // 无 finding 迹象、无信封的 .md（交付物/说明文档）
let rawFindingCount = 0;  // 未去重：产物里实际写了多少条 finding

for (const file of mdFiles) {
  const text = readFileSync(join(ARGS.artifacts, file), 'utf8');
  const r = extractEnvelope(text);
  if (!r.ok) {
    if (r.reason === 'bad_json') {
      configError('artifact_json_invalid',
        `${file} 的 JSON 信封解析失败: ${r.detail}`
        + '——解析不出信封就不能当作「这份产物没有 finding」，否则分母会悄悄缩水', { file });
    }
    // 2026-11-20：用**内容**而不是文件名判断「这是不是波次产物」。
    //
    // 判据要同时满足两条，缺一不可：
    //   (a) 文件里出现 finding 的**数据形状**（JSON 键、`字段: 值`、或表格列）
    //   (b) 该文件**不是**任务书/说明文档
    //
    // 只用 (a) 会误伤一种真实存在的文件：**任务书**（`TASK3.md`）——
    // 它用散文提到 "13 条已确认的发现"、列举 id，但它是写给子 Agent 的指令，
    // 不是产物。实测就是被它卡住的。
    //
    // 表格形态必须单独覆盖：真实产物里「未修复清单」常常是 markdown 表格
    //（`| F9 | HIGH |`），而早期判据只认 JSON 键和 `字段: 值`，会把它们漏掉，
    // 于是「描述了 finding 却没信封」这份产物静默逃过分母。
    const claimsFindings = /["'`]?(finding_id|local_id)["'`]?\s*[:：]/.test(text)
      || /["'`]?severity["'`]?\s*[:：]\s*["'`]?(CRITICAL|HIGH|MEDIUM|LOW|critical|high|medium|low)/.test(text)
      || /\|[^|\n]*(finding_id|local_id)[^|\n]*\|/i.test(text)                       // 表格表头有 finding_id 列
      || /\|\s*[A-Z]\d{1,3}-F\d{1,3}\s*\|\s*(CRITICAL|HIGH|MEDIUM|LOW)\s*\|/i.test(text) // 表格行形如 | S01-F1 | HIGH |
      || /\|\s*F\d{1,3}\s*\|\s*(CRITICAL|HIGH|MEDIUM|LOW)\s*\|/i.test(text);
    const looksLikeTaskBrief = /^(你|请|对\s*\d+\s*条|任务[:：]|指令[:：])/.test(text.trim().slice(0, 60))
      || /\*\*硬约束\*\*|## 硬约束|你（主 Agent）|必须派子 Agent/.test(text);
    const looksLikeFindings = claimsFindings && !looksLikeTaskBrief;
    if (looksLikeFindings) {
      configError('artifact_without_envelope',
        `${file} 里描述了 finding 但找不到可解析的 \`\`\`json 信封。`
        + '**这份产物里的 finding 会静默漏出分母**——补上信封，或把它移出 --artifacts 目录', { file });
    }
    for (const reason of [r.reason]) skippedDeliverables.push({ file, reason });
    continue;
  }
  if (r.ok && r.reason === 'no_findings') {
    configError('artifact_without_findings',
      `${file} 的信封里既没有 payload.findings[] 也没有 payload.verdicts[]，无法作为对账分母`, { file });
  }
  artifacts.push({
    file,
    scope: scopeOf(file),
    agentId: r.envelope?.agent_id ?? null,
    // 2026-11-20：critique 产物的条目是 verdicts，它们不产生新发现，
    // 所以不进 findings 分母，但要在报告里显式计数——否则「锐评波做了多少裁决」
    // 这件事在覆盖率里完全不可见。
    findings: r.kind === 'findings' ? r.payload.findings : [],
    verdictCount: r.kind === 'verdicts' ? r.items.length : 0,
  });
}

// ────────────────────────────────────────────────────────────────────
// 2 · 建索引，检查产物内重复
// ────────────────────────────────────────────────────────────────────
/** canonical key → finding record */
const findingsByKey = new Map();     // `${scope}::${id}` → { scope, id, severity, file, line, index }
/** bare id → [scope]（去重后的产物 scope 列表，用于裸 id 唯一性判定） */
const byBareId = new Map();
/** scope（小写）→ Set<真实 scope>，用于宽松匹配 + 撞名检测 */
const scopesByLower = new Map();

for (const art of artifacts) {
  const lc = art.scope.toLowerCase();
  if (!scopesByLower.has(lc)) scopesByLower.set(lc, new Set());
  scopesByLower.get(lc).add(art.scope);

  const seenInFile = new Map();  // finding_id → count（同一份产物内）
  rawFindingCount += art.findings.length;
  art.findings.forEach((f, idx) => {
    const id = typeof f?.finding_id === 'string' ? f.finding_id.trim() : '';
    if (!id) {
      configError('artifact_without_findings',
        `${art.file} 第 ${idx + 1} 条 finding 没有 finding_id，无法对账`, { file: art.file });
    }
    seenInFile.set(id, (seenInFile.get(id) ?? 0) + 1);

    const key = `${art.scope}::${id}`;
    // 两个不同文件映射到同一 scope（如 foo-audit.md 与 foo.md）会让后一份
    // 覆盖前一份的同名 finding——分母静默变小。scope 必须唯一。
    if (findingsByKey.has(key)) {
      const prev = findingsByKey.get(key);
      if (prev.file !== art.file) {
        configError('artifact_scope_collision',
          `${art.file} 与 ${prev.file} 解析出同一个 scope "${art.scope}"，`
          + `且都有 finding_id "${id}"——后一份会覆盖前一份，分母静默变小。`
          + '请重命名，让每个产物文件名去掉 -audit.md 后互不相同',
          { file: art.file, other: prev.file, scope: art.scope, finding_id: id });
      }
    }
    findingsByKey.set(key, {
      key,
      scope: art.scope,
      id,
      file: art.file,
      severity: String(f?.severity ?? 'UNKNOWN').toUpperCase(),
      line: f?.evidence?.line ?? null,
      evidenceFile: f?.evidence?.file ?? null,
      index: idx,
    });

    if (!byBareId.has(id)) byBareId.set(id, []);
    // 同一份产物内重复只算一次「这个 id 在这份产物里出现过」——
    // 否则跨产物撞名的计数会把这 3 次重复说成「3 份产物」。
    const scopesForId = byBareId.get(id);
    if (!scopesForId.includes(art.scope)) scopesForId.push(art.scope);
  });

  // 同一份产物内 id 重复 → 两条发现在下游不可区分。
  // 实测：把 7 条 finding 的 id 改成完全相同，check-payload 仍报「✅ 契约合规」。
  for (const [id, n] of seenInFile) {
    if (n > 1) {
      fail('duplicate_finding_id_in_artifacts',
        `${art.file} 里 finding_id "${id}" 出现 ${n} 次——同一文件内重复，`
        + `下游修复/verify 按 id 挂接时会静默串线（${n} 条只能保住 1 条）`,
        { file: art.file, finding_id: id, occurrences: n });
    }
  }
}

const totalFindings = findingsByKey.size;

// 跨产物裸 id 撞名：真实数据里 F1 同时出现在 4 份产物中。
// 这不一定是错（各轮独立编号），但它意味着「裸 id」不能作为挂接键，
// 去向表必须用 scope::id。这里只提示，不阻断。
for (const [id, scopes] of byBareId) {
  if (scopes.length > 1) {
    warn('cross_artifact_id_collision',
      `finding_id "${id}" 在 ${scopes.length} 份产物里重复（${scopes.join('、')}）`
      + `——去向表必须用 scope::id 指定，裸 "${id}" 会被判为歧义`,
      { finding_id: id, scopes });
  }
}

// ────────────────────────────────────────────────────────────────────
// 3 · 读取去向表
// ────────────────────────────────────────────────────────────────────
if (!existsSync(ARGS.ledger)) {
  configError('ledger_missing',
    `去向表不存在: ${ARGS.ledger}\n`
    + '  这不是「覆盖率 100%」——是没有分母。收口前必须逐条产出 disposition。');
}

const ledgerText = readFileSync(ARGS.ledger, 'utf8');
const ledgerRows = parseLedger(ledgerText);
if (!ledgerRows) {
  configError('ledger_unparsable',
    `${ARGS.ledger} 里找不到 markdown 表格（需要表头含 finding_id 与 disposition 两列）`);
}

/** 解析 markdown 表格。返回 [{ rawId, disposition, reason, lineNo }] 或 null。 */
function parseLedger(text) {
  const lines = text.split(/\r?\n/);
  let header = null;
  const rows = [];

  // 围栏代码块里的内容不是表格行——它是给人看的示例。
  // 不跳过的话，去向表里贴一段「该怎么写」的示例就会被当成真实行，
  // 进而凭空多出 NEW_FINDING 计数或多报 disposition_without_finding。
  let inFence = false;
  const fenceLines = new Set();
  for (let li = 0; li < lines.length; li++) {
    if (/^\s*(```|~~~)/.test(lines[li])) { inFence = !inFence; fenceLines.add(li); continue; }
    if (inFence) fenceLines.add(li);
  }

  const cell = (s) => String(s).replace(/\*\*/g, '').replace(/`/g, '').trim();
  const splitRow = (line) => {
    // 去掉首尾的 |，再按 | 切。不处理转义竖线（表格里写竖线本身就会坏）。
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
  const DISP_COLS = ['disposition', '去向', '处置', '处理'];
  const REASON_COLS = ['依据', 'reason', '理由', '说明', '备注'];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (fenceLines.has(li)) continue;
    if (!line.includes('|')) continue;
    const cells = splitRow(line);
    if (isSeparator(cells)) continue;

    if (!header) {
      const idCol = findCol(cells, ID_COLS);
      const dispCol = findCol(cells, DISP_COLS);
      // 必须同时命中两列，才认这是表头——避免把正文里的竖线当成表。
      if (idCol >= 0 && dispCol >= 0 && idCol !== dispCol) {
        header = {
          id: idCol,
          disp: dispCol,
          reason: findCol(cells, REASON_COLS),
        };
      }
      continue;
    }

    // 表头之后、下一张表头之前的行都算数据行。
    // 若这一行自己又像表头（含 disposition 字样），则重置表头。
    const maybeDisp = findCol(cells, DISP_COLS);
    const maybeId = findCol(cells, ID_COLS);
    if (maybeDisp >= 0 && maybeId >= 0 && maybeId !== maybeDisp
        && /disposition|去向|处置/i.test(cells[maybeDisp] ?? '')) {
      header = { id: maybeId, disp: maybeDisp, reason: findCol(cells, REASON_COLS) };
      continue;
    }

    const rawId = cells[header.id] ?? '';
    const disposition = (cells[header.disp] ?? '').toUpperCase();
    const reason = header.reason >= 0 ? (cells[header.reason] ?? '') : '';
    // 跳过空行 / 模板占位行
    if (!rawId) continue;
    if (rawId === '—' || rawId === '-') continue;
    rows.push({ rawId, disposition, reason, lineNo: li + 1 });
  }

  return header ? rows : null;
}

// ────────────────────────────────────────────────────────────────────
// 4 · 解析去向表的每一行
// ────────────────────────────────────────────────────────────────────
/** 把去向表里的 id 拆成 { scope|null, baseId, raw }。 */
function splitLedgerId(raw) {
  let s = raw.trim().replace(/^`|`$/g, '');
  let scope = null;
  if (s.includes('::')) {
    const i = s.indexOf('::');
    scope = s.slice(0, i).trim();
    s = s.slice(i + 2).trim();
  } else if (s.includes('/')) {
    // scope/id 形态：只有当斜杠左侧能匹配到一个真实 scope 时才当 scope。
    const i = s.indexOf('/');
    const left = s.slice(0, i).trim();
    if (scopesByLower.has(left.toLowerCase())) {
      scope = left;
      s = s.slice(i + 1).trim();
    }
  }
  // 子主张后缀：A-04/a、A-04.b → 基础 id 是 A-04
  const m = s.match(/^(.*?)(?:[/.][A-Za-z0-9_-]+)$/);
  const baseId = m && m[1] ? m[1] : s;
  return { scope, baseId, raw, subClaim: baseId !== s ? s.slice(baseId.length) : null };
}

/** 解析 scope 名（大小写不敏感）。返回真实 scope 或 null。 */
function resolveScope(name) {
  if (!name) return null;
  const set = scopesByLower.get(name.toLowerCase());
  if (!set || set.size === 0) return null;
  return [...set][0];
}

const ledgerSeen = new Map();   // 规范化 key → row（查重）
const covered = new Set();      // 已被任何一行指向的 canonical key
const deferredKeys = new Set(); // disposition 为 DEFERRED 的 canonical key
const wontFixKeys = new Map();  // R9: disposition 为 WONT_FIX 的 canonical key → 理由原文
let newFindingCount = 0;

for (const row of ledgerRows) {
  const { scope: rawScope, baseId, raw, subClaim } = splitLedgerId(row.rawId);

  // 规则 · disposition 枚举
  const validDisp = DISPOSITIONS.includes(row.disposition);
  if (!validDisp) {
    fail('invalid_disposition',
      `去向表第 ${row.lineNo} 行 "${raw}" 的 disposition 是 "${row.disposition || '（空）'}"，`
      + `只能取 ${DISPOSITIONS.join(' | ')}`,
      { line: row.lineNo, raw_id: raw, disposition: row.disposition });
  }

  // 规则 · 不修的必须给理由
  const reasonChars = [...String(row.reason ?? '').replace(/\s+/g, '')].length;
  if (validDisp && REASON_REQUIRED.has(row.disposition) && reasonChars < MIN_REASON_CHARS) {
    fail('disposition_missing_reason',
      `去向表第 ${row.lineNo} 行 "${raw}" 标了 ${row.disposition}，但「依据」只有 ${reasonChars} 字`
      + `（要求 ≥ ${MIN_REASON_CHARS}）——「不修」和「暂缓」都是判断，必须写理由，`
      + '否则它们和「忘了」无法区分',
      { line: row.lineNo, raw_id: raw, disposition: row.disposition, reason_chars: reasonChars });
  }

  // NEW_FINDING 允许不在产物里
  if (row.disposition === 'NEW_FINDING') {
    newFindingCount++;
    const key = rawScope ? `${resolveScope(rawScope) ?? rawScope}::${raw}` : `NEW::${raw}`;
    if (ledgerSeen.has(key)) {
      fail('ledger_duplicate_id',
        `去向表第 ${row.lineNo} 行与第 ${ledgerSeen.get(key)} 行重复（"${raw}"）——后一行会悄悄覆盖前一行`,
        { line: row.lineNo, raw_id: raw, first_line: ledgerSeen.get(key) });
    } else {
      ledgerSeen.set(key, row.lineNo);
    }
    // 若它其实指向了一条真实 finding，也把它算作已覆盖（合法写法）。
    if (rawScope) {
      const k = `${resolveScope(rawScope) ?? rawScope}::${baseId}`;
      if (findingsByKey.has(k)) covered.add(k);
    }
    continue;
  }

  // 定位到具体 finding
  let key = null;
  if (rawScope) {
    const scope = resolveScope(rawScope);
    if (!scope) {
      fail('disposition_without_finding',
        `去向表第 ${row.lineNo} 行 "${raw}" 的 scope "${rawScope}" 不匹配任何产物`
        + `（现有: ${[...scopesByLower.values()].flat().join('、')}）`,
        { line: row.lineNo, raw_id: raw });
      continue;
    }
    key = `${scope}::${baseId}`;
  } else {
    const scopeHits = byBareId.get(baseId) ?? [];
    if (scopeHits.length === 1) {
      key = `${scopeHits[0]}::${baseId}`;
    } else if (scopeHits.length > 1) {
      fail('ambiguous_finding_reference',
        `去向表第 ${row.lineNo} 行用了裸 id "${baseId}"，但它在 ${scopeHits.length} 份产物里都存在`
        + `（${scopeHits.join('、')}）——裸 id 无法确定指哪一条，必须写成 scope::id`,
        { line: row.lineNo, raw_id: raw, candidates: scopeHits.map((s) => `${s}::${baseId}`) });
      continue;
    } else {
      key = null;   // 下面报 disposition_without_finding
    }
  }

  if (key && findingsByKey.has(key)) {
    // 规则 · 去向表内重复
    if (ledgerSeen.has(key)) {
      fail('ledger_duplicate_id',
        `去向表第 ${row.lineNo} 行与第 ${ledgerSeen.get(key)} 行指向同一条发现（${key}）`
        + '——同一 id 出现两次，后一行会悄悄覆盖前一行',
        { line: row.lineNo, key, first_line: ledgerSeen.get(key) });
    } else {
      ledgerSeen.set(key, row.lineNo);
    }
    covered.add(key);
    if (row.disposition === 'DEFERRED') deferredKeys.add(key);
    // R9: WONT_FIX 的理由要留到第 6 节做逐条呈现（读者要看得到理由才能判断）。
    if (row.disposition === 'WONT_FIX') wontFixKeys.set(key, String(row.reason ?? ''));
    continue;
  }

  // 规则 · 杜撰
  const near = suggestNear(baseId, raw);
  fail('disposition_without_finding',
    `去向表第 ${row.lineNo} 行 "${raw}" 在产物里找不到对应发现——`
    + `去向表不能凭空多出 id（会掩盖「表填满了但内容是编的」）`
    + (near ? `。最接近的是 ${near}（产物里的 finding_id 可能是裸 id，跨产物会撞名，请写 scope::id）` : ''),
    { line: row.lineNo, raw_id: raw, suggestion: near });
}

/** 对找不到的 id，找一条最接近的真实发现，帮人定位（纯提示）。 */
function suggestNear(baseId, raw) {
  // 1) 裸 id 本身就是真实 id：给出所有候选 key
  if (byBareId.has(baseId)) return byBareId.get(baseId).map((s) => `${s}::${baseId}`).join(' 或 ');
  // 2) raw 以某个真实 id 结尾（R1-core-F2 → F2）
  const cands = [];
  for (const [id, scopes] of byBareId) {
    if (raw.endsWith(id) && id.length >= 2) cands.push(...scopes.map((s) => `${s}::${id}`));
  }
  if (cands.length === 1) return cands[0];
  if (cands.length > 1) return `${cands.length} 条候选: ${cands.join('、')}`;
  return null;
}

// ────────────────────────────────────────────────────────────────────
// 5 · 核心规则：逐条检查「有发现、无 disposition」
// ────────────────────────────────────────────────────────────────────
const unaccounted = [];
for (const [key, f] of findingsByKey) {
  if (covered.has(key)) continue;
  unaccounted.push(f);
  fail('finding_without_disposition',
    `${key}（${f.severity}，${f.file}:${f.line ?? '?'}）没有任何 disposition`
    + '——它从未被表态，也就可能从未被处理',
    { key, finding_id: f.id, file: f.file, severity: f.severity, line: f.line });
}

// ────────────────────────────────────────────────────────────────────
// 6 · 汇总规则：HIGH 被 DEFERRED 或消失，单独醒目警告
//
// 这是「全填 DEFERRED 就能过」的唯一防线：
//   - 覆盖率规则回答「有没有表态」；
//   - 这条回答「表态之后 HIGH 还剩几条悬着」。
// 真实数据里它本应点名 2 条 HIGH（R2-mechanics F3、R3-A A-01），
// 而那 2 条当时确实还在 HEAD 里。
// ────────────────────────────────────────────────────────────────────
const highUnaccounted = [];
for (const [key, f] of findingsByKey) {
  if (f.severity !== 'HIGH') continue;
  const rowKey = key;
  const isDeferred = deferredKeys.has(rowKey);
  const isMissing = !covered.has(rowKey);
  if (isDeferred || isMissing) {
    highUnaccounted.push({ key, severity: f.severity, why: isMissing ? '无 disposition' : 'DEFERRED' });
  }
}

if (highUnaccounted.length > 0) {
  const lvl = ARGS.strictHigh ? 'FAIL' : 'WARN';
  const msg = `${highUnaccounted.length} 条 HIGH 处于 DEFERRED / 无去向：`
    + highUnaccounted.map((h) => `${h.key}（${h.why}）`).join('、')
    + '——HIGH 暂缓不是非法，但必须有人看见；'
    + '全部填 DEFERRED 能让覆盖率 100%，却让最该修的 HIGH 继续留在线上';
  add(lvl, 'high_severity_unaccounted', msg, {
    high_unaccounted: highUnaccounted.length,
    details: highUnaccounted,
  });
}

// ────────────────────────────────────────────────────────────────────
// 6b · HIGH 被判 WONT_FIX —— R9 补的洞（R7 报告 §4 洞 2）
//
// 原判据只认「DEFERRED / 无去向」，于是把 8 条 HIGH 全填 WONT_FIX
// （理由写够 20 字）就能让 high_severity_unaccounted 完全消失，
// --strict-high 也无感——因为规则根本没被触发。
//
// 这里**不**把 WONT_FIX 并进 high_severity_unaccounted，因为两者性质不同：
//   DEFERRED = 承认有缺陷，只是这轮不修（自带一个未来的检查点）
//   WONT_FIX = 主张这不是缺陷（写下去之后，再没有任何动作会回头看它）
// 后者更强，风险更高，所以它需要自己一条规则、自己的措辞，
// 而不是被折叠进「暂缓」的计数里。
//
// 关键设计：逐条列出 finding_id + 理由摘录。只报「N 条」等于把人
// 送回原问题——看见数字不等于看见内容，而判断「理由是否成立」
// 必须读到理由本身。
// ────────────────────────────────────────────────────────────────────
const REASON_EXCERPT_CHARS = 30;

/** 按显示宽度截断（CJK 记 2），让摘录在终端里大致等宽。 */
function excerpt(text, maxChars) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return '（理由为空）';
  const chars = [...s];
  let width = 0;
  let out = '';
  for (const ch of chars) {
    const w = /[\u2E80-\uFFEF]/.test(ch) ? 2 : 1;
    if (width + w > maxChars * 2 - 1) return `${out}…`;
    width += w;
    out += ch;
  }
  return out;
}

const highWontFix = [];
for (const [key, f] of findingsByKey) {
  if (f.severity !== 'HIGH') continue;
  if (!wontFixKeys.has(key)) continue;
  const reason = wontFixKeys.get(key) ?? '';
  const reasonChars = [...reason.replace(/\s+/g, '')].length;
  const hasAnchor = HIGH_WONT_FIX_ANCHOR.test(reason);
  highWontFix.push({ key, finding_id: f.id, file: f.file, line: f.line, reason, reasonChars, hasAnchor });
}

// 6b-1 · HIGH 的 WONT_FIX 本身要看得见（逐条 + 理由摘录）
if (highWontFix.length > 0) {
  const lvl = ARGS.strictHigh ? 'FAIL' : 'WARN';
  const lines = highWontFix.map((h) => `  · ${h.key} —— 「${excerpt(h.reason, REASON_EXCERPT_CHARS)}」`);
  const msg = `${highWontFix.length} 条 HIGH 被判 WONT_FIX（声称不是缺陷）。`
    + '这个判定比 DEFERRED 更强——DEFERRED 说「下轮修」，WONT_FIX 说「不用修」。'
    + '对 HIGH 来说这是最需要第二个人看一眼的结论，而它只靠一段自由文字支撑；'
    + 'DEFERRED 至少还留下一个「什么条件下重新处置」的钩子，WONT_FIX 什么都不留。'
    + '以下几条请逐条确认理由是否成立：\n'
    + lines.join('\n');
  add(lvl, 'high_severity_wont_fix', msg, {
    high_wont_fix: highWontFix.length,
    details: highWontFix.map((h) => ({
      key: h.key, finding_id: h.finding_id, file: h.file, line: h.line,
      reason: h.reason, reason_chars: h.reasonChars, has_anchor: h.hasAnchor,
    })),
  });
}

// 6b-2 · HIGH 的 WONT_FIX 理由是否撑得住（≥40 字 + 一个可复核指涉）
// 只对 HIGH 抬高门槛：MEDIUM/LOW 的 WONT_FIX 沿用 ≥10 字的既有要求。
// 理由见文件头「为什么 HIGH 的 WONT_FIX 要比 MEDIUM/LOW 更严」。
const thinHighWontFix = highWontFix.filter(
  (h) => h.reasonChars < MIN_HIGH_WONT_FIX_CHARS || !h.hasAnchor,
);

if (thinHighWontFix.length > 0) {
  const lvl = ARGS.strictHigh ? 'FAIL' : 'WARN';
  const parts = thinHighWontFix.map((h) => {
    const why = [];
    if (h.reasonChars < MIN_HIGH_WONT_FIX_CHARS) {
      why.push(`仅 ${h.reasonChars} 字（要求 ≥ ${MIN_HIGH_WONT_FIX_CHARS}）`);
    }
    if (!h.hasAnchor) why.push('没有一个可复核指涉（文件路径 / 行号 / 反引号标识符 / #编号）');
    return `${h.key}（${why.join('；')}）`;
  });
  const msg = `${thinHighWontFix.length} 条 HIGH 的 WONT_FIX 理由撑不住：`
    + parts.join('、')
    + '——「这不是缺陷」是一个结论，不是一个解释。'
    + `一条理由若既不到 ${MIN_HIGH_WONT_FIX_CHARS} 字、又指不出任何具体位置，`
    + '读者只能选择相信写的人，无法自己复核；'
    + '这正是「一段 20 字的设计意图可以覆盖任何东西」的形态。'
    + '请补到能让人顺着去查的程度（例如 src/a/B.java:42 中该分支的调用方约定）。'
    + '注意：本规则只提示理由质量，不否定 WONT_FIX 这个处置本身——'
    + '该处置的可见性由 high_severity_wont_fix 单独负责。';
  add(lvl, 'high_wont_fix_reason_thin', msg, {
    high_wont_fix_reason_thin: thinHighWontFix.length,
    details: thinHighWontFix.map((h) => ({
      key: h.key, reason_chars: h.reasonChars, has_anchor: h.hasAnchor,
      min_chars: MIN_HIGH_WONT_FIX_CHARS,
    })),
  });
}

// ────────────────────────────────────────────────────────────────────
// 7 · 输出
// ────────────────────────────────────────────────────────────────────
const counts = problems.reduce((a, p) => { a[p.level] = (a[p.level] ?? 0) + 1; return a; }, {});
const accounted = totalFindings - unaccounted.length;
const sev = findingsByKey.size ? [...findingsByKey.values()].reduce((a, f) => {
  a[f.severity] = (a[f.severity] ?? 0) + 1; return a;
}, {}) : {};

const exitCode = (counts.FAIL ?? 0) > 0 ? 1 : ((counts.CONFIG ?? 0) > 0 ? 2 : 0);
const totals = {
  findings: totalFindings,
  // 产物里实际写的条数。有重复 id 时它会 > findings——
  // 差额就是「因 id 撞车而无法被单独表态」的那些条。
  rawFindings: rawFindingCount,
  accounted,
  unaccounted: unaccounted.length,
  newFindings: newFindingCount,
  high: sev.HIGH ?? 0,
  highUnaccounted: highUnaccounted.length,
  // R9: 与 highUnaccounted 并列，不合并——两者性质不同（见第 6b 节说明）。
  highWontFix: highWontFix.length,
  highWontFixReasonThin: thinHighWontFix.length,
  severity: sev,
};

if (ARGS.json) {
  console.log(JSON.stringify({
    artifacts: ARGS.artifacts,
    ledger: ARGS.ledger,
    ledgerRows: ledgerRows.length,
    totals,
    problems,
    exitCode,
  }, null, 2));
  process.exit(exitCode);
}

console.log('\n=== 发现去向对账 ===\n');
console.log(`  产物目录: ${ARGS.artifacts}`);
console.log(`  去向表:   ${ARGS.ledger}`);
console.log(`  解析产物: ${artifacts.length} 个文件，${totalFindings} 条 finding`
  + `（HIGH ${sev.HIGH ?? 0} / MEDIUM ${sev.MEDIUM ?? 0} / LOW ${sev.LOW ?? 0}）`
  + (rawFindingCount !== totalFindings
    ? `\n  注意:    产物里实际写了 ${rawFindingCount} 条，去重后 ${totalFindings} 条`
      + `——另有 ${rawFindingCount - totalFindings} 条因 finding_id 重复而无法被单独表态`
    : ''));
console.log(`  去向表:   ${ledgerRows.length} 行\n`);

const order = { FAIL: 0, WARN: 1, CONFIG: 2, PASS: 3 };
const tag = { FAIL: '✗', WARN: '!', CONFIG: '✗', PASS: '✓' };
for (const p of [...problems].sort((a, b) => order[a.level] - order[b.level])) {
  console.log(`${tag[p.level]} [${p.rule}] ${p.msg}`);
}

console.log(`\n合计: ${totalFindings} 条 finding / 已表态 ${accounted} / 未表态 ${unaccounted.length}`
  + (newFindingCount ? ` / NEW_FINDING ${newFindingCount}` : ''));
console.log(`合计: ${counts.FAIL ?? 0} FAIL / ${counts.WARN ?? 0} WARN`
  + ` / ${totalFindings - unaccounted.length} PASS\n`);

if (exitCode === 0) {
  // R9: 「没有 HIGH 悬空」这种话不能在有 HIGH 被判 WONT_FIX 时说出口——
  // 那正是 R7 洞 2 的形状：报告全绿，最该看一眼的 8 条 HIGH 一句话被关掉。
  if (highUnaccounted.length > 0 || highWontFix.length > 0) {
    const bits = [];
    if (highUnaccounted.length > 0) bits.push(`${highUnaccounted.length} 条 HIGH 仍未闭合（DEFERRED / 无去向）`);
    if (highWontFix.length > 0) {
      bits.push(`${highWontFix.length} 条 HIGH 被判 WONT_FIX（声称不是缺陷，理由见上）`);
    }
    console.log(`结论：全部 ${totalFindings} 条都已表态，但 ${bits.join('；另有 ')}。`);
    console.log('这些是「已知且被记录」的风险，不再属于「静默丢失」——但收口前应逐条确认。');
    if (highWontFix.length > 0) {
      console.log(`WONT_FIX 的 HIGH 共 ${highWontFix.length} 条，其中 ${thinHighWontFix.length} 条理由撑不住；`
        + '「不是缺陷」是唯一不产生后续工作的处置，请把上面列出的理由逐条读完再放行。\n');
    } else {
      console.log('');
    }
  } else {
    console.log(`结论：全部 ${totalFindings} 条都已表态，且没有 HIGH 悬空。\n`);
  }
} else if (unaccounted.length === 0) {
  // 没有「未表态」，但仍有 FAIL——通常是 --strict-high 把 HIGH 悬空类规则升级上来的。
  console.log('结论：所有 finding 都表态了，但有 FAIL（见上，多半是 --strict-high 下的 HIGH 悬空 / HIGH WONT_FIX）。');
  console.log('覆盖率不是这里的瓶颈——需要处理的是上面点名的那些行。\n');
} else {
  console.log(`结论：${unaccounted.length} 条 finding 从未被表态。`);
  console.log('它们可能从未进入任何任务书——这正是「38 条只修 6 条」丢失的地方。\n');
}
process.exit(exitCode);
