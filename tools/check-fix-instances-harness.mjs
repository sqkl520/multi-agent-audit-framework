#!/usr/bin/env node
/**
 * check-fix-instances-harness.mjs — 用 harness 的**真实 session 日志**核对账本声称的修复实例数
 *
 * ── 为什么需要它 ─────────────────────────────────────────────────────
 * R7（`experiments/hilltop-dsh/FIX-R7-report.md` §4「洞 1」）实测出一条完整绕过：
 *
 *     8 条 HIGH 全部登记成 8 个**不同**的 fix_agent_id（fake-agent-1..8），
 *     budget.spawned_fix_agents: 8，每条 target_files 不同。
 *     主 Agent 实际仍是 1 个 session 串行做完。
 *     → stop-hook exit 0 | check-fix-instances exit 0 | missing 0 | rules []
 *
 * 为什么两道门都放行：
 *   - `stop-hook.mjs` 比较 distinct(finding_id) 与 `spawned_fix_agents`
 *   - `check-fix-instances.mjs`（R6）比较 distinct(fix_agent_id) 与 `spawned_fix_agents`
 *   三个数**全部来自 `state.json`**，是主 Agent 的自述。两个自述互相一致，
 *   不产生任何外部约束力——账本记的不是派发事实，而是主 Agent 对自己工作的印象。
 *
 * 本脚本引入的唯一外部基准是 **harness 自己落的 session 日志**：
 * 主 session 到底发起过几次 `subagent` 工具调用。这个数字主 Agent 不能随手改，
 * 它是 harness 在执行时写下的记录。
 *
 * ── 数据来源（dsh）───────────────────────────────────────────────────
 *   <sessions-root>/<project-dir>/session-<uuid>/session.v4.jsonl.zstd
 *
 *   - zstd 压缩的 JSONL，Node ≥ 22.15 / 24 用 `zlib.zstdDecompressSync` 解
 *   - `session` 事件的字段在**顶层**（不在 `.data` 里）：
 *       { type:'session', version, id, cwd, delegationDepth, parentSession?, origin? }
 *   - `tool/call` 事件：`.data.name`（如 'subagent'）+ `.data.arguments`（JSON 字符串）
 *   - `request/header` 事件：`.data.header.tools[].name` —— 判断 harness 有没有 subagent 能力
 *   - 子 agent 的 session：`delegationDepth: 1` + `parentSession: <父 session id>` + `origin: 'subagent'`
 *
 * ── **这个检查器只有 dsh 能用吗？** ───────────────────────────────────
 * **是。当前只实现了 dsh 的格式。** Claude Code 的 session 格式完全不同，
 * 它把会话写成：
 *
 *     ~/.claude/projects/<slug>/<session-uuid>.jsonl
 *
 * 未压缩的 JSONL，每行一个消息/事件，子 agent（Task 工具）的记录在同一目录下的
 * 独立 jsonl 里。要支持它，需要在本文件的 `readSessionEvents()` 旁边加一个
 * `readClaudeCodeSession()` 适配器，并把「真实的 subagent 调用次数」映射到
 * Task 工具调用数（`type:"assistant"` 里 `content[].type === "tool_use"` 且
 * `name === "Task"`），子 session 的父子关系则要从 `isSidechain` / `parentUuid` 推。
 * 本轮没有实现，**故意不做半成品**。
 *
 * 因此本检查器对「不是 dsh」的 sessions root 采取**降级而非阻断**：
 *   探测不到任何 `session.v4.jsonl.zstd` → `unsupported_harness` → **exit 0 + WARN**。
 * 理由：一个只支持 dsh 的工具，不该在别的 harness 上把整个修复流程卡死。
 * 宁可让它沉默（并在输出里明确写「本 harness 未被验证」），也不能把
 * 「工具不支持」误报成「账本造假」。
 *
 * 唯一例外：用户**显式**传了 `--session-id` 却在 root 下找不到 → `session_not_found`
 * → exit 2。因为那说明路径或 id 给错了，继续跑只会得到假绿。
 *
 * ── 用法 ─────────────────────────────────────────────────────────────
 *   node check-fix-instances-harness.mjs --state <state.json> --sessions <dsh sessions root>
 *        [--session-id <id>] [--project-dir <dir>] [--json]
 *
 *   --state        `state.json`。读 `fix_contracts[].fix_agent_id`、`budget.spawned_fix_agents`。
 *   --sessions     dsh sessions 根目录（其下是 `<project-dir>/<session-dir>/session.v4.jsonl.zstd`）。
 *   --session-id   主 session 的 id。**省略时自动取该 project 目录下最新的顶层 session
 *                  （delegationDepth: 0，按 session 文件 mtime 排序）**。
 *   --project-dir  显式指定 project 目录名。dsh 的目录名本身以 `--` 开头
 *                  （如 `--D-Projects-foo--`），位置参数无法区分 flag 与值，
 *                  所以只能靠这个显式 flag。省略时若 root 下只有一个 project 目录则自动识别，
 *                  多于一个则报 `project_dir_ambiguous`（exit 2），不猜。
 *   --json         输出机器可读 JSON。
 *   --help / -h    打印说明，exit 0。
 *
 * ── 规则（每条独立命名）──────────────────────────────────────────────
 *   sessions_root_missing                 sessions root 不存在                        exit 2
 *   state_missing / state_invalid         state.json 不存在 / 解析失败                exit 2
 *   session_not_found                     找不到指定/推断的 session                   exit 2
 *   session_undecodable                   找到文件但 zstd 解不开 / 没有 session 事件  exit 2
 *   project_dir_ambiguous                 root 下有多个 project 目录且未指定          exit 2
 *   unsupported_harness                   root 下没有任何 dsh 格式日志                exit 0 + WARN
 *   claimed_agents_exceed_real_subagents  **核心**：distinct(fix_agent_id) > 真实调用数 FAIL
 *   zero_subagent_but_multiple_agents     **核心**：真实调用 0 次但 ≥2 个 id          FAIL
 *   spawned_count_exceeds_real             spawned_fix_agents > 真实调用数             FAIL
 *   no_subagent_capability                 request/header 里没有 subagent 工具         WARN（合法降级）
 *   child_sessions_missing                真实调用 N 次但只找到 <N 个子 session         WARN
 *   session_id_mismatch                   fix_agent_id 像 session id 却找不到          WARN
 *   capability_unknown                    日志里没有 request/header，无法判断能力     WARN
 *   project_dir_inferred                  自动识别了 project 目录（仅提示）            INFO
 *   more_real_dispatches_than_claimed     真实调用多于账本（多派发不是违规）           INFO
 *
 * 退出码：0 = 通过（允许 WARN/INFO） / 1 = 有 FAIL / 2 = 配置错误
 *
 * ── 与 no_subagent_capability 的关系 ─────────────────────────────────
 * 若 harness 的工具集里根本没有 `subagent`，说明这个环境**不可能**派发子 agent。
 * 此时 `fix_agent_id` 只能是逻辑分组，唯一的申报通道是 `discipline_log`
 * ——这是 `run-state.md` 认可的合法降级。所以在这种情况下，
 * rule 3 / rule 4 / rule 5 **一律降级为 WARN**，不判 FAIL。
 * 否则每一个没有 subagent 能力的 harness 都会永远红，防线会被人直接关掉。
 *
 * ── 它不检查什么 ─────────────────────────────────────────────────────
 *   - 修复质量（改得对不对）——要读代码
 *   - 子 session 里到底做了什么——那是 `dsh-session-audit.mjs` 的职责
 *   - `target_files` 是否真的覆盖了缺陷
 *   它只回答一个问题：**账本说派发了 N 个实例，harness 说主 session 发起了 M 次派发，
 *   N 与 M 对得上吗？**
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

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

const ARGS = parseArgs(process.argv);

if (ARGS.help) {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
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

function finish(exitCode, extra = {}) {
  const result = { ...extra, problems, infos, exitCode };
  if (ARGS.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  process.exit(exitCode);
}

function configError(rule, message) {
  if (ARGS.json) {
    console.log(JSON.stringify({ problems: [{ level: 'CONFIG', rule, message }], exitCode: 2 }, null, 2));
  }
  console.error(`\n[配置错误] ${rule}`);
  console.error(`  ${message}\n`);
  process.exit(2);
}

// ────────────────────────────────────────────────────────────────────
// 0 · 参数与 state
// ────────────────────────────────────────────────────────────────────
if (ARGS.badArg) configError('usage', `未知或不完整参数: ${ARGS.badArg}\n  用法见 --help。`);
if (!ARGS.state) configError('usage', '缺少必填参数 --state <state.json>');
if (!ARGS.sessions) configError('usage', '缺少必填参数 --sessions <dsh sessions root>');

if (!existsSync(ARGS.state)) {
  configError('state_missing',
    `state.json 不存在: ${ARGS.state}\n`
    + '  本检查器的全部结论都建立在「账本声称了什么」之上，没有账本就无从对账。');
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

const contracts = Array.isArray(state.fix_contracts) ? state.fix_contracts : [];
const fixAgentIds = [...new Set(
  contracts
    .map((c) => (typeof c?.fix_agent_id === 'string' ? c.fix_agent_id.trim() : ''))
    .filter(Boolean),
)];
const claimedAgents = fixAgentIds.length;
const rawSpawned = state.budget?.spawned_fix_agents;
const spawned = typeof rawSpawned === 'number' && Number.isFinite(rawSpawned) ? rawSpawned : 0;
const spawnedPresent = typeof rawSpawned === 'number' && Number.isFinite(rawSpawned);

const root = resolve(ARGS.sessions);
if (!existsSync(root)) {
  configError('sessions_root_missing',
    `sessions 根目录不存在: ${root}\n`
    + '  没有 harness 日志就没有外部基准，本检查器的核心规则会全部失去依据。'
    + '（注意：这与「日志里显示 0 次派发」是两件完全不同的事，不能混为一谈。）');
}

// ────────────────────────────────────────────────────────────────────
// 1 · 探测 harness 格式，并列出所有 session 目录
//
// dsh：<root>/<project-dir>/<session-dir>/session.v4.jsonl.zstd
// 也允许 <root> 本身就是一个 project 目录（<root>/<session-dir>/…）。
// ────────────────────────────────────────────────────────────────────
const DSH_FILE = 'session.v4.jsonl.zstd';

function listSessionDirs(base) {
  const out = [];
  const entries = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  for (const e of entries) {
    const full = join(base, e.name);
    if (existsSync(join(full, DSH_FILE))) {
      out.push({ project: base, abs: full, name: e.name });
      continue;
    }
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
}

const allSessionDirs = listSessionDirs(root);

if (allSessionDirs.length === 0) {
  // 显式指定了 id 却一份日志都没有 → 路径/id 给错了，退出 2 而不是假装通过
  if (ARGS.sessionId) {
    configError('session_not_found',
      `指定了 --session-id ${ARGS.sessionId}，但 ${root} 下没有任何 ${DSH_FILE}\n`
      + '  可能是 --sessions 指错了目录，或者这个 harness 的日志格式不是 dsh 的。');
  }
  // 探测不到 dsh 格式 → 降级：WARN + exit 0（不能让只支持 dsh 的工具卡死别家 harness）
  warn('unsupported_harness',
    `在 ${root} 下没有找到任何 ${DSH_FILE}，判断这不是 dsh 的 session 目录结构。\n`
    + '  本检查器当前**只实现了 dsh 的格式**，因此无法用 harness 侧证据核对账本。\n'
    + '  这是「工具没覆盖」，不是「账本合规」——WARN 必须可见，但不能升成 FAIL，\n'
    + '  否则换一个 harness 就会把整个修复流程卡死。\n'
    + '  Claude Code 的日志在 ~/.claude/projects/<slug>/<session-uuid>.jsonl，\n'
    + '  子 agent 记录是其中的 sidechain / Task 工具调用，需要单独的适配器（见文件头）。',
    { sessionsRoot: root });
  finish(0, {
    harness: 'unknown', sessionsRoot: root, state: ARGS.state,
    claimedAgents, spawned, spawnedPresent, fixAgentIds,
    session: null, realSubagentCalls: null, realToolCalls: null, realSteps: null,
    childSessions: null, hasSubagentCapability: null,
  });
}

// ────────────────────────────────────────────────────────────────────
// 2 · 读取 session
// ────────────────────────────────────────────────────────────────────
function readSessionEvents(dir) {
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
}

function sessionMeta(events) {
  const head = events.find((e) => e.type === 'session');
  return {
    id: head?.id ?? null,
    parentSession: head?.parentSession ?? null,
    origin: head?.origin ?? null,
    delegationDepth: head?.delegationDepth ?? null,
    cwd: head?.cwd ?? null,
  };
}

const countType = (events, type) => events.filter((e) => e.type === type).length;

/** 目录名与 session id 的对应：dsh 里顶层目录是 `session-<uuid>`，子 session 目录是裸 uuid。 */
function dirNameMatchesId(dirName, id) {
  if (!dirName || !id) return false;
  if (dirName === id) return true;
  const bare = id.startsWith('session-') ? id.slice('session-'.length) : id;
  return dirName === bare || `session-${dirName}` === id || dirName === `session-${bare}`;
}

