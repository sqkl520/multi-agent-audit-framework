#!/usr/bin/env node
/**
 * dsh-session-audit.mjs — 检查 dsh 的一次运行里，子 agent 的产出有没有被父级真正消费
 *
 * 为什么需要（2026-11-13 dsh 实测发现）：
 *   dsh 的 `subagent` 工具**返回值是「已启动」而不是「已完成」**：
 *
 *       "started subagent 82757119-cfd1-45d1-8807-d5f82d3f52e6"
 *
 *   子 agent 的结论不走工具返回值，而是作为 `subagent-settled` 事件注入父 agent 的**下一轮**
 *   `agent/inbox/spliced`。也就是说：
 *
 *     - 调用方只看 tool result → 看到的是「已启动」，会以为任务还没完成
 *     - 或者任务已完成，但答句用的是 turn 1 的文本 → 看起来「跑完了但没内容」
 *
 *   这正是「agent 已经产出了但主智能体没意识到」的**机制级成因**，不是模型疏忽。
 *
 * 这个脚本把这件事变成可判定的事实。给定一个 dsh session 目录，它回答三个问题：
 *
 *   1. 这次运行一共 spawn 了几个子 agent（按 session 文件里的 parentSession 反查）
 *   2. 每个子 agent 是否真的产生了 assistant 消息（不是只有 turn/start）
 *   3. 父级是否收到了对应的 subagent-settled 注入
 *
 * 用法：
 *   node dsh-session-audit.mjs --sessions <sessions 根目录> [--project <子目录名>] [--json]
 *
 *   项目目录名本身以 `--` 开头（如 `--D-Projects-foo--`），位置参数无法区分
 *   flag 与值，所以必须用显式 flag。
 *
 * 退出码：0 = 全部闭环  1 = 有问题  2 = 用法错误
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const pi = args.indexOf('--project');
const ri = args.indexOf('--sessions');

// dsh 的项目目录名本身就以 `--` 开头（如 `--D-Projects-foo--`），
// 所以位置参数无法区分「flag」和「值」——一律走显式 --sessions / --project。
if (ri < 0) {
  console.error('用法: node dsh-session-audit.mjs --sessions <sessions 根目录> [--project <子目录名>] [--json]');
  process.exit(2);
}

const root = resolve(args[ri + 1] ?? '');
if (!existsSync(root)) {
  console.error(`目录不存在: ${root}`);
  process.exit(2);
}

const projectDir = pi >= 0 ? join(root, args[pi + 1]) : null;
const scanRoot = projectDir ?? root;

if (!existsSync(scanRoot)) {
  console.error(`目录不存在: ${scanRoot}`);
  process.exit(2);
}

// ── 读取一个 session 目录的事件 ──
function readSession(dir) {
  const file = join(dir, 'session.v4.jsonl.zstd');
  if (!existsSync(file)) return null;
  let text;
  try {
    text = zstdDecompressSync(readFileSync(file)).toString('utf8');
  } catch {
    return null;
  }
  const events = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { events.push(JSON.parse(line)); } catch { /* 半行写入时跳过 */ }
  }
  return { file, events, size: statSync(file).size };
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

const counts = (events, type) => events.filter((e) => e.type === type).length;

// ── 收集所有 session ──
const sessionDirs = [];
for (const entry of readdirSync(scanRoot)) {
  const full = join(scanRoot, entry);
  if (!statSync(full).isDirectory()) continue;
  if (entry.startsWith('.')) continue;
  const s = readSession(full);
  if (!s) continue;
  sessionDirs.push({ dir: entry, ...s, meta: sessionMeta(s.events) });
}

if (sessionDirs.length === 0) {
  console.error(`在 ${scanRoot} 下没有找到 session.v4.jsonl.zstd`);
  process.exit(2);
}

const byId = new Map(sessionDirs.map((s) => [s.meta.id, s]));

