#!/usr/bin/env node
/**
 * check-fix-artifacts-envelope.mjs — 修复产物有没有 JSON 信封（证据链第 1 环的机械闸门）
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * R11（experiments/hilltop-dsh/FIX-R11-report.md §8.2）把证据链写成四环：
 *
 *   产物有没有信封（1） → 有没有人调校验器（2） → 路径存在吗（3）→ 内容对得上主张吗（4）
 *
 * R11 修的是第 3 环（`existsSync`）。但前两环是空的，而**第 1 环空着会让后面全部空转**：
 *
 *   $ grep -c '"schema_version"' experiments/hilltop-dsh/repair/done-*.md
 *   done-1.md:0  done-3.md:0  done-4.md:0  done-6.md:0  done-7.md:0  done-8.md:0
 *
 * 2026-11-15 那次事故的 6 份修复产物**一份都没有信封**。
 * 而 check-payload.mjs 的全部规则都挂在信封上——`role` 取不到时，
 * 除 `no_json_envelope` 外一条都不跑。也就是说：
 *
 *   那一批修复产物从未被任何契约校验器观测过。
 *   「红测日志必须在 target/ 之外」「证据文件必须存在」「disposition 必须表态」
 *   这些规则**在它们身上一次都没执行过**，不是因为它们通过了，是因为没跑。
 *
 * 这不是「格式不规范」。**没有信封 = 无法被任何机械检查观测到 = 未交付。**
 * 所以这个检查器不提供降级：它存在的全部意义就是拒绝这种「看不见的产物」。
 *
 * ── 与 check-payload.mjs 的分工 ──────────────────────────────────────
 *   check-payload   单份产物、逐字段、内容级（信封在内的一切契约）
 *   本脚本          整个目录、只问一件事：**每一份都能被 check-payload 看见吗**
 *
 * 两者不是重复。本脚本是**批量守门**：它回答「这一批产物里，有几份根本进不了
 * check-payload」。补上信封之后再逐份跑 check-payload。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *   node check-fix-artifacts-envelope.mjs --dir <修复产物目录> [--pattern '<glob>'] [--json]
 *
 *   --dir <目录>        必填。修复产物所在目录（不递归）。
 *   --pattern '<glob>'  可选，可重复。默认 `done-*.md` 与 `*-fix-*.md`。
 *                       兼容现有实践：前者是 experiments/hilltop-dsh/repair 的写法，
 *                       后者是 artifacts/report-naming.md 的 round{N}-04-fix-{n}.md。
 *   --json              输出机器可读 JSON。
 *   --help / -h         打印本说明，退出 0。
 *
 * ── 规则 ─────────────────────────────────────────────────────────────
 *   dir_missing                      --dir 不存在 / 不是目录                exit 2
 *   no_fix_artifacts                 pattern 选中 0 个文件                  exit 2
 *                                    （**配置错误，绝不等于通过**）
 *   bad_pattern                      --pattern 为空串                      exit 2
 *   artifact_without_envelope        **核心**：找不到 ```json 信封          FAIL
 *   envelope_invalid                 信封 JSON 解析失败                     FAIL
 *   envelope_wrong_role              信封 role !== "fix"                    FAIL
 *   envelope_missing_disposition     payload 既无 disposition 也无
 *                                    非空 dispositions[]（R3 契约）         FAIL
 *   artifact_name_not_conforming     文件名不符合 *-04-fix-*.md / done-*.md WARN
 *   subdirectory_not_scanned         目录下有子目录（其产物不进分母）      WARN
 *   json_trailing_comma_fixed        原样解析失败、容错后通过              WARN
 *                                    （容错会改动字符串内容，例如 quote 里的 `,}`）
 *
 * 退出码：0 = 全部带信封（允许 WARN） / 1 = 有 FAIL / 2 = 配置错误
 *
 * ── 降级纪律：无 ────────────────────────────────────────────────────
 * 这个检查器**故意**不提供 `--allow-missing-envelope` / `--ignore <glob>`
 * 之类的开关。理由是它要防的正是「我知道它不合规，但我先放它过去」——
 * 那个开关一旦存在，它就会成为默认路径，然后这个脚本就等于不存在。
 *
 * **如果你有意保留无信封的历史产物**（例如 2026-11-15 那一批作为事故证据），
 * 把它们移进子目录，再用 --dir 指向别处：
 *
 *   experiments/hilltop-dsh/repair/            ← 当前产物（必须全部带信封）
 *   experiments/hilltop-dsh/repair/legacy/     ← 历史产物（本脚本不扫，会报 WARN）
 *
 * 这不是「白名单」：子目录里的东西仍然没被观测到，只是把它们从
 * 「本轮交付物」的账上挪到了「历史证据」的账上，并且这个动作会留下 WARN 痕迹。
 * 子目录**不递归扫描**是刻意的——递归会让 legacy/ 里的产物悄悄混回分母。
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROLES_ALLOWED = 'fix';

// ────────────────────────────────────────────────────────────────────
// 参数
// ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { dir: null, patterns: [], json: false, help: false, bad: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') {
      const v = argv[i + 1];
      // 显式给了 flag 却没给值，不能静默忽略——那会让调用方以为检查生效了
      if (v === undefined || v.startsWith('--')) { out.bad = '--dir 需要一个目录参数'; break; }
      out.dir = v; i++;
    } else if (a === '--pattern') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { out.bad = '--pattern 需要一个 glob 参数'; break; }
      if (v.trim() === '') { out.bad = '--pattern 不能为空串'; break; }
      out.patterns.push(v); i++;
    } else if (a === '--json') {
      out.json = true;
    } else if (a === '--help' || a === '-h') {
      out.help = true;
    } else {
      out.bad = `未知参数: ${a}`;
      break;
    }
  }
  return out;
}

const DEFAULT_PATTERNS = ['done-*.md', '*-fix-*.md'];

// 报告名合规线：artifacts/report-naming.md 的 round{N}-04-fix-{n}.md，
// 以及 experiments 里既有的 done-{n}.md。只做 WARN——命名是规范问题，
// 信封才是「能不能被观测」的问题，两者不该共用一个严重性。
const NAME_CONFORMING = /(?:^|-)04-fix-[^/]*\.md$|^done-[^/]*\.md$/i;

const HELP = `
check-fix-artifacts-envelope.mjs — 修复产物有没有 JSON 信封（证据链第 1 环）

没有信封的修复产物 = 无法被 check-payload 观测 = 未交付。
本脚本是全目录级的机械闸门：确认每一份修复产物都能进入契约校验。

用法:
  node check-fix-artifacts-envelope.mjs --dir <修复产物目录> [--pattern '<glob>'] [--json]

参数:
  --dir <目录>        必填。修复产物所在目录（**不递归**）。
  --pattern '<glob>'  可选，可重复。默认: ${DEFAULT_PATTERNS.map((p) => `'${p}'`).join(' ')}
                      - done-*.md        experiments/<round>/repair/ 的现有实践
                      - *-fix-*.md       round{N}-04-fix-{n}.md 的规范命名
                      可用多次，例如 --pattern 'a-*.md' --pattern 'b-*.md'
  --json              输出机器可读 JSON
  --help, -h          显示本说明

为什么「空目录」是 exit 2 而不是通过:
  pattern 选中 0 个文件时，「每份都有信封」在逻辑上为真——这是本框架最反复
  出现的失败模式（vacuously true）。配置错误必须与通过严格区分。

如果你有意保留无信封的历史产物:
  本脚本**没有**任何「忽略某份产物」的开关，而且刻意不提供。
  正确做法是把历史产物移进子目录，再用 --dir 指向别处：
      <dir>/              ← 本轮产物，必须全部带信封
      <dir>/legacy/       ← 历史产物，本脚本不扫（会报 subdirectory_not_scanned WARN）
  子目录不递归是刻意的：递归会让 legacy/ 里的产物悄悄混回分母。

规则:
  dir_missing                     --dir 不存在 / 不是目录                  exit 2
  no_fix_artifacts                pattern 选中 0 个文件                    exit 2
  artifact_without_envelope       找不到 \`\`\`json 信封                      FAIL
  envelope_invalid                信封 JSON 解析失败                       FAIL
  envelope_wrong_role             role 不是 "fix"                          FAIL
  envelope_missing_disposition    payload 无 disposition（复用 R3 契约）   FAIL
  artifact_name_not_conforming           文件名不符合 *-04-fix-*.md / done-*.md   WARN
  subdirectory_not_scanned        目录下有子目录（不进分母）               WARN
  json_trailing_comma_fixed       容错解析生效（会改动字符串内容）         WARN

退出码: 0 = 全部带信封（允许 WARN） / 1 = 有 FAIL / 2 = 配置错误
`;

const ARGS = parseArgs(process.argv);

const problems = [];
const add = (level, rule, msg, extra = {}) => {
  const p = { level, rule, msg, ...extra };
  problems.push(p);
  return p;
};
const fail = (rule, msg, extra) => add('FAIL', rule, msg, extra);
const warn = (rule, msg, extra) => add('WARN', rule, msg, extra);

/** 配置错误：打印后直接 exit 2，绝不允许降级成「全部合规」。 */
function configError(rule, msg, extra = {}) {
  add('CONFIG', rule, msg, extra);
  emit(null, 2);
  process.exit(2);
}