function findSessionDirById(id) {
  const hits = allSessionDirs.filter((s) => dirNameMatchesId(s.name, id));
  if (hits.length > 0) return hits[0];
  // 兜底：目录名与 id 不一致时，逐个解码比对（只在名字匹配失败时发生）
  for (const s of allSessionDirs) {
    const r = readSessionEvents(s.abs);
    if (!r || r.error) continue;
    const meta = sessionMeta(r.events);
    if (meta.id === id) return s;
  }
  return null;
}

let target = null;

if (ARGS.sessionId) {
  target = findSessionDirById(ARGS.sessionId);
  if (!target) {
    configError('session_not_found',
      `在 ${root} 下找不到 session id = ${ARGS.sessionId} 的日志。\n`
      + `  已扫描 ${allSessionDirs.length} 个 dsh session 目录（目录名与 session 事件的 id 都比对过）。\n`
      + '  账本声称的派发必须有对应的 harness 记录；找不到记录时本检查器不会替你假设「大概跑过」。');
  }
} else {
  // 推断 project 目录
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
    // 不猜：猜错 project 会拿另一个 session 的日志去判本次账本，得到的是错误结论
    configError('project_dir_ambiguous',
      `${root} 下有 ${projectDirs.length} 个 project 目录，无法自动判断本次账本属于哪一个：\n  `
      + projectDirs.map((p) => basename(p)).join('\n  ')
      + '\n  请用 --project-dir <目录名> 指定，或用 --session-id 直接指定主 session。');
  }
  info('project_dir_inferred', `自动识别的 project 目录: ${basename(projectDir)}`);

  // 该 project 下所有 session 都读一遍，取最新的顶层（delegationDepth: 0 / 无）
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
      + '（delegationDepth: 0）——只有子 agent 的记录，主 session 的日志不在或已被清理。\n'
      + '  没有主 session 的日志就无法统计「主 session 发起过几次派发」。');
  }
  tops.sort((a, b) => b.r.mtimeMs - a.r.mtimeMs);
  target = tops[0].s;
}

