#!/usr/bin/env node
/**
 * check-files-touched-harness.mjs — 用 harness 的 **write/edit 记录**核对 files_touched
 *
 * ── 为什么这是「换观测面」而不是「再加一个字段」──────────────────────
 * R20（`experiments/hilltop-dsh/FIX-R20-report.md`）§三点诚实结论原文：
 *
 *   「『自述层还能加什么』的答案：这条链上已经到极限。
 *     R20 与前几次有本质区别——前几次接的是**新证据面**，R20 接的还是 `git status`，
 *     只多了一个**由被审者自己声称的**时间点。它不是新层次，是上一层的边界条件。
 *     下一个层次必须换观测面（harness 记录 tool call 与文件写入），
 *     而不是继续往 state.json 加字段——**每个新字段都是一个新省略点**。」
 *
 * R19 的 `files_touched_overclaimed` 比对的是 `git status`：
 * 它回答「相对 HEAD 有没有差异」，那是**状态**。一个文件在修复前就脏、本轮一个字没碰，
 * `git status` 说它变了 → 声称它不算 overclaim（假阴性）。
 *
 * 本脚本比对的是 harness 自己落的 `tool/call` 事件：
 * **这个 session 到底有没有调用过 write/edit、调了几次、写的是哪个绝对路径**。
 * 那是**动作**，且天然是 per-call 粒度（哪一次调用、写了哪个文件、哪个 session 写的）。
 * 这条记录主 Agent 改不了——要改得篡改 zstd 日志、保持 seq 连续、
 * 还要让 tool/result 与 step 边界自洽。伪造成本从「改账本」跳到「篡改 harness 运行时数据」。
 *
 * 它同时解决了 R19 §(b) 的归属问题：
 *   「`files_touched` 没有 agent_id 维度，对账是全局的不是逐实例的。」
 * dsh 的子 session 有 `parentSession` + `delegationDepth: 1`，
 * 当 `fix_contracts[].fix_agent_id` 能对应到某个子 session 时，可以**逐实例**对账。
 *
 * ── 数据来源（dsh）───────────────────────────────────────────────────
 *   <sessions-root>/<project-dir>/<session-dir>/session.v4.jsonl.zstd
 *
 *   - zstd 压缩的 JSONL，Node ≥ 22.15 / 24 用 `zlib.zstdDecompressSync` 解
 *   - `session` 事件字段在**顶层**：{ type, version, id, cwd, delegationDepth, parentSession?, origin? }
 *   - `tool/call`：`.data.name`（write / edit）+ `.data.arguments`（JSON 字符串）
 *       实测（a40f0162，68 次 write/edit）的两种 arguments 形状：
 *         write: {"file_path": "...", "content": "..."}
 *         edit : {"file_path": "...", "old_string": "...", "new_string": "..."}
 *   - 子 agent 的 session：`delegationDepth: 1` + `parentSession: <父 id>` + `origin: 'subagent'`
 *
 * ── 只支持 dsh，别家一律降级 ─────────────────────────────────────────
 * 探测不到任何 `session.v4.jsonl.zstd` → `unsupported_harness` → **exit 0 + WARN**。
 * 与 R8 同一纪律：一个只支持 dsh 的工具不该在别的 harness 上把修复流程卡死。
 * 宁可让它沉默（输出里明写「本 harness 未被验证」），也不能把「工具不支持」
 * 误报成「账本造假」。唯一例外是用户**显式**传了 `--session-id` 却找不到 → exit 2
 * （那说明路径/id 给错了，继续跑只会得到假绿）。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *   node check-files-touched-harness.mjs \
 *     --state <state.json> --sessions <dsh sessions root> \
 *     [--session-id <id>] [--project-dir <dir>] [--json]
 *
 *   --state        读 `fix_contracts[].fix_agent_id`、`target_repo`、`report.dir_path`。
 *   --sessions     dsh sessions 根目录。
 *   --session-id   主 session 的 id。省略时取该 project 目录下**最新**的顶层 session
 *                  （delegationDepth: 0，按 session 文件 mtime 排序）。
 *   --project-dir  显式指定 project 目录名（dsh 的目录名以 `--` 开头，位置参数无法区分）。
 *                  省略时若 root 下只有一个 project 目录则自动识别；多于一个报
 *                  `project_dir_ambiguous`（exit 2），**不猜**。
 *   --json         输出机器可读 JSON。
 *   --help / -h    打印说明，exit 0。
 *
 * ── 规则（每条独立命名）──────────────────────────────────────────────
 *   sessions_root_missing                    sessions root 不存在                        exit 2
 *   state_missing / state_invalid            state.json 不存在 / 解析失败                exit 2
 *   session_not_found                        找不到指定/推断的 session                   exit 2
 *   session_undecodable                      找到文件但 zstd 解不开 / 没有 session 事件  exit 2
 *   project_dir_ambiguous                    root 下有多个 project 目录且未指定          exit 2
 *   unsupported_harness                      root 下没有任何 dsh 格式日志                exit 0 + WARN
 *
 *   files_touched_overclaimed_by_harness     **核心**：声称侧有、write/edit 记录里没有   FAIL
 *   files_touched_underreported_by_harness   **核心**：写了源码、声称侧没有               FAIL
 *   agent_attribution_mismatch               **归属**：子 session 的写入 ⊄ 它自己的声称 FAIL
 *
 *   no_claimed_files                         claimed 集合为空，核心判据无法执行          WARN
 *   agent_attribution_unavailable            fix_agent_id 映射不到 session（降级）       WARN
 *   unnormalizable_claimed_path              声称侧的绝对路径不在 target_repo 内         WARN
 *   unnormalizable_actual_path               写操作的目标不在 target_repo 内             WARN
 *   file_existence_unknown                   无法判定文件现在是否还在（降级）           WARN
 *   repo_from_session_cwd                    target_repo 缺失，基准取自 session cwd      INFO
 *   probe_files_deleted                      写了源码、文件已删、且有删除记录（探针）    INFO
 *   probe_files_deleted_by_agent             同上，但发生在逐实例归属对账里              INFO
 *   more_actual_than_claimed_files           实际写的文件多于声称（仅计数提示）          INFO
 *
 * 退出码：0 = 通过（允许 WARN/INFO） / 1 = 有 FAIL / 2 = 配置错误
 *
 * ── 与 R19 `files_touched_overclaimed` 的分工（相邻但不同）───────────
 *   R19  声称 vs `git status`（相对 HEAD 的**状态**）→ 文件早就脏就蒙混得过去
 *   本脚本 声称 vs write/edit **调用**（per-call 的动作记录）→ 没写过就是没写过
 * 反方向同理：R19 的 underreported 被「基线里本来就脏」干扰（R20 才补上基线），
 * 本脚本的 underreported 只看「这个 session 真的写了什么」，与仓库脏不脏无关。
 *
 * ── 它不检查什么 ─────────────────────────────────────────────────────
 *   - 改动的内容对不对（要读代码 / diff）
 *   - 写完之后有没有被回滚（`write` 过再 `git checkout --` 还原，日志里仍有那条 write
 *     记录）——本脚本判「写动作发生过」，**不判「写动作最终生效」**。见 R21 报告 §六。
 *   - 非 dsh 的 harness（当前未实现适配器，故意不做半成品）
 *
 * ── R23：写了又删的探针不是「未登记的修复改动」───────────────────────
 * field-test-1（2026-11-16）真实盲区：主 session 为验证修复建了 8 个
 * `*ProbeTest.java` 探针、用完删掉，`files_touched` 没登记它们——**这是对的**，
 * 因为仓库最终状态里没有它们。R21 把「harness 记录的所有源码写入」都当成
 * 「修复改动」，于是报 1 FAIL。
 *
 * 判据（**两条都要**，缺一不认）：
 *   (a) harness 有 write/edit 记录，且该文件**现在不在磁盘上**
 *   (b) harness 的 shell 调用里有一条**删除动作**（Remove-Item / rm / git clean…）
 *       指向这个文件
 *   → probe_files_deleted（INFO），不判 under-reported
 *   只满足 (a) 不满足 (b) → 照旧 FAIL
 *
 * 为什么必须要 (b)：光看「文件不在」分辨不出三种情况——
 *   1. 写完就删的探针（本规则要放行的）
 *   2. 日志里那条 write 根本没落盘 / 基准 target_repo 指错了（**该报的**）
 *   3. agent 为了逃避登记把文件删了（**该报的**——不过那时仓库里确实没改动，
 *      真正该抓的是「修复没发生」，由 R18 的 files_touched_not_found 与
 *      测试/红测证据链负责，见 R23 报告 §诚实评估）
 * 只有 (b) 能把 1 与 2/3 分开，因为它是**动作记录**，不是状态推断。
 *
 * 为什么仍然必须显式列出来（INFO，不静默过滤）：静默过滤等于规则自己决定什么不重要；
 * 而且「写了又忘删」的情形仍会留在仓库里 → 那时规则照旧报 FAIL，**这是对的**。
 *
 * 存在性不可判定（target_repo 不是目录 / 路径形态无法解析）时**不甄别**：
 * 退回到 R21 的行为并 WARN `file_existence_unknown`。
 * 宁可维持旧口径，也不能让「判断不了」变成「一律放过」——那会重新打开
 * under-reporting 的口子。
 *
 * 反方向不受影响：`files_touched` 登记了一个不存在的文件，是 R18 的
 * `files_touched_not_found` 的事（`check-payload.mjs`），本脚本不代劳也不放过。
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, dirname, basename, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';

// ────────────────────────────────────────────────────────────────────
// 路径归一化 —— 本工具最容易出 bug 的地方，导出以便单独测
// ────────────────────────────────────────────────────────────────────
//
// harness 记录的是**绝对路径**（`D:/Server/.../src/main/java/X.java`），
// `files_touched` 里是**相对路径**（`src/main/java/X.java`）。
// 不归一化会让同一个文件在两边看起来不同 → 假 overclaim → 整段被关掉。
//
// 三条规则：
//   1. 绝对路径 → 相对 `target_repo` 的 posix 路径
//   2. 相对路径 → 原样（去掉前导 `./`、尾斜杠）
//   3. 大小写：Windows 上不敏感，**但不能统一转小写**（Linux 上敏感）。
//      比较键 `key` 按平台折叠，展示用的 `rel` 保留原大小写。
const IS_WIN = process.platform === 'win32';

const isAbsolutePath = (p) => /^[A-Za-z]:\//.test(p) || p.startsWith('/');
const toPosix = (p) => String(p).replace(/\\/g, '/');
/** 去尾斜杠，但保留盘符根（`D:/` → `D:/`，否则拼前缀会变成 `D:`）。 */
const stripTrailingSlash = (p) => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p);

