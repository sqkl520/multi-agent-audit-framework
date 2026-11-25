#!/usr/bin/env node
/**
 * check-repo.mjs — 把能对**本仓库自己**跑的校验器跑一遍
 *
 * ── 为什么需要（2026-11-24 实测）────────────────────────────────────
 *
 * `check-all` 的条目里绝大多数是 `.test.mjs`。也就是说：对其中十几个校验器，
 * CI 只跑了它们的**自测**——在临时目录里造合成数据，验证「判定逻辑本身对不对」，
 * **从来没有对着这个仓库跑过一次**。
 *
 * 这不是理论风险，有两条实测证据：
 *
 *   1. `check-doc-counts` 修好接线前，报出 **14 处过期数字**（套件数 52 vs 实际 53、
 *      出口率 22.1% vs 22.4%），exit 1。它的自测一直绿，CI 也一直绿。
 *   2. 2026-11-24 新加的 `check-fixture-portability` 犯了同一个错：
 *      往 check-all 里接的是它的 `.test.mjs`，检查器本身从未扫过真实仓库。
 *
 * 「自测绿」和「仓库干净」是两个命题。这个文件补的是第二个。
 *
 * ── 判据（2026-11-25 重写：第一版被锐评打穿了）──────────────────────
 *
 *   上一版：TARGETS 列要跑的，SKIPPED 列「需要运行时输入」的，理由 ≥10 字即可。
 *   锐评实测它有三个洞：
 *
 *     C1  把任何校验器从 TARGETS 挪进 SKIPPED、编一句 22 字的理由，
 *         `check-repo` 与 `check-test-registration` **同时变绿**——
 *         这轮改动要解决的那个错误可以一行复活。
 *     C2  自测里断言「TARGETS 至少 8 个」，12 → 8 可以无声消失 4 个。
 *     C3  「被别的工具引用」按裸子串判定，于是**注释里提到**也算接线：
 *         `check-contract-slices` 与 `check-suite-vitality` 都是靠注释被判绿的。
 *
 *   现在的判据不再依赖「人写的理由」：
 *
 *     R1  **不跑就红**。SKIPPED 的每一条都真的执行一次（不带参数），
 *         必须 exit 2 并且报出用法 —— 这就机械证明了「它确实需要运行时输入」。
 *         一个其实能在本仓库跑通的校验器，不会在无参数时 exit 2，
 *         于是藏进 SKIPPED 会当场失败。
 *
 *     R2  **分母不许悄悄变小**。TARGETS 的脚本清单被钉进
 *         `fixtures/repo-targets-baseline.json`，与基线不一致 → exit 2。
 *         减一个要显式改基线文件，那次改动会出现在 diff 里。
 *
 *     R3  **例外必须点名**。`EXEMPT_NO_ARG_FAIL` 是「无参数时不 exit 2」的白名单，
 *         每条必须给理由，且 SKIPPED 里必须包含它 —— 防止把 R1 变成「谁都报 skip」。
 *
 *     R4  **只信退出码，但要交叉核对输出**。exit 0 但输出里有 `✗` / `FAIL`
 *         → 判失败。`fixtures/contract-probe/run.mjs` 就是这么绿了很久的。
 *
 * ── 不检查什么 ──────────────────────────────────────────────────────
 *
 *   需要真实运行现场才能有意义的校验器（会话日志、某轮的产物目录）不跑。
 *   但 R1 会验证它们**确实**是无参数不可跑的，不是我们懒得接。
 *
 * 用法：node check-repo.mjs [--json]
 * 退出码：0 全部通过 / 1 有校验器失败 / 2 配置错误
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const jsonOut = process.argv.includes('--json');
const BASELINE = join(HERE, 'fixtures', 'repo-targets-baseline.json');

// ── 能对真实仓库跑的校验器 ──
const TARGETS = [
  { script: 'check-doc-counts.mjs',            args: [],            why: '文档里写死的数字 vs 代码实际' },
  { script: 'check-doc-paths.mjs',             args: [],            why: '文档引用的仓库内路径是否还可达' },
  { script: 'check-rule-doc-link.mjs',         args: [],            why: '每条校验器规则是否在契约里有落点' },
  { script: 'check-wrapper-contract.mjs',      args: [],            why: '7 个角色 wrapper 是否覆盖必填字段' },
  { script: 'check-enum-consistency.mjs',      args: [],            why: '枚举闭集在四处副本间是否一致' },
  { script: 'check-contract-examples.mjs',     args: [],            why: '契约示例能否通过校验器（照抄即合规）' },
  { script: 'check-contract-slice-fidelity.mjs', args: [],          why: '契约拆分后是否丢字段' },
  { script: 'check-contract-slices.mjs',       args: [],            why: '每份切片是否含该角色的全部必填字段' },
  { script: 'check-gate-doc-sync.mjs',         args: [],            why: 'gate.mjs 参数 vs protocol.md 示例' },
  { script: 'check-pattern-coverage.mjs',      args: [],            why: 'GT 缺陷是否都有模式归属' },
  { script: 'check-fixture-portability.mjs',   args: [],            why: '夹具里有没有写死本机绝对路径' },
  { script: 'check-promises.mjs',              args: ['tools'],     why: 'tools/ 的 JSDoc 承诺是否兑现' },
  { script: 'lint-terminology.mjs',            args: [],            why: '同一概念是否只有一个写法' },
];

// ── 需要真实运行现场的，必须**机械证明**它确实跑不了 ──
//
// 每条都会被不带参数跑一次，必须 exit 2。理由只用来给人读，不作为放行依据。
const SKIPPED = [
  { script: 'check-concurrency-cap.mjs',   reason: '需要 --sessions（dsh 会话日志）；本仓库没有某次真实运行的日志' },
  { script: 'check-handoff.mjs',           reason: '需要 <packet.json>；由 gate.mjs --gate close --packet 调用（2026-11-25 接线前它不在任何门上）' },
  { script: 'check-deliverables.mjs',      reason: '需要 --round-dir；本仓库的 experiments/ 快照是历史产物，跑出来红在占位符上，不是本仓库的缺陷' },
  { script: 'check-state.mjs',             reason: '需要 <state.json>；仓库里唯一的 state.json 是 experiments/ 下的历史快照，target_repo 仍是占位符' },
  { script: 'check-payload.mjs',           reason: '需要 <产物文件> --role <角色>；由 gate.mjs accept 门在真实返回上调用' },
  { script: 'verify-artifacts.mjs',        reason: '需要 --repo + --artifacts；由 gate.mjs accept 门在真实返回上调用' },
  { script: 'check-disposition-coverage.mjs', reason: '需要 --artifacts + --ledger；由 gate.mjs close 门调用' },
  { script: 'check-fix-instances.mjs',     reason: '需要 --state + --report；由 gate.mjs close 门调用' },
  { script: 'check-fix-instances-harness.mjs', reason: '需要 --state + --sessions；运行时对账' },
  { script: 'check-files-touched-harness.mjs', reason: '需要 --state + dsh session 日志；运行时对账' },
  { script: 'check-fix-artifacts-envelope.mjs', reason: '需要 --dir 指向 fix 产物目录；运行时产物' },
  { script: 'verify-postfix-snapshot.mjs', reason: '需要 --repo + --snapshot；运行时产物' },
  { script: 'check-blindspots.mjs',        reason: '需要 <目录> 指向被审代码；对本仓库 tools/ 跑会命中 27 条「返回内部引用」类命中（那是被审对象的模式，不是本仓库的缺陷）' },
  { script: 'check-round-detection.mjs',   reason: '需要 --dir；本仓库没有 round{N} 目录，跑出来恒为「第 1 轮」，证明不了任何事' },
  { script: 'check-plan.mjs',              reason: '需要 <plan.md>；计划文件在运行时产生' },
  { script: 'dsh-driver.mjs',              reason: '需要 --patch 与真实 dsh 可执行文件' },
  { script: 'dsh-run-guard.mjs',           reason: '需要 --artifacts + --sessions；运行时' },
  { script: 'dsh-session-audit.mjs',       reason: '需要 --sessions；运行时' },
  { script: 'agent-status.mjs',            reason: '需要 --artifact；运行时产物' },
  { script: 'attempt-ledger.mjs',          reason: '需要 --ledger + --payload；运行时账本' },
  { script: 'classify-failures.mjs',       reason: '需要 --state；运行时账本' },
  { script: 'gate.mjs',                    reason: '需要 --gate + 各门参数；由运行流程调用' },
  { script: 'stop-hook.mjs',               reason: 'Stop hook，需要 --state 且从 stdin 读上下文' },
  { script: 'check-round-chain-live.mjs',  reason: '需要 <state.json>；仓库里唯一的 state.json 是历史快照，且它无参数时 exit 0（见 EXEMPT_NO_ARG_FAIL）' },
];

// ── 只能人工按需跑的：必须跑一个**受限切片**证明它还能工作 ──
//
// check-suite-vitality 全量要十几分钟，不可能每次提交跑。但它确实存在、确实能用，
// 只是没进 CI——这是**已知缺口**，不是「需要运行时输入」。
//
// 分类要诚实：写进 SKIPPED 会被 R1 判红（它无参数时不会 exit 2，而是跑满全程），
// 所以单列一类，并且必须用 boundedArgs 跑通一次。
const MANUAL_ONLY = [
  {
    script: 'check-suite-vitality.mjs',
    boundedArgs: ['--only', 'check-doc-counts', '--max-mutants', '1'],
    reason: '全量变异十几分钟，不适合每次提交跑。CI 里跑的是 check-suite-vitality.test.mjs（8 条，'
      + '验「能抓到存活变异」这个能力本身）。这里用最小切片证明它还能工作',
  },
  {
    script: 'detect-harness.mjs',
    boundedArgs: [],
    noArgsIsBounded: true,   // 无参数就是完整一轮（它只打印，不跑长任务）
    reason: '探测运行环境并打印，不做判定——结果取决于跑它的机器，不是仓库的属性。'
      + '但它确实从没在任何路径上跑过（R4 实测），所以至少跑一次证明它没坏',
  },
];

// ── R3：无参数时不 exit 2 的例外，必须点名并说明 ──
const EXEMPT_NO_ARG_FAIL = [
  { script: 'check-round-chain-live.mjs',
    reason: '无参数时它什么都不分析、直接 exit 0（脚本自己没写用法守卫）。这是它的缺陷，'
      + '但补守卫属于改它的行为，不在本轮范围；列在这里是为了让 R1 不把它当成「能跑」' },
  { script: 'stop-hook.mjs',
    reason: '这是 Stop hook，由 harness 在回合结束时调用。没有 --state 时它**故意** exit 0：'
      + '文件头写明「没有账本就无法判断——不阻断（宁可不拦，也不要误拦）」。'
      + '这个「不拦」是设计决定，不是缺守卫' },
];

// ── R4：输出里出现失败标记 → 仍判失败 ──
//
// 这个仓库踩过一次：`fixtures/contract-probe/run.mjs` 结尾写 `process.exit(0)`，
// 于是 CI 上稳定打印「2 个不符」而 check-all 一直绿。
//
// 2026-11-25 锐评指出：光看输出也不够——`check-handoff` 在**用法错误**时
// 也打印「✗ 3 项违规」（它把 usage 当成一条错误），于是「输出有 ✗」这一条
// 会把「根本没跑起来」误判成「跑了且失败」。所以判据分两半：
//
//   exit≠0                     → 失败（不管输出说什么）
//   exit=0 且输出含失败标记     → 失败（校验器自己说有问题却退 0）
//
// 反过来「exit=2 + 输出有 ✗」是正常的用法错误形态，不额外判罚。
const FAIL_MARKERS = /(^|\n)\s*(✗|FAIL\b)/;

// ── --write-baseline：显式更新分母基线 ──
if (process.argv.includes('--write-baseline')) {
  mkdirSync(dirname(BASELINE), { recursive: true });
  writeFileSync(BASELINE, JSON.stringify({
    note: 'check-repo.mjs 的 TARGETS 分母基线。改动 TARGETS 必须同步这里——'
      + '否则「把某个校验器从真实仓库自检里摘掉」会悄无声息地发生（见 check-repo.mjs 的 R2）',
    targets: TARGETS.map((t) => t.script).sort(),
  }, null, 2) + '\n');
  console.log(`已写入基线: ${BASELINE}（${TARGETS.length} 个目标）`);
  process.exit(0);
}

// ── 理由长度：按「信息量」而不是字符数 ──
//
// 2026-11-25 锐评实测：原来的 `reason.length < 10` 对中文天然不友好——
// 「需要运行时输入」（7 个汉字，意思完整）被拒，10 个 `a` 通过。
// 这个仓库是中文的，门槛必须按信息量算：汉字一个字算 2，ASCII 算 1。
//
// 注意：理由现在**不是放行依据**了（R1 会机械验证「无参数确实 exit 2」），
// 它只给人读。所以门槛只要能挡住「两个字敷衍」就够了，不必再严。
const infoLen = (s) => [...String(s ?? '')]
  .reduce((n, ch) => n + (/[一-鿿　-〿＀-￯]/.test(ch) ? 2 : 1), 0);
const REASON_MIN = 10;

// ────────────────────────────────────────────────────────────────
// 配置校验：跳过项必须有理由，且脚本必须存在
// ────────────────────────────────────────────────────────────────
const configErrors = [];
for (const m of MANUAL_ONLY) {
  if (infoLen(m.reason) < REASON_MIN) configErrors.push(`MANUAL_ONLY 里 ${m.script} 的理由太短（信息量 ${infoLen(m.reason)} < ${REASON_MIN}）`);
  if (!Array.isArray(m.boundedArgs)) {
    configErrors.push(`MANUAL_ONLY 里 ${m.script} 的 boundedArgs 不是数组`);
  } else if (m.boundedArgs.length === 0 && !m.noArgsIsBounded) {
    configErrors.push(`MANUAL_ONLY 里 ${m.script} 的 boundedArgs 为空——那等于跑全量，会卡住 CI`
      + '（若它的无参数运行本来就是有限的一次，显式写 noArgsIsBounded: true）');
  }
  if (!existsSync(join(HERE, m.script))) configErrors.push(`MANUAL_ONLY 里列了 ${m.script}，但该文件不存在`);
}

for (const s of SKIPPED) {
  if (infoLen(s.reason) < REASON_MIN) {
    configErrors.push(`SKIPPED 里 ${s.script} 的理由太短（信息量 ${infoLen(s.reason)} < ${REASON_MIN}）`);
  }
  if (!existsSync(join(HERE, s.script))) {
    configErrors.push(`SKIPPED 里列了 ${s.script}，但该文件不存在（多半是改名后忘了同步）`);
  }
}
for (const t of TARGETS) {
  // M7：TARGETS 也要存在性校验。写错一个字母时，execFileSync 抛 ENOENT、status 为 null，
  // 落成「exit=1 + 空 tail」，读起来像校验器失败，其实是配置写错了。
  if (!existsSync(join(HERE, t.script))) {
    configErrors.push(`TARGETS 里列了 ${t.script}，但该文件不存在`);
  }
}
if (TARGETS.length === 0) configErrors.push('TARGETS 为空——一份都没跑，不能算通过');

const targetNames = new Set(TARGETS.map((t) => t.script));
const skippedNames = new Set(SKIPPED.map((s) => s.script));
for (const s of SKIPPED) {
  if (targetNames.has(s.script)) configErrors.push(`${s.script} 同时在 TARGETS 和 SKIPPED 里——自相矛盾`);
}
for (const e of EXEMPT_NO_ARG_FAIL) {
  if (!skippedNames.has(e.script)) {
    configErrors.push(`EXEMPT_NO_ARG_FAIL 里的 ${e.script} 不在 SKIPPED 里——豁免只能给被判为「需要运行时输入」的脚本`);
  }
  if (infoLen(e.reason) < REASON_MIN) {
    configErrors.push(`EXEMPT_NO_ARG_FAIL 里 ${e.script} 的理由太短（信息量 ${infoLen(e.reason)} < ${REASON_MIN}）`);
  }
}

// R2：分母不许悄悄变小
if (!existsSync(BASELINE)) {
  configErrors.push(`缺少基线 ${BASELINE}——用 --write-baseline 生成；没有基线就没有「分母没变小」的证据`);
} else {
  let base;
  try { base = JSON.parse(readFileSync(BASELINE, 'utf8')); }
  catch (e) { configErrors.push(`基线解析失败: ${e.message}`); }
  if (base) {
    const now = TARGETS.map((t) => t.script).sort();
    const was = [...(base.targets ?? [])].sort();
    const removed = was.filter((s) => !now.includes(s));
    const added = now.filter((s) => !was.includes(s));
    if (removed.length || added.length) {
      configErrors.push(
        `TARGETS 与基线不一致（基线 ${was.length} 个，现在 ${now.length} 个）`
        + (removed.length ? `；被移出: ${removed.join(', ')}` : '')
        + (added.length ? `；新增: ${added.join(', ')}` : '')
        + '。改动分母必须显式更新 fixtures/repo-targets-baseline.json——'
        + '否则「少接一个校验器」会悄无声息地发生',
      );
    }
  }
}

if (configErrors.length > 0) {
  if (jsonOut) console.log(JSON.stringify({ ok: false, configErrors }, null, 2));
  else {
    console.error('\n[配置错误]');
    for (const e of configErrors) console.error(`  ✗ ${e}`);
    console.error('');
  }
  process.exit(2);
}

// ────────────────────────────────────────────────────────────────
// R1：SKIPPED 的每一条都必须「无参数 exit 2」——机械证明它确实跑不了
// ────────────────────────────────────────────────────────────────
const exempt = new Set(EXEMPT_NO_ARG_FAIL.map((e) => e.script));
const noArgResults = [];
for (const s of SKIPPED) {
  if (exempt.has(s.script)) {
    noArgResults.push({ script: s.script, code: null, exempt: true, ok: true });
    continue;
  }
  const p = join(HERE, s.script);
  const r = spawnSync(process.execPath, [p], {
    cwd: ROOT, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  // exit 2 = 「用法错误」是本仓库的统一约定（各脚本文件头都这么写）
  const ok = r.status === 2 && /用法|usage|必须给|缺少必填参数|需要 --?[a-z]|不存在|目录/i.test(out);
  noArgResults.push({ script: s.script, code: r.status, exempt: false, ok, tail: out.trim().split('\n').slice(0, 3) });
}

const r1Failed = noArgResults.filter((r) => !r.ok);

// ────────────────────────────────────────────────────────────────
// 执行 TARGETS
// ────────────────────────────────────────────────────────────────
// cwd 设为仓库根：若干校验器的参数是相对路径（如 check-promises 的 `tools`），
// 而 check-all 调子脚本时用的 cwd 是 tools/——两处口径不同会导致「同一个参数
// 在这里找到 tools/tools」。显式钉在仓库根，避免这种二义。
const results = [];
for (const t of TARGETS) {
  const p = join(HERE, t.script);
  let code = 0, out = '';
  try {
    out = execFileSync(process.execPath, [p, ...t.args], {
      encoding: 'utf8', cwd: ROOT, stdio: 'pipe',
      // M3：不设 maxBuffer 时，一个话多的校验器会 ENOBUFS → status=null → 判红，
      // 而 tail 是空的，排查时看不出原因是缓冲区爆了。check-doc-counts 早就设了，这里照抄。
      maxBuffer: 128 * 1024 * 1024,
    });
  } catch (e) {
    code = e.status ?? 1;
    out = (e.stdout ?? '') + (e.stderr ?? '');
  }
  // R4：exit 0 但输出里报失败 → 不算通过
  const claimedFail = code === 0 && FAIL_MARKERS.test(out);
  results.push({ script: t.script, args: t.args, why: t.why, code, out, claimedFail, summary: summarize(out, code, claimedFail) });
}

/**
 * 一行摘要：优先取「判定」而不是「最后一行输出」。
 *
 * L1（2026-11-25 锐评）：原先一律打最后一行，于是 check-gate-doc-sync 打出来的是
 * `[optional_arg_not_documented] dispatch --max` —— 看起来像错误，实际 exit 0 是提示。
 */