// ────────────────────────────────────────────────────────────────────
// 3 · 从日志里数事实
// ────────────────────────────────────────────────────────────────────
const read = readSessionEvents(target.abs);
if (!read || read.error) {
  configError('session_undecodable',
    `找到 ${join(target.abs, DSH_FILE)} 但读不出事件${read?.error ? `：${read.error}` : ''}。\n`
    + '  解不开的日志不能当作「0 次派发」——那是把读取失败误报成账本造假。');
}
const events = read.events;
const meta = sessionMeta(events);
if (!meta.id) {
  configError('session_undecodable',
    `${join(target.abs, DSH_FILE)} 里没有 type="session" 的事件，无法确认这是哪个 session。`);
}

const SPAWN_TOOLS = ['subagent', 'subagent_fork'];

const toolCalls = events.filter((e) => e.type === 'tool/call');
let realSubagentCalls = toolCalls.filter((e) => e.data?.name === 'subagent').length;
let realForkCalls = toolCalls.filter((e) => e.data?.name === 'subagent_fork').length;

// 兜底：如果整份日志没有 tool/call 事件（有些 harness 版本只在 assistant 消息里记
// tool-call 内容块），从 assistant/message 的内容块里数，避免把「日志格式差异」判成造假。
let countedFrom = 'tool/call';
if (toolCalls.length === 0) {
  const blocks = events
    .filter((e) => e.type === 'assistant/message')
    .flatMap((e) => (e.data?.message?.content ?? []).filter((c) => c?.type === 'tool-call'));
  if (blocks.length > 0) {
    countedFrom = 'assistant/message.tool-call';
    realSubagentCalls = blocks.filter((b) => b.name === 'subagent').length;
    realForkCalls = blocks.filter((b) => b.name === 'subagent_fork').length;
  }
}
const realSpawnCalls = realSubagentCalls + realForkCalls;
const realToolCalls = toolCalls.length;
const realSteps = countType(events, 'step/start');

