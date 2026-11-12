#!/usr/bin/env node
/**
 * stop-hook.mjs — 相位未闭合就拒绝结束回合
 *
 * 为什么需要这个脚本（而不是在提示词里写「不要停下来」）：
 *
 *   Anthropic 官方文档 `best-practices.md` 把手段强弱排了序：
 *     提示词（最弱，"Claude decides for itself"）
 *       < `/goal`（中等，由另一个模型判定）
 *       < Stop hook（最强，由 harness 强制）
 *
 *   根因是机械的：Agent 循环的退出条件是「本轮回复里没有 tool call」。
 *   「我已完成 X，接下来做 Y」这段话天然没有 tool call，所以写出来就交差了。
 *   提示词拦不住这件事——它能被「判定为不适用」。
 *
 * 用法（Claude Code）：
 *
 *   settings.json:
 *   {
 *     "hooks": {
 *       "Stop": [{ "hooks": [{ "type": "command",
 *         "command": "node <本文件路径> --state <state.json 路径>" }] }]
 *     }
 *   }
 *
 * 退出码语义（官方 `hooks.md`）：
 *   0 = 允许结束回合
 *   2 = 拒绝结束，stderr 内容回灌给模型作为「你还不能结束」的理由
 *   其他 = 出错（会被显示为 hook error）
 *
 * 上限：官方有 8 次连续续跑上限，可用 CLAUDE_CODE_STOP_HOOK_BLOCK_CAP 调整。
 * 本脚本自身也检查 stop_hook_active，避免在永远不成立的条件上死循环。
 */

import { readFileSync, existsSync, statSync } from 'node:fs';

const args = process.argv.slice(2);
const stateIdx = args.indexOf('--state');
const statePath = stateIdx >= 0 ? args[stateIdx + 1] : null;

// 读 stdin（Claude Code 会把 hook 上下文以 JSON 传给脚本）
let input = '';
try {
  input = readFileSync(0, 'utf8');
} catch { /* 没有 stdin 也继续 */ }

let hookCtx = {};
try { hookCtx = JSON.parse(input || '{}'); } catch { /* ignore */ }

// 官方建议必须检查：已经在 hook 续跑中时，不要无限拦截
if (hookCtx.stop_hook_active === true) {
  process.exit(0);
}

if (!statePath || !existsSync(statePath)) {
  // 没有账本就无法判断——不阻断（宁可不拦，也不要误拦）
  process.exit(0);
}

let state;
try {
  state = JSON.parse(readFileSync(statePath, 'utf8'));
} catch {
  process.exit(0);
}

const problems = [];

// 1. 执行相位必须有计划
if (['wave2a', 'wave2b', 'wave3'].includes(state.phase)) {
  const plan = state.current_plan;
  if (!plan) {
    problems.push(
      `phase=${state.phase} 是执行相位，但 state.json 里没有 current_plan。\n` +
      `按 protocol.md §0.8.4：进入相位前必须先把计划写进 current_plan` +
      `（steps 每步要有 action + done_when，还要有 exit_condition）。\n` +
      `不要用一段进度汇报结束回合——请先把计划落盘，然后继续执行。`
    );
  } else {
    if (!plan.exit_condition) {
      problems.push(
        `current_plan 缺 exit_condition——不知道什么算「这个相位做完了」，就无法判断现在该不该停。\n` +
        `请补上 exit_condition，然后继续执行直到它成立。`
      );
    }
    const steps = Array.isArray(plan.steps) ? plan.steps : [];
    if (steps.length === 0) {
      problems.push(`current_plan.steps 为空——那不是计划，是一句意图。请写出具体步骤。`);
    } else {
      const current = plan.current_step ?? 1;
      const remaining = steps.filter((s, i) => (i + 1) >= current);
      // 若当前步骤还有未完成的下游步骤，说明相位没闭合
      if (remaining.length > 0 && state.status === 'RUNNING') {
        const tail = remaining[remaining.length - 1];
        problems.push(
          `相位尚未闭合：计划共 ${steps.length} 步，当前在第 ${current} 步，` +
          `还有 ${remaining.length} 步没做完（最后一步是「${tail.action}」）。\n` +
          `按 protocol.md §0.8.2，一次交付 = 整个相位，不是单步。\n` +
          `请继续执行；只有 exit_condition 成立（「${plan.exit_condition}」）后才允许结束回合。`
        );
      }
    }
  }
}

