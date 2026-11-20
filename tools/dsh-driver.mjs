#!/usr/bin/env node
/**
 * dsh-driver.mjs — 从外面驱动 dsh 跑完一个相位（因为 dsh 自己没有 Stop hook）
 *
 * ── 为什么需要它（2026-11-20 实测）────────────────────────────────────
 *
 * 用 dsh 0.2.1-rc.2 原生跑完整审计。第一次运行：侦察 + 26 份宽扫完成后，
 * 主 Agent 派了 4 个深挖 Agent，然后输出「End turn」——**父进程随即退出**，
 * 4 份深挖产物全部丢失。
 *
 * 根因是机械的（`stop-hook.mjs` 文件头写过同一件事）：
 *
 *   Agent 循环的退出条件是「本轮回复里没有 tool call」。
 *   「我已完成 X，接下来做 Y」这段话天然没有 tool call，所以写出来就交差了。
 *
 * Claude Code 有 Stop hook 能在这一刻拦住。**dsh 没有这个机制**
 *（`--dump-config` 里没有 hook 类插件，schema 里也没有）。
 *
 * 框架的 `protocol.md` §0.8.2 早就定义了「相位之间可以停，相位之内不许停」，
 * 但这条规则**只能靠执行者自觉**——dsh 上没有任何东西保证它。
 *
 * ── 它做什么 ────────────────────────────────────────────────────────
 *
 * 不修改 dsh，从**外面**做 Stop hook 本该做的事：
 *
 *   1. 跑一次 dsh
 *   2. 读 state.json，看相位闭合了没有
 *   3. 没闭合 → 带着「还差什么」再跑一次
 *   4. 直到闭合、或达到 max_iterations、或连续两次没有进展（STALLED）
 *
 * 判据用 `state.json` 的 `phase` 与 `status`，这两个字段是框架本来就要维护的，
 * 不需要为驱动额外编造状态。同时用产物文件数作为**独立的进展信号**——
 * 只看 status 会被「说自己 RUNNING 但什么都没做」骗过去。
 *
 * ── 它不做什么 ──────────────────────────────────────────────────────
 *
 *   - 不判断发现的真假（那是锐评波的事）
 *   - 不修改产物（只读 state.json 与文件列表）
 *   - 不在相位闭合后继续跑（`CLOSED` / `PARTIALLY_CLOSED` 即停）
 *
 * 用法：
 *   node dsh-driver.mjs --patch <patch.yml> --task <task.md> --artifacts <产物目录>
 *                       [--dsh <dsh bin.js>] [--max-iterations 6]
 *                       [--api-key-env AUDIT_API_KEY] [--dry-run]
 *
 * 退出码：0 = 相位闭合   1 = 未闭合（达上限或 STALLED）   2 = 用法错误
 */

import { readFileSync, existsSync, readdirSync, writeFileSync, appendFileSync, statSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const ARG = {
  patch: null, task: null, artifacts: null, dsh: null,
  maxIterations: 6, apiKeyEnv: 'AUDIT_API_KEY', dryRun: false, json: false,
};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--patch') ARG.patch = process.argv[++i];
  else if (a === '--task') ARG.task = process.argv[++i];
  else if (a === '--artifacts') ARG.artifacts = process.argv[++i];
  else if (a === '--dsh') ARG.dsh = process.argv[++i];
  else if (a === '--max-iterations') ARG.maxIterations = Number(process.argv[++i]);
  else if (a === '--api-key-env') ARG.apiKeyEnv = process.argv[++i];
  else if (a === '--dry-run') ARG.dryRun = true;
  else if (a === '--json') ARG.json = true;
  else if (a === '--help' || a === '-h') {
    console.log('用法: node dsh-driver.mjs --patch <yml> --task <md> --artifacts <目录>'
      + ' [--dsh <bin.js>] [--max-iterations 6] [--api-key-env AUDIT_API_KEY] [--dry-run]');
    process.exit(0);
  } else { console.error(`未知参数: ${a}`); process.exit(2); }
}

