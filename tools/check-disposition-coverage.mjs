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
 *   --strict-high  把 `high_severity_unaccounted` 从 WARN 升级为 FAIL。
 *                  默认是 WARN，因为 DEFERRED 有时确实是正确决定；
 *                  但「全填 DEFERRED」能骗过默认模式，交付闸门应当开这个开关。
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
 *               FIXED 建议写修复编号或 commit；NEW_FINDING 必须能用它追溯到来源。
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
 *
 * 退出码：0 = 全部表态（允许 WARN） / 1 = 有覆盖率问题 / 2 = 配置错误
 *
 * ── 它不检查什么 ─────────────────────────────────────────────────────
 *   disposition 填得对不对（DEFERRED 的理由是否成立、FIXED 是否真有测试）——
 *   那要读代码和测试，脚本不碰。本脚本只保证「没有一条静默消失」。
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const DISPOSITIONS = ['FIXED', 'WONT_FIX', 'DEFERRED', 'NEW_FINDING'];
const REASON_REQUIRED = new Set(['WONT_FIX', 'DEFERRED']);
const MIN_REASON_CHARS = 10;

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
  --strict-high  把 high_severity_unaccounted 从 WARN 升级为 FAIL（交付闸门应开启）
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

const mdFiles = readdirSync(ARGS.artifacts)
  .filter((f) => /\.(md|markdown)$/i.test(f))
  .sort();

if (mdFiles.length === 0) {
  configError('artifacts_missing', `产物目录里没有任何 .md: ${ARGS.artifacts}`);
}

// 子目录里的产物不会被 readdirSync 的顶层列举看到，于是它们既没进分母、
// 也没触发 artifact_without_envelope——整份产物凭空消失，覆盖率照样 100%。
// 真实场景：产物按轮次分目录（out/round1/、out/round2/）。这时应当把
// --artifacts 指向共同的父目录并保持扁平，或一次一个目录地跑并汇总。
const subdirs = readdirSync(ARGS.artifacts, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);
if (subdirs.length > 0) {
  configError('artifacts_contain_subdirectories',
    `${ARGS.artifacts} 下有子目录（${subdirs.slice(0, 6).join('、')}${subdirs.length > 6 ? ' …' : ''}）`
    + '——子目录里的产物不会进分母，等于凭空白名单。'
    + '请对每个产物目录分别跑一次，或把产物摊平到同一层');
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
    if (payload && Array.isArray(payload.findings)) {
      return { ok: true, envelope: j, payload, blockIndex: i };
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
    if (r.reason === 'no_findings') {
      configError('artifact_without_findings',
        `${file} 的信封里没有 payload.findings[]，无法作为对账分母`, { file });
    }
    configError('artifact_without_envelope',
      `${file} 里找不到 \`\`\`json 信封。本目录下的每个 .md 都必须是审计产物`
      + '（或把它移出 --artifacts 目录），否则未解析的产物等于凭空消失', { file });
  }
  artifacts.push({
    file,
    scope: scopeOf(file),
    agentId: r.envelope?.agent_id ?? null,
    findings: r.payload.findings,
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
  if (highUnaccounted.length > 0) {
    console.log(`结论：全部 ${totalFindings} 条都已表态，但 ${highUnaccounted.length} 条 HIGH 仍未闭合（见上）。`);
    console.log('这些是「已知且被记录」的风险，不再属于「静默丢失」——但收口前应逐条确认。\n');
  } else {
    console.log(`结论：全部 ${totalFindings} 条都已表态，且没有 HIGH 悬空。\n`);
  }
} else if (unaccounted.length === 0) {
  // 没有「未表态」，但仍有 FAIL——通常是 --strict-high 把 HIGH 悬空升级上来的。
  console.log('结论：所有 finding 都表态了，但有 FAIL（见上，多半是 --strict-high 下的 HIGH 悬空）。');
  console.log('覆盖率不是这里的瓶颈——需要处理的是上面点名的那些行。\n');
} else {
  console.log(`结论：${unaccounted.length} 条 finding 从未被表态。`);
  console.log('它们可能从未进入任何任务书——这正是「38 条只修 6 条」丢失的地方。\n');
}
process.exit(exitCode);
