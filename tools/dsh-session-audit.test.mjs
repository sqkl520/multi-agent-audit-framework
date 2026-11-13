#!/usr/bin/env node
/**
 * dsh-session-audit.test.mjs — 用合成的 dsh session 目录测判定逻辑
 *
 * 为什么用合成数据而不是真跑 dsh：真运行需要 LLM 上游可用（本机当前全部不可用），
 * 而且无法稳定制造「子 agent 有产出但父级没收到」这类边界情形。
 * 判定逻辑是纯读文件的，所以可以直接喂构造好的事件序列。
 *
 * 每个用例都是「已知该红 → 必须红」或「已知该绿 → 必须绿」。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { zstdCompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL = join(HERE, 'dsh-session-audit.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

function makeSessionsRoot(sessions) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-audit-'));
  for (const s of sessions) {
    const sd = join(dir, s.dir);
    mkdirSync(sd, { recursive: true });
    const body = s.events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    writeFileSync(join(sd, 'session.v4.jsonl.zstd'), zstdCompressSync(Buffer.from(body, 'utf8')));
  }
  return dir;
}

function run(root) {
  try {
    const out = execFileSync(process.execPath, [TOOL, '--sessions', root, '--json'], { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out, err: e.stderr?.toString() }; }
  }
}

const ev = {
  session: (id, extra = {}) => ({ type: 'session', version: 4, id, cwd: 'C:\\x', ...extra }),
  turnStart: (t = 1) => ({ type: 'turn/start', data: { turn: t } }),
  turnEnd: (t = 1) => ({ type: 'turn/end', data: { turn: t, reason: { kind: 'completed' } } }),
  assistantText: (text, turn = 1, step = 1) => ({
    type: 'assistant/message',
    data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }] } },
  }),
  assistantTool: (name, turn = 1, step = 1) => ({
    type: 'assistant/message',
    data: { turn, step, message: { role: 'assistant', content: [{ type: 'tool-call', name }] } },
  }),
  settle: (childId) => ({
    type: 'agent/inbox/spliced',
    data: {
      inserted: [{
        content: [{ type: 'text', text: `Background subagent ${childId} finished` }],
        source: { kind: 'subagent-settled', senderSessionId: childId },
      }],
    },
  }),
  requestHeader: () => ({ type: 'request/header', data: { header: { tools: [] } } }),
  retry: () => ({ type: 'llm/retry', data: { retryId: 'r1' } }),
  attempt: (reason) => ({
    type: 'assistant/attempt',
    data: { stream: [{ type: 'chunk', chunk: { type: 'finish', reason } }] },
  }),
};

console.log('dsh-session-audit 自测');

// ── 1. 健康闭环：子 agent 有产出，父级收到 settle ──
{
  const root = makeSessionsRoot([
    { dir: 'session-p1', events: [
      ev.session('session-p1', { delegationDepth: 0 }),
      ev.requestHeader(), ev.turnStart(1), ev.assistantTool('subagent'), ev.turnEnd(1),
      ev.settle('c1'), ev.turnStart(2), ev.assistantText('父级最终答复', 2), ev.turnEnd(2),
    ] },
    { dir: 'c1', events: [
      ev.session('c1', { parentSession: 'session-p1', origin: 'subagent', delegationDepth: 1 }),
      ev.turnStart(1), ev.assistantText('子 agent 的结论'), ev.turnEnd(1),
    ] },
  ]);
  const r = run(root);
  expect('闭环时退出码 0', r.code === 0, `实际 ${r.code}`);
  expect('闭环时无问题', (r.data?.problems ?? []).length === 0,
    JSON.stringify(r.data?.problems));
  rmSync(root, { recursive: true, force: true });
}

// ── 2. 子 agent 有产出但父级没收到 settle —— 核心场景 ──
{
  const root = makeSessionsRoot([
    { dir: 'session-p2', events: [
      ev.session('session-p2', { delegationDepth: 0 }),
      ev.turnStart(1), ev.assistantTool('subagent'), ev.assistantText('父级先说了句话'), ev.turnEnd(1),
      // 注意：没有 settle 事件
    ] },
    { dir: 'c2', events: [
      ev.session('c2', { parentSession: 'session-p2', origin: 'subagent', delegationDepth: 1 }),
      ev.turnStart(1), ev.assistantText('子 agent 辛苦算出来的结论'), ev.turnEnd(1),
    ] },
  ]);
  const r = run(root);
  expect('父级漏收时退出码 1', r.code === 1, `实际 ${r.code}`);
  const kinds = (r.data?.problems ?? []).map((p) => p.kind);
  expect('报出 parent_missed_child', kinds.includes('parent_missed_child'), kinds.join(','));
  rmSync(root, { recursive: true, force: true });
}

// ── 3. 子 agent 开了 turn 但零 assistant 消息 ──
{
  const root = makeSessionsRoot([
    { dir: 'session-p3', events: [
      ev.session('session-p3', { delegationDepth: 0 }),
      ev.turnStart(1), ev.assistantTool('subagent'), ev.turnEnd(1),
      ev.settle('c3'),
    ] },
    { dir: 'c3', events: [
      ev.session('c3', { parentSession: 'session-p3', origin: 'subagent', delegationDepth: 1 }),
      ev.turnStart(1),
      ev.requestHeader(), ev.attempt({ kind: 'error', failure: { code: 'TRANSPORT' } }),
      ev.retry(), ev.turnEnd(1),
    ] },
  ]);
  const r = run(root);
  const kinds = (r.data?.problems ?? []).map((p) => p.kind);
  expect('子 agent 空产出被发现', kinds.includes('child_no_output'), kinds.join(','));
  expect('空 turn 也被发现', kinds.includes('turn_without_output'), kinds.join(','));
  rmSync(root, { recursive: true, force: true });
}

// ── 4. finish.reason 是对象时必须能读出原因（不是 [object Object]） ──
{
  const root = makeSessionsRoot([
    { dir: 'session-p4', events: [
      ev.session('session-p4', { delegationDepth: 0 }),
      ev.turnStart(1), ev.requestHeader(),
      ev.attempt({ kind: 'error', failure: { code: 'SERVER', message: '503 upstream' } }),
      ev.retry(), ev.turnEnd(1),
    ] },
  ]);
  const r = run(root);
  const txt = JSON.stringify(r.data ?? {});
  expect('finish 原因不含 [object Object]', !txt.includes('[object Object]'), txt.slice(0, 200));
  expect('finish 原因含具体错误码', txt.includes('SERVER'), txt.slice(0, 300));
  expect('重试次数被记录', txt.includes('"retryCount":1'), txt.slice(0, 300));
  rmSync(root, { recursive: true, force: true });
}

// ── 5. 孤儿：parentSession 指向不存在的 session ──
{
  const root = makeSessionsRoot([
    { dir: 'c5', events: [
      ev.session('c5', { parentSession: 'session-gone', origin: 'subagent', delegationDepth: 1 }),
      ev.turnStart(1), ev.assistantText('有产出'), ev.turnEnd(1),
    ] },
  ]);
  const r = run(root);
  const kinds = (r.data?.problems ?? []).map((p) => p.kind);
  expect('孤儿 session 被发现', kinds.includes('orphan_child'), kinds.join(','));
  rmSync(root, { recursive: true, force: true });
}

// ── 6. 只有工具调用没有文本，不算产出 ──
{
  const root = makeSessionsRoot([
    { dir: 'session-p6', events: [
      ev.session('session-p6', { delegationDepth: 0 }),
      ev.turnStart(1), ev.assistantTool('subagent'), ev.turnEnd(1),
      ev.settle('c6'),
    ] },
    { dir: 'c6', events: [
      ev.session('c6', { parentSession: 'session-p6', origin: 'subagent', delegationDepth: 1 }),
      ev.turnStart(1), ev.assistantTool('read'), ev.turnEnd(1),
    ] },
  ]);
  const r = run(root);
  const child = (r.data?.sessions ?? []).find((s) => s.id === 'c6');
  expect('仅有工具调用时 producedOutput=false', child?.producedOutput === false,
    JSON.stringify(child?.producedOutput));
  rmSync(root, { recursive: true, force: true });
}

// ── 7. 缺 --sessions 参数时报用法错误 ──
{
  try {
    execFileSync(process.execPath, [TOOL], { encoding: 'utf8', stdio: 'pipe' });
    expect('缺参数应退出 2', false, '竟然成功了');
  } catch (e) {
    expect('缺参数应退出 2', e.status === 2, `实际 ${e.status}`);
  }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