// 工具集：判断这个 harness 到底有没有 subagent 能力
const headers = events.filter((e) => e.type === 'request/header');
const headerTools = headers
  .map((e) => (Array.isArray(e.data?.header?.tools) ? e.data.header.tools.map((t) => t?.name).filter(Boolean) : null))
  .filter(Boolean)
  .flat();
const hasHeader = headers.some((e) => Array.isArray(e.data?.header?.tools));
// 只要任意一次请求的工具集里有 subagent 系工具，就认为具备该能力
const hasSubagentCapability = hasHeader
  ? headers.some((e) => Array.isArray(e.data?.header?.tools)
      && e.data.header.tools.some((t) => SPAWN_TOOLS.includes(t?.name)))
  : null;
// 一次 subagent 都没调用、且工具集里也没有 → 合法降级（不判 FAIL）
const noCapability = hasSubagentCapability === false && realSpawnCalls === 0;

// 子 session：与主 session 同一个 project 目录里，parentSession == 主 session id
let childSessions = null;
try {
  const siblings = allSessionDirs.filter((s) => s.project === target.project);
  let n = 0;
  for (const s of siblings) {
    if (s.abs === target.abs) continue;
    const r = readSessionEvents(s.abs);
    if (!r || r.error) continue;
    const m = sessionMeta(r.events);
    if (m.parentSession && m.parentSession === meta.id) n++;
  }
  childSessions = n;
} catch { childSessions = null; }