function emit(artifacts, exitCode) {
  const totals = {
    artifacts: artifacts?.length ?? 0,
    fail: problems.filter((p) => p.level === 'FAIL').length,
    warn: problems.filter((p) => p.level === 'WARN').length,
  };
  if (ARGS.json) {
    console.log(JSON.stringify({
      dir: ARGS.dir,
      patterns: ARGS.patterns.length ? ARGS.patterns : DEFAULT_PATTERNS,
      totals,
      artifacts,
      problems,
      exitCode,
    }, null, 2));
    return;
  }

  console.log('');
  console.log(`修复产物信封闸门 — ${ARGS.dir}`);
  console.log(`pattern: ${(ARGS.patterns.length ? ARGS.patterns : DEFAULT_PATTERNS).join(' ')}`);
  console.log('');

  if (artifacts) {
    for (const a of artifacts) {
      const bad = a.rules.filter((r) => r.level === 'FAIL');
      const wn = a.rules.filter((r) => r.level === 'WARN');
      const mark = bad.length ? '✗' : wn.length ? '!' : '✓';
      console.log(`  ${mark} ${a.file}`);
      for (const r of a.rules) {
        console.log(`      [${r.level}] ${r.rule}: ${r.msg}`);
      }
    }
    if (artifacts.length) console.log('');
  }

  for (const p of problems.filter((x) => x.level === 'CONFIG')) {
    console.error(`[配置错误] ${p.rule}: ${p.msg}`);
  }

  const fails = problems.filter((p) => p.level === 'FAIL');
  const warns = problems.filter((p) => p.level === 'WARN');
  console.log(`结果: ${totals.artifacts} 份产物 / ${totals.fail} FAIL / ${totals.warn} WARN`);
  if (fails.length) {
    console.log('');
    console.log('没有信封的修复产物 = 无法被 check-payload 观测 = 未交付。');
    console.log('补法：在文件末尾追加一个 ```json 代码块，内容见 components/output-contract.md §1，');
    console.log('然后重跑: node tools/check-payload.mjs <该产物> --role fix --repo <被审仓库>');
  }
  console.log('');
}

