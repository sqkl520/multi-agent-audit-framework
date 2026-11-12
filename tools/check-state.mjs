#!/usr/bin/env node
/**
 * check-state.mjs — state.json 的 schema 与语义校验（L2 契约层第 1 项）
 *
 * 为什么需要它（2026-11-09 对比 dsh-superagent 后确定）：
 *
 *   参考项目用 `z.object().strict().refine()` 让「字段缺失」变成**编译期/调用期错误**；
 *   我们的 state.json 是全框架的状态源，却**从来没有被校验过**——
 *   写错了只有等下游某个工具行为异常时才发现。
 *
 *   实测已经出过的事故：
 *     - `attempt` 字段在 rounds 里存在但语义不一致（有的算重试、有的算尝试）
 *     - `failure.error_type` 的枚举里还有已废弃的 `SCRIPT_TIMEOUT`
 *       （2026-11-09 已改名为 SKELETON_ONLY，但 schema 没同步）
 *     - `slices[].state == FAILED` 但 `failure` 为空，无法诊断
 *
 * 用法：node check-state.mjs <state.json> [--json]
 * 退出码：0 合规 / 1 不合规 / 2 用法错误
 */

import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const file = args.find((a) => !a.startsWith('--'));

if (!file) {
  console.error('用法: node check-state.mjs <state.json> [--json]');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`文件不存在: ${file}`);
  process.exit(2);
}

let state;
try {
  state = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  console.error(`JSON 解析失败: ${e.message}`);
  process.exit(1);
}

const errors = [];
const warnings = [];
const err = (field, rule, msg) => errors.push({ field, rule, msg });
const warn = (field, rule, msg) => warnings.push({ field, rule, msg });

// ────────────────────────────────────────────────────────────────────
// 枚举（与 run-state.md 及各处规则保持同步）
// ────────────────────────────────────────────────────────────────────
const ENUM = {
  schema_version: ['run-state-v1'],
  path_mode: ['AUDIT_ONLY', 'FIX'],
  phase: ['init', 'wave1', 'wave2a', 'wave2b', 'wave3', 'report', 'closed'],
  status: ['RUNNING', 'PARTIALLY_CLOSED', 'CLOSED', 'BLOCKED'],
  slice_state: ['DONE', 'RUNNING', 'PENDING', 'FAILED', 'DEFERRED'],
  // 2026-11-10（蓝队 A2/A3）：补 ENTRY 与 GENERATED。
  // wave2a-sweep.md §5 定义了这两个值，但账本枚举里没有——
  // 主 Agent 拿到 sweep 的结论后无法如实记账（要么丢信息，要么写非法值）。
  reachability: ['PROD', 'ENTRY', 'TEST_ONLY', 'UNREACHABLE', 'GENERATED', null],
  error_type: ['NO_OUTPUT', 'SKELETON_ONLY', 'TOOL_REJECTED', 'EMPTY_RESULT',
               'CONTRACT_VIOLATION', 'HARNESS_REPORTED_TIMEOUT', null],
  // 已废弃的枚举值：出现即为需要迁移
  deprecated_error_type: ['SCRIPT_TIMEOUT'],
  task: ['sweep', 'deep_dive'],
};

// ────────────────────────────────────────────────────────────────────
// 1 · 顶层必填与枚举
// ────────────────────────────────────────────────────────────────────
const TOP_REQUIRED = ['schema_version', 'trace_id', 'round_id', 'path_mode', 'phase', 'status', 'slices'];
for (const k of TOP_REQUIRED) {
  if (!(k in state)) err(k, 'missing_top_field', `缺顶层字段: ${k}`);
}

for (const [k, allowed] of [['schema_version', ENUM.schema_version], ['path_mode', ENUM.path_mode],
                             ['phase', ENUM.phase], ['status', ENUM.status]]) {
  if (k in state && !allowed.includes(state[k])) {
    err(k, 'invalid_enum', `必须是 ${allowed.join(' | ')} 之一，实际是 "${state[k]}"`);
  }
}