// ────────────────────────────────────────────────────────────────────
// 4 · 规则
// ────────────────────────────────────────────────────────────────────

// 规则 6 · no_subagent_capability 先算，因为后面三条要看它决定 FAIL 还是 WARN
if (hasHeader && !hasSubagentCapability) {
  warn('no_subagent_capability',
    `该 session 的 request/header 里没有 subagent 工具（工具集：${headerTools.join('、') || '（空）'}）。\n`
    + `  这说明本 harness **不支持派发子 agent**，因此账本里的 ${claimedAgents} 个 fix_agent_id `
    + '只能是逻辑分组，不是物理实例。\n'
    + '  这种情况下唯一可用的申报通道是 discipline_log（run-state.md 认可的合法降级），\n'
    + '  本检查器因此把下列计数类规则降级为 WARN，不判 FAIL。',
    { tools: headerTools });
} else if (hasSubagentCapability === null) {
  warn('capability_unknown',
    '该 session 的日志里没有 request/header 事件，无法判断这个 harness 有没有 subagent 能力。\n'
    + '  仍然按「有」处理（更严格），但如果下面出现 FAIL 且你确定环境本身不支持派发，\n'
    + '  那就是本检查器的误报，请以 discipline_log 的申报为准。');
}

// 规则 3 / 4 · 核心：账本声称的实例数 vs 真实派发次数
if (realSpawnCalls === 0 && claimedAgents >= 2) {
  // 规则 4：0 次真实派发 + ≥2 个 id —— 与 2026-11-15 事故完全同形，比规则 3 更精确，优先报这条
  const detail = `本 session 实测：${realToolCalls} 次工具调用、${realSteps} 个 step、0 次 subagent`;
  const msg =
    `账本里有 ${claimedAgents} 个不同的 fix_agent_id（${fixAgentIds.join('、')}），`
    + `但 harness 日志显示这个主 session 一次 subagent 都没有发起（${detail}）。\n`
    + '这与 2026-11-15 那次真实事故完全同形：303 次工具调用、196 个 step、0 次 subagent'
    + '——主 Agent 在自己一个 session 里串行做完了全部修复，'
    + `然后在账本上把「我修了 ${claimedAgents} 条」写成了「我派发了 ${claimedAgents} 个实例」。\n`
    + '账本记的是主 Agent 对自己工作的印象，session 日志是外部事实。'
    + `这 ${claimedAgents} 个 id 里有 ${claimedAgents} 个没有对应的真实派发`
    + '——没有任何外部依据证明这些实例存在过。\n'
    + (noCapability
      ? '（已降级为 WARN：本 harness 的工具集里没有 subagent，只能靠 discipline_log 申报。）'
      : '请真正按缺陷逐条派发独立实例，或改用 discipline_log 如实申报「单实例串行」并说明理由。');
  if (noCapability) warn('zero_subagent_but_multiple_agents', msg, { claimedAgents, realSpawnCalls });
  else fail('zero_subagent_but_multiple_agents', msg, { claimedAgents, realSpawnCalls });
} else if (claimedAgents > realSpawnCalls) {
  // 规则 3：账本比真实多
  const gap = claimedAgents - realSpawnCalls;
  // 1 条契约 + 0 次真实派发：这在语义上仍属规则 3（账本比 harness 多），
  // 但它最可能的成因不是造假，而是「只有一条缺陷，主 Agent 自己改了」。
  // 按 run-state.md 的口径，「自己改」不是一次派发，spawned_fix_agents 不该记 1。
  // 所以仍然 FAIL（与规则 3 的字面一致），但额外给一条可操作提示。
  if (claimedAgents === 1 && realSpawnCalls === 0) {
    warn('single_contract_without_dispatch',
      `账本只有 1 条 fix_contract、没有真实派发。若这一条确实是主 Agent 自己在主 session 里改的，`
      + '那它就不是「派发了 1 个实例」——请把 fix_agent_id 去掉并把 spawned_fix_agents 记 0，'
      + '在 discipline_log 里如实申报「单条缺陷主实例自修」；'
      + '若确实派发过而日志里没有，说明 --session-id 指错了 session（子 session 自己不会记派发）。');
  }
  const msg =
    `账本声称派发了 ${claimedAgents} 个修复实例（fix_agent_id 去重 ${claimedAgents} 个），`
    + `但 harness 日志显示主 session 只发起了 ${realSpawnCalls} 次 subagent 调用`
    + `（subagent ${realSubagentCalls} 次 / subagent_fork ${realForkCalls} 次；`
    + `该 session 共 ${realToolCalls} 次工具调用、${realSteps} 个 step）。`
    + '账本记的是主 Agent 对自己工作的印象，session 日志是外部事实。'
    + `这 ${claimedAgents} 个 id 里有 ${gap} 个没有对应的真实派发。\n`
    + (noCapability
      ? '（已降级为 WARN：本 harness 的工具集里没有 subagent，只能靠 discipline_log 申报。）'
      : '差额的部分要么补上真实派发，要么从账本里删掉——账本不能比 harness 记的多。');
  if (noCapability) warn('claimed_agents_exceed_real_subagents', msg, { claimedAgents, realSpawnCalls, gap });
  else fail('claimed_agents_exceed_real_subagents', msg, { claimedAgents, realSpawnCalls, gap });
}