// ── 每个 session 的判定 ──
const report = sessionDirs.map((s) => {
  const assistantMsgs = s.events
    .filter((e) => e.type === 'assistant/message')
    .map((e) => ({
      turn: e.data?.turn,
      step: e.data?.step,
      // 只统计文本块；工具调用块不计入「产出」
      text: (e.data?.message?.content ?? [])
        .filter((c) => c?.type === 'text')
        .map((c) => c.text)
        .join('')
        .trim(),
      toolCalls: (e.data?.message?.content ?? []).filter((c) => c?.type === 'tool-call').map((c) => c.name),
    }));

  const settles = s.events.filter(
    (e) => e.type === 'agent/inbox/spliced' &&
      (e.data?.inserted ?? []).some((x) => x?.source?.kind === 'subagent-settled'),
  );

  // 重试链：dsh 对 EMPTY_RESPONSE / TIMEOUT / TRANSPORT 会自动重试（默认 5 次）。
  // 重试耗尽仍无 assistant 消息 = 这一轮彻底没产出，但 turn 已经开过了。
  const retries = s.events.filter((e) => e.type === 'llm/retry');
  // finish.reason 是对象（{kind:'error', failure:{code,message}} / {kind:'stop'}），
  // 不是字符串——直接拼进日志会印出 [object Object]。
  const finishes = s.events
    .filter((e) => e.type === 'assistant/attempt')
    .flatMap((e) => (e.data?.stream ?? []).filter((c) => c?.chunk?.type === 'finish'))
    .map((c) => c.chunk.reason)
    .filter(Boolean);
  const describeFinish = (r) => {
    if (!r) return null;
    if (typeof r === 'string') return r;
    if (r.kind === 'error') return `error:${r.failure?.code ?? '?'}${r.failure?.message ? ' (' + r.failure.message + ')' : ''}`;
    return String(r.kind ?? JSON.stringify(r));
  };

  return {
    dir: s.dir,
    id: s.meta.id,
    origin: s.meta.origin,
    parentSession: s.meta.parentSession,
    delegationDepth: s.meta.delegationDepth,
    eventCount: s.events.length,
    turns: counts(s.events, 'turn/start'),
    assistantMessages: assistantMsgs.length,
    assistantTexts: assistantMsgs.filter((m) => m.text !== '').map((m) => ({
      turn: m.turn, step: m.step, chars: m.text.length, preview: m.text.slice(0, 80),
    })),
    producedOutput: assistantMsgs.some((m) => m.text !== ''),
    retryCount: retries.length,
    lastFinishReason: finishes.length > 0 ? describeFinish(finishes[finishes.length - 1]) : null,
    llmRequests: counts(s.events, 'request/header'),
    settledNoticesReceived: settles.length,
    settledFrom: settles.flatMap((e) =>
      (e.data?.inserted ?? [])
        .filter((x) => x?.source?.kind === 'subagent-settled')
        .map((x) => x.source.senderSessionId),
    ),
  };
});

// ── 父子闭环判定 ──
const children = report.filter((r) => r.origin === 'subagent' || r.parentSession);
const problems = [];

// 每个开过 turn 却没有任何 assistant 消息的 session，都是一次「跑了但没产出」。
// 这条对父 session 同样适用——不是只有子 agent 会静默失败。
for (const r of report) {
  if (r.turns > 0 && r.assistantMessages === 0) {
    const why = r.retryCount > 0
      ? `重试 ${r.retryCount} 次后放弃（最后 finish=${r.lastFinishReason ?? '未知'}）`
      : r.llmRequests === 0
        ? '从未发出 LLM 请求——turn 开了但没走到调用模型'
        : `发出 ${r.llmRequests} 次请求但都没有 assistant 消息落盘`;
    problems.push({
      kind: 'turn_without_output',
      sessionId: r.id,
      detail: `开了 ${r.turns} 个 turn，但 0 条 assistant 消息——${why}`,
    });
  }
}

for (const child of children) {
  const parent = byId.get(child.parentSession);
  if (!parent) {
    problems.push({
      kind: 'orphan_child',
      childId: child.id,
      detail: `子 session 声明了 parentSession=${child.parentSession}，但在本目录找不到该父 session`,
    });
    continue;
  }

  if (!child.producedOutput) {
    problems.push({
      kind: 'child_no_output',
      childId: child.id,
      detail: `子 agent 跑了 ${child.turns} 个 turn / ${child.assistantMessages} 条 assistant 消息，但没有任何文本产出`,
    });
  }

  const parentReport = report.find((r) => r.id === child.parentSession);
  const received = parentReport?.settledFrom?.includes(child.id) ?? false;
  if (!received) {
    problems.push({
      kind: 'parent_missed_child',
      childId: child.id,
      parentId: child.parentSession,
      detail: child.producedOutput
        ? '子 agent 有产出，但父 session 里没有对应的 subagent-settled 注入——父级看不到这个结果'
        : '子 agent 无产出，且父 session 也没有收到 settle 通知',
    });
  }
}

// ── 输出 ──
if (jsonOut) {
  console.log(JSON.stringify({ scanRoot, sessions: report, problems }, null, 2));
  process.exit(problems.length === 0 ? 0 : 1);
}

console.log(`扫描: ${scanRoot}`);
console.log(`session 数: ${report.length}（其中子 agent ${children.length} 个）\n`);

for (const r of report) {
  const tag = r.origin === 'subagent' ? `子(depth=${r.delegationDepth})` : '父/顶层';
  console.log(`${tag}  ${r.id}`);
  console.log(`  turn=${r.turns} assistant消息=${r.assistantMessages} 文本产出=${r.producedOutput ? '有' : '无'} 收到settle=${r.settledNoticesReceived}${r.retryCount > 0 ? ` 重试=${r.retryCount}` : ''}`);
  if (r.parentSession) console.log(`  parentSession=${r.parentSession}`);
  for (const t of r.assistantTexts) {
    console.log(`    turn ${t.turn}.${t.step}: ${t.chars} 字 → ${t.preview}`);
  }
  console.log('');
}

if (problems.length === 0) {
  console.log('结论：全部闭环。每个有产出的子 agent，其父级都收到了 settle 通知。');
  process.exit(0);
}

console.log(`结论：发现 ${problems.length} 个问题`);
for (const p of problems) {
  console.log(`  [${p.kind}] ${p.detail}`);
}
process.exit(1);