// IN_PROGRESS 已从状态枚举移除（round31 停在它上面的教训）
if (state.status === 'IN_PROGRESS') {
  err('status', 'deprecated_status',
    'IN_PROGRESS 已移除。用 RUNNING（还在跑）或 PARTIALLY_CLOSED（已收口）');
}

// ────────────────────────────────────────────────────────────────────
// 2 · slices 的结构与语义
// ────────────────────────────────────────────────────────────────────
if (state.slices && typeof state.slices === 'object') {
  const entries = Object.entries(state.slices);
  if (entries.length === 0) {
    warn('slices', 'empty_slices', 'slices 为空。若这是 init 阶段可忽略，否则应有切片');
  }

  for (const [id, s] of entries) {
    if (!s || typeof s !== 'object') {
      err(`slices.${id}`, 'not_object', '切片必须是对象');
      continue;
    }
    if (!('state' in s)) {
      err(`slices.${id}.state`, 'missing_field', '切片缺 state');
    } else if (!ENUM.slice_state.includes(s.state)) {
      err(`slices.${id}.state`, 'invalid_enum',
        `必须是 ${ENUM.slice_state.join(' | ')} 之一，实际是 "${s.state}"`);
    }

    if ('reachability' in s && !ENUM.reachability.includes(s.reachability)) {
      err(`slices.${id}.reachability`, 'invalid_enum',
        `必须是 ${ENUM.reachability.filter(Boolean).join(' | ')} | null，实际是 "${s.reachability}"`);
    }

    // FAILED 必须带 failure 诊断（2026-11-05 的教训：只有裸 FAILED 无法判断该不该重试）
    if (s.state === 'FAILED' && !s.failure) {
      err(`slices.${id}.failure`, 'missing_failure_diagnosis',
        'state=FAILED 但缺少 failure 字段。没有 error_type 就无法决定重派策略');
    }
    if (s.failure) {
      const et = s.failure.error_type;
      if (ENUM.deprecated_error_type.includes(et)) {
        err(`slices.${id}.failure.error_type`, 'deprecated_enum',
          `"${et}" 已改名为 SKELETON_ONLY（它只描述产物形态，不推断超时原因）`);
      } else if ('error_type' in s.failure && !ENUM.error_type.includes(et)) {
        err(`slices.${id}.failure.error_type`, 'invalid_enum',
          `必须是 ${ENUM.error_type.filter(Boolean).join(' | ')} | null，实际是 "${et}"`);
      }
      if (typeof s.failure.artifact_bytes !== 'number') {
        warn(`slices.${id}.failure.artifact_bytes`, 'missing_field',
          '缺 artifact_bytes —— 它是区分「从未写过」与「写了就停」的关键字段');
      }
    }

    // attempt 语义：至少 1（第一次尝试），不能是 0 或负数
    if ('attempt' in s) {
      if (typeof s.attempt !== 'number' || s.attempt < 1) {
        err(`slices.${id}.attempt`, 'invalid_attempt',
          `attempt 必须 ≥1（第一次尝试就是 1），实际是 ${s.attempt}`);
      }
    }

    // DONE 必须有产物路径
    if (s.state === 'DONE') {
      const hasArtifact =
        (Array.isArray(s.artifact_paths) && s.artifact_paths.length > 0) || Boolean(s.sweep_artifact);
      if (!hasArtifact) {
        err(`slices.${id}.artifact_paths`, 'done_without_artifact',
          'state=DONE 但没有任何产物路径。DONE 必须有东西可追溯');
      }
    }

    // lead_count 与数组的一致性（若有）
    if (typeof s.lead_count === 'number' && Array.isArray(s.deep_dive_done)) {
      // 只是提示级：lead_count 是宽扫产出，deep_dive_done 是深挖进度，本就不等
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 3 · budget 自洽
// ────────────────────────────────────────────────────────────────────
if (state.budget && typeof state.budget === 'object') {
  const b = state.budget;
  if (typeof b.spent === 'number' && typeof b.total_cap === 'number') {
    if (b.spent > b.total_cap) {
      err('budget.spent', 'over_budget',
        `spent=${b.spent} 超过 total_cap=${b.total_cap}。若确实超了，说明护栏没生效`);
    }
  }
  const failSum = (b.failed_sweep ?? 0) + (b.failed_deep_dive ?? 0);
  if (state.failure_stats && typeof state.failure_stats === 'object') {
    const statSum = Object.values(state.failure_stats).reduce((a, x) => a + (Number(x) || 0), 0);
    if (failSum !== statSum && statSum > 0) {
      warn('failure_stats', 'mismatch',
        `budget 的失败数(${failSum}) 与 failure_stats 之和(${statSum}) 不一致`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 4 · status 与 report 的联动（CLOSED 必须有报告）
// ────────────────────────────────────────────────────────────────────
if (state.status === 'CLOSED') {
  if (!state.report?.final_report_path) {
    err('report.final_report_path', 'closed_without_report',
      'status=CLOSED 但没有 final_report_path。CLOSED 的前置条件是报告已落盘');
  }
  if (state.report?.is_complete === false) {
    err('report.is_complete', 'closed_but_incomplete',
      'status=CLOSED 但 is_complete=false，自相矛盾');
  }
}
if (state.status === 'RUNNING' && state.report?.is_complete === true) {
  warn('report.is_complete', 'running_but_complete',
    'status=RUNNING 但 is_complete=true。可能状态没同步');
}

// ────────────────────────────────────────────────────────────────────
// 4.5 · fix_contracts：修复前置登记必须完整（2026-11-09 新增）
// ────────────────────────────────────────────────────────────────────
if (Array.isArray(state.fix_contracts)) {
  const required = ['finding_id', 'fix_agent_id', 'registered_at',
    'defect_statement', 'disproof_condition', 'rollback_command', 'test_path'];
  state.fix_contracts.forEach((fc, i) => {
    for (const k of required) {
      if (fc?.[k] === undefined || fc?.[k] === null || fc?.[k] === '') {
        err(`fix_contracts[${i}].${k}`, 'fix_contract_incomplete',
          `修复前置字段 ${k} 缺失（wave4-fix.md §2 要求编辑前登记五个字段，缺任一不得进入编辑）`);
      }
    }
    // baseline_result 与 baseline_unverified 二选一必须给出
    const hasBaseline = fc?.baseline_result !== undefined && fc?.baseline_result !== null && fc?.baseline_result !== '';
    const declaredUnverified = fc?.baseline_unverified === true;
    if (!hasBaseline && !declaredUnverified) {
      err(`fix_contracts[${i}].baseline_result`, 'baseline_not_recorded',
        '既没有 baseline_result，也没有标 baseline_unverified=true。没做也没声明 = CONTRACT_VIOLATION');
    }
    if (hasBaseline && declaredUnverified) {
      warn(`fix_contracts[${i}].baseline_unverified`, 'baseline_conflicting',
        '同时给了 baseline_result 又标了 baseline_unverified=true，语义冲突');
    }
  });
}

// ────────────────────────────────────────────────────────────────────
// 4.6 · current_plan：相位内必须先写计划再执行（2026-11-10 新增）
// ────────────────────────────────────────────────────────────────────
// 实测问题：主 Agent 每做完一小步就停下来交付、问「要不要继续」，
// 而所有静态检查都判合规——因为框架从未定义「一次交付」的粒度。
// protocol.md §0.8 现在要求：进入执行相位前必须把计划写进 state.json。
if (['wave2a', 'wave2b', 'wave3'].includes(state.phase)) {
  const plan = state.current_plan;
  if (!plan || typeof plan !== 'object') {
    err('current_plan', 'missing_plan_in_execution_phase',
      `phase=${state.phase} 是执行相位，但没有 current_plan。` +
      `protocol.md §0.8.4 要求：进入相位前先写计划（steps + exit_condition），否则就是「边走边看」，` +
      `而这种执行方式必然会演变成「做完一小步就停下来问」`);
  } else {
    if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
      err('current_plan.steps', 'plan_without_steps',
        'current_plan 没有 steps——那不是计划，是一句意图');
    } else if (plan.steps.length > 12) {
      // 2026-11-10（R1 研究发现）：计划过细会损害执行质量。
      // ADaPT 实测「先出完整详细计划再照做」在 ALFWorld 上比不做计划还低 12 点；
      // arXiv:2408.02442 测得严格格式约束本身会损害推理（掉分不是解析失败）。
      warn('current_plan.steps', 'plan_too_granular',
        `current_plan 有 ${plan.steps.length} 步，超过 12。` +
        `计划应写可判定的里程碑（3–7 步覆盖整个相位），不是逐步操作指令——` +
        `越细的计划越容易在真实观测到来时失配`);
    } else {
      plan.steps.forEach((s, i) => {
        if (!s?.action) {
          err(`current_plan.steps[${i}].action`, 'plan_step_without_action',
            `第 ${i + 1} 步没有 action`);
        }
        if (!s?.done_when) {
          err(`current_plan.steps[${i}].done_when`, 'plan_step_without_done_when',
            `第 ${i + 1} 步没有 done_when——没有完成判据的步骤会被无限延长或提前宣告完成`);
        }
      });
    }
    if (!plan.exit_condition) {
      err('current_plan.exit_condition', 'plan_without_exit_condition',
        'current_plan 没有 exit_condition——不知道什么算「这个相位做完了」，就不知道该在哪停');
    }
    if (plan.phase && plan.phase !== state.phase) {
      err('current_plan.phase', 'plan_phase_mismatch',
        `current_plan.phase=${plan.phase} 与 state.phase=${state.phase} 不一致（改了相位没改计划？）`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 5 · phase 与 status 的联动
// ────────────────────────────────────────────────────────────────────
if (state.phase === 'closed' && state.status === 'RUNNING') {
  err('phase', 'phase_status_mismatch',
    'phase=closed 但 status=RUNNING。closed 相位应当对应已收口的状态');
}

// ────────────────────────────────────────────────────────────────────
// 6 · in_flight 不得与已终态的切片冲突
// ────────────────────────────────────────────────────────────────────
if (Array.isArray(state.in_flight) && state.slices) {
  for (const f of state.in_flight) {
    const s = state.slices[f.slice_id];
    if (s && (s.state === 'DONE' || s.state === 'DEFERRED')) {
      warn(`in_flight.${f.slice_id}`, 'conflict',
        `in_flight 里有 ${f.slice_id}，但它的 state 已是 ${s.state}`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 输出
// ────────────────────────────────────────────────────────────────────
const result = {
  file,
  ok: errors.length === 0,
  round_id: state.round_id ?? null,
  status: state.status ?? null,
  slice_count: state.slices ? Object.keys(state.slices).length : 0,
  errors,
  warnings,
};

if (jsonOut) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\nstate.json 校验: ${file}\n`);
  console.log(`  round: ${result.round_id}   status: ${result.status}   slices: ${result.slice_count}\n`);

  if (errors.length === 0) {
    console.log('  ✅ schema 合规\n');
  } else {
    console.log(`  ✗ ${errors.length} 项违规:\n`);
    for (const e of errors) {
      console.log(`    [${e.rule}] ${e.field}`);
      console.log(`      ${e.msg}`);
    }
    console.log();
  }
  if (warnings.length) {
    console.log(`  ⚠️  ${warnings.length} 项警告:`);
    for (const w of warnings) console.log(`    [${w.rule}] ${w.field}: ${w.msg}`);
    console.log();
  }
}

process.exit(errors.length > 0 ? 1 : 0);