for (const k of ['patch', 'task', 'artifacts']) {
  if (!ARG[k]) { console.error(`必须给 --${k}`); process.exit(2); }
}
if (!existsSync(ARG.patch)) { console.error(`patch 不存在: ${ARG.patch}`); process.exit(2); }
if (!existsSync(ARG.task)) { console.error(`task 不存在: ${ARG.task}`); process.exit(2); }
if (!existsSync(ARG.artifacts)) { console.error(`产物目录不存在: ${ARG.artifacts}`); process.exit(2); }

// ── 找 dsh ──
function findDsh() {
  if (ARG.dsh) return existsSync(ARG.dsh) ? ARG.dsh : null;
  // 按版本号从新到旧找，跳过缺 lib/ 的不完整安装
  const base = join(homedir(), '.dsh-win', 'versions');
  if (!existsSync(base)) return null;
  const vers = readdirSync(base)
    .filter((v) => /^\d/.test(v))
    .sort((a, b) => {
      const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
      const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
      }
      return 0;
    });
  for (const v of vers) {
    const p = join(base, v, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
    if (existsSync(p)) return p;
  }
  return null;
}

const DSH = findDsh();
if (!DSH) {
  console.error('[配置错误] 找不到可用的 dsh（试过 --dsh 与 ~/.dsh-win/versions/*）');
  console.error('  注意：安装目录不完整时（没有 lib/bin.js）要跳过，不要当成可用');
  process.exit(2);
}

// ── 相位闭合判据 ──
//
// 用 state.json 的 phase + status（框架本来就要维护），
// 加一个独立的进展信号（产物文件数），防止「说自己 RUNNING 但什么都没做」。
const CLOSED_STATUS = new Set(['CLOSED', 'PARTIALLY_CLOSED', 'DONE', 'FAILED']);
const TERMINAL_PHASE = new Set(['report', 'done', 'closed']);

const statePath = join(ARG.artifacts, 'state.json');

function readState() {
  if (!existsSync(statePath)) return null;
  try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return null; }
}

function artifactCount() {
  try {
    return readdirSync(ARG.artifacts).filter((f) => {
      try { return statSync(join(ARG.artifacts, f)).isFile() && f.endsWith('.md'); } catch { return false; }
    }).length;
  } catch { return 0; }
}

/** 相位闭合了吗？返回 { closed, reason } */
function checkClosure(st) {
  if (!st) return { closed: false, reason: 'state.json 不存在或无法解析' };
  const phase = String(st.phase ?? '');
  const status = String(st.status ?? '');
  if (CLOSED_STATUS.has(status)) return { closed: true, reason: `status=${status}` };
  if (TERMINAL_PHASE.has(phase)) return { closed: true, reason: `phase=${phase}` };
  return { closed: false, reason: `phase=${phase || '(空)'} status=${status || '(空)'}——仍在进行中` };
}

/** 把「还差什么」写给下一轮的 dsh */
function buildResumePrompt(st, iter, prevCount, curCount) {  const base = readFileSync(ARG.task, 'utf8');
  const phase = st?.phase ?? '(未知)';
  const status = st?.status ?? '(未知)';
  const judged = [];
  try {
    const j = JSON.parse(readFileSync(join(ARG.artifacts, 'state.json'), 'utf8'));
    const slices = j.slices ?? {};
    for (const [id, s] of Object.entries(slices)) {
      const stt = s?.state ?? s?.status ?? '?';
      if (!['SUCCESS', 'PERMANENT_FAILURE'].includes(stt)) judged.push(`${id}=${stt}`);
    }
  } catch { /* ignore */ }

  return `**这是自动续跑的第 ${iter} 轮，不是新的审计。**

上一轮结束时 state.json 记录：\`phase=${phase}\`、\`status=${status}\`。
产物文件数：上一轮 ${prevCount} → 本轮 ${curCount}
（${curCount > prevCount ? '有进展' : '**没有新产物——上一轮可能空转**'}）。

${judged.length ? `仍未进入终态的切片（${judged.length} 个）：${judged.slice(0, 10).join('、')}${judged.length > 10 ? ' …' : ''}` : '所有切片均已进入终态。'}

## 你这一轮必须做的事

1. **先读 \`${ARG.artifacts}/state.json\` 和已有产物**，不要从头重跑
2. 继续把当前相位做完。框架 §0.8.2 的规则是「相位之间可以停，相位之内不许停」
3. **每派一批子 Agent，必须在本回合内等到它们落盘再结束回合**
   —— dsh 没有 Stop hook，你说「End turn」，父进程立刻退出，未落盘的产物会全丢
4. 做完当前相位后更新 state.json 的 \`phase\` / \`status\`

## 原始任务书（供参考，已完成的部分不要重做）

${base}`;
}