// 2. 有在飞的 agent 时不许结束
// 2026-11-12 修正：原来只看 in_flight 数组长度。但「在飞」的真相是
// **产物有没有落盘**，不是主 Agent 有没有把它从数组里划掉。
//
// 真实事故：主 Agent 连续 35 分钟说某个子 Agent「还在跑」，
// 而它的产物早已写完——因为判断依据是「in_flight 里还有它」，
// 而不是「它的产物存在吗」。数组是主 Agent 自己维护的，
// 它忘了更新，判断就一直错下去。
if (Array.isArray(state.in_flight) && state.in_flight.length > 0) {
  const done = [];
  const flying = [];
  for (const f of state.in_flight) {
    const ap = f?.artifact_path;
    // 声明了产物路径且文件真实存在（非空）→ 实际已落地，不管数组里还在不在
    let landed = false;
    if (typeof ap === 'string' && ap !== '') {
      try { landed = existsSync(ap) && statSync(ap).size > 0; } catch { landed = false; }
    }
    (landed ? done : flying).push({ id: f?.agent_id ?? f?.slice_id ?? '?', ap });
  }

  if (flying.length > 0) {
    const ids = flying.map((x) => x.id).slice(0, 5).join(', ');
    let msg =
      `还有 ${flying.length} 个 agent 在飞（${ids}${flying.length > 5 ? '…' : ''}）。\n` +
      `按 protocol.md §0.8 与 wave2a-sweep.md §7.5.5：harness 报告终态之前不得主动终止，` +
      `但也不该在这里交差——请等待它们到终态并处理产物。`;
    if (done.length > 0) {
      msg += `\n\n另外 ${done.length} 个的产物**已经落盘**（${done.map((x) => x.id).join(', ')}）——` +
        `它们不该还留在 in_flight 里。先用 tools/agent-status.mjs 确认，再更新 state.json。`;
    }
    problems.push(msg);
  } else if (done.length > 0) {
    // 全都有产物了，只是数组没清——这不是「还在飞」，是账本没更新
    problems.push(
      `in_flight 里 ${done.length} 个 agent 的产物**都已经落盘**（${done.map((x) => x.id).join(', ')}），` +
      `但它们还在 in_flight 数组里。\n` +
      `这不是「还在跑」，是账本没跟上。请核对产物后更新 state.json —— ` +
      `用产物是否落盘作判据，不要用「数组里还有没有」当判据。`
    );
  }
}

// 3. 相位声明完成但交付物缺失
const PHASE_DELIVERABLES = {
  wave1: () => state.slices && Object.keys(state.slices).length > 0,
  wave2a: () => Array.isArray(state.wave2_completed) && state.wave2_completed.length > 0,
  report: () => state.report?.final_report_path && existsSync(state.report.final_report_path),
};
const check = PHASE_DELIVERABLES[state.phase];
if (check && !check()) {
  problems.push(
    `phase=${state.phase} 的交付物还没落盘（见 protocol.md §0.8.2 的相位交付物表）。\n` +
    `相位交付物是「这个相位做完了」的客观证据——没有它，就还不能交付。`
  );
}

if (problems.length > 0) {
  // 退出码 2：拒绝结束回合，stderr 内容会回灌给模型
  console.error(
    `[交付粒度检查] 还不能结束这一回合：\n\n` +
    problems.map((p, i) => `${i + 1}. ${p}`).join('\n\n') +
    `\n\n如果你确实需要用户决定某件事，只有 protocol.md §0.8.5 列出的 6 种情形可以。` +
    `其余情况请自行判断、记进 discipline_log，然后继续。`
  );
  process.exit(2);
}

process.exit(0);