// 规则 5 · spawned_fix_agents 比真实多
if (spawned > realSpawnCalls) {
  const msg =
    `budget.spawned_fix_agents = ${spawned}，但 harness 日志显示主 session 只发起了 `
    + `${realSpawnCalls} 次 subagent 调用（subagent ${realSubagentCalls} 次 / subagent_fork ${realForkCalls} 次）。\n`
    + `spawned_fix_agents 的定义是「波次四**实际**派发的修复实例数，只能由实际计数写入，不得估算」`
    + '（run-state.md §2）。这里它比 harness 的事实多了 '
    + `${spawned - realSpawnCalls} 个。\n`
    + (noCapability
      ? '（已降级为 WARN：本 harness 不支持 subagent，该字段只能按 discipline_log 的申报口径解释。）'
      : '多出来的这部分没有任何 harness 记录支撑。');
  if (noCapability) warn('spawned_count_exceeds_real', msg, { spawned, realSpawnCalls });
  else fail('spawned_count_exceeds_real', msg, { spawned, realSpawnCalls });
}

// 规则 5b · 真实多于账本：不是违规，但必须可见（否则「账本漏记」会静默）
if (realSpawnCalls > spawned && spawnedPresent) {
  info('more_real_dispatches_than_claimed',
    `harness 日志显示 ${realSpawnCalls} 次真实派发，账本 spawned_fix_agents = ${spawned}`
    + '——多派发不是违规（重试、补派都合法），但账本少记会让后续的失败率与覆盖率算错，'
    + '建议回填为实际计数。',
    { spawned, realSpawnCalls });
}