// ── patch 里的端点占位符 ──
//
// 2026-11-20 踩到的坑：为了不把上游 IP 提交进公开仓库，我把 patch.yml 里的
// baseURL 改成了 `<your-upstream>` 占位符——然后 dsh 报 `PI_AI_ERROR: Invalid URL`，
// 驱动连跑两轮都是立刻失败，STALLED 判它「无进展」。
//
// 正确做法是**运行期注入**：patch 里写占位符，驱动从环境变量取真值，
// 写到产物目录之外的临时文件再传给 dsh。仓库里永远不含真地址。
//
// 环境变量：
//   DSH_UPSTREAM_BASEURL  覆盖 patch 里的 <your-upstream> 部分（如 http://1.2.3.4:33000）
//   AUDIT_API_KEY         由 patch 的 apiKeyEnv 指名，dsh 自己读
function resolvePatch() {
  const src = readFileSync(ARG.patch, 'utf8');
  if (!/<your-upstream>/.test(src)) return { path: resolve(ARG.patch), injected: false };

  const endpoint = process.env.DSH_UPSTREAM_BASEURL;
  if (!endpoint) {
    console.error('[配置错误] patch 里有 <your-upstream> 占位符，但没设 DSH_UPSTREAM_BASEURL。');
    console.error('  这个占位符是有意的：仓库是公开的，不能写真实上游地址。');
    console.error('  运行时注入，例如：');
    console.error('    DSH_UPSTREAM_BASEURL=http://<你的端点>:33000 \\');
    console.error('    AUDIT_API_KEY=<你的key> node tools/dsh-driver.mjs ...');
    process.exit(2);
  }
  if (!/^https?:\/\/[^\s<>]+$/.test(endpoint)) {
    console.error(`[配置错误] DSH_UPSTREAM_BASEURL 不是合法 URL: ${endpoint}`);
    process.exit(2);
  }

  // 写到产物目录的父目录（不进 git），文件名带随机后缀避免并发覆盖
  const tmp = join(dirname(resolve(ARG.artifacts)), `.patch-resolved-${process.pid}.yml`);
  writeFileSync(tmp, src.replace(/<your-upstream>/g, endpoint));
  return { path: tmp, injected: true, tmp };
}

const PATCH = resolvePatch();

// ── 主循环 ──
const logPath = join(ARG.artifacts, '..', 'driver.log');const log = (s) => {
  const line = `[${new Date().toISOString()}] ${s}`;
  // 2026-11-20：`--json` 时日志必须走 stderr。
  // 混在 stdout 里会让 JSON 前面多出 N 行，下游 JSON.parse 直接失败——
  // 这正是本框架反复记过的「机器可读输出被人读日志污染」。
  if (ARG.json) console.error(line);
  else console.log(line);
  try { appendFileSync(logPath, line + '\n'); } catch { /* ignore */ }
};

const history = [];
let closed = false;
let reason = '';
let prevCount = artifactCount();

log(`dsh: ${DSH}`);
log(`起始产物数: ${prevCount}`);