function summarize(out, code, claimedFail) {
  const lines = out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  if (claimedFail) return '（输出里报了失败，见下）';
  if (code !== 0) return lines.slice(-1)[0] ?? '';
  // 优先挑「结论」形态的行
  const verdict = lines.filter((l) => /^(✓|✅|全部|跑了|所有|合计|结论|7 份|每份)/.test(l)
    || /全部通过|全部合规|均可达|一致$|无损|已接线/.test(l));
  return (verdict.slice(-1)[0] ?? lines.slice(-1)[0] ?? '');
}

const failed = results.filter((r) => r.code !== 0 || r.claimedFail);

// ────────────────────────────────────────────────────────────────
// MANUAL_ONLY：用受限切片跑一次，证明它还能工作
// ────────────────────────────────────────────────────────────────
const manualResults = [];
for (const m of MANUAL_ONLY) {
  const p = join(HERE, m.script);
  let code = 0, out = '';
  try {
    out = execFileSync(process.execPath, [p, ...(m.boundedArgs ?? [])], {
      encoding: 'utf8', cwd: ROOT, stdio: 'pipe', maxBuffer: 64 * 1024 * 1024, timeout: 180000,
    });
  } catch (e) {
    code = e.status ?? 1;
    out = (e.stdout ?? '') + (e.stderr ?? '');
  }
  const claimedFail = code === 0 && FAIL_MARKERS.test(out);
  manualResults.push({ script: m.script, code, out, claimedFail, reason: m.reason, boundedArgs: m.boundedArgs });
}
const manualFailed = manualResults.filter((r) => r.code !== 0 || r.claimedFail);

