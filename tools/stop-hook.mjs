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

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

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
// 2026-11-15（R1）：白名单补 wave4 / wave5。
// 此前只有 wave2a/wave2b/wave3 —— 修复与验收阶段 stop-hook **完全不触发**，
// 而 harness 强制的 hook 是本框架唯一的硬手段（见文件头对手段强弱的排序）。
// 缺口存在时，修复阶段只剩提示词那一层，也就是框架自己判为「最弱」的那一层。
if (['wave2a', 'wave2b', 'wave3', 'wave4', 'wave5'].includes(state.phase)) {
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
// 2026-11-15（R1）：补 wave4 / wave5 两个键。
// 此前这两个相位根本不在映射表里，`check` 取到 undefined → 整段跳过。
// 交付物的判据都只读账本里已有的字段，不新增必填项。
const VERDICT_VALUES = ['PASS', 'FAIL'];
const fixContracts = Array.isArray(state.fix_contracts) ? state.fix_contracts : [];
const PHASE_DELIVERABLES = {
  wave1: () => state.slices && Object.keys(state.slices).length > 0,
  wave2a: () => Array.isArray(state.wave2_completed) && state.wave2_completed.length > 0,
  // wave4（修复相位）的交付物 = 账本里有修复登记。
  // 判据是 `fix_contracts` 非空，不是「主 Agent 说修完了」——
  // wave4-fix.md §2 要求每个缺陷在**第一次 Edit 之前**登记五字段，
  // 所以「有登记」等价于「确实进入过修复」，而「无登记」等价于「这个相位什么都没发生」。
  wave4: () => fixContracts.length > 0,
  // wave5（验收相位）的交付物 = 每一条 fix_contract 都有裁决。
  // 判据取 `verdict ∈ {PASS, FAIL}`（output-contract 的 verify 闭集）。
  // 为什么不是「有一条 PASS」：验收相位做完的标志是**没有未裁决的修复**，
  // 而不是「修好了几个」。FAIL 也是合法的终态——它意味着回波次四重修，
  // 但那个决定必须已经被做出来。缺 verdict 的那条是「没人看过」，
  // 它与「看过后判不通过」在账本上必须可区分，否则未验收会被混进已验收。
  wave5: () => fixContracts.length > 0 &&
    fixContracts.every((fc) => VERDICT_VALUES.includes(fc?.verdict)),
  report: () => state.report?.final_report_path && existsSync(state.report.final_report_path),
};
const check = PHASE_DELIVERABLES[state.phase];
if (check && !check()) {
  // wave4/wave5 缺席的是账本里的具体条目，泛泛说「交付物没落盘」等于没说——
  // 回灌给模型的信息必须指出缺的是哪一条，否则它只会再汇报一遍进度。
  const specific = {
    wave4:
      `wave4（修复相位）的 fix_contracts 为空。这个相位的交付物就是修复登记本身：\n` +
      `每个缺陷在**第一次 Edit 之前**登记 finding_id / fix_agent_id / registered_at / ` +
      `defect_statement / disproof_condition / rollback_command / test_path（wave4-fix.md §2）。\n` +
      `没有登记的修复无法被验收波消费，rollback_command 也无人可用。`,
    wave5:
      `wave5（验收相位）还有没被裁决的 fix_contract：每一条都必须有 verdict ∈ PASS | FAIL。\n` +
      `验收结论只有这两种取值（output-contract verify 闭集）；「带保留通过」写成 ` +
      `PASS + escalation_required:true，不是新的枚举值（wave5-verify.md §5.2）。\n` +
      `缺 verdict 意味着这条修复**没人验过**，它与「验过但没通过」在账本上必须可区分。`,
  }[state.phase];
  problems.push(
    specific ??
    `phase=${state.phase} 的交付物还没落盘（见 protocol.md §0.8.2 的相位交付物表）。\n` +
    `相位交付物是「这个相位做完了」的客观证据——没有它，就还不能交付。`
  );
}

// 3.5 · wave4：多条缺陷必须多实例，不得在单个实例里串行
// 2026-11-15（R1）新增。比 wave2a 更严，理由是修复相位缺了 wave3 的 Skeptic：
// `critique-panel.md` 的 Skeptic 只在锐评相位执法，修复相位没有对应的批判角色，
// 所以「一条一条串着修」在修复相位没有任何东西会反对它（见 DIAG-FINAL 的 S2-4）。
//
// 第二个诱因在 `final-report.md:25`：它要求 FIX 路径「每条发现结束」出报告，
// 于是每条发现天然生成一个停点，而停点就是串行的入口。
// 这两条合起来把「极限多 agent」在修复阶段折成了单实例。
//
// 判据用 `spawned_fix_agents`（实际派发的修复实例数，写在 budget 下）：
// 它必须是**实际计数**，与 budget.spent 同一条纪律（run-state.md 第 2 节）。
// 字段缺失按 0 处理——账本没有记录就等于没有发生过，不能默认它派过。
if (state.phase === 'wave4') {
  const findingIds = new Set(
    fixContracts.map((fc) => fc?.finding_id).filter((x) => typeof x === 'string' && x !== '')
  );
  const spawned = Number(state.budget?.spawned_fix_agents ?? state.spawned_fix_agents ?? 0);
  if (findingIds.size > 1 && spawned <= 1) {
    problems.push(
      `wave4 里有 ${findingIds.size} 条独立缺陷（${[...findingIds].slice(0, 5).join(', ')}` +
      `${findingIds.size > 5 ? '…' : ''}），但账本记录的修复派发实例数是 ${spawned}。\n` +
      `多条独立缺陷在单个实例里串行完成，违反 triage.md 的面板下限` +
      `（T0≥3 / T1≥5 / T2≥9，triage.md §3「取消降级路径」）。\n` +
      `修复相位没有 Skeptic 执法（Skeptic 只在 wave3），所以这条只能由本 hook 拦。\n` +
      `请按缺陷逐条派发独立实例，并把实际派发数写进 budget.spawned_fix_agents（实际计数，不得估算）。`
    );
  }
}

// 3.6 · wave4/wave5：账本声称的实例数必须与 harness 日志对得上
// 2026-11-15（R8）新增。上面 3.5 的判据只比较三个**都来自 state.json** 的数字：
// distinct(finding_id)、distinct(fix_agent_id)、spawned_fix_agents。
// 它们全是主 Agent 的自述，两个自述互相一致不产生外部约束力。
//
// R7 实测过完整绕过（`FIX-R7-report.md` §4 洞 1）：
//   8 条发现登记成 8 个不同的假 fix_agent_id，spawned=8，实际 1 个 session 做完
//   → stop-hook exit 0、check-fix-instances exit 0、missing 0、零规则触发
//
// 这里引入一个主 Agent 不能随手写的外部基准：harness 自己落的 session 日志里
// 真实发起过几次 `subagent` 调用。伪造它的成本从「改账本」跳到
// 「篡改 harness 运行时数据」（zstd 日志里还有 tool/result、job/registered、
// seq 连续性，单改一处会对不上）。
//
// 降级纪律：只有探测到 dsh 格式的 session 日志时才启用。其他 harness 一律跳过——
// 一个只支持 dsh 的判据不该在别处把流程卡死（见 check-fix-instances-harness.mjs 文件头）。
if (state.phase === 'wave4' || state.phase === 'wave5') {
  const sessionsRoot = process.env.DSH_SESSIONS_ROOT ||
    join(homedir(), '.dsh', 'sessions');
  if (existsSync(sessionsRoot)) {
    // 从 state.json 所在目录推断 dsh 的 project 目录名。
    //
    // 为什么必须推断而不是让用户传参：`check-fix-instances-harness.mjs` 在 sessions root 下
    // 有多个 project 时报 project_dir_ambiguous（exit 2）——它的立场是「不猜」。但如果集成层
    // 也照抄这个立场，这条对账就永远跑不起来（真实环境的 sessions root 下有 19 个 project），
    // 等于没接。所以推断的责任在调用方，也就是这里。
    //
    // dsh 的目录名编码（实测，见 sessions root 下的真实目录名）：
    //   - 空格 → `~0020`
    //   - 路径分隔符（`\` `/`）与冒号 → `-`
    //   - **字母、数字、下划线 `_`、连字符 `-` 原样保留**
    //   - 整体包一层 `--`
    // 例如
    //   D:\Projects\AI prompt\many-agents_multi-prompt-files_token-heavy\multi-agent-audit-framework
    //   → --D-Projects-AI~0020prompt-many-agents_multi-prompt-files_token-heavy-multi-agent-audit-framework--
    //
    // 注意：下划线必须保留。早期版本把 `_` 也替换成 `-`，导致
    // `..._multi-prompt-files_token-heavy...` 编码成 `...-multi-prompt-files-token-heavy...`，
    // 与真实目录名永不匹配，集成静默失效。
    const dshEncode = (absPath) => '--' + absPath
      .replace(/ /g, '~0020')
      .replace(/[\\/:]+/g, '-')
      .replace(/[^A-Za-z0-9_~-]+/g, '-') + '--';
    const guessProjectDir = (stateDirAbs) => {
      let entries;
      try { entries = readdirSync(sessionsRoot, { withFileTypes: true }); }
      catch { return null; }
      const dirs = entries.filter((e) => e.isDirectory() && e.name.startsWith('--')).map((e) => e.name);
      if (dirs.length === 1) return dirs[0];
      // state.json 按约定在 <repo>/docs/reports/round{N}/ 下，向上找三级得到仓库根
      const candidates = [
        stateDirAbs,
        dirname(stateDirAbs),
        dirname(dirname(stateDirAbs)),
        dirname(dirname(dirname(stateDirAbs))),
      ].map(dshEncode);
      for (const c of candidates) {
        if (dirs.includes(c)) return c;
      }
      return null;
    };
    const projectDir = guessProjectDir(dirname(resolve(statePath)));
    const extraArgs = projectDir ? ['--project-dir', projectDir] : [];
    let parsed = null;
    try {
      const out = execFileSync(process.execPath, [
        join(HERE, 'check-fix-instances-harness.mjs'),
        '--state', statePath,
        '--sessions', sessionsRoot,
        ...extraArgs,
        '--json',
      ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      parsed = JSON.parse(out);
    } catch (e) {
      try { parsed = JSON.parse(String(e.stdout ?? '')); } catch { /* 不是 JSON */ }
      // exit 2 是配置错误（推断失败 / 没有本项目日志），这属于环境问题，不拦人
      if (!parsed && e.status !== 2) {
        problems.push(
          `harness 日志对账没能执行：${String(e.message ?? e).slice(0, 200)}。` +
          `如果这是环境问题，说明原因后继续；否则先修工具。`
        );
      }
    }
    if (parsed) {
      for (const f of (parsed.problems ?? [])) {
        if (f.level === 'FAIL') {
          problems.push(
            `账本声称与实际派发对不上（${f.rule}）：${f.message}\n` +
            `本 hook 只认 harness 的 session 日志，不认账本自述——` +
            `上面 3.5 那三条判据的数字全部来自 state.json，能被一致地写出来。`
          );
        }
      }
    }
  }
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