for (let iter = 1; iter <= ARG.maxIterations; iter++) {
  const st = readState();
  const before = checkClosure(st);
  if (before.closed) {
    closed = true; reason = before.reason;
    log(`第 ${iter} 轮开始前相位已闭合（${reason}），不再启动`);
    break;
  }

  const prompt = iter === 1
    ? readFileSync(ARG.task, 'utf8')
    : buildResumePrompt(st, iter, prevCount, artifactCount());

  log(`=== 第 ${iter}/${ARG.maxIterations} 轮 ===`);
  log(`当前: ${before.reason}`);

  if (ARG.dryRun) {
    log('[dry-run] 不实际调用 dsh');
    log(`prompt 前 200 字: ${prompt.slice(0, 200).replace(/\n/g, ' ')}`);
    break;
  }

  const r = spawnSync(process.execPath, [DSH, '--profile', 'headless',
    '--patch', PATCH.path, prompt], {
    encoding: 'utf8',
    env: process.env,
    maxBuffer: 512 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const out = (r.stdout ?? '') + (r.stderr ?? '');
  try {
    appendFileSync(join(ARG.artifacts, '..', `driver-iter-${iter}.log`), out);
  } catch { /* ignore */ }

  const after = artifactCount();
  const stAfter = readState();
  const post = checkClosure(stAfter);

  history.push({
    iter, exitCode: r.status, phase: stAfter?.phase ?? null, status: stAfter?.status ?? null,
    artifactsBefore: prevCount, artifactsAfter: after, closed: post.closed,
  });

  log(`第 ${iter} 轮结束: exit=${r.status} phase=${stAfter?.phase ?? '?'} status=${stAfter?.status ?? '?'} 产物 ${prevCount}→${after}`);

  if (post.closed) {
    closed = true; reason = post.reason;
    log(`✓ 相位已闭合（${reason}）`);
    break;
  }

  // 防空转：两轮之间产物数没变，且 state 也没变 → STALLED
  if (iter > 1 && after === prevCount) {
    const prev = history[history.length - 2];
    if (prev && prev.artifactsAfter === after && prev.phase === stAfter?.phase && prev.status === stAfter?.status) {
      reason = `连续两轮无进展（产物停在 ${after} 份，phase/status 未变）——STALLED`;
      log(`✗ ${reason}`);
      break;
    }
  }

  prevCount = after;
  reason = post.reason;
}

// ── 收尾：跑守卫，看这一轮到底丢了什么 ──
// 顺便清掉临时 patch（里面含真实端点，不该留在磁盘上）
if (PATCH.tmp) {
  try { unlinkSync(PATCH.tmp); } catch { /* ignore */ }
}

const guard = join(HERE, 'dsh-run-guard.mjs');
let guardOut = '', guardCode = 0;
if (existsSync(guard) && !ARG.dryRun) {
  const g = spawnSync(process.execPath, [guard, '--artifacts', ARG.artifacts], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  guardCode = g.status ?? 1;
  guardOut = (g.stdout ?? '') + (g.stderr ?? '');
}

const result = {
  ok: closed,
  closed, reason, iterations: history.length, history,
  guard: { exitCode: guardCode, output: guardOut.slice(-3000) },
};

if (ARG.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('\n──────────────────────────────────────');
  console.log(`相位移闭合: ${closed ? '是' : '否'}（${reason}）`);
  console.log(`轮次: ${history.length}`);
  for (const h of history) {
    console.log(`  #${h.iter} exit=${h.exitCode} ${h.phase}/${h.status} 产物 ${h.artifactsBefore}→${h.artifactsAfter}${h.closed ? ' ✓闭合' : ''}`);
  }
  if (guardOut) {
    console.log('\n运行守卫:');
    for (const l of guardOut.trim().split('\n').slice(-12)) console.log('  ' + l);
  }
  console.log('──────────────────────────────────────');
}

process.exit(closed ? 0 : 1);
