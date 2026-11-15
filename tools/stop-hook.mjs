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
import { join, dirname, resolve, basename } from 'node:path';
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

// 3.7 · wave4/wave5：交付的修复产物自己能不能被观测到（R13 新增）
//
// 上面 3.5 / 3.6 检查的全是「账本里写了什么」：distinct(finding_id)、
// budget.spawned_fix_agents、以及 harness 日志里的 subagent 次数。
// **没有一条检查产物本身。** 于是 R12《FIX-R12-report.md》§八·洞 B 逐字写下的
// 失败场景在 R12 之后仍然完全可行：
//
//   修复 Agent 写完 6 份 done-*.md，全都没有信封，check-payload 一次没跑。
//   主 Agent 不看模板第 7 节，直接收下返回 —— 信封里 payload 为空也能过 status 检查，
//   因为**根本没有信封可检查**。stop-hook 放行（fix_contracts 非空即可）。本轮照样闭合。
//
// 这里把 `check-fix-artifacts-envelope.mjs`（证据链第 1 环的批量闸门）接上来。
// 它只问一件事：这一批产物里，有几份根本进不了 check-payload。
// 没有信封 = 无法被任何机械检查观测 = 未交付 —— 与 check-payload 的立场一致。
//
// ── 产物目录从哪来（本段的中心设计决策）──
// 读 `framework/artifacts/run-state.md` 与 `report-naming.md` 后确认：
// state.json **已有**约定的产物目录字段 `report.dir_path`
// （run-state.md 第 2 节：「本轮产物目录的绝对路径，供子 Agent 拼 artifact_path」，
//   且 `report.dir_ready` 是派发前的硬闸）。所以**不新增必填字段**——
// `check-state.mjs` 的 TOP_REQUIRED 只有 7 个顶层键，但 check-state 对未列出的
// 顶层字段是宽容的；真正的风险不是它，而是「新增必填字段会让所有存量 state.json
// 一夜之间变不合规」。既有字段已经够用，就没有理由付那个代价。
//
// 推断顺序（后者是兜底，不是首选）：
//   1. state.report.dir_path                       ← 约定字段，直接可信
//   2. dirname(state.report.final_report_path)     ← report-naming.md §4：一层平铺，
//                                                    报告与波次产物同目录
//   3. dirname(state.fix_contracts[].test_path)    ← 最后兜底；测试文件常在仓库里，
//                                                    不常在产物目录里，容易推错
// 三条都推不出来 → 见下方「推断失败时的判据」。
//
// ── 推断失败时的判据（2026-11-15 R14 改）──
//
// 原文是「三条都推不出 → **WARN，不 FAIL**」。R13 自己在
// `FIX-R13-report.md` §7.2 把它标为「本轮最大的残留口子」，理由是：
//
//   它把「检查不通过」和「检查没跑」混成了同一种结局。
//   而「不写 report.dir_path」是**最省力的绕过**——不用伪造产物、不用改账本数字，
//   只消省略一个字段，整道信封闸门就变成一条 WARN。
//   这与 R10 点名的「降级路径本身就是一条明面上的后门」是同一类问题。
//
// 所以现在分两种情况，判据是「这一相位有没有已登记的修复」：
//
//   - `fix_contracts` **非空** → 目录推断不出 = **账本缺字段** → 拒绝闭合（进 problems）。
//     理由：修复已经登记了，就必然有产物要交、有信封要查；
//     「推断不出目录」在这里不是环境问题——主 Agent 手上有这个路径（它派发时用过），
//     写一行就能让闸门跑起来。省略不是受环境所限，是选择。
//
//   - `fix_contracts` **为空** → 仍降级 WARN。
//     理由：这一相位本来就没有待检产物，目录对信封检查没有意义；
//     而「wave4 但契约为空」另有 §3 的交付物判据去拦，不需要这里重复开火。
//
// 降级纪律仍然适用于**真正的环境问题**：sessions root 不存在（§3.6）、
// 目录可推断但读不了、检查器执行失败——那些是拿不到外部信息，不是账本没写。
// 两者的区别是「谁有能力让它变成可查」：环境不行时主 Agent 无能为力，
// 缺字段时它只要写一行。**能自己修的事不能算降级理由。**
//
// ── 存量无信封产物怎么办：可声明豁免 ──
// 硬 FAIL 一个历史产物目录会让所有老项目无法闭合。所以 state.json 可以声明
// `legacy_artifacts: [<文件名>...]`（可选，**不是必填**，见 run-state.md §2.6）。
// 但豁免必须留痕且可见，而且**不能变成关掉检查的开关**：
//   - 每条被豁免的产物都单独 WARN，写明它在契约体系之外、证据不可机械复核；
//   - 豁免条目若匹配不到任何产物，WARN（悬空豁免 = 悄悄复活的可能）；
//   - 豁免条目数 ≥ 目录下待检产物总数 → **FAIL**。全量豁免等于把这段检查关掉，
//     那它就是「有开关的检查」，而 R12 §洞 B 的失败场景会原样复现，
//     只是这次账本里多了一个数组。
if (state.phase === 'wave4' || state.phase === 'wave5') {
  if (state.path_mode !== 'FIX') {
    // wave4/wave5 只在 FIX 路径上有意义（run-state.md §2.5）。
    // 相位与路径模式对不上是账本自己的问题，交给 check-state.mjs，这里不管。
  } else {
    const warnings = [];

    // 3.7.1 推断产物目录
    const inferArtifactDir = (st) => {
      const candidates = [];
      const dirPath = st.report?.dir_path;
      if (typeof dirPath === 'string' && dirPath.trim() !== '') {
        candidates.push({ from: 'report.dir_path', dir: resolve(dirname(resolve(statePath)), dirPath) });
        candidates.push({ from: 'report.dir_path', dir: resolve(dirPath) });
      }
      const frp = st.report?.final_report_path;
      if (typeof frp === 'string' && frp.trim() !== '') {
        candidates.push({ from: 'dirname(report.final_report_path)', dir: resolve(dirname(resolve(statePath)), dirname(frp)) });
        candidates.push({ from: 'dirname(report.final_report_path)', dir: resolve(dirname(frp)) });
      }
      const contracts = Array.isArray(st.fix_contracts) ? st.fix_contracts : [];
      for (const c of contracts) {
        const tp = c?.test_path;
        if (typeof tp === 'string' && tp.trim() !== '' && /[\\/]/.test(tp)) {
          const cand = resolve(dirname(resolve(statePath)), dirname(tp));
          candidates.push({ from: 'dirname(fix_contracts[].test_path)', dir: cand });
          break;
        }
      }
      for (const c of candidates) {
        try {
          if (existsSync(c.dir) && statSync(c.dir).isDirectory()) return c;
        } catch { /* 继续试下一个 */ }
      }
      return null;
    };

    const inferred = inferArtifactDir(state);
    if (!inferred) {
      if (fixContracts.length > 0) {
        // R14：账本缺字段不能降级。见本段上方的「推断失败时的判据」。
        //
        // 报错必须区分两种成因，否则回灌给模型的方向是错的：
        //   (a) 两个字段根本没写      → 这是本案的主要目标（最省力的绕过）
        //   (b) 写了但指向不存在的目录 → 不是省略，是「写错了」，补法与 (a) 不同
        // 两者都是账本问题、都该拦，但混成一句话会让模型去补一个它已经写过的字段。
        const rawDir = state.report?.dir_path;
        const rawFinal = state.report?.final_report_path;
        const wroteSomething =
          (typeof rawDir === 'string' && rawDir.trim() !== '') ||
          (typeof rawFinal === 'string' && rawFinal.trim() !== '');
        const diagnosis = wroteSomething
          ? `state.json 里写了目录线索（report.dir_path=${JSON.stringify(rawDir)}，`
            + `report.final_report_path=${JSON.stringify(rawFinal)}），`
            + `但按它解析出的目录都不存在，fix_contracts[].test_path 也定位不到。\n`
            + `**这仍然是账本问题，不是环境问题**：路径写错了，而「写错」不能当成「没写」的降级通道。`
            + `环境问题（例如 sessions root 不存在）可以降级，账本写错了不行。`
          : `state.json 里既没有 report.dir_path，也没有 report.final_report_path，`
            + `fix_contracts[].test_path 也不足以定位产物目录。`;
        problems.push(
          `产物目录推断不出来，而 phase=${state.phase} 已经登记了 ${fixContracts.length} 条修复契约。\n`
          + `${diagnosis}\n\n`
          + `**在这条判据上，「推断不出目录」不是环境问题，是账本缺字段。** 修复已经登记了，`
          + `就必然有产物要交、有「产物必须带 JSON 信封」这道闸门要跑；而闸门需要一个目录作为输入。\n`
          + `所以不能像 R13 那样用一条 WARN 放行——那样等于把「检查没跑」记成「检查通过」，`
          + `而绕过它只需要省略一个字段（FIX-R13-report.md §7.2 口子 1，R13 自己标为「最大的残留口子」）。\n\n`
          + `环境问题（例如 sessions root 不存在）可以降级，账本缺字段不行——`
          + `区别在于「谁有能力让它变成可查」：环境不行时你无能为力，缺字段时你只要写一行。\n`
          + `补法：把本轮产物目录的**绝对路径**写进 report.dir_path（report-naming.md §5.1：`
          + `波次一启动前就该有它），或至少写 report.final_report_path（与产物同目录），`
          + `并确认该目录真实存在。`
        );
      } else {
        warnings.push(
          `WARN · 产物目录无法确定：state.json 里既没有可用的 report.dir_path，`
          + `也没有 report.final_report_path / fix_contracts[].test_path 可供推断。\n`
          + `因此本次**没有执行**产物信封检查（check-fix-artifacts-envelope.mjs）——`
          + `「修复产物有没有信封」这一项在本回合未验证。\n`
          + `这一档之所以仍可降级，是因为 fix_contracts 为空：这个相位还没有任何待检产物，`
          + `目录对信封检查也就没有意义（「wave4 却没有任何修复登记」由 §3 的交付物判据拦）。\n`
          + `按 report-naming.md §5.1，主 Agent 应在波次一启动前把产物目录写进 report.dir_path；`
          + `补上它之后这个检查会自动生效。`
        );
      }
    } else {
      // 3.7.2 读目录、算分母
      //
      // 待检产物口径必须与 check-fix-artifacts-envelope.mjs 的默认 pattern 一致
      // （done-*.md 与 *-fix-*.md），否则两套工具会对同一目录给出不同分母。
      //
      // 2026-11-15（R15）：补上 `fix-*.md`。R7 的 e2e fixture 用的就是 `fix-1.md`
      // 这种最朴素的名字，而 `*-fix-*.md` 要求 fix 前面还有一段（`round1-04-fix-1.md`）。
      // 两者都是合法的修复产物命名，漏掉一个会让「目录里明明有产物」被误判成空目录——
      // 而空目录在 R15 之后是拒绝闭合的。分母口径必须宽到覆盖真实命名习惯。
      const patternRes = [/^done-.*\.md$/i, /^.*-fix-.*\.md$/i, /^fix-.*\.md$/i];
      let files = [];
      let subdirs = [];
      let totalFiles = 0;
      let dirReadable = true;
      try {
        const entries = readdirSync(inferred.dir, { withFileTypes: true });
        const plainFiles = entries.filter((e) => e.isFile()).map((e) => e.name);
        totalFiles = plainFiles.length;
        files = plainFiles
          .filter((n) => patternRes.some((re) => re.test(n)))
          .sort();
        subdirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();
      } catch {
        dirReadable = false;
        warnings.push(
          `WARN · 产物目录可推断（${inferred.dir}，来自 ${inferred.from}）但无法读取，`
          + `本次跳过产物信封检查。这是环境问题，不是产物问题。`
        );
      }

      if (dirReadable && subdirs.length > 0) {
        // 这一条与检查器自己的 subdirectory_not_scanned 同义，但**必须在本层也报**：
        // 「把存量产物移进 legacy/ 子目录」是本框架对「无信封历史产物」的官方出路
        // （见 check-fix-artifacts-envelope.mjs 文件头），而子目录不进分母这件事
        // 如果没人说出来，就等于给了它一个静默的豁免通道。留下痕迹，才能被审计。
        warnings.push(
          `WARN · 产物目录 ${inferred.dir} 下有子目录（${subdirs.slice(0, 6).join('、')}`
          + `${subdirs.length > 6 ? ' …' : ''}）——其中的产物**不在**本次信封检查的范围内，也不进分母。\n`
          + `若那是刻意保留的无信封历史产物（例如 legacy/），这个 WARN 就是它的痕迹：`
          + `那些证据在契约体系之外，不可机械复核。若那是本轮产物，请摊平到 ${inferred.dir} 下。`
        );
      }

      if (dirReadable && files.length === 0) {
        // 0 份产物在逻辑上「每份都有信封」，但那不是通过，是「没什么可检查」。
        // check-fix-artifacts-envelope.mjs 对空目录报 exit 2（配置错误），
        // 在集成层这里降为 WARN —— 但**只在「本回合确实还有活没干完」时降级**。
        //
        // 2026-11-15（R15）：R14 发现这里仍是一条「用空目录换掉闸门」的路——
        // 把 report.dir_path 写成一个真实存在但没有产物的目录，仍然 exit 0。
        // R14 当时没有升 FAIL，理由是「修复相位允许『产物还没写完』这个中间态」。
        // 那个理由只在**还有修复实例在跑**的时候成立。
        //
        // 所以判据不能用「有没有产物」，要问「**该不该有产物了**」。
        // 能机械回答这件事的信号只有一个：`in_flight` 里还有没有活着的修复实例。
        //   - `in_flight` 非空 → 确实还在跑 → 降级 WARN（本回合结束不代表相位结束）
        //   - `in_flight` 为空（或缺失）→ 活都干完了却一份产物都没有 → **拒绝闭合**
        // 这不是新增判据，是把 R13/R14 那条降级的适用条件写准。
        const inFlight = Array.isArray(state.in_flight) ? state.in_flight : [];
        const stillRunning = inFlight.length > 0;
        const emptyMsg =
          `产物目录 ${inferred.dir}（来自 ${inferred.from}）下没有任何 done-*.md / *-fix-*.md。`;
        if (stillRunning) {
          warnings.push(
            `WARN · ${emptyMsg}`
            + `账本里还有 ${inFlight.length} 个实例在 in_flight 中，说明本回合确实处在`
            + `「产物还没写完」的中间态，本轮不阻断。`
          );
        } else {
          problems.push(
            `${emptyMsg}\n`
            + `而账本的 in_flight 是空的——也就是说没有任何修复实例还在跑，`
            + `但那个目录里一份产物都没有。\n`
            + `这不是「还没写完」，是「写完了却什么都没交」。\n`
            + `空目录在逻辑上「每份都有信封」，但那不是通过，是**没什么可检查**——`
            + `把 report.dir_path 指向一个空目录就能让这道闸门失效，`
            + `这正是 R13 §7.2 口子 1 换个写法后的样子。\n`
            + `请把产物写到该目录下，或修正 report.dir_path 指到真正的产物目录。`
          );
        }
      } else if (dirReadable) {
        // 3.7.3 legacy_artifacts 豁免（可选字段，不是必填）
        const rawLegacy = state.legacy_artifacts;
        let legacy = [];
        if (rawLegacy !== undefined && rawLegacy !== null) {
          if (!Array.isArray(rawLegacy)) {
            problems.push(
              `legacy_artifacts 必须是字符串数组（列被豁免的无信封产物文件名），`
              + `实际是 ${Array.isArray(rawLegacy) ? 'array' : typeof rawLegacy}。`
              + `一个自由格式的豁免字段无法被机械核对，等于没有。`
            );
          } else {
            legacy = rawLegacy.filter((x) => typeof x === 'string' && x.trim() !== '').map((x) => basename(x.trim().replace(/\\/g, '/')));
          }
        }
        const legacySet = new Set(legacy);

        // ── 全量豁免 = 关掉检查 ──
        //
        // 分母用**目录下文件总数**（totalFiles），不是「被 pattern 选中的产物数」。
        // 理由：repair/ 这类目录里产物与流程文档（SUMMARY / ADJUDICATION / 验收记录 /
        // 退修日志）是平铺共存的——report-naming.md §4 明规定「一层平铺、不分子目录」。
        // 而「全量豁免」要防的是「把整个目录都划到检查之外」。
        // 若拿产物数当分母，真实场景里 6 份历史产物 + 6 条豁免立刻触发 6/6，
        // 而这恰恰是**应当允许**的那一档（任务书与本轮 LEGACY-ARTIFACTS.md 的决定：
        // 承认这批证据永久不可复核）。分母取文件总数，6/15 才是「少数例外」的正确刻画。
        //
        // 由此带来的形态是：目录里**只有**产物时（6 份产物、无文档）6/6 依然成立 → 正确拦截。
        // 而「有文档稀释、但所有产物都被豁免」这一档不阻断，转由下面那条 WARN 大声留痕
        // （「本轮没有任何修复产物经过信封检查」）。这是有意的取舍：
        // 硬 FAIL 会把真实历史目录判死，而任务书对它的决定是「豁免 + 留痕」，不是「不许闭合」。
        const matchedLegacy = legacy.filter((n) => files.includes(n));
        if (totalFiles > 0 && matchedLegacy.length >= totalFiles) {
          problems.push(
            `legacy_artifacts 声明了 ${matchedLegacy.length} 条匹配到产物的豁免，`
            + `而产物目录 ${inferred.dir} 下共 ${totalFiles} 个文件（其中待检产物 ${files.length} 份）——`
            + `**全量豁免等于关掉这个检查**。\n`
            + `这个字段的用途是「承认少数历史产物永久不可机械复核」，不是「让这轮通过」。`
            + `两者在账本上必须可区分，否则它就是本轮之后仍然可行的失败场景，`
            + `只是账本里多了一个数组（见 FIX-R12-report.md §八·洞 B）。\n`
            + `请减少豁免条目，或把历史产物移出待检目录（例如 <dir>/legacy/，子目录不进分母），`
            + `或补上信封。`
          );
        } else if (files.length > 0 && matchedLegacy.length === files.length) {
          // 产物 100% 被豁免，但目录里有别的文件把计数稀释了，所以没触发上面那条。
          // 不阻断（这是「少数产物 + 大量过程文档」的真实形态），
          // 但必须大声说出来：这一轮的产物**一份都没被检查过**。
          warnings.push(
            `WARN · 待检产物 ${files.length} 份**全部**在 legacy_artifacts 里（${matchedLegacy.join('、')}）——`
            + `本轮没有任何修复产物经过信封检查。\n`
            + `这是「整批承认不可复核」，不是「这批产物合规」。凡是引用它们的验收结论都无法由工具复核。`
          );
        }

        // 悬空豁免：列了但目录里没有这份产物。
        // 不是闭合障碍（历史产物可能已被清理），但必须说出来——
        // 一条永远匹配不上的豁免会在同名文件将来出现时悄悄生效。
        const dangling = legacy.filter((n) => !files.includes(n));
        if (dangling.length > 0) {
          warnings.push(
            `WARN · legacy_artifacts 有 ${dangling.length} 条豁免在 ${inferred.dir} 下匹配不到任何产物：`
            + `${dangling.slice(0, 6).join('、')}${dangling.length > 6 ? ' …' : ''}。\n`
            + `它们不阻断闭合，但会在同名产物将来出现时静默生效——确认这些文件确实已被清理，`
            + `然后从 legacy_artifacts 里删掉对应条目。`
          );
        }

        // 3.7.4 调批量闸门。豁免不在这里过滤：
        // 让检查器照常报 FAIL，再由本层把「已声明豁免的」降级为 WARN。
        // 这样检查器本身仍然保持「不提供 --ignore」的立场（它的文件头写了为什么），
        // 豁免的唯一出口就在账本里，而且可见。
        let parsed = null;
        let configErr = null;
        try {
          const out = execFileSync(process.execPath, [
            join(HERE, 'check-fix-artifacts-envelope.mjs'),
            '--dir', inferred.dir,
            '--json',
          ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
          parsed = JSON.parse(out);
        } catch (e) {
          try { parsed = JSON.parse(String(e.stdout ?? '')); } catch { parsed = null; }
          if (!parsed) configErr = e;
        }

        if (!parsed) {
          // 配置错误（exit 2）与执行失败（其他）都是环境/接线问题，不拦人。
          warnings.push(
            `WARN · 产物信封检查没能执行：${String(configErr?.message ?? '无输出').slice(0, 200)}。`
            + `这是工具/环境问题，不是产物合规问题——但意味着「有没有信封」本回合没有答案。`
          );
        } else {
          const withoutEnvelope = [];
          for (const f of (parsed.problems ?? [])) {
            if (f.level !== 'FAIL') continue;
            const file = f.file;
            const isEnvelopeRule = ['artifact_without_envelope', 'envelope_invalid',
              'envelope_wrong_role', 'envelope_missing_disposition'].includes(f.rule);

            if (file && legacySet.has(file)) {
              // 已声明豁免：留痕，不阻断。
              warnings.push(
                `WARN · 产物 ${file} 在契约体系之外（legacy_artifacts 已声明豁免）：${f.rule}。\n`
                + `  证据不可机械复核——它不是「通过了检查」，是「没有被检查」。`
                + `后续任何引用它的验收结论都无法由工具复核，只能由人读原文。`
              );
              continue;
            }

            if (isEnvelopeRule && file) {
              withoutEnvelope.push({ file, rule: f.rule, msg: f.msg });
            } else {
              problems.push(
                `修复产物的信封不可用（${f.rule}${file ? ` · ${file}` : ''}）：${f.msg}\n`
                + `没有信封 = check-payload 的全部规则在这份产物上一次都不会跑 = 无法被观测 = 未交付。`
              );
            }
          }

          if (withoutEnvelope.length > 0) {
            problems.push(
              `有 ${withoutEnvelope.length} 份修复产物**没有可用的信封**（产物目录 ${inferred.dir}，`
              + `来自 ${inferred.from}）：\n`
              + withoutEnvelope.slice(0, 8).map((x) => `  - ${x.file}（${x.rule}）`).join('\n')
              + (withoutEnvelope.length > 8 ? `\n  … 另有 ${withoutEnvelope.length - 8} 份` : '')
              + `\n\n这不是「格式不规范」。没有信封 = check-payload 的全部规则在这份产物上一次都不会跑`
              + `（含「红测日志必须在 target/ 之外」「证据文件必须存在」「disposition 必须表态」）——`
              + `无法被任何机械检查观测 = 未交付。不是因为通过，是因为没跑。\n`
              + `两份 2026-11-15 的修复产物就是这样交出去的。\n`
              + `补法：在每份产物末尾追加一个 \`\`\`json 信封（components/output-contract.md §1），`
              + `role="fix"，payload 里带 disposition（FIXED | WONT_FIX | DEFERRED | NEW_FINDING），`
              + `然后跑 node tools/check-payload.mjs <产物> --role fix --repo <被审仓库>。\n`
              + `若这些是**历史产物**、确实无法补信封，把它们列入 state.json 的 legacy_artifacts`
              + `（会留 WARN 且计入不可复核证据；不能全量豁免）。`
            );
          }
        }
      }
    }

    // WARN 走 stderr 但不阻断：exit 0 时 stderr 仍会被 harness 记录，
    // 这样「降级」与「什么都没发生」在日志上可区分。
    if (warnings.length > 0) {
      console.error(
        `[产物信封检查 · 告警（不阻断）]\n\n`
        + warnings.map((w, i) => `${i + 1}. ${w}`).join('\n\n')
      );
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