// 规则 7 · 子 session 缺失
if (realSpawnCalls > 0 && childSessions !== null && childSessions < realSpawnCalls) {
  warn('child_sessions_missing',
    `harness 日志里有 ${realSpawnCalls} 次 subagent 调用，但在 sessions root 下只找到 `
    + `${childSessions} 个 parentSession == ${meta.id} 的子 session。\n`
    + `差额 ${realSpawnCalls - childSessions} 个可能是子 session 已归档/清理，`
    + '也可能派发失败了。子 session 缺失不足以单独判 FAIL（它可能真的被清理掉了），'
    + '但这意味着这部分派发的产物无法从日志侧复核。',
    { realSpawnCalls, childSessions });
}

// 规则 8 · fix_agent_id 长得像 session id 却不存在
const looksLikeSessionId = (s) => /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const idShaped = fixAgentIds.filter(looksLikeSessionId);
if (idShaped.length > 0) {
  const missing = idShaped.filter((id) => !allSessionDirs.some((s) => dirNameMatchesId(s.name, id)));
  if (missing.length > 0) {
    warn('session_id_mismatch',
      `fix_agent_id 里有 ${missing.length} 个看起来是 session id，但在 ${root} 下找不到对应 session：\n  `
      + missing.join('\n  ')
      + '\n  若它们确实是本 harness 的 session id，说明账本引用了一个不存在的派发；'
      + '若只是命名恰好像 uuid，可以忽略本警告。\n'
      + '  本规则只看目录名（不解压全部日志），因此「归档后目录被移走」也会命中——所以只是 WARN。',
      { missing });
  }
}

// ────────────────────────────────────────────────────────────────────
// 5 · 输出
// ────────────────────────────────────────────────────────────────────
const failCount = problems.filter((p) => p.level === 'FAIL').length;
const exitCode = failCount > 0 ? 1 : 0;

finish(exitCode, {
  harness: 'dsh',
  sessionsRoot: root,
  projectDir: basename(target.project),
  state: ARGS.state,
  session: {
    id: meta.id,
    dir: target.abs,
    delegationDepth: meta.delegationDepth,
    cwd: meta.cwd,
    file: read.file,
  },
  claimedAgents,
  spawned,
  spawnedPresent,
  fixAgentIds,
  realSubagentCalls,
  realSubagentForkCalls: realForkCalls,
  realSpawnCalls,
  realToolCalls,
  realSteps,
  childSessions,
  hasSubagentCapability,
  countedFrom,
});

// ────────────────────────────────────────────────────────────────────
function printHuman(r) {
  const line = '─'.repeat(66);
  console.log(`\n${line}`);
  console.log('修复实例 × harness session 日志对账');
  console.log(line);
  console.log(`  账本:   ${r.state}`);
  console.log(`  root:   ${r.sessionsRoot}`);
  console.log(`  session: ${r.session?.id ?? '（无）'}`);
  console.log(`  日志:   ${r.session?.file ?? '（无）'}`);
  console.log('');
  console.log('账本（自述）');
  console.log(`  distinct fix_agent_id : ${r.claimedAgents}`);
  console.log(`  spawned_fix_agents    : ${r.spawnedPresent ? r.spawned : '（缺失，按 0 处理）'}`);
  console.log('harness（外部事实）');
  console.log(`  subagent 调用         : ${r.realSubagentCalls}`);
  console.log(`  subagent_fork 调用    : ${r.realSubagentForkCalls}`);
  console.log(`  工具调用总数 / step   : ${r.realToolCalls} / ${r.realSteps}`);
  console.log(`  subagent 能力         : ${r.hasSubagentCapability === null ? '未知（无 request/header）' : r.hasSubagentCapability ? '有' : '无'}`);
  console.log(`  子 session 数         : ${r.childSessions === null ? '未知' : r.childSessions}`);
  console.log('');
  if (r.problems.length === 0) {
    console.log('✓ 账本与 harness 记录一致（无 FAIL / WARN）。');
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