// ────────────────────────────────────────────────────────────────────
// 0 · 参数与目录检查
// ────────────────────────────────────────────────────────────────────
if (ARGS.help) { console.log(HELP); process.exit(0); }
if (ARGS.bad) {
  console.error(`${ARGS.bad}\n${HELP}`);
  process.exit(2);
}
if (!ARGS.dir) {
  console.error(`缺少必填参数 --dir。\n${HELP}`);
  process.exit(2);
}

if (!existsSync(ARGS.dir)) {
  configError('dir_missing', `产物目录不存在: ${ARGS.dir}`);
}
if (!statSync(ARGS.dir).isDirectory()) {
  configError('dir_missing', `--dir 不是目录: ${ARGS.dir}`);
}

// ────────────────────────────────────────────────────────────────────
// 1 · glob → 正则（只支持 * 与 ?，够用且不会误吞路径分隔符）
// ────────────────────────────────────────────────────────────────────
function globToRe(glob) {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${esc}$`, 'i');
}

const patterns = (ARGS.patterns.length ? ARGS.patterns : DEFAULT_PATTERNS).map(globToRe);

// ────────────────────────────────────────────────────────────────────
// 2 · 列举产物（不递归）
// ────────────────────────────────────────────────────────────────────
const entries = readdirSync(ARGS.dir, { withFileTypes: true });
const subdirs = entries.filter((d) => d.isDirectory()).map((d) => d.name).sort();
const files = entries
  .filter((d) => d.isFile() && patterns.some((re) => re.test(d.name)))
  .map((d) => d.name)
  .sort();

if (subdirs.length > 0) {
  warn('subdirectory_not_scanned',
    `${ARGS.dir} 下有子目录（${subdirs.slice(0, 6).join('、')}${subdirs.length > 6 ? ' …' : ''}）——`
    + '其中的产物没有被本脚本扫描、也不进分母。'
    + '若那是你刻意保留的无信封历史产物，这个 WARN 就是它的痕迹；'
    + '若那是本轮产物，请摊平到 --dir 指向的同一层');
}

if (files.length === 0) {
  configError('no_fix_artifacts',
    `在 ${ARGS.dir} 下，pattern（${(ARGS.patterns.length ? ARGS.patterns : DEFAULT_PATTERNS).join(' ')}）`
    + ' 选中 0 个文件。「每份都有信封」在 0 份上恒为真——这是配置错误，不是通过。'
    + '检查 --dir 是否指错，或用 --pattern 显式指定文件名规则');
}

// ────────────────────────────────────────────────────────────────────
// 3 · 逐份解析信封
// ────────────────────────────────────────────────────────────────────
/**
 * 取信封块。与 check-payload.mjs 的取值口径保持一致：
 *   从后往前找第一个「看起来是信封」的块（含 schema_version 或 role），
 *   都不像信封时退回最后一个可解析的块。
 * 不一致会让两个工具对同一份产物给出不同结论，那比两个都报错更糟。
 */
function pickEnvelopeBlock(text) {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (blocks.length === 0) return { ok: false, reason: 'no_envelope', count: 0 };
  const looksLikeEnvelope = (s) => /"schema_version"\s*:/.test(s) || /"role"\s*:/.test(s);
  let idx = -1;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (looksLikeEnvelope(blocks[i])) { idx = i; break; }
  }
  // 没有一块「像」信封 = 这些都只是正文里的示例 JSON，不是信封。
  // 这一点与 check-payload 不同：它退回最后一个块再解析（能让更多产物过门），
  // 而本脚本的职责是判定「有没有信封」，示例块不算信封。
  if (idx < 0) return { ok: false, reason: 'no_envelope', count: blocks.length };
  return { ok: true, raw: blocks[idx], count: blocks.length };
}

/** disposition 判据：单发现形态看 payload.disposition，多发现形态看 dispositions[]。 */
function hasDisposition(payload) {
  if (!payload || typeof payload !== 'object') return { ok: false, why: 'payload 缺失或不是对象' };
  if (Array.isArray(payload.dispositions) && payload.dispositions.length > 0) {
    const missing = payload.dispositions
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => !d || typeof d !== 'object' || d.disposition === undefined || d.disposition === null || d.disposition === '');
    if (missing.length) {
      return { ok: false, why: `dispositions[] 中有 ${missing.length} 条缺 disposition（下标 ${missing.map((m) => m.i).join(', ')}）` };
    }
    return { ok: true, why: `dispositions[] 共 ${payload.dispositions.length} 条` };
  }
  if (payload.disposition !== undefined && payload.disposition !== null && payload.disposition !== '') {
    return { ok: true, why: `disposition=${payload.disposition}` };
  }
  if (Array.isArray(payload.dispositions) && payload.dispositions.length === 0) {
    return { ok: false, why: 'dispositions 是空数组——一条都没表态，不是「多发现形态」' };
  }
  return { ok: false, why: 'payload 里既没有 disposition，也没有非空的 dispositions[]' };
}

const artifacts = [];

for (const file of files) {
  const p = join(ARGS.dir, file);
  const rules = [];
  const rFail = (rule, msg) => { rules.push({ level: 'FAIL', rule, msg }); fail(rule, msg, { file }); };
  const rWarn = (rule, msg) => { rules.push({ level: 'WARN', rule, msg }); warn(rule, msg, { file }); };

  const text = readFileSync(p, 'utf8');
  const picked = pickEnvelopeBlock(text);

  // 3.1 核心规则：必须有信封
  if (!picked.ok) {
    rFail('artifact_without_envelope',
      picked.count > 0
        ? `有 ${picked.count} 个 json 代码块，但没有一个含 schema_version / role——`
          + '它们只是正文里的示例数据，不是信封。check-payload 看不到任何可校验的字段'
        : '整个文件没有任何 ```json 代码块。**这不是「格式不规范」，是「无法被任何机械检查观测到」**——'
          + 'check-payload 的全部规则（含「红测日志必须在 target/ 之外」「证据文件必须存在」）在这份产物上一次都不会跑');
  } else {
    // 3.2 信封必须可解析。先按原样解析，原样能解析就绝不改写。
    let env = null;
    let parseErr = null;
    try {
      env = JSON.parse(picked.raw);
    } catch (e) {
      parseErr = e;
      const tolerant = picked.raw.replace(/,(\s*[}\]])/g, '$1');
      if (tolerant !== picked.raw) {
        try {
          env = JSON.parse(tolerant);
          // 容错会改动字符串内的内容（例如 quote 里的 `,}` 变成 `}`），
          // 必须留痕：否则这份产物不能再说自己的 quote 是逐字原文。
          rWarn('json_trailing_comma_fixed',
            '原样 JSON 无法解析，已自动修复尾随逗号后通过。该修复会改动字符串内的内容，'
            + '本产物的 quote 不能视为「逐字原文」——请让 agent 输出合法 JSON');
        } catch {
          env = null;
        }
      }
    }

    if (env === null) {
      rFail('envelope_invalid', `信封 JSON 解析失败: ${parseErr?.message ?? '未知'}（共 ${picked.count} 个 json 块）`);
    } else if (typeof env !== 'object' || Array.isArray(env)) {
      rFail('envelope_invalid',
        `信封必须是 JSON 对象，实际是 ${Array.isArray(env) ? 'array' : typeof env}: ${JSON.stringify(env).slice(0, 80)}`);
    } else {
      // 3.3 role
      if (env.role !== 'fix') {
        rFail('envelope_wrong_role',
          `修复产物的信封 role 必须是 "${ROLES_ALLOWED}"，实际是 ${JSON.stringify(env.role)}。`
          + 'role 错了会让 check-payload 走错分支——它按 fix 分支应该校验的 disposition / red_log_path '
          + '一条都不会跑，而表面上「有信封、解析成功」');
      }

      // 3.4 disposition（复用 R3 的契约）
      const disp = hasDisposition(env.payload);
      if (!disp.ok) {
        rFail('envelope_missing_disposition',
          `${disp.why}。R3 契约要求每条发现都有一个去向（FIXED | WONT_FIX | DEFERRED | NEW_FINDING）——`
          + '缺它等于「这条发现有没有被修」在机械上不可判');
      }
    }
  }

  // 3.5 命名规范（WARN；信封才是硬问题）
  if (!NAME_CONFORMING.test(file)) {
    rWarn('artifact_name_not_conforming',
      `文件名不符合 *-04-fix-*.md 或 done-*.md（实际 ${file}）。`
      + '若这是被其他 pattern 一起扫进来的非修复产物，用 --pattern 收窄');
  }

  artifacts.push({ file, rules });
}

// ────────────────────────────────────────────────────────────────────
// 4 · 汇总
// ────────────────────────────────────────────────────────────────────
const hasFail = problems.some((p) => p.level === 'FAIL');
const exitCode = hasFail ? 1 : 0;

emit(artifacts, exitCode);

if (!ARGS.json) {
  const without = artifacts.filter((a) => a.rules.some((r) => r.rule === 'artifact_without_envelope'));
  if (without.length) {
    console.log(`其中 ${without.length} 份没有信封: ${without.map((a) => a.file).join(', ')}`);
    console.log('');
  }
}

process.exit(exitCode);