// ────────────────────────────────────────────────────────────────
// 输出
// ────────────────────────────────────────────────────────────────
const ok = failed.length === 0 && r1Failed.length === 0 && manualFailed.length === 0;

if (jsonOut) {
  console.log(JSON.stringify({
    ok,
    ran: results.length,
    failed: failed.map((r) => ({
      script: r.script, code: r.code, claimed_fail_but_exit_0: r.claimedFail,
      tail: r.out.trim().split('\n').slice(-6),
    })),
    skip_proof_failed: r1Failed.map((r) => ({ script: r.script, code: r.code, tail: r.tail })),
    manual: manualResults.map((r) => ({
      script: r.script, code: r.code, claimed_fail_but_exit_0: r.claimedFail, args: r.boundedArgs,
    })),
    skipped: SKIPPED.map((s) => ({ script: s.script, reason: s.reason })),
    exempt: EXEMPT_NO_ARG_FAIL.map((e) => e.script),
  }, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log('\n真实仓库自检（这些校验器跑在仓库本身，不是合成 fixture 上）\n');
for (const r of results) {
  const mark = r.code !== 0 ? '✗' : r.claimedFail ? '✗' : '✓';
  console.log(`  ${mark} ${r.script.padEnd(34)} ${r.summary.slice(0, 72)}`);
}

// H4（2026-11-25 锐评）：文档里写的是「57 个自测套件」，但 check-doc-counts 数的
// 是 check-all 的**全部条目**（含 check-repo.mjs 这类直接运行的校验器）。
// 数字对得上，标签是错的。所以这里把两个口径都打出来，让人一眼看到差别。
{
  const registered = [...readFileSync(join(HERE, 'check-all.mjs'), 'utf8').matchAll(/script:\s*'([^']+)'/g)]
    .map((m) => m[1]);
  const withTest = registered.filter((s) => s.endsWith('.test.mjs')).length;
  console.log(`\n  check-all 共 ${registered.length} 条：${withTest} 个自测套件 + ${registered.length - withTest} 个直接运行的脚本`);
}
console.log(`\n  跑了 ${results.length} 个；另有 ${SKIPPED.length} 个需要运行时输入（已逐个验证无参数时 exit 2）；`);
console.log(`  ${MANUAL_ONLY.length} 个只能人工按需跑（已用受限切片跑通一次）`);
console.log('  （那是本仓库没有的东西——造一份假数据只会变成又一层自欺）\n');

if (manualFailed.length > 0) {
  console.log('✗ 以下「只能人工按需跑」的脚本在受限切片下失败：');
  for (const r of manualFailed) {
    console.log(`    ${r.script} exit=${r.code}${r.claimedFail ? '（但输出里报了失败）' : ''}  args=${JSON.stringify(r.boundedArgs)}`);
    for (const l of r.out.trim().split('\n').slice(-5)) console.log(`      ${l}`);
  }
  console.log('');
}

if (r1Failed.length > 0) {
  console.log('✗ 以下脚本被标为「需要运行时输入」，但无参数跑时**没有** exit 2：');
  for (const r of r1Failed) {
    console.log(`    ${r.script}  exit=${r.code}`);
    for (const l of r.tail ?? []) console.log(`      ${l}`);
  }
  console.log('  → 它其实能在本仓库跑通，或它缺了用法守卫。挪进 TARGETS，或加进 EXEMPT_NO_ARG_FAIL 并说明。\n');
}

if (failed.length > 0) {
  for (const r of failed) {
    console.log(`✗ ${r.script} exit=${r.code}${r.claimedFail ? '（但输出里报了失败）' : ''}`);
    const lines = r.out.trim().split('\n').filter(Boolean);
    const bad = lines.filter((l) => /✗|FAIL|过期|不存在|不一致/.test(l));
    for (const l of (bad.length ? bad : lines).slice(-10)) console.log(`    ${l}`);
    console.log('');
  }
  console.log(`✗ ${failed.length} / ${results.length} 个校验器在真实仓库上失败\n`);
}

process.exit(ok ? 0 : 1);