export function normalizePath(p, targetRepo, caseInsensitive = IS_WIN) {
  if (typeof p !== 'string') return { ok: false, reason: 'invalid', raw: p };
  const raw = p.trim();
  if (raw === '') return { ok: false, reason: 'invalid', raw: p };

  const fold = (s) => (caseInsensitive ? s.toLowerCase() : s);
  let n = stripTrailingSlash(toPosix(raw));

  if (isAbsolutePath(n)) {
    if (typeof targetRepo !== 'string' || targetRepo.trim() === '') {
      return { ok: false, reason: 'no_repo', raw, abs: n };
    }
    const repo = stripTrailingSlash(toPosix(targetRepo.trim()));
    if (repo === '' || repo === '/') return { ok: false, reason: 'no_repo', raw, abs: n };
    if (fold(n) === fold(repo)) return { ok: true, rel: '', key: '', abs: n, raw };
    // 必须按「repo + 分隔符」比前缀：纯字符串前缀会把 `Some Repo2` 算进 `Some Repo`
    if (!fold(n).startsWith(fold(repo) + '/')) {
      return { ok: false, reason: 'outside_repo', raw, abs: n, repo };
    }
    const rel = posix.normalize(n.slice(repo.length + 1));
    if (rel === '' || rel === '.') return { ok: false, reason: 'invalid', raw, abs: n };
    if (rel === '..' || rel.startsWith('../')) return { ok: false, reason: 'escapes_repo', raw, abs: n };
    return { ok: true, rel, key: fold(rel), abs: n, raw };
  }

  // 相对路径
  n = n.replace(/^\.\//, '');
  const rel = posix.normalize(n);
  if (rel === '' || rel === '.') return { ok: false, reason: 'invalid', raw };
  if (rel === '..' || rel.startsWith('../')) return { ok: false, reason: 'escapes_repo', raw };
  const abs = typeof targetRepo === 'string' && targetRepo.trim() !== ''
    ? `${stripTrailingSlash(toPosix(targetRepo.trim()))}/${rel}`
    : null;
  return { ok: true, rel, key: fold(rel), abs, raw };
}

// ────────────────────────────────────────────────────────────────────
// 参数
// ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = { state: null, sessions: null, sessionId: null, projectDir: null, json: false, help: false };
  const known = new Map([
    ['--state', 'state'],
    ['--sessions', 'sessions'],
    ['--session-id', 'sessionId'],
    ['--project-dir', 'projectDir'],
  ]);
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (a === '--help' || a === '-h') { out.help = true; continue; }
    if (known.has(a)) {
      // 值可能本身以 `--` 开头（dsh 的 project 目录名就是），所以无条件取下一个 token
      const v = argv[i + 1];
      if (v === undefined) { out.badArg = a; continue; }
      out[known.get(a)] = v;
      i++;
      continue;
    }
    out.badArg = a;
  }
  return out;
}

// 常量：判「源码」用扩展名白名单（与 verify-postfix-snapshot.mjs / stop-hook.mjs §3.7.6 同一份口径）。
// 用白名单而不是路径黑名单：黑名单要枚举所有产物目录名，必然漏。
const SRC_EXT = /\.(java|js|mjs|cjs|ts|tsx|jsx|py|go|rs|kt|kts|c|cc|cpp|h|hpp|cs|rb|php|swift|scala|sh)$/i;
// 修复相位里合法存在的产物/构建前缀。它们在 under-reporting 判据里是噪音，
// 不是「改了却没登记」。
const NOISE_PREFIXES = [
  'repair-artifacts/', 'experiments/', 'docs/', '.work/', 'target/', 'build/',
  'node_modules/', '.git/',
];
const WRITE_TOOLS = ['write', 'edit'];

