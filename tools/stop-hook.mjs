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
import { join, dirname, resolve, basename, isAbsolute } from 'node:path';
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
//
// 这个 project 目录推断也被下面的 §3.6b（R21 的 files_touched ↔ write/edit 对账）复用，
// 所以提到两段共用的位置；两段必须用**同一个** project 目录，否则两段会看不同的日志。
const DSH_SESSIONS_ROOT = process.env.DSH_SESSIONS_ROOT ||
  join(homedir(), '.dsh', 'sessions');

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

// 从 state.json 所在目录推断 dsh 的 project 目录名。
//
// 为什么必须推断而不是让用户传参：`check-fix-instances-harness.mjs` 在 sessions root 下
// 有多个 project 时报 project_dir_ambiguous（exit 2）——它的立场是「不猜」。但如果集成层
// 也照抄这个立场，这条对账就永远跑不起来（真实环境的 sessions root 下有 19 个 project），
// 等于没接。所以推断的责任在调用方，也就是这里。
const guessDshProjectDir = (stateDirAbs, sessionsRoot) => {
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

if (state.phase === 'wave4' || state.phase === 'wave5') {
  const sessionsRoot = DSH_SESSIONS_ROOT;
  if (existsSync(sessionsRoot)) {
    const projectDir = guessDshProjectDir(dirname(resolve(statePath)), sessionsRoot);
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

// 3.6b · wave4/wave5：files_touched ↔ harness 的 write/edit 记录对账（R21 新增）
//
// 为什么这是**新层次**而不是 3.6 的延长线（R20 §三点原文）：
//   「下一个层次必须换观测面（harness 记录 tool call 与文件写入），而不是继续往
//     state.json 加字段——每个新字段都是一个新省略点。」
//
// 3.6 用 harness 日志回答了「派发了几次」，但它看的是 `subagent` 工具调用。
// 这段看的是另一类事件：**`write` / `edit` 的 file_path**。
// 它回答的是 R19/R20 那条链上一直没答对的问题——「files_touched 里声称的文件，
// 真的被改过吗」。R19 拿 `git status` 当基准（相对 HEAD 的**状态**），
// 于是「修复前就是脏的」既能造出假阴性也能造假阳性，R20 只能靠一个同样自述的
// `fix_baseline` 把误差缩小一点。write/edit 记录是**动作**，与仓库脏不脏无关。
//
// 同时也回答了 R19 §(b) 的归属问题：`files_touched` 没有 agent_id 维度，
// 全局对账时「A 少登记的被 B 登记过」会互相抵消。dsh 的子 session 有 parentSession，
// 所以当 fix_agent_id 就是子 session id 时，可以逐实例对账。
//
// ── 为什么这条必须真的挡住闭合 ──
// R12/R13 反复批评过「接上了但没接在门上」：检查跑通了、输出也有，就是不改 exit code。
// 那等于给了一道看得见摸不着的闸门，比没有更糟——它让人以为有人在管。
// 所以这里 FAIL → `problems.push` → exit 2，与 §3 的其他判据同等地位。
//
// ── 降级纪律 ──
// sessions root 不存在 / 探测不到 dsh 日志 / 推断不出 project 目录 → **跳过**，
// 不 push 任何东西（该工具自己会在被调用时给出 WARN，这里不重复开火）。
// 与 §3.6 同一条纪律：只支持 dsh 的判据不该在别处把流程卡死。
if (state.phase === 'wave4' || state.phase === 'wave5') {
  const sessionsRoot = DSH_SESSIONS_ROOT;
  if (existsSync(sessionsRoot)) {
    const projectDir = guessDshProjectDir(dirname(resolve(statePath)), sessionsRoot);
    if (projectDir) {
      let parsed = null;
      try {
        const out = execFileSync(process.execPath, [
          join(HERE, 'check-files-touched-harness.mjs'),
          '--state', statePath,
          '--sessions', sessionsRoot,
          '--project-dir', projectDir,
          '--json',
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
        parsed = JSON.parse(out);
      } catch (e) {
        try { parsed = JSON.parse(String(e.stdout ?? '')); } catch { /* 不是 JSON */ }
        // exit 2 = 配置错误（state 坏了 / session 指错）。那是账本或环境问题，
        // 由别的段去报；这里不重复开火，但也不能静默 —— 只有在完全拿不到输出时才说一句。
        if (!parsed && e.status !== 2 && e.status !== 1) {
          problems.push(
            `files_touched × write/edit 对账没能执行：${String(e.message ?? e).slice(0, 200)}。\n`
            + `如果这是环境问题（node 版本 / 权限），说明原因后继续；否则先修工具。`
          );
        }
      }
      if (parsed) {
        for (const f of (parsed.problems ?? [])) {
          if (f.level === 'FAIL') {
            const tail = f.rule === 'files_touched_overclaimed_by_harness'
              ? `\n本 hook 的判据是 harness 的 write/edit 调用记录，不是 \`git status\`。`
                + `R19 那条（§3.7.6.4）看的是「相对 HEAD 有没有差异」，一个文件在修复前就脏、`
                + `本轮一个字没碰也能蒙混过去；这里看的是「有没有人真的写过它」。`
              : f.rule === 'files_touched_underreported_by_harness'
                ? `\n这是外部基准判的 under-reporting，不是 \`git status\` 差值猜的：`
                  + `分母是「这个 session 真的写了什么」，与仓库脏不脏无关。`
                : f.rule === 'agent_attribution_mismatch'
                  ? `\n这是 R19 §(b) 点名的归属问题：全局对账时 A 的漏登记会被 B 的登记抵消，`
                    + `逐实例对账之后不会。`
                  : '';
            problems.push(
              `files_touched 与 harness 的写操作记录对不上（${f.rule}）：${f.message}${tail}`
            );
          }
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
        // 3.7.5 · 第二道闸门：check-payload 逐份校验（R17 新增）
        //
        // 3.7.4 的 check-fix-artifacts-envelope.mjs 只问**一件事**：这批产物里
        // 有几份根本进不了 check-payload。它回答「有没有信封」。
        // 但 R14 §六 的表里，口子 2 和口子 3 的「还差什么」写的是同一句话：
        //
        //   口子 2  有信封但字段错（schema_version / role / disposition 非法）
        //   口子 3  red_log_path 指向已删除文件
        //   → **stop-hook §3.7 只调 check-fix-artifacts-envelope，不调 check-payload**
        //
        // 所以「有信封」变成了「信封内容正确」的替代品。实测形态：
        // 一份 schema_version 写成 output-contract-v2、red_log_path 指向已删文件的产物，
        // 在 R14 之后仍然能 exit 0 闭合本轮。而 check-payload 早就有
        // wrong_schema_version / red_log_not_found 这两条规则——**规则存在，
        // 只是没有任何强制的调用点**。规则存在但从不执行，等于不存在。
        //
        // 这道闸门补的就是那个调用点：对 3.7.2 算出的每一份产物，逐份调用
        // check-payload.mjs --role fix --repo <state.target_repo> --artifact-dir <dir>。
        //
        // ── 为什么必须传 --repo 和 --artifact-dir ──
        // check-payload 的 red_log_not_found / test_path_not_found 要把信封里的
        // **相对路径**解析成绝对路径才能 existsSync。只给 --artifact-dir 时，
        // 相对被审仓库根的路径（例如 src/test/X.java）解析不出来，于是降级成
        // evidence_existence_unchecked 的 WARN——**检查被跳过，而不是不通过**。
        // 那正是口子 3 的形态。所以 target_repo 缺失时本层必须报错而不是静默降级：
        // 否则「接上了 check-payload」这句话在账本上看不出真假。
        //
        // R16a 已经在 check-state.mjs 加了 target_repo 的条件必填（FIX + wave4 +
        // 契约非空 → 必须是非空且真实存在的目录）。但 stop-hook 不能依赖
        // check-state 先跑过：这里是 harness 强制的最后一道闸，必须自己判。
        //
        // ── 性能：串行 + 硬上限 + 单份超时（R17 的取舍，不要重新设计）──
        // 逐份调用 = N 次进程启动。修复相位的产物数通常是 1~20 份，
        // 串行几十毫秒一份，总代价在百毫秒量级；并发带来的复杂度
        // （进程池、错误聚合顺序不确定）不值得。
        // 两个上限防止病态情况挂死：
        //   1. 超过 50 份只查前 50 份（按文件名排序，确定性），并 WARN 说出被跳过多少
        //   2. 单份 10 秒超时（execFileSync 的 timeout）——超时报 FAIL，但明确标注
        //      「这是工具没跑完，不是产物被判定违规」，避免把超时读成违规
        const MAX_PAYLOAD_FILES = 50;
        const PAYLOAD_TIMEOUT_MS = 10_000;

        // 只检查真的能进 check-payload 的产物。
        // 已声明 legacy 豁免的、以及根本没信封的，3.7.4 已经报过/降级过，
        // 这里再调一次 check-payload 只会得到一堆 no_json_envelope，是噪音。
        // 复用一个与 3.7.4 相同的信封探测，避免对同一份文件跑两次 json 解析逻辑：
        // 只要文件里有含 schema_version 或 role 的 ```json 块，就认为有信封可查。
        const hasEnvelope = (absPath) => {
          let text;
          try { text = readFileSync(absPath, 'utf8'); } catch { return false; }
          const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
          return blocks.some((b) => /"(schema_version|role)"\s*:/.test(b[1]));
        };

        const candidates = files
          .filter((f) => !legacySet.has(f))
          .map((f) => ({ name: f, abs: join(inferred.dir, f) }))
          .filter((x) => hasEnvelope(x.abs));

        const toCheck = candidates.slice(0, MAX_PAYLOAD_FILES);
        if (candidates.length > MAX_PAYLOAD_FILES) {
          warnings.push(
            `WARN · 待检产物 ${candidates.length} 份，超过硬上限 ${MAX_PAYLOAD_FILES} 份——`
            + `**只检查了前 ${MAX_PAYLOAD_FILES} 份**（按文件名排序），`
            + `另外 ${candidates.length - MAX_PAYLOAD_FILES} 份本次**没有经过 check-payload**。\n`
            + `这是性能保护，不是通过：被跳过的那 ${candidates.length - MAX_PAYLOAD_FILES} 份`
            + `的字段合规性本轮无答案。若这是真实形态（数百份产物），`
            + `请分批闭合，或先确认产物目录没把历史文件一起摊平进来。`
          );
        }

        if (toCheck.length > 0) {
          // target_repo 的判据。缺它 = check-payload 的相对路径解析会降级，
          // 而「降级」在这里等于口子 3 原样复现。所以是 problems 不是 warnings。
          const rawRepo = state.target_repo;
          const repoMissing = !(typeof rawRepo === 'string' && rawRepo.trim() !== '');
          let repoDir = null;
          let repoUsable = false;
          if (!repoMissing) {
            repoDir = isAbsolute(rawRepo) ? rawRepo : resolve(dirname(resolve(statePath)), rawRepo);
            try { repoUsable = existsSync(repoDir) && statSync(repoDir).isDirectory(); } catch { repoUsable = false; }
          }

          if (repoMissing || !repoUsable) {
            problems.push(
              `${repoMissing
                ? 'state.json 顶层没有 target_repo'
                : `state.json 的 target_repo="${rawRepo}"（解析为 ${repoDir}）不是一个真实存在的目录`}，`
              + `而 stop-hook 需要它来对 ${toCheck.length} 份修复产物跑 check-payload。\n\n`
              + `**这是账本问题，不是产物问题。** check-payload 的 red_log_not_found / `
              + `test_path_not_found 要把信封里的相对路径解析成绝对路径才能 existsSync；`
              + `拿不到被审仓库根时，这两条规则会降级成 evidence_existence_unchecked 的 WARN——`
              + `也就是「证据文件是否真的存在过」这一整项**本轮没有验证**，而不是不通过。\n`
              + `这正是 R14 §六 口子 3 的形态：不给 --repo 就降级。所以本层不降级。\n\n`
              + `补法：把被审仓库根的**绝对路径**写进 state.json 顶层的 target_repo`
              + `（R16a 已在 check-state.mjs 把它设为 FIX + wave4/wave5 + 契约非空时的条件必填）。`
            );
          } else {
            const checked = [];
            const failed = [];
            const timedOut = [];

            for (const { name, abs } of toCheck) {
              let json = null;
              let execErr = null;
              try {
                const out = execFileSync(process.execPath, [
                  join(HERE, 'check-payload.mjs'),
                  abs,
                  '--role', 'fix',
                  '--repo', repoDir,
                  '--artifact-dir', inferred.dir,
                  '--json',
                ], {
                  encoding: 'utf8',
                  stdio: ['ignore', 'pipe', 'pipe'],
                  timeout: PAYLOAD_TIMEOUT_MS,
                });
                json = JSON.parse(out);
              } catch (e) {
                // exit 1（不合规）也会走这里——stdout 里仍然是完整 JSON。
                try { json = JSON.parse(String(e.stdout ?? '')); } catch { json = null; }
                if (!json) execErr = e;
              }

              if (json) {
                const errs = Array.isArray(json.errors) ? json.errors : [];
                const warns = Array.isArray(json.warnings) ? json.warnings : [];
                checked.push({ name, errs, warns });
                if (errs.length > 0) failed.push({ name, errs });
                // WARN 也带上来：evidence_existence_unchecked 就藏在这里面。
                // 若出现它，说明 --repo 给了但某条路径仍然解析不出——这是枚举层面的
                // 信息，比 FAIL 更值得看，因为它意味着「这条路径的检查没跑」。
                for (const w of warns) {
                  if (w.rule === 'evidence_existence_unchecked') {
                    warnings.push(
                      `WARN · 产物 ${name} 的证据存在性**没能校验**：${w.msg}\n`
                      + `  （--repo / --artifact-dir 都已提供。可能是该路径写成了绝对路径但指向别处，`
                      + `或路径里带变量占位。这一条不是通过，是「本回合没答案」。）`
                    );
                  }
                }
              } else {
                const isTimeout = execErr?.code === 'ETIMEDOUT'
                  || /timed? ?out/i.test(String(execErr?.message ?? ''));
                if (isTimeout) {
                  timedOut.push(name);
                } else {
                  warnings.push(
                    `WARN · 产物 ${name} 的 check-payload 没能执行：`
                    + `${String(execErr?.stderr ?? execErr?.message ?? '无输出').slice(0, 200)}。`
                    + `这是工具/环境问题，不是产物违规——但意味着这份产物的字段合规性本回合没有答案。`
                  );
                }
              }
            }

            // ── 汇总失败：每条都必须能回答「哪份产物、哪个字段、错在哪 ──
            // 只说「check-payload 失败」的消息无法行动：读的人不知道去改哪一句。
            if (failed.length > 0) {
              const totalErrs = failed.reduce((s, f) => s + f.errs.length, 0);
              const lines = [];
              for (const { name, errs } of failed.slice(0, 10)) {
                lines.push(`  ${name}：`);
                for (const e of errs.slice(0, 6)) {
                  lines.push(`    - [${e.rule}] ${e.field}：${String(e.msg ?? '').split('\n')[0]}`);
                }
                if (errs.length > 6) lines.push(`    … 另有 ${errs.length - 6} 项`);
              }
              problems.push(
                `有 ${failed.length} 份修复产物**信封里的字段不合规**`
                + `（产物目录 ${inferred.dir}，共检查 ${toCheck.length} 份，`
                + `合计 ${totalErrs} 项违规）：\n`
                + lines.join('\n')
                + (failed.length > 10 ? `\n  … 另有 ${failed.length - 10} 份产物不合规` : '')
                + `\n\n这不是「格式不规范」那么轻。3.7.4 的信封闸门只回答「有没有信封」——`
                + `而这 ${failed.length} 份**有信封**，所以上一道闸门放行了；`
                + `答案在信封里面：schema_version 错了会让下游按错误的契约解析，`
                + `red_log_path / test_path 指向不存在的文件意味着「声称有的证据」其实没有。\n`
                + `这正是 R14 §六 的口子 2 与口子 3：规则（wrong_schema_version / red_log_not_found）`
                + `在 check-payload 里早就存在，但没有任何强制的调用点——规则存在但从不执行，等于不存在。\n`
                + `补法：逐份修。可以先自己跑一遍看完整理由：\n`
                + `  node tools/check-payload.mjs ${join(inferred.dir, failed[0].name)} --role fix `
                + `--repo ${repoDir} --artifact-dir ${inferred.dir}`
              );
            }

            if (timedOut.length > 0) {
              problems.push(
                `有 ${timedOut.length} 份产物的 check-payload **检查超时**（单份上限 `
                + `${PAYLOAD_TIMEOUT_MS / 1000} 秒）：${timedOut.slice(0, 8).join('、')}`
                + `${timedOut.length > 8 ? ` … 另有 ${timedOut.length - 8} 份` : ''}。\n`
                + `**这不是「产物违规」的判定**——是检查没跑完，所以这份产物的字段合规性本回合无答案。`
                + `最可能的原因是产物过大（几十万字的正文会让 json 块提取变慢）。\n`
                + `补法：确认这份产物是不是被误当成了产物（例如把整个会话记录写进了 done-*.md）；`
                + `若确实需要保留，请把正文压到必要证据，信封仍然完整。`
              );
            }
          }
        }

        // 3.7.6 · files_touched ↔ git status 双向对账（R19 新增）
        //
        // R18 §6 原文（直接采信）：
        //   **path existence does not mean the file was changed by this instance.**
        //   R18 的 files_touched_not_found 只证明必要条件。仍未回答：它到底被改了没有、
        //   是不是这一轮改的、改了什么，以及最糟的 under-reporting——
        //   一个实例改了 10 个文件，只列 1 个存在的，R18 的规则完全绿。
        //
        // 判据是**两个方向**，缺任何一个都只堵一半：
        //
        //   overclaimed   claimed - actual 非空 → FAIL
        //     「我在 files_touched 里写了它，但仓库里它没有改动」。
        //     R18 已经覆盖「路径不存在」；这条覆盖「路径存在但没被改」——两者是不同的洞。
        //     一个实例把某个**一直存在、从未被碰过**的文件写进 files_touched，
        //     R18 全绿，而它实际上什么都没改。这就是「凭证存在 ≠ 凭证为真」。
        //
        //   underreported actual - claimed 非空（**过滤后**）→ 源码 FAIL / 非源码 WARN
        //     「仓库里有改动，但没有任何 fix 产物把它列进 files_touched」。
        //     为什么不无条件 FAIL：修复相位的 actual 里必然混着合法噪音——
        //     日志、快照目录、repair-artifacts/、主 Agent 自己写的账本与产物目录。
        //     无条件升 FAIL 会让每个回合都红，然后被一条 WARN 关掉（R10 的教训：
        //     「降级路径本身就是一条明面上的后门」——但反过来，把降级全删掉同样会
        //     让人把整道闸门关掉）。所以判据是「过滤之后还剩不剩源码」：
        //     源码被改却没登记，正是 under-reporting 的典型形态，那一档必须 FAIL。
        //
        // ── 过滤规则（必须先排除再判断）──
        // 排除项不是「我觉得不重要」，每一条都对应修复相位里真实存在的合法产物：
        //   · state.report.dir_path 指向的目录 —— 本轮产物目录，里面全是 .md
        //   · state.legacy_artifacts 里列的文件 —— 已声明为历史证据
        //   · repair-artifacts / experiments / docs / .work / target / build ——
        //     产物、实验记录、构建输出；target/ 与 build/ 还会被构建清理，
        //     把它们算成「改了没登记」等于让每个跑过构建的回合都红
        //   · .md .log .json .yml .yaml .txt .xml .properties —— 非源码扩展名
        // 先排除、再判断：剩下的才叫「应该被 files_touched 覆盖的东西」。
        //
        // ── 降级纪律 ──
        //   target_repo 缺失        → 跳过，WARN「未做双向对账」
        //                             （check-state 报 target_repo_required，
        //                               §3.7.5 也报账本问题，这里不重复开火）
        //   git status 执行失败     → WARN，不 FAIL（不是 git 仓库 = 环境问题）
        //   没有任何 fix 产物       → 跳过（没有 claimed 集合可比，比较无意义）
        //
        // ── 性能 ──
        // git status 是**一次**调用，不是逐份产物调用。整个相位只付一次进程启动。
        if (state.phase === 'wave4' || state.phase === 'wave5') {
          const warnings2 = warnings;   // 同一个 stderr 汇总块，便于阅读

          // 3.7.6.1 收集 claimed：所有 fix 信封里的 payload.files_touched[].path 并集。
          //
          // 信封可能有两种形态（check-payload 里写过）：
          //   单发现  payload.files_touched
          //   多发现  payload.dispositions[].files_touched
          // 两种都要收，否则「换个写法」就能让一个实例的改动不进 claimed 集合——
          // 而 claimed 集合为空时本段直接跳过，等于整道闸门失效。
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

          // 只读「本段待检产物」里真的有信封且 role=fix 的（legacy 豁免的没有信封，
          // 读了也只会得到一堆解析失败的噪音）。
          const claimedRaw = [];
          let fixEnvelopeCount = 0;
          for (const name of files) {
            if (legacySet.has(name)) continue;
            let text;
            try { text = readFileSync(join(inferred.dir, name), 'utf8'); } catch { continue; }
            for (const b of text.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
              let env;
              try { env = JSON.parse(b[1]); } catch { continue; }
              if (env?.role !== 'fix') continue;
              fixEnvelopeCount++;
              claimedRaw.push(...collectFilesTouched(env.payload));
            }
          }

          if (fixEnvelopeCount === 0 || claimedRaw.length === 0) {
            // 没有 fix 产物 = 没有 claimed 集合。此时「双向对账」只剩一个方向，
            // 而 under-reported 的判据（actual - claimed）会把仓库里的**全部**改动
            // 报成未登记——那是误伤，不是信号。所以跳过判据。
            //
            // 但**不能静默跳过**。R19 自证时实测到这条残余口子：
            // 一份 disposition=WONT_FIX、files_touched:[] 的产物 → claimed 为空 →
            // 仓库里一个真实源码改动零告警地溜过去，stderr 一片安静。
            // 「检查没跑」与「检查通过」在日志上必须可区分（R13 §7.2 的教训）。
            //
            // 不能升 FAIL：WONT_FIX 轮次里 files_touched 为空是**合法**的
            // （不修的发现不改文件，要求它列改动文件是错的）。所以这里只 WARN。
            //
            // 注意这条与「没有产物」的判据（3.7.2 的 files.length === 0）不同：
            // 产物可能有，只是它们不是 fix 角色，或它们的 files_touched 全是空数组。
            warnings2.push(
              `WARN · 未做双向对账（files_touched ↔ git status）：`
              + `${fixEnvelopeCount === 0
                ? '产物目录里没有 role="fix" 的信封'
                : `有 ${fixEnvelopeCount} 份 fix 产物，但它们的 payload.files_touched 全是空的`
                  + `（例如 disposition=WONT_FIX / DEFERRED）`}，`
              + `claimed 集合为空，无从比对。\n`
              + `这意味着「仓库里有没有源码被改却没登记」这一项**本回合没有答案**——`
              + `不是通过，是没查。若本轮确实有修复（disposition=FIXED），请把它改的源代码`
              + `列进该产物的 payload.files_touched[]，这条对账就会自动生效。`
            );
          } else {
            const rawRepo = state.target_repo;
            const repoMissing = !(typeof rawRepo === 'string' && rawRepo.trim() !== '');
            let repoDir = null;
            let repoUsable = false;
            if (!repoMissing) {
              repoDir = isAbsolute(rawRepo) ? rawRepo : resolve(dirname(resolve(statePath)), rawRepo);
              try { repoUsable = existsSync(repoDir) && statSync(repoDir).isDirectory(); } catch { repoUsable = false; }
            }

            if (repoMissing || !repoUsable) {
              // 重复报错的问题：target_repo 缺失时 §3.7.5 已经 push 了一条完整的
              // FAIL（它比本段更急，因为缺 --repo 会让 check-payload 降级）。
              // 这里只留一条 WARN，写明「对账没做」——「检查没跑」必须与
              // 「检查通过」在日志上可区分。
              warnings2.push(
                `WARN · 未做双向对账（files_touched ↔ git status）：`
                + `${repoMissing
                  ? 'state.json 顶层没有 target_repo'
                  : `target_repo="${rawRepo}"（解析为 ${repoDir}）不是真实存在的目录`}，`
                + `无法执行 git status。\n`
                + `这意味着「files_touched 里声称改过的文件，真的被改了吗」以及`
                + `「仓库里还有没有源码被改却没登记」这两项**本回合没有答案**——`
                + `不是通过，是没查。补上 target_repo 后本段会自动生效。`
              );
            } else {
              // 3.7.6.2 一次 git status 拿 actual
              let porcelain = null;
              let gitErr = null;
              try {
                porcelain = execFileSync('git', ['-C', repoDir, 'status', '--porcelain'], {
                  encoding: 'utf8',
                  stdio: ['ignore', 'pipe', 'pipe'],
                  timeout: 20_000,
                });
              } catch (e) {
                gitErr = e;
              }

              if (porcelain === null) {
                // 环境问题（不是 git 仓库 / 没有 git / 权限）→ WARN，不 FAIL。
                // 「拿不到外部信息」与「账本写错了」的区别见 §3.7 开头那段。
                warnings2.push(
                  `WARN · 未做双向对账（files_touched ↔ git status）：`
                  + `在 ${repoDir} 执行 git status 失败（`
                  + `${String(gitErr?.stderr ?? gitErr?.message ?? '无输出').slice(0, 200)}）。\n`
                  + `最可能是 target_repo 不是 git 仓库。这是环境问题，不阻断闭合——`
                  + `但「文件到底改了没有」这一项本回合没有答案。`
                );
              } else {
                // porcelain 行格式：`XY <path>`，rename 是 `XY <old> -> <new>`。
                // XY 里可能含空格（` M` / `??` / `R `），所以按前两个字符切。
                // 与 verify-postfix-snapshot.mjs 的解析保持一致。
                //
                // 噪音前缀在**展开之前**就要用上。原因不是判据，是性能：
                // 未跟踪目录 `?? node_modules/` / `?? target/` 展开会走十万级文件，
                // 而其中每一个随后都会被过滤掉。先排除再展开，代价从「一次全盘 walk」
                // 降到「一次字符串比较」。
                // 同一份清单也用于 3.7.6.5 的 under-reported 过滤——**两侧必须同一口径**，
                // 否则会出现「因为不看它所以算没登记」这种自相矛盾的判断。
                const NOISE_PREFIXES = [
                  'repair-artifacts/', 'experiments/', 'docs/', '.work/', 'target/', 'build/',
                  // 这两条不参与判据，只为避免展开巨型目录
                  'node_modules/', '.git/',
                ];
                const isNoisePath = (p) => {
                  const lower = p.toLowerCase().replace(/^\.\//, '');
                  return NOISE_PREFIXES.some((pre) => lower === pre.slice(0, -1) || lower.startsWith(pre));
                };

                const rawEntries = [];
                for (const line of porcelain.split('\n')) {
                  if (!line.trim()) continue;
                  const xy = line.slice(0, 2);
                  let rest = line.slice(3).trim();
                  if (rest.includes(' -> ')) rest = rest.split(' -> ').pop().trim();
                  rawEntries.push({ xy, path: rest.replace(/\\/g, '/') });
                }

                // 未跟踪目录（porcelain 里写作 `?? newdir/`）展开成其中的文件。
                // **不能跳过**：跳过等于把「一个新目录里 20 个源文件」算作 0 条，
                // 那正好是 under-reporting 的最短路径（verify-postfix-snapshot
                // 的文件头也记过一次真实的漏补事故）。
                // 唯一的例外是上面那些噪音前缀——它们本来就要在判据里被排掉，
                // 展开它们只会付出代价。
                const WALK_LIMIT = 20000;
                let walked = 0;
                let walkTruncated = false;
                const actualAll = [];
                for (const en of rawEntries) {
                  if (isNoisePath(en.path)) {
                    // 仍然记下目录条目本身（不是文件）：后续若有人声称改了
                    // `repair-artifacts/x.md`，会落进「噪音区不可对账」那一档。
                    continue;
                  }
                  const abs = join(repoDir, en.path.replace(/\/$/, ''));
                  let isDir = false;
                  try { isDir = statSync(abs).isDirectory(); } catch { /* 已删除的文件 */ }
                  if (isDir && en.xy.includes('?')) {
                    const walk = (dir) => {
                      if (walked >= WALK_LIMIT) { walkTruncated = true; return; }
                      let entries;
                      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
                      for (const e of entries) {
                        if (walked >= WALK_LIMIT) { walkTruncated = true; return; }
                        const p = join(dir, e.name);
                        if (e.isDirectory()) walk(p);
                        else {
                          walked++;
                          // 保持与 porcelain 同样的正斜杠、仓库根相对口径
                          const rel = p.slice(repoDir.length).replace(/^[\\/]+/, '').replace(/\\/g, '/');
                          actualAll.push(rel);
                        }
                      }
                    };
                    walk(abs);
                  } else {
                    actualAll.push(en.path.replace(/\/$/, ''));
                  }
                }
                if (walkTruncated) {
                  warnings2.push(
                    `WARN · 未跟踪目录展开触到硬上限 ${WALK_LIMIT} 个文件，双向对账**只覆盖了一部分**：`
                    + `被截断之后没枚举到的文件既不会被算进 git status 的 actual，`
                    + `也不会被判成 under-reported。\n`
                    + `这一档是性能保护（防止未跟踪的 node_modules/ 这类目录把 hook 挂死），`
                    + `不是通过。若被审仓库常有大量未跟踪文件，请先 .gitignore 掉构建产物目录。`
                  );
                }
                const actualSet = new Set(actualAll);

                // 3.7.6.2b 修复基线：把「这一轮改了什么」从「相对 HEAD 的差异」里剥出来
                // （2026-11-16 / R20 新增）
                //
                // R19 §(a) 原文（直接采信）：
                //   **基线问题：`git status` 在修复前就是脏的。**
                //   `git status` 报的是「相对于 HEAD 的差异」，**不是「这一轮改了什么」**。
                //   真实场景里被审仓库常常一开始就是脏的。
                //
                // 后果是**双向都失真**，而且两个方向的失真方向相反：
                //   overclaimed 侧：实例根本没改 src/B.java，但它在修复**之前**就已经是 M
                //     → actual 里有它 → 声称它不算 overclaim → **假阴性**。
                //     这就是 R18 §6 问的「是不是**这一轮**改的」——旧判据没有回答。
                //   underreported 侧：实例改的是 src/A.java，但仓库里另有一堆本轮之前就存在的
                //     改动 → 全部算成 under-reported → **假阳性**，然后这条规则会被当成
                //     噪音关掉（R10 的教训：假阳性是规则被卸载的最短路径）。
                //
                // 最便宜的修法（也是这里实现的）：在 wave4 开始时把 `git status --porcelain`
                // 写进 state.fix_baseline，对账时用「现在的改动 − 基线里的改动」。
                //
                // ── 它是什么、不是什么 ──
                // `fix_baseline` **本身也是自述**：主 Agent 可以写一个假的空基线
                // （dirty_paths: []），让所有改动都算成「本轮改的」。本段不试图验证它的真伪
                // （做不到——没有外部基准能与「修复前那一刻」比对）。
                // 能做的只有留痕：把 captured_at 与 head 一起记下，并在告警与失败信息里显示，
                // 于是一个假基线至少留下「它声称自己在什么时刻、基于什么 HEAD 抓的」这个痕迹。
                // **它是把假阴性/假阳性缩小，不是消除。**
                //
                // ── 降级纪律 ──
                // 缺失 fix_baseline       → 照旧用相对 HEAD 的差异，但**必须** WARN 说明降级。
                //                            理由：不能让所有存量账本一夜不合规；但降级必须可见，
                //                            不能静默（R13 §7.2：「检查没跑」与「检查通过」必须可区分）。
                // 格式非法（不是对象/不是数组）→ 同样降级 + WARN。**不能当成空基线静默吞掉**——
                //                            那比没有基线更糟：主 Agent 以为自己在提供基线，
                //                            而对账实际按相对 HEAD 跑，且毫无提示。
                const SRC_EXT_UP = /\.(java|js|mjs|cjs|ts|tsx|jsx|py|go|rs|kt|kts|c|cc|cpp|h|hpp|cs|rb|php|swift|scala|sh)$/i;

                // 现在的脏路径，两种形态都收：目录条目（`?? newdir/`）与展开后的文件。
                // 少了目录那一形态，「基线里整目录未跟踪、现在整个目录被删掉」会漏判。
                const nowDirtyRaw = new Set();
                for (const en of rawEntries) {
                  nowDirtyRaw.add(en.path);
                  nowDirtyRaw.add(en.path.replace(/\/+$/, ''));
                }

                const blRaw = state.fix_baseline;
                let baselinePaths = null;          // Set<string> | null
                let baselineDegraded = null;       // null | 'missing' | 非法原因字符串
                let baselineIncomplete = null;     // 用了，但 captured_at/head 不全
                let baselineProvenance = '';

                if (blRaw === undefined || blRaw === null) {
                  baselineDegraded = 'missing';
                } else if (typeof blRaw !== 'object' || Array.isArray(blRaw)) {
                  baselineDegraded = `fix_baseline 不是对象（实际是 ${Array.isArray(blRaw) ? '数组' : typeof blRaw}）`;
                } else if (!Array.isArray(blRaw.dirty_paths)) {
                  const actual = blRaw.dirty_paths === undefined ? '缺失' : JSON.stringify(blRaw.dirty_paths);
                  baselineDegraded = `fix_baseline.dirty_paths 不是数组（实际是 ${actual}）`;
                } else {
                  const bad = blRaw.dirty_paths.filter((p) => typeof p !== 'string' || p.trim() === '');
                  if (bad.length > 0) {
                    // 混进非字符串 → 整份基线不可信，降级而不是「尽力而为地过滤掉」。
                    // 过滤掉会得到一个比作者本意更小的基线，而更小的基线 = 更多假阴性。
                    baselineDegraded = `fix_baseline.dirty_paths 里有 ${bad.length} 个非字符串/空条目`;
                  } else {
                    baselinePaths = new Set(
                      blRaw.dirty_paths.map((p) => p.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
                    );
                  }
                }

                if (baselinePaths !== null) {
                  const ca = typeof blRaw.captured_at === 'string' && blRaw.captured_at.trim() !== ''
                    ? blRaw.captured_at.trim() : null;
                  const head = typeof blRaw.head === 'string' && blRaw.head.trim() !== ''
                    ? blRaw.head.trim() : null;
                  if (!ca || !head) {
                    const miss = [!ca && 'captured_at', !head && 'head'].filter(Boolean).join(' / ');
                    baselineIncomplete = miss;
                  }
                  // 溯源串：出现在失败信息里，让「这份基线声称了什么」跟着结论一起留痕。
                  baselineProvenance = `fix_baseline：captured_at=${ca ?? '未记录'}，`
                    + `head=${head ?? '未记录'}，dirty_paths=${baselinePaths.size} 个`;

                  // ── HEAD 漂移：基线记的 HEAD 与现在的 HEAD 不一致（R20 实测发现）──
                  //
                  // 这是 `head` 字段从「纯装饰」变成「有判据价值」的唯一一处。
                  // 为什么会漂：修复实例（或主 Agent）在中途 `git commit` 了。
                  // 后果是**减法会反向出错**：
                  //   基线里 dirty 的文件 → 被 commit 掉 → git status 变干净
                  //   → 它落进 restored，同时从 actual 里消失
                  //   → 产物声称改了它，却因为 actual 里没有 → 被误判成 overclaimed。
                  // 实测复现：基线记 src/A.java 脏，实例改完 A.java 并 commit，hook 报
                  //   restored 1 个 + overclaimed 1 个，两个都是假警报。
                  //
                  // 不能因此关掉判据（commit 修复也是合法做法），也不能假装没发生：
                  // 只能是 WARN，并把「HEAD 变了」这件事实说清楚——它是上面所有结论的
                  // 口径前提，读者必须知道。
                  if (head) {
                    let nowHead = null;
                    try {
                      nowHead = execFileSync('git', ['-C', repoDir, 'rev-parse', 'HEAD'], {
                        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
                      }).trim();
                    } catch { nowHead = null; }
                    if (nowHead && nowHead !== head) {
                      warnings2.push(
                        `WARN · 修复基线与现在的 HEAD 不一致：基线记的是 ${head.slice(0, 12)}，`
                        + `现在是 ${nowHead.slice(0, 12)}。\n`
                        + `这说明在抓基线之后、本段运行之前，仓库发生过一次 commit（或 reset）。`
                        + `后果：基线里脏、后来被 commit 掉的文件，在现在的 \`git status\` 里是干净的，`
                        + `于是它们既会被算成「被还原」，又会在产物声称改了它们时被误判成 overclaimed。`
                        + `**本段给出的一切结论都建立在这个已经不确定的差值上。**\n`
                        + `补法：若 commit 是本轮修复的一部分（合法做法），请重抓基线——`
                        + `在 commit 之后、下一批修复实例派发之前再跑一次 \`git status --porcelain\` `
                        + `并更新 fix_baseline（captured_at 与 head 一起更新）。\n`
                        + `溯源（${baselineProvenance}）。`
                      );
                    }
                  }

                  // 基线里的目录条目（`repair-artifacts/`）要按前缀覆盖其下所有文件，
                  // 否则「修复前就存在的未跟踪目录」里的每个文件都会被算成本轮新增。
                  const baselineDirs = [...baselinePaths].filter((p) => p.endsWith('/'));
                  const isBaselineDirty = (p) => {
                    if (baselinePaths.has(p)) return true;
                    return baselineDirs.some((d) => p.startsWith(d));
                  };

                  // 「这一轮新增的脏」= 现在的脏 − 基线里的脏。
                  // 注意：**只做减法，不做噪音过滤**。过滤是给 under-reporting 用的
                  // （「剩下的是应该被覆盖的东西」），overclaim 必须用未过滤集合，
                  // 3.7.6.4 那段解释过原因。
                  for (const p of [...actualSet]) {
                    if (isBaselineDirty(p)) actualSet.delete(p);
                  }

                  // 反方向也要覆盖：基线里脏、现在干净了（被还原 / stash / checkout）。
                  // 它**不是违规**——rollback_command 干的就是这件事，合法的还原是修复流程的一部分。
                  // 但「修复前脏、现在不脏」也可能是一次误操作的唯一痕迹
                  //（experiments/CHECKOUT-INCIDENT.md 记过一次真的把本轮改动 checkout 掉的事故）。
                  // 所以只 WARN，不 FAIL；且只在本段**真的在跑对账**时提示。
                  //
                  // 判「现在干净了」不能只看精确匹配：基线记的是文件，而现在 git status
                  // 可能只给出它的祖先未跟踪目录（`?? src/new/`）。所以任一祖先目录仍然脏
                  // 都算「它还脏」，否则会造成一批假 restored。
                  const stillDirty = (p) => {
                    if (nowDirtyRaw.has(p)) return true;
                    const parts = p.split('/');
                    for (let i = 1; i < parts.length; i++) {
                      if (nowDirtyRaw.has(parts.slice(0, i).join('/') + '/')) return true;
                    }
                    return false;
                  };
                  const restoredAll = [...baselinePaths]
                    .filter((p) => !stillDirty(p))
                    .map((p) => p.replace(/\/+$/, ''))
                    .filter((p) => p !== '');
                  const restoredSrc = restoredAll.filter((p) => SRC_EXT_UP.test(p)).sort();
                  if (restoredSrc.length > 0) {
                    warnings2.push(
                      `WARN · 这些文件在修复前是脏的，现在变干净了（${restoredSrc.length} 个）：\n`
                      + restoredSrc.slice(0, 12).map((p) => `  - ${p}`).join('\n')
                      + (restoredSrc.length > 12 ? `\n  … 另有 ${restoredSrc.length - 12} 个` : '')
                      + `\n\n可能是被还原了（rollback），也可能是 stash / checkout —— 请确认这不是误操作。`
                      + `\n这不是违规：rollback_command 本来就是干这个的，所以只告警、不阻断。`
                      + `但它也可能是「本轮改动被误 checkout 掉」的唯一痕迹`
                      + `（experiments/CHECKOUT-INCIDENT.md 记录过一次真实事故）。\n`
                      + `溯源（${baselineProvenance}）。`
                    );
                  }
                }

                // 降级必须可见：无基线 / 基线非法都 WARN，并且点明两个方向的失真方向。
                if (baselineDegraded !== null) {
                  warnings2.push(
                    `WARN · 双向对账**降级**：${baselineDegraded === 'missing'
                      ? '账本里没有修复基线 fix_baseline'
                      : `修复基线 fix_baseline 格式非法——${baselineDegraded}`}，`
                    + `本次按「相对 HEAD 的差异」（裸 \`git status\`）对账。\n`
                    + `为什么这是个问题：\`git status\` 报的是**相对于 HEAD 的差异**，`
                    + `**不是「这一轮改了什么」**。被审仓库在修复前常常一开始就是脏的，于是两个方向都失真：\n`
                    + `  · overclaimed 一侧（假阴性）：文件在修复前就已是 M，实例本轮根本没碰它，`
                    + `却因为它在 actual 里而不算 overclaim。\n`
                    + `  · underreported 一侧（假阳性）：仓库里本轮之前就存在的改动全被算成「改了没登记」，`
                    + `然后这条规则会被当成噪音关掉。\n`
                    + `补法：主 Agent 在进入 wave4 **之前**（派发第一个修复实例之前）执行一次 `
                    + `\`git status --porcelain\`，把路径写进 state.fix_baseline.dirty_paths，`
                    + `并把时刻与 HEAD 一并记进 captured_at / head（见 artifacts/run-state.md 第 2.7 节）。\n`
                    + `注意：fix_baseline 是把假阴性/假阳性**缩小**，不是消除——它本身也是自述。`
                  );
                } else if (baselineIncomplete !== null) {
                  warnings2.push(
                    `WARN · fix_baseline 缺少 ${baselineIncomplete}：基线可用，`
                    + `但「它声称自己在什么时刻、基于什么 HEAD 抓的」这一项没有记录，`
                    + `事后无法核对这份基线是不是修复前那一刻抓的。\n`
                    + `fix_baseline 本身是自述，本段无法验证它的真伪；能做的只是让假基线留下痕迹。`
                    + `请在下一次进入 wave4 前把 captured_at 与 head 一并写入。`
                  );
                }

                // 3.7.6.3 归一化 claimed 到「仓库根相对的 posix 路径」
                //
                // 信封里的写法至少有三种：`src/main/java/X.java`（仓库相对，最常见）、
                // `.\src\X.java`（Windows 手写）、`D:/repo/src/X.java`（绝对路径）。
                // 不归一化会让同一个文件在两边看起来不同，产生**假 overclaim**——
                // 而假 FAIL 会让人把整段关掉，比漏报更糟。
                const repoNorm = repoDir.replace(/\\/g, '/').replace(/\/+$/, '');
                const claimed = new Set();
                const unnormalizable = [];
                for (const p of claimedRaw) {
                  const n = p.replace(/\\/g, '/');
                  if (/^[A-Za-z]:\//.test(n) || n.startsWith('/')) {
                    const absNorm = n.replace(/\/+$/, '');
                    if (absNorm.toLowerCase().startsWith(repoNorm.toLowerCase() + '/')) {
                      claimed.add(absNorm.slice(repoNorm.length + 1));
                    } else {
                      // 绝对路径且不在被审仓库里：无法与这个仓库的 git status 对账。
                      // 不判 overclaim（那是误伤），但要说出来。
                      unnormalizable.push(p);
                    }
                  } else {
                    claimed.add(n.replace(/^\.\//, '').replace(/\/+$/, ''));
                  }
                }
                if (unnormalizable.length > 0) {
                  warnings2.push(
                    `WARN · files_touched 里有 ${unnormalizable.length} 个绝对路径不在被审仓库 `
                    + `${repoDir} 内，无法与 git status 对账：`
                    + `${unnormalizable.slice(0, 5).join('、')}`
                    + `${unnormalizable.length > 5 ? ' …' : ''}。\n`
                    + `这些条目既不算 overclaim 也不算已登记——它们在本次对账之外。`
                  );
                }

                // 3.7.6.4 overclaimed：声称了但 git status 里没有
                //
                // 这里用**未过滤**的 actual：过滤是给 under-reporting 用的
                //（「剩下的是应该被覆盖的东西」）。若 overclaim 也用过滤后的集合，
                // 那么「声称改了 docs/x.md 而且确实改了」会被误报——
                // 它明明改了，只是被我们的噪音过滤器排掉了。
                const overclaimed = [...claimed].filter((p) => !actualSet.has(p)).sort();
                if (overclaimed.length > 0) {
                  problems.push(
                    `这些路径在 files_touched 里，但 \`git status\` 显示仓库里它们没有改动`
                    + `（${overclaimed.length} 个，被审仓库 ${repoDir}）：\n`
                    + overclaimed.slice(0, 12).map((p) => `  - ${p}`).join('\n')
                    + (overclaimed.length > 12 ? `\n  … 另有 ${overclaimed.length - 12} 个` : '')
                    + `\n\n判据口径：${baselinePaths !== null
                      ? `**本轮改动 = 现在的 \`git status\` − 修复基线**（${baselineProvenance}）`
                      : `**相对 HEAD 的差异**（本回合没有可用的 fix_baseline，已降级——见上方 WARN）`}。`
                    + `\n\n规则：files_touched_overclaimed。`
                    + `R18 的 files_touched_not_found 只回答「这些文件存在吗」；`
                    + `**存在不等于被改过**（R18 §6 原文：path existence does not mean `
                    + `the file was changed by this instance）。一个实例把一直存在、`
                    + `从未被碰过的文件写进 files_touched，R18 全绿，而它什么都没改。`
                    + (baselinePaths !== null
                      ? `\nR20 补充：有基线之后，这一条还覆盖了「文件在修复**之前**就脏、`
                        + `本轮根本没碰」——旧判据（相对 HEAD）会把那种情况当成「改过」，是假阴性。`
                      : '')
                    + `\n补法：要么真的去改（然后重跑），要么从 files_touched 里删掉这些条目。`
                    + `不要用「它在仓库里存在」当改动凭证——凭证是改动本身。`
                  );
                }

                // 3.7.6.5 underreported：改了但没声称（过滤后判断）
                //
                // 排除顺序按「最便宜且最确定」排：前缀 → 产物目录 → legacy → 扩展名。
                // NOISE_PREFIXES 在 3.7.6.2 已定义，这里**复用同一份**：
                // 展开阶段与判据阶段口径不一致会让「没展开」被读成「没改动」，
                // 那是自相矛盾的判断。
                const dirRel = inferred.dir.replace(/\\/g, '/').replace(/\/+$/, '');
                const dirRelInRepo = dirRel.toLowerCase().startsWith(repoNorm.toLowerCase() + '/')
                  ? dirRel.slice(repoNorm.length + 1)
                  : null;
                // 与 verify-postfix-snapshot.mjs 同一个 SRC_EXT（R15 同款）。
                // 用扩展名白名单而不是路径黑名单：黑名单要求枚举所有产物目录名，
                // 必然漏；白名单漏一个的代价是「那个语言没被保护」，
                // 而不是「整道门失效」。
                // R20：定义已提到 3.7.6.2b（restored 判据要先用到它），这里只做别名，
                // 避免两处正则各自演化。
                const SRC_EXT = SRC_EXT_UP;
                const NON_SRC_EXT = /\.(md|log|json|yml|yaml|txt|xml|properties)$/i;
                const legacyNames = new Set(legacy);

                const isNoise = (p) => {
                  if (isNoisePath(p)) return true;
                  const lower = p.toLowerCase();
                  if (dirRelInRepo && (lower === dirRelInRepo.toLowerCase()
                    || lower.startsWith(dirRelInRepo.toLowerCase() + '/'))) return true;
                  // legacy_artifacts 通常只写文件名（basename），按 basename 比
                  const base = p.split('/').pop();
                  if (legacyNames.has(base)) return true;
                  if (NON_SRC_EXT.test(p)) return true;
                  return false;
                };

                const unclaimed = [...actualSet].filter((p) => !claimed.has(p));
                const unclaimedNoisy = unclaimed.filter(isNoise);
                const unclaimedMaterial = unclaimed.filter((p) => !isNoise(p)).sort();
                const unclaimedSrc = unclaimedMaterial.filter((p) => SRC_EXT.test(p));

                if (unclaimed.length > 0) {
                  const listOf = (arr, n = 10) => arr.slice(0, n).join('、')
                    + (arr.length > n ? ` … 另有 ${arr.length - n} 个` : '');
                  if (unclaimedSrc.length > 0) {
                    // 源码被改却没登记 → FAIL。这是 under-reporting 的典型形态：
                    // 「改了 10 个只列 1 个」里剩下的 9 个通常就是源码。
                    problems.push(
                      `仓库里有 ${unclaimed.length} 个文件被改动，其中 ${unclaimedSrc.length} 个是**源码文件**`
                      + `，但没有任何 fix 产物把它们列进 files_touched（被审仓库 ${repoDir}）：\n`
                      + unclaimedSrc.slice(0, 12).map((p) => `  - ${p}`).join('\n')
                      + (unclaimedSrc.length > 12 ? `\n  … 另有 ${unclaimedSrc.length - 12} 个` : '')
                      + `\n\n规则：files_touched_underreported。`
                      + `判据口径：${baselinePaths !== null
                        ? `**本轮改动 = 现在的 \`git status\` − 修复基线**（${baselineProvenance}）`
                        : `**相对 HEAD 的差异**（本回合没有可用的 fix_baseline，已降级——见上方 WARN）`}。`
                      + `\n这就是 R18 §6 点名的 under-reporting：一个实例改了 10 个文件，`
                      + `只列 1 个存在的，R18 的存在性检查完全绿。`
                      + `存在性只证明「凭证不是假的」，不证明「凭证是完整的」。\n`
                      + `已排除的合法噪音（${unclaimedNoisy.length} 个）：产物目录、legacy_artifacts、`
                      + `repair-artifacts/ 等前缀、以及 .md/.log/.json 这类非源码扩展名——`
                      + `排除之后**剩下的**才叫「应该被 files_touched 覆盖的东西」。\n`
                      + `补法：把这些源码改动登记进对应 fix 产物的 payload.files_touched`
                      + `（或确认它们不属于本次修复，然后回滚 / 说明来源）。`
                    );
                  } else {
                    warnings2.push(
                      `WARN · 仓库里有 ${unclaimed.length} 个文件被改动，但没有任何 fix 产物`
                      + `把它们列进 files_touched（${listOf([...unclaimedNoisy, ...unclaimedMaterial])}）。\n`
                      + `规则：files_touched_underreported。**本回合不阻断**——`
                      + `被改动但未登记的文件里没有源码（按 SRC_EXT 判），`
                      + `多半是日志 / 快照 / 产物目录 / 构建输出这类合法噪音。\n`
                      + `之所以只 WARN：把这些无条件升 FAIL 会让每一个跑过构建、写过日志的回合都红，`
                      + `然后这条规则会被整体关掉——那比漏报更糟。`
                      + `但若这些文件其实应该登记，请补进 files_touched；`
                      + `否则可以忽略（它已经留痕，可审计）。`
                    );
                  }
                }
              }
            }
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