function isNoisePath(rel) {
  const lower = rel.toLowerCase().replace(/^\.\//, '');
  return NOISE_PREFIXES.some((pre) => lower === pre.slice(0, -1) || lower.startsWith(pre));
}
const isSourcePath = (rel) => !isNoisePath(rel) && SRC_EXT.test(rel);

// ────────────────────────────────────────────────────────────────────
// R23 · 文件现在还在不在
// ────────────────────────────────────────────────────────────────────
//
// 甄别「写了又删的探针」与「留下来的真改动」的唯一依据。
// 三个返回值，必须**都**能表达，不能用 false 兜底：
//   true  = 文件现在存在（真改动）
//   false = 文件现在不存在（写了又删的探针）
//   null  = 判断不了（基准目录不存在 / 路径形态无法解析）→ 调用方**不甄别**
//
// 为什么 null 不折成 false：折成 false 等于「判断不了就算已删除」，
// under-reporting 会重新变成可绕过的（只要让 target_repo 指向一个不存在的目录）。
// 为什么 null 不折成 true：折成 true 会在 target_repo 指错时产生假 FAIL。
// 两种猜测都会错，所以只能把「不确定」如实传出去，由调用方降级并 WARN。
//
// 只看 `target_repo` 本身是不是一个真目录，**不**用「父目录存在」兜底：
// 一个路径的父目录在、文件不在，可能只是它被删了，也可能是 root 拼错了。
// 分辨不了就不要假装分辨了。
export function fileExistence(rel, targetRepo, caseInsensitive = IS_WIN) {
  if (typeof rel !== 'string' || rel.trim() === '') return null;
  if (typeof targetRepo !== 'string' || targetRepo.trim() === '') return null;
  let repoIsDir = false;
  try { repoIsDir = statSync(targetRepo.trim()).isDirectory(); } catch { repoIsDir = false; }
  if (!repoIsDir) return null;

  const n = normalizePath(rel, targetRepo, caseInsensitive);
  if (!n.ok || !n.abs) return null;
  if (!isAbsolutePath(n.abs)) return null;
  try {
    return existsSync(n.abs);
  } catch {
    return null;
  }
}

// ────────────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────────────
function main() {
  const ARGS = parseArgs(process.argv);

  if (ARGS.help) {
    const head = readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, '');
    console.log(head);
    process.exit(0);
  }

  const problems = [];
  const infos = [];
  const fail = (rule, message, meta = {}) => problems.push({ level: 'FAIL', rule, message, ...meta });
  const warn = (rule, message, meta = {}) => problems.push({ level: 'WARN', rule, message, ...meta });
  const info = (rule, message, meta = {}) => {
    problems.push({ level: 'INFO', rule, message, ...meta });
    infos.push({ rule, message, ...meta });
  };

  const finish = (exitCode, extra = {}) => {
    const result = { ...extra, problems, infos, exitCode };
    if (ARGS.json) console.log(JSON.stringify(result, null, 2));
    else printHuman(result);
    process.exit(exitCode);
  };

  const configError = (rule, message) => {
    if (ARGS.json) {
      console.log(JSON.stringify({ problems: [{ level: 'CONFIG', rule, message }], exitCode: 2 }, null, 2));
    }
    console.error(`\n[配置错误] ${rule}`);
    console.error(`  ${message}\n`);
    process.exit(2);
  };

  // ── 0 · 参数与 state ──
  if (ARGS.badArg) configError('usage', `未知或不完整参数: ${ARGS.badArg}\n  用法见 --help。`);
  if (!ARGS.state) configError('usage', '缺少必填参数 --state <state.json>');
  if (!ARGS.sessions) configError('usage', '缺少必填参数 --sessions <dsh sessions root>');

  if (!existsSync(ARGS.state)) {
    configError('state_missing',
      `state.json 不存在: ${ARGS.state}\n`
      + '  本检查器的声称侧全部来自账本与 fix 信封；没有账本就无从对账。');
  }

  let state;
  try {
    state = JSON.parse(readFileSync(ARGS.state, 'utf8'));
  } catch (e) {
    configError('state_invalid', `state.json 解析失败: ${e.message}`);
  }
  if (!state || typeof state !== 'object' || Array.isArray(state)) {
    configError('state_invalid',
      `state.json 顶层不是对象（实际是 ${Array.isArray(state) ? 'array' : typeof state}）`);
  }

  const root = resolve(ARGS.sessions);
  if (!existsSync(root)) {
    configError('sessions_root_missing',
      `sessions 根目录不存在: ${root}\n`
      + '  没有 harness 日志就没有外部基准，本检查器的核心规则会全部失去依据。'
      + '（这与「日志里显示一次 write 都没有」是两件完全不同的事：'
      + '前者是没证据，后者是证据指向「什么都没写」。）');
  }

  // ── 1 · 声称侧：所有 fix 信封里的 files_touched[].path + 各自信封的 agent_id ──
  //
  // 不新增字段：产物目录沿用 state.report.dir_path（run-state.md 已有约定），
  // 信封里的 agent_id 本来就是必填。所以这一步只是「读已有数据」。
  const collectFilesTouched = (payload) => {
    const out = [];
    const take = (entry) => {
      const ft = entry?.files_touched;
      if (!Array.isArray(ft)) return;
      for (const item of ft) {
        const p = item?.path;
        if (typeof p === 'string' && p.trim() !== '') out.push(p.trim());
      }
    };
    take(payload);
    if (Array.isArray(payload?.dispositions)) {
      for (const d of payload.dispositions) take(d);
    }
    return out;
  };

  const rawDir = state.report?.dir_path;
  let artifactDir = null;
  if (typeof rawDir === 'string' && rawDir.trim() !== '') {
    const cands = [
      resolve(dirname(resolve(ARGS.state)), rawDir),
      resolve(rawDir),
    ];
    artifactDir = cands.find((d) => { try { return existsSync(d) && statSync(d).isDirectory(); } catch { return false; } }) ?? null;
  }

  const claimedRaw = [];            // [{ path, agentId, artifact }]
  let fixEnvelopeCount = 0;
  if (artifactDir) {
    const FIX_ARTIFACT = [/^done-.*\.md$/i, /^.*-fix-.*\.md$/i, /^fix-.*\.md$/i];
    let names = [];
    try {
      names = readdirSync(artifactDir, { withFileTypes: true })
        .filter((e) => e.isFile() && FIX_ARTIFACT.some((re) => re.test(e.name)))
        .map((e) => e.name);
    } catch { names = []; }
    for (const name of names) {
      let text;
      try { text = readFileSync(join(artifactDir, name), 'utf8'); } catch { continue; }
      for (const b of text.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
        let env;
        try { env = JSON.parse(b[1]); } catch { continue; }
        if (env?.role !== 'fix') continue;
        fixEnvelopeCount++;
        const agentId = typeof env.agent_id === 'string' ? env.agent_id.trim() : '';
        for (const p of collectFilesTouched(env.payload)) {
          claimedRaw.push({ path: p, agentId, artifact: name });
        }
      }
    }
  }

  // ── 2 · 探测 harness 格式，列出 session ──
  const DSH_FILE = 'session.v4.jsonl.zstd';

  const listSessionDirs = (base) => {
    const out = [];
    let entries = [];
    try {
      entries = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    } catch { return out; }
    for (const e of entries) {
      const full = join(base, e.name);
      if (existsSync(join(full, DSH_FILE))) { out.push({ project: base, abs: full, name: e.name }); continue; }
      let children = [];
      try {
        children = readdirSync(full, { withFileTypes: true }).filter((c) => c.isDirectory() && !c.name.startsWith('.'));
      } catch { continue; }
      for (const c of children) {
        const cd = join(full, c.name);
        if (existsSync(join(cd, DSH_FILE))) out.push({ project: full, abs: cd, name: c.name });
      }
    }
    return out;
  };

  const allSessionDirs = listSessionDirs(root);

  if (allSessionDirs.length === 0) {
    if (ARGS.sessionId) {
      configError('session_not_found',
        `指定了 --session-id ${ARGS.sessionId}，但 ${root} 下没有任何 ${DSH_FILE}\n`
        + '  可能是 --sessions 指错了目录，或者这个 harness 的日志格式不是 dsh 的。');
    }
    warn('unsupported_harness',
      `在 ${root} 下没有找到任何 ${DSH_FILE}，判断这不是 dsh 的 session 目录结构。\n`
      + '  本检查器当前**只实现了 dsh 的格式**，因此无法用 write/edit 记录核对 files_touched。\n'
      + '  这是「工具没覆盖」，不是「files_touched 合规」——WARN 必须可见，但不能升成 FAIL，\n'
      + '  否则换一个 harness 就会把整个修复流程卡死（R8 同一纪律）。\n'
      + '  Claude Code 的日志在 ~/.claude/projects/<slug>/<session-uuid>.jsonl，'
      + '它的 write/edit 记录是 assistant 消息里 type="tool_use" 的内容块，需要单独的适配器。',
      { sessionsRoot: root });
    finish(0, {
      harness: 'unknown', sessionsRoot: root, state: ARGS.state, session: null,
      writeEditCalls: null, actualFiles: null, claimedFiles: claimedRaw.length,
      sessionsScanned: 0,
    });
  }

  // ── 3 · 定位主 session ──
  const readSessionEvents = (dir) => {
    const file = join(dir, DSH_FILE);
    if (!existsSync(file)) return null;
    let text;
    try {
      text = zstdDecompressSync(readFileSync(file)).toString('utf8');
    } catch (e) {
      return { error: `zstd 解压失败: ${e.message}`, file };
    }
    const events = [];
    for (const line of text.split('\n')) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { /* 半行写入时跳过 */ }
    }
    return { file, events, mtimeMs: statSync(file).mtimeMs };
  };

  const sessionMeta = (events) => {
    const head = events.find((e) => e.type === 'session');
    return {
      id: head?.id ?? null,
      parentSession: head?.parentSession ?? null,
      origin: head?.origin ?? null,
      delegationDepth: head?.delegationDepth ?? null,
      cwd: head?.cwd ?? null,
    };
  };

  const dirNameMatchesId = (dirName, id) => {
    if (!dirName || !id) return false;
    if (dirName === id) return true;
    const bare = id.startsWith('session-') ? id.slice('session-'.length) : id;
    return dirName === bare || `session-${dirName}` === id || dirName === `session-${bare}`;
  };

  const findSessionDirById = (id) => {
    const hits = allSessionDirs.filter((s) => dirNameMatchesId(s.name, id));
    if (hits.length > 0) return hits[0];
    for (const s of allSessionDirs) {
      const r = readSessionEvents(s.abs);
      if (!r || r.error) continue;
      if (sessionMeta(r.events).id === id) return s;
    }
    return null;
  };

  let target = null;
  if (ARGS.sessionId) {
    target = findSessionDirById(ARGS.sessionId);
    if (!target) {
      configError('session_not_found',
        `在 ${root} 下找不到 session id = ${ARGS.sessionId} 的日志。\n`
        + `  已扫描 ${allSessionDirs.length} 个 dsh session 目录（目录名与 session 事件的 id 都比对过）。\n`
        + '  声称的写操作必须有对应的 harness 记录；找不到记录时本检查器不会替你假设「大概跑过」。');
    }
  } else {
    const projectDirs = [...new Set(allSessionDirs.map((s) => s.project))];
    let projectDir;
    if (ARGS.projectDir) {
      projectDir = join(root, ARGS.projectDir);
      if (!existsSync(projectDir)) {
        configError('project_dir_not_found', `指定的 project 目录不存在: ${projectDir}`);
      }
    } else if (projectDirs.length === 1) {
      projectDir = projectDirs[0];
    } else {
      configError('project_dir_ambiguous',
        `${root} 下有 ${projectDirs.length} 个 project 目录，无法自动判断本次账本属于哪一个：\n  `
        + projectDirs.map((p) => basename(p)).join('\n  ')
        + '\n  请用 --project-dir <目录名> 指定，或用 --session-id 直接指定主 session。');
    }
    const candidates = allSessionDirs.filter((s) => s.project === projectDir);
    const tops = [];
    for (const s of candidates) {
      const r = readSessionEvents(s.abs);
      if (!r || r.error) continue;
      const meta = sessionMeta(r.events);
      if ((meta.delegationDepth ?? 0) === 0) tops.push({ s, r, meta });
    }
    if (tops.length === 0) {
      configError('session_not_found',
        `${basename(projectDir)} 下有 ${candidates.length} 个 session，但没有一个是顶层的`
        + '（delegationDepth: 0）——只有子 agent 的记录，主 session 的日志不在或已被清理。');
    }
    tops.sort((a, b) => b.r.mtimeMs - a.r.mtimeMs);
    target = tops[0].s;
    if (!ARGS.projectDir) info('project_dir_inferred', `自动识别的 project 目录: ${basename(projectDir)}`);
  }

  // ── 4 · 读「本次会话」的写入记录 ──
  //
  // 「本次会话」的边界是本工具**最容易搞错、也最危险**的设计点，两个方向都要防：
  //
  //   (a) 边界太窄 → 假 FAIL。dsh 的同一个 project 目录（= 同一个 cwd）下可以同时存在
  //       多个**顶层** session（实测 Hilltop Village 那个 project 就有两个：
  //       a40f0162 写了 68 次、d5ad7820 写了 26 次，done-1..7 来自前者、done-8 来自后者）。
  //       若「省略 --session-id 时取最新顶层」，拿其中任意一个当全集，
  //       另一边的 files_touched 就会全部被判成 overclaim —— 一次结构性的假 FAIL，
  //       然后这条规则会被整体关掉（R10 的教训：假 FAIL 比漏报更糟）。
  //
  //   (b) 边界太宽 → 放水。别的 project 目录（别的 cwd、别的项目）的 session 绝不能算进来。
  //
  // 所以默认口径是 **「该 project 目录下的全部 session」**，而不是某一个 session：
  // 一个 project 目录对应一个工作目录，也就是一次工作的全部会话（含其子 agent）。
  // 用户显式传 `--session-id` 时口径收窄到**该 session 及其后代**——
  // 那时用户已经明确指定了范围，本工具就按它算，并把 scope 写进输出。
  const targetRead = readSessionEvents(target.abs);
  if (!targetRead || targetRead.error) {
    configError('session_undecodable',
      `找到 ${join(target.abs, DSH_FILE)} 但读不出事件${targetRead?.error ? `：${targetRead.error}` : ''}。\n`
      + '  解不开的日志不能当作「一次 write/edit 都没有」——那是把读取失败误报成账本造假。');
  }
  const targetMeta = sessionMeta(targetRead.events);
  if (!targetMeta.id) {
    configError('session_undecodable',
      `${join(target.abs, DSH_FILE)} 里没有 type="session" 的事件，无法确认这是哪个 session。`);
  }

  const scanned = [];
  let actualScope;
  if (ARGS.sessionId) {
    actualScope = 'session';
    scanned.push({ dir: target, read: targetRead, meta: targetMeta });
    const descIds = new Set([targetMeta.id]);
    // 子 session 可能排在父后面，所以要反复扫直到不再新增（父链可能多级）
    for (let grew = true; grew;) {
      grew = false;
      for (const s of allSessionDirs) {
        if (s.project !== target.project) continue;
        if (scanned.some((x) => x.dir.abs === s.abs)) continue;
        const r = readSessionEvents(s.abs);
        if (!r || r.error) continue;
        const m = sessionMeta(r.events);
        if (!m.id || !m.parentSession) continue;
        if (descIds.has(m.parentSession)) {
          descIds.add(m.id);
          scanned.push({ dir: s, read: r, meta: m });
          grew = true;
        }
      }
    }
  } else {
    actualScope = 'project';
    for (const s of allSessionDirs.filter((x) => x.project === target.project)) {
      const r = s.abs === target.abs ? targetRead : readSessionEvents(s.abs);
      if (!r || r.error) continue;
      const m = sessionMeta(r.events);
      if (!m.id) continue;
      scanned.push({ dir: s, read: r, meta: m });
    }
  }

  // ── 5 · 归一化基准：target_repo，缺失时用 target session 的 cwd ──
  let repoBase = typeof state.target_repo === 'string' && state.target_repo.trim() !== ''
    ? state.target_repo.trim()
    : null;
  let repoSource = repoBase ? 'state.target_repo' : null;
  if (!repoBase && typeof targetMeta.cwd === 'string' && targetMeta.cwd.trim() !== '') {
    repoBase = targetMeta.cwd.trim();
    repoSource = 'session.cwd';
    info('repo_from_session_cwd',
      `state.json 没有 target_repo，用主 session 的 cwd 作为路径基准：${repoBase}\n`
      + '  dsh 的 cwd 就是启动会话时的工作目录，被审仓库通常就是它。'
      + '但这只是推断——若被审仓库在子目录里，绝对路径会被判成「仓库外」（只 WARN，不 FAIL）。');
  }

  // ── 6 · 实际侧：write/edit 的 file_path ──
  //
  // 读 arguments 时只认 file_path / path / filePath 三个键（实测 dsh 用 file_path）。
  // 一个 write/edit 调用取不到路径时**不能静默丢掉**：那会把「记录里有写操作」
  // 变成「没有写操作」，方向正好是给账本放水。所以计入 unparsed 并 WARN。
  const extractWritePath = (ev) => {
    let args = ev.data?.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { return { error: 'arguments 不是合法 JSON' }; }
    }
    if (!args || typeof args !== 'object') return { error: 'arguments 缺失' };
    const p = args.file_path ?? args.path ?? args.filePath;
    if (typeof p !== 'string' || p.trim() === '') return { error: '没有 file_path/path 字段' };
    return { path: p.trim() };
  };

  const writeCalls = [];     // [{ sessionId, tool, raw, at }]
  let unparsedWrites = 0;
  for (const s of scanned) {
    const calls = s.read.events.filter((e) => e.type === 'tool/call' && WRITE_TOOLS.includes(e.data?.name));
    for (const c of calls) {
      const got = extractWritePath(c);
      if (got.error) { unparsedWrites++; continue; }
      writeCalls.push({ sessionId: s.meta.id, tool: c.data.name, raw: got.path });
    }
    if (calls.length === 0) {
      // 兜底：有些 harness 版本只在 assistant 消息里记 tool-call 内容块
      const blocks = s.read.events
        .filter((e) => e.type === 'assistant/message')
        .flatMap((e) => (e.data?.message?.content ?? []).filter((c) => c?.type === 'tool-call'));
      for (const b of blocks) {
        if (!WRITE_TOOLS.includes(b?.name)) continue;
        const args = typeof b.arguments === 'string'
          ? (() => { try { return JSON.parse(b.arguments); } catch { return null; } })()
          : b.arguments;
        const p = args?.file_path ?? args?.path ?? args?.filePath;
        if (typeof p === 'string' && p.trim() !== '') {
          writeCalls.push({ sessionId: s.meta.id, tool: b.name, raw: p.trim() });
        } else unparsedWrites++;
      }
    }
  }

  if (unparsedWrites > 0) {
    warn('unparsed_write_calls',
      `有 ${unparsedWrites} 次 write/edit 调用取不到文件路径（arguments 缺失或不是 JSON）。\n`
      + '  它们既不算「写过」也不算「没写过」——本回合的实际侧因此**是不完整的**。\n'
      + '  不把它们静默丢掉：丢掉会让「日志里有写操作」退化成「没有写操作」，方向正好给账本放水。',
      { unparsedWrites });
  }

  // ── 7 · 归一化两侧 ──
  const claimed = new Map();          // key → { rel, agents:Set, raw:[] }
  const unnormalizableClaimed = [];
  for (const c of claimedRaw) {
    const n = normalizePath(c.path, repoBase);
    if (!n.ok) { unnormalizableClaimed.push({ ...c, reason: n.reason }); continue; }
    if (n.rel === '') continue;
    const e = claimed.get(n.key) ?? { rel: n.rel, agents: new Set(), raw: [] };
    if (c.agentId) e.agents.add(c.agentId);
    e.raw.push(c.path);
    claimed.set(n.key, e);
  }
  if (unnormalizableClaimed.length > 0) {
    warn('unnormalizable_claimed_path',
      `files_touched 里有 ${unnormalizableClaimed.length} 个路径无法与 target_repo `
      + `${repoBase ?? '（未知）'} 对齐：\n  `
      + unnormalizableClaimed.slice(0, 8).map((c) => `${c.path}（${c.reason}）`).join('\n  ')
      + '\n  它们既不算 overclaim 也不算已登记——在本次对账之外。\n'
      + '  不判 FAIL 是有意的：假 FAIL 比漏报更糟，它会让整段检查被关掉。',
      { paths: unnormalizableClaimed.map((c) => c.path) });
  }

  const actual = new Map();           // key → { rel, sessions:Set, calls:number }
  const unnormalizableActual = [];
  for (const w of writeCalls) {
    const n = normalizePath(w.raw, repoBase);
    if (!n.ok) { unnormalizableActual.push({ ...w, reason: n.reason }); continue; }
    if (n.rel === '') continue;
    const e = actual.get(n.key) ?? { rel: n.rel, sessions: new Set(), calls: 0 };
    e.sessions.add(w.sessionId);
    e.calls++;
    actual.set(n.key, e);
  }
  if (unnormalizableActual.length > 0) {
    warn('unnormalizable_actual_path',
      `harness 记录了 ${unnormalizableActual.length} 次 write/edit，目标不在 target_repo 内：\n  `
      + unnormalizableActual.slice(0, 8).map((w) => `${w.raw}（${w.reason}）`).join('\n  ')
      + '\n  它们不参与本次对账。若这些确实是本轮改的文件，说明 target_repo 指错了仓库。',
      { paths: unnormalizableActual.map((w) => w.raw) });
  }

  // ── 6.5 · 删除记录（R23）──
  //
  // 「文件现在不存在」单独**不足以**证明它是「写完就删的探针」：
  // 它也可能是 target_repo 指错、或者日志里那条 write 根本没落盘。
  // 两者必须能分开，否则 under-reporting 会重新变成可绕过的
  // （只要别让文件落盘、或者把基准指向一个空目录）。
  //
  // 第二个信号来自 harness 自己：**它记了删除动作**。
  // field-test-1 的 8 个探针全部留下 `Remove-Item ...` 的 pwsh 调用，
  // 这是「写了又删」最直接的证据，而且是**动作记录**，不是状态推断。
  //
  // 判据（两者都要）：
  //   (a) harness 有 write/edit 记录，且文件**现在不存在**
  //   (b) harness 的 shell 调用里有一条**删除动作**指向这个文件
  //
  // 只满足 (a) 不满足 (b) → 照旧 FAIL。「日志说写过、磁盘上没有、
  // 也没人删过它」= 那条 write 记录与仓库对不上，这本身就是要报的，
  // 而且它正是 R18 §6 那种「只列存在的文件」的形状。
  const SHELL_TOOLS = ['pwsh', 'powershell', 'bash', 'sh', 'shell', 'zsh', 'cmd',
    'terminal', 'run_command', 'execute_bash', 'exec', 'run'];
  // 只认**明确的删除动词**。故意不把 `Test-Path` / `Get-Content` / `Resolve-Path`
  // 算进来：它们只是引用路径，不改变仓库。
  // `git clean` 也算（它会真的把未跟踪文件删掉）。
  const DELETE_PATTERN = new RegExp([
    'Remove-Item',
    '(?:^|[^\\w-])rm\\s+-',
    '(?:^|[^\\w-])rm\\s+[^\\s]',
    '(?:^|[^\\w-])del\\s+/[A-Za-z]',
    '(?:^|[^\\w-])rmdir\\b',
    '(?:^|[^\\w-])unlink\\b',
    'git\\s+clean',
    '\\[System\\.IO\\.File\\]::Delete',
    '\\[System\\.IO\\.Directory\\]::Delete',
  ].join('|'), 'i');

  const extractCommand = (ev) => {
    let args = ev.data?.arguments;
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { return null; }
    }
    if (!args || typeof args !== 'object') return null;
    const c = args.command ?? args.cmd ?? args.script ?? args.input;
    return typeof c === 'string' && c.trim() !== '' ? c : null;
  };

  const deleteCommands = [];      // [{ sessionId, cmd }]（cmd 已转 posix + 小写）
  for (const s of scanned) {
    for (const ev of s.read.events) {
      if (ev.type !== 'tool/call') continue;
      if (!SHELL_TOOLS.includes(ev.data?.name)) continue;
      const cmd = extractCommand(ev);
      if (!cmd || !DELETE_PATTERN.test(cmd)) continue;
      deleteCommands.push({ sessionId: s.meta.id, cmd: toPosix(cmd).toLowerCase() });
    }
  }

  // 命中口径：命令里出现**这个文件的相对路径**，或它的唯一 basename（≥6 字符，
  // 避免 `A.java` 这种到处都有的名字误命中）。shell 里可能写反斜杠、也可能写绝对路径，
  // 都在 cmd 归一化成 posix 之后覆盖。
  const deleteEvidence = new Map();   // relLower → [cmd...]
  const deleteEvidenceFor = (rel) => {
    const relLower = toPosix(rel).toLowerCase();
    if (deleteEvidence.has(relLower)) return deleteEvidence.get(relLower);
    const base = relLower.split('/').pop();
    const hits = deleteCommands
      .filter((d) => d.cmd.includes(relLower) || (base.length >= 6 && d.cmd.includes(base)))
      .map((d) => d.cmd);
    deleteEvidence.set(relLower, hits);
    return hits;
  };

  // ── 8 · 核心规则 ──
  const claimedCount = claimed.size;

  // 供 §10 输出复用：**不重算**，避免在没有核心判据的回合（no_claimed_files）
  // 里为了填 JSON 字段去触一次存在性判断、凭空多一条 WARN。
  let outUnderreported = [];
  let outProbeFiles = [];

  // R23 · 「文件现在还在不在」的唯一判定入口（8.2 与 9 共用同一份缓存）。
  //
  // 三值语义见 fileExistence()：true / false / null。
  // **null 绝不折成 false**：那等于「判断不了就算已删除」，under-reporting
  // 只要把 target_repo 指向一个不存在的目录就能绕过。null 时退回 R21 口径 + WARN。
  const existenceCache = new Map();
  let existenceUnknownWarned = false;
  const existsNow = (rel) => {
    if (!existenceCache.has(rel)) existenceCache.set(rel, fileExistence(rel, repoBase));
    const got = existenceCache.get(rel);
    if (got === null && !existenceUnknownWarned) {
      existenceUnknownWarned = true;
      warn('file_existence_unknown',
        `无法判断 harness 写过的文件现在是否还在：路径基准 `
        + `${repoBase === null ? '（未知）' : `"${repoBase}" 不是一个存在的目录`}。\n`
        + '  本回合**不做探针甄别**（未登记的源码写入一律照 R21 口径判 under-reported），'
        + '逐实例归属对账同理不甄别。\n'
        + '  为什么不按「文件不在 = 已删除」处理：那等于把「判断不了」变成「一律放过」，'
        + 'under-reporting 只要把 target_repo 指向一个不存在的目录就能绕过。\n'
        + '  为什么不按「文件在 = 存在」处理：基准指错时会造出假 FAIL，而假 FAIL 比漏报更糟'
        + '（它会让整条规则被关掉）。\n'
        + '  两种猜测都会错，所以这里只把「不确定」如实说出来，并维持旧口径。',
        { repoBase });
    }
    return got;
  };

  if (fixEnvelopeCount === 0 || claimedCount === 0) {
    // 没有 claimed 集合 → 核心判据无从执行。**不能静默跳过**：
    // 「检查没跑」与「检查通过」在日志上必须可区分（R13 §7.2 的教训）。
    // 不能升 FAIL：WONT_FIX / DEFERRED 轮次里 files_touched 为空是合法的；
    // 而「产物没有信封」由 check-fix-artifacts-envelope.mjs 单独拦，这里不重复开火。
    warn('no_claimed_files',
      `${fixEnvelopeCount === 0
        ? '产物目录里没有 role="fix" 的 JSON 信封'
        : `有 ${fixEnvelopeCount} 份 fix 产物，但它们的 payload.files_touched 全是空的`}，`
      + '声称侧为空，无从与 write/edit 记录对账。\n'
      + `harness 侧记录本次会话共 ${writeCalls.length} 次 write/edit、`
      + `${actual.size} 个不同文件——这些并没有被核对过。\n`
      + '这意味着「files_touched 说得对不对」这一项**本回合没有答案**——不是通过，是没查。');
  } else {
    // 8.1 overclaimed：声称了、但本次会话从未 write/edit 过
    //
    // 用**未过滤**的实际集合：过滤是给 under-reporting 用的
    // （「剩下的是应该被登记的源码」）。若这一侧也用过滤后的集合，
    // 「声称改了一个 .md 而且确实写了」会被误报成 overclaim。
    const overclaimed = [...claimed.entries()]
      .filter(([k]) => !actual.has(k))
      .map(([, v]) => v.rel)
      .sort();
    if (overclaimed.length > 0) {
      fail('files_touched_overclaimed_by_harness',
        `这些路径在 files_touched 里，但 harness 日志显示本次会话从未对它们调用过 write/edit`
        + `（${overclaimed.length} 个，会话 ${targetMeta.id}，共 ${writeCalls.length} 次写操作）：\n`
        + overclaimed.slice(0, 12).map((p) => `  - ${p}`).join('\n')
        + (overclaimed.length > 12 ? `\n  … 另有 ${overclaimed.length - 12} 个` : '')
        + '\n\n判据口径：**harness 的 write/edit 调用记录**，不是 `git status`、也不是账本自述。'
        + `\n这比 R19 的 files_touched_overclaimed 强一档：R19 比对的是「相对 HEAD 有没有差异」，`
        + `一个文件在修复之前就脏、本轮一个字没碰，它也能蒙混过去；`
        + `这里比对的是「有没有人真的写过它」。`
        + `\n规则：files_touched_overclaimed_by_harness。`
        + `\n补法：要么真的去改（然后重跑），要么从 files_touched 里删掉这些条目。`
        + `不要用「它在仓库里存在 / 它已经脏了」当改动凭证——凭证是写动作本身。`,
        { paths: overclaimed });
    }

    // 8.2 underreported：写了源码、没有声称
    //
    // 只看源码（SRC_EXT）且非噪音前缀。修复相位里必然有合法噪音——
    // 产物 .md、日志、repair-artifacts/、experiments/、构建输出。
    // 无条件升 FAIL 会让每个回合都红，然后这条规则被整体关掉（那比漏报更糟）。
    //
    // R23：再加一层「文件现在还在不在」。write/edit 记录里有、但文件现在不存在
    // 的源码，是**写完就删的一过性探针**，不是「改了却没登记」——
    // `files_touched` 的语义是「这个实例改动了哪些文件」，仓库最终状态里没有它，
    // 就不构成改动。它们单独走 INFO（probe_files_deleted），不静默过滤。
    const unclaimed = [...actual.entries()].filter(([k]) => !claimed.has(k));
    const unclaimedNoise = unclaimed.filter(([, v]) => !isSourcePath(v.rel));

    const unclaimedSourceAll = unclaimed.filter(([, v]) => isSourcePath(v.rel)).map(([, v]) => v);
    const unclaimedSource = [];
    const probeFiles = [];
    const probeNoEvidence = [];
    for (const v of unclaimedSourceAll) {
      // 两个条件都要求，缺一不可（见 §6.5 的说明）：
      //   (a) 文件现在不存在   (b) harness 记过指向它的删除动作
      // existsNow 为 null（判断不了）时**不甄别**：归入正常判据，不放过。
      if (existsNow(v.rel) !== false) { unclaimedSource.push(v); continue; }
      const ev = deleteEvidenceFor(v.rel);
      if (ev.length > 0) probeFiles.push({ ...v, deleteCommands: ev });
      else probeNoEvidence.push(v);
    }
    // 文件不在磁盘上、但日志里没有任何删除动作 → 不当作探针，照旧判 under-reported。
    for (const v of probeNoEvidence) unclaimedSource.push(v);
    unclaimedSource.sort((a, b) => (a.rel < b.rel ? -1 : 1));
    probeFiles.sort((a, b) => (a.rel < b.rel ? -1 : 1));
    outUnderreported = unclaimedSource.map((v) => v.rel);
    outProbeFiles = probeFiles.map((v) => v.rel);

    if (probeFiles.length > 0) {
      // INFO，不是 WARN：这是**正确**的用法（验证完就清理），不是账本的瑕疵。
      // 但必须显式列出来——静默过滤等于规则自己决定什么不重要，
      // 而「写了又忘删」恰恰是真正该报的情形（那时文件还在，会进上面的 FAIL）。
      info('probe_files_deleted',
        `harness 记录了 ${probeFiles.length} 个源码文件的写入，但这些文件在 target_repo 里已不存在`
        + `（写入后删除的一过性探针/临时脚本），不参与 files_touched 对账：\n`
        + probeFiles.slice(0, 12).map((v) => `  - ${v.rel}（${v.calls} 次写操作；`
          + `删除动作 ${v.deleteCommands.length} 条）`).join('\n')
        + (probeFiles.length > 12 ? `\n  … 另有 ${probeFiles.length - 12} 个` : '')
        + '\n\n判据（两条都要）：harness 有 write/edit 记录 **且** 该文件当前不在磁盘上，'
        + `**且** harness 的 shell 调用里记过一条指向它的删除动作。`
        + `\n为什么这不算 under-reported：files_touched 的语义是「这个实例**改动了**哪些文件」，`
        + `一个写完就删的临时文件不构成改动——仓库最终状态里没有它。`
        + `\n为什么还要「删除动作」这一条：光看「文件不在」分辨不出「写完删了」和`
        + `「日志里的 write 根本没落盘 / 基准指错了」。后者照旧判 under-reported（FAIL）。`
        + `\n但请注意区分：如果一个探针**写了却忘了删**，它会留在仓库里，`
        + `那时规则照旧判 under-reported（FAIL）——那才是真的留下了未登记的文件。`
        + `\n如果你认为其中某些不该删，检查它们是否被误删。`,
        {
          paths: probeFiles.map((v) => v.rel),
          calls: probeFiles.map((v) => v.calls),
          deleteEvidence: probeFiles.map((v) => ({ path: v.rel, commands: v.deleteCommands })),
        });
    }

    if (unclaimedSource.length > 0) {
      fail('files_touched_underreported_by_harness',
        `harness 记录本次会话写了 ${unclaimedSource.length} 个源码文件，`
        + `但没有任何 fix 产物登记它们（会话 ${targetMeta.id}）：\n`
        + unclaimedSource.slice(0, 12).map((v) => `  - ${v.rel}（${v.calls} 次写操作）`).join('\n')
        + (unclaimedSource.length > 12 ? `\n  … 另有 ${unclaimedSource.length - 12} 个` : '')
        + '\n\n判据口径：这是**外部基准**判的，不是 `git status` 差值猜的。'
        + `R19 的 underreported 拿仓库改动当分母，被「修复前就脏」干扰（R20 才补上基线）；`
        + `这里的分母是「这个 session 真的写了什么」，与仓库脏不脏无关。`
        + `\n规则：files_touched_underreported_by_harness。这就是 R18 §6 说的 under-reporting：`
        + `一个实例改了 10 个文件，只列 1 个存在的，存在性检查完全绿。`
        + `\n已排除的噪音（${unclaimedNoise.length} 个写目标）：产物 .md / 日志 / `
        + `repair-artifacts/ experiments/ docs/ target/ build/ 等前缀——排除之后**剩下的**`
        + `才叫「应该被 files_touched 覆盖的东西」。`
        + (probeFiles.length > 0
          ? `\n另已识别 ${probeFiles.length} 个「写了又删」的探针（见 INFO probe_files_deleted），`
            + `它们不算改动、不在本条里。`
          : '')
        + `\n补法：把这些源码改动登记进对应 fix 产物的 payload.files_touched，`
        + `或确认它们不属于本次修复并说明来源。`,
        { paths: unclaimedSource.map((v) => v.rel), ignoredNonSource: unclaimedNoise.map(([, v]) => v.rel),
          probeFilesDeleted: probeFiles.map((v) => v.rel) });
    } else if (unclaimed.length > 0) {
      info('more_actual_than_claimed_files',
        `harness 记录了 ${unclaimed.length} 个未被 files_touched 登记的文件，`
        + `但它们都不是源码（${unclaimed.slice(0, 8).map(([, v]) => v.rel).join('、')}`
        + `${unclaimed.length > 8 ? ' …' : ''}），按噪音处理，不判 under-reported。`,
        { paths: unclaimed.map(([, v]) => v.rel) });
    }
  }

  // ── 9 · 归属：fix_agent_id 能映射到子 session 时逐实例对账 ──
  //
  // R19 §(b)：`files_touched` 没有 agent_id 维度，对账是全局的。
  // dsh 的子 session 有 parentSession，所以只要 fix_agent_id 就是子 session 的 id
  // （命名习惯见 run-state.md），就能把「谁写的」拆到实例粒度。
  // 映射不到时**不能瞎猜**——不是所有 harness 都能把 agent_id 映射到 session，
  // 强行 FAIL 会让所有用逻辑名的项目永远红。降级为 WARN，但必须可见。
  const contracts = Array.isArray(state.fix_contracts) ? state.fix_contracts : [];
  const fixAgentIds = [...new Set(
    contracts.map((c) => (typeof c?.fix_agent_id === 'string' ? c.fix_agent_id.trim() : '')).filter(Boolean),
  )];
  const children = scanned.filter((s) => (s.meta.delegationDepth ?? 0) > 0 && s.meta.parentSession);
  const mapped = [];
  for (const id of fixAgentIds) {
    const hit = children.find((s) => dirNameMatchesId(s.dir.name, id) || s.meta.id === id);
    if (hit) mapped.push({ agentId: id, session: hit });
  }

  // 逐实例的写入（同样只算源码、非噪音）
  const writesBySession = new Map();
  for (const w of writeCalls) {
    const n = normalizePath(w.raw, repoBase);
    if (!n.ok || n.rel === '' || !isSourcePath(n.rel)) continue;
    const arr = writesBySession.get(w.sessionId) ?? [];
    arr.push(n);
    writesBySession.set(w.sessionId, arr);
  }

  const attributionMismatches = [];
  const attributionProbes = [];
  for (const m of mapped) {
    const own = writesBySession.get(m.session.meta.id) ?? [];
    const ownKeys = new Set(own.map((n) => n.key));
    const claimedByAgent = new Set();
    for (const [k, v] of claimed) if (v.agents.has(m.agentId)) claimedByAgent.add(k);
    const rawUncovered = [...new Map(own.filter((n) => !claimedByAgent.has(n.key)).map((n) => [n.key, n])).values()];
    // R23：逐实例对账同样不能把「写完就删的探针」算成漏登记（与 8.2 同一判据：
    // 文件现在不存在 **且** harness 记过删除动作）。判不了（null）时同样不甄别。
    const uncovered = [];
    for (const n of rawUncovered) {
      if (existsNow(n.rel) === false && deleteEvidenceFor(n.rel).length > 0) {
        attributionProbes.push({ agentId: m.agentId, rel: n.rel });
      } else uncovered.push(n);
    }
    if (uncovered.length > 0) {
      attributionMismatches.push({ agentId: m.agentId, sessionId: m.session.meta.id, paths: uncovered.map((n) => n.rel) });
      fail('agent_attribution_mismatch',
        `子 session ${m.session.meta.id}（fix_agent_id = ${m.agentId}）写了 ${uncovered.length} 个源码文件，`
        + `但它自己的 files_touched 没有登记：\n`
        + uncovered.map((n) => `  - ${n.rel}`).join('\n')
        + `\n\n它自己的 files_touched 覆盖了 ${claimedByAgent.size} 个文件`
        + `（${[...claimed].filter(([k]) => claimedByAgent.has(k)).map(([, v]) => v.rel).join('、') || '（空）'}），`
        + `写操作记录里还有 ${ownKeys.size} 个文件中的 ${uncovered.length} 个不在其中。`
        + `\n规则：agent_attribution_mismatch。这条回答的是 R19 §(b) 的归属问题：`
        + `「files_touched 没有 agent_id 维度，对账是全局的不是逐实例的」——`
        + `全局对账里，A 实例少登记的文件只要被 B 实例登记过就两边都绿。`
        + `逐实例对账之后，这种互相抵消不成立了。`
        + `\n补法：把漏掉的路径补进这个实例自己的 files_touched（信封的 agent_id 要与 fix_agent_id 一致）。`,
        { agentId: m.agentId, sessionId: m.session.meta.id, paths: uncovered.map((n) => n.rel) });
    }
  }
  if (attributionProbes.length > 0) {
    // 逐实例侧同样显式列出，理由与 8.2 一致：静默过滤等于规则自己决定什么不重要。
    info('probe_files_deleted_by_agent',
      `逐实例对账时，有 ${attributionProbes.length} 个子 session 的写后已删探针被排除在外`
      + `（文件现在不存在，不构成改动）：\n  `
      + attributionProbes.slice(0, 12).map((p) => `${p.rel}（fix_agent_id = ${p.agentId}）`).join('\n  ')
      + (attributionProbes.length > 12 ? `\n  … 另有 ${attributionProbes.length - 12} 个` : '')
      + '\n  判据与 probe_files_deleted 相同：harness 有 write/edit 记录且文件当前不在磁盘上。',
      { probes: attributionProbes });
  }
  if (fixAgentIds.length > 0 && mapped.length === 0) {
    warn('agent_attribution_unavailable',
      `账本里有 ${fixAgentIds.length} 个 fix_agent_id（${fixAgentIds.slice(0, 6).join('、')}`
      + `${fixAgentIds.length > 6 ? ' …' : ''}），但没有任何一个能对应到 harness 的子 session `
      + `（本次扫描了 ${scanned.length} 个 session：${scanned.map((s) => s.meta.id).join('、')}）。\n`
      + '  因此本轮只做了**全局**对账（所有 session 的写操作合并 vs 所有 files_touched 合并），'
      + '没有做**逐实例**对账。\n'
      + '  这不是账本的错——不是所有 harness 都能把 agent_id 映射到 session，'
      + '用「fix-agent-1」这类逻辑名也是合法的。所以只 WARN，不 FAIL。'
      + '但如果你的 harness 有子 session 且 fix_agent_id 就写成子 session 的 id，'
      + '这条对账会自动生效，并能抓到「A 的漏登记被 B 的登记抵消」这种情形。',
      { fixAgentIds, scanned: scanned.map((s) => s.meta.id) });
  }

  // ── 10 · 输出 ──
  const failCount = problems.filter((p) => p.level === 'FAIL').length;
  finish(failCount > 0 ? 1 : 0, {
    harness: 'dsh',
    sessionsRoot: root,
    projectDir: basename(target.project),
    state: ARGS.state,
    session: {
      id: targetMeta.id,
      dir: target.abs,
      delegationDepth: targetMeta.delegationDepth,
      cwd: targetMeta.cwd,
      file: targetRead.file,
    },
    sessionsScanned: scanned.length,
    actualScope,
    scannedSessionIds: scanned.map((s) => s.meta.id),
    repoBase,
    repoSource,
    claimedFiles: claimedCount,
    claimedRaw: claimedRaw.length,
    fixEnvelopeCount,
    writeEditCalls: writeCalls.length,
    actualFiles: actual.size,
    ignoredNonSourceWrites: [...actual.entries()]
      .filter(([k]) => !claimed.has(k) && !isSourcePath(actual.get(k).rel)).length,
    unparsedWrites,
    overclaimed: fixEnvelopeCount > 0
      ? [...claimed.entries()].filter(([k]) => !actual.has(k)).map(([, v]) => v.rel)
      : [],
    underreported: outUnderreported,
    // R23：写了源码、但文件现在已不存在的一过性探针（INFO，不判 under-reported）。
    probeFilesDeleted: outProbeFiles,
    attribution: {
      mapped: mapped.length,
      unmapped: fixAgentIds.length - mapped.length,
      mismatches: attributionMismatches,
      probeFilesDeleted: [...new Set(attributionProbes.map((p) => p.rel))].sort(),
    },
  });

  function printHuman(r) {
    const line = '─'.repeat(66);
    console.log(`\n${line}`);
    console.log('files_touched × harness write/edit 记录对账');
    console.log(line);
    console.log(`  账本:    ${r.state}`);
    console.log(`  root:    ${r.sessionsRoot}`);
    console.log(`  session: ${r.session?.id ?? '（无）'}`);
    console.log(`  日志:    ${r.session?.file ?? '（无）'}`);
    console.log(`  路径基准: ${r.repoBase ?? '（无）'}（来自 ${r.repoSource ?? '无'}）`);
    console.log('');
    console.log('声称侧（files_touched）');
    console.log(`  fix 信封数            : ${r.fixEnvelopeCount}`);
    console.log(`  不同文件数            : ${r.claimedFiles}`);
    console.log('实际侧（write/edit 记录）');
    console.log(`  扫描范围              : ${r.actualScope === 'project'
      ? `该 project 目录下全部 ${r.sessionsScanned} 个 session（含子 agent）`
      : `指定的 session 及其子 session（${r.sessionsScanned} 个）`}`);
    console.log(`  write/edit 调用数     : ${r.writeEditCalls}`);
    console.log(`  不同被写文件数        : ${r.actualFiles}`);
    console.log(`  其中未登记的非源码    : ${r.ignoredNonSourceWrites}`);
    console.log(`  其中写后已删的探针    : ${(r.probeFilesDeleted ?? []).length}（INFO，不参与对账）`);
    console.log(`  归属（能映射的实例）  : ${r.attribution?.mapped ?? 0}`);
    console.log('');
    if (r.problems.length === 0) {
      console.log('✓ files_touched 与 harness 的 write/edit 记录一致（无 FAIL / WARN）。');
    } else {
      for (const p of r.problems) {
        const tag = p.level === 'FAIL' ? '✗ FAIL' : p.level === 'WARN' ? '! WARN' : '· INFO';
        console.log(`${tag} [${p.rule}]`);
        for (const l of String(p.message).split('\n')) console.log(`    ${l}`);
        console.log('');
      }
    }
    const n = (lv) => r.problems.filter((p) => p.level === lv).length;
    console.log(`合计: ${n('FAIL')} FAIL / ${n('WARN')} WARN / ${n('INFO')} INFO → exit ${r.exitCode}\n`);
  }
}

// 只有直接执行时才跑主流程。测试文件会 `import` 本模块来单测 normalizePath，
// 若无条件执行，import 就会把 CLI 逻辑跑一遍并 process.exit。
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
const selfPath = resolve(fileURLToPath(import.meta.url));
const sameFile = IS_WIN
  ? invokedPath.toLowerCase() === selfPath.toLowerCase()
  : invokedPath === selfPath;
if (sameFile) main();

// 供集成层（stop-hook）与测试使用
export { SRC_EXT, NOISE_PREFIXES, WRITE_TOOLS, isNoisePath, isSourcePath };