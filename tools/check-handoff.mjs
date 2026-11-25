#!/usr/bin/env node
/**
 * check-handoff.mjs — Resume Packet 的机械校验
 *
 * ── 为什么需要它（2026-11-19 补）────────────────────────────────────
 *   `framework/components/handoff-schema.md` 定义了波次之间传递的 Resume Packet：
 *   5 个必填字段、`wave_id` 5 值枚举、`wave_status` 3 值枚举、`open_items.kind` 10 种。
 *   文件里写着「缺失时行为：拒绝整个包」「违反此规则视为 CONTRACT_VIOLATION」。
 *
 *   但 `grep -rln "Resume Packet" tools/*.mjs` 的结果里**没有任何校验器**。
 *   也就是说：这份契约的每一条约束，从写下那天起就没有被执行过。
 *
 *   这不是「引用断了」，是「根本没有检测器」——比规则句出口率 0% 那类更彻底。
 *
 * ── 检查项 ──────────────────────────────────────────────────────────
 *   H1  顶层必填字段缺失（schema_version / round_id / wave_id / wave_status / trace_id）
 *       `generated_at` 与 `packet_digest` 契约明写「允许缺失」，不在 REQUIRED 里。
 *   H2  `schema_version` 不等于 "handoff-schema-v1"
 *   H3  `wave_id` 不在 {wave-1..wave-5}
 *   H4  `wave_status` 不在 {CLOSED, PARTIALLY_CLOSED, FAILED}
 *   H5  `open_items[].kind` 不在 10 种闭集内
 *   H6  **整份包**里出现原始正文（2026-11-25 从「只在 open_items 上扫」扩到全包）
 *   H7  `round_id` 与 `wave_id` 的形态不对（round_id 应形如 round{N}）
 *
 *   2026-11-25 补（H8–H14）：
 *   H8  `conflicts[].resolution` 不在闭集 / parties 缺 artifact_ref /
 *       已裁决（UPHELD|DOWNGRADED|REVOKED）却没有 `arbiter_artifact_ref`（第 4 节 + §9 步骤 5）
 *   H9  `deferred_items[]` 的 kind / reason 越界（第 7 节）
 *   H10 `covered_modules[].audit_verdict` 越界 / 计数不是整数（第 5 节）
 *   H11 `open_items[].blocking` 不是布尔值（第 3 节）
 *   H12 PENDING / ARBITRATING 冲突 + 对应 `open_item.blocking=true` → 不得闭合（第 4 节第一条硬约束）
 *   H13 原始正文检查覆盖整份包（同 H6，见上）
 *   H14 `closed_waves[].gate_result` 越界 / `summary` 超预算（第 2 节）
 *
 *   补这些的原因：`handoff-schema.md` 有 31 条规则、30 条没有机器出口，
 *   而本工具此前只实现了 7 条，且**从没被任何门或工具调用过**（只被自己的自测跑）。
 *   2026-11-25 起它接在 `gate.mjs --gate close --packet` 上。
 *
 * ── 级别 ────────────────────────────────────────────────────────────
 *   ERROR（契约明写「拒绝整个包」/「必填」/「不得」/「闭集」）：
 *     H1–H5、H7、H8（闭集 / party 缺 ref / 已裁决缺 arbiter_ref）、H9（闭集）、
 *     H10（闭集 / 计数类型）、H12、H14
 *   WARN（契约示例里有、但正文没写「必填」——**校验器不比契约严**）：
 *     `missing_blocking` / `missing_conflict_id` / `missing_resolution` /
 *     `conflict_no_parties` / `empty_parties` / `missing_requires_human_intervention` /
 *     `non_boolean_requires_human_intervention` / `conflict_not_linked` /
 *     `human_blocker_present` / `digest_not_sha256_hex`
 *   这条分界是 2026-11-25 两轮锐评 + 验收逼出来的：第一版把「示例里有」当成「必填」，
 *   于是拒绝了契约自己的示例（`SUCCESS + upheld_count:2`）和「缺失也合法」的
 *   `packet_digest`——而那正是 `output-contract/audit.md:180` 记过的形态。
 *
 * ── 它检查什么、不检查什么 ──────────────────────────────────────────
 *   检查：结构、枚举、必填、跨字段一致性（PENDING 冲突 ↔ blocking 项）、
 *   以及「有没有把原始正文塞进来」这一条最关键的约束。
 *   **不检查** `packet_digest` 与内容是否真的对得上——那需要包生成器的确定性序列化约定，
 *   当前没有定义，猜一个算法会让这条检查本身变成假保险。
 *   也不检查 `open_items` 与上一波产物的一致性——那需要读产物，超出本工具范围。
 *   也不检查 `arbiter_artifact_ref` 指向的**文件是否存在**——包可能被搬到别处，
 *   静态校验器检查它会变成假保险。（现状：**没有任何工具**检查它，这是已知缺口。）
 *
 * 用法：
 *   node check-handoff.mjs <packet.json> [--json]
 *   node check-handoff.mjs --dir <目录>        # 校验目录下所有 *.json
 * 退出码：0 = 全部合规／1 = 有违规／2 = 配置错误
 */

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

const ARGS = { target: null, dir: null, json: false };
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a === '--json') ARGS.json = true;
  else if (a === '--dir') ARGS.dir = process.argv[++i] ?? null;
  else if (a === '--help' || a === '-h') {
    console.log('用法: node check-handoff.mjs <packet.json> [--json]');
    console.log('      node check-handoff.mjs --dir <目录> [--json]');
    process.exit(0);
  } else if (!a.startsWith('--')) ARGS.target = a;
  else { console.error(`未知参数: ${a}`); process.exit(2); }
}

// ── 契约里写死的闭集 ──
const SCHEMA_VERSION = 'handoff-schema-v1';
const WAVE_IDS = ['wave-1', 'wave-2', 'wave-3', 'wave-4', 'wave-5'];
const WAVE_STATUS = ['CLOSED', 'PARTIALLY_CLOSED', 'FAILED'];
const OPEN_ITEM_KINDS = [
  'UNRESOLVED_FINDING', 'EVIDENCE_GAP', 'COVERAGE_GAP', 'REGRESSION_SCAN_REQUIRED',
  'AFFECTED_BY_FIX', 'PERMANENT_FAILURE', 'UNVERIFIED_TARGET', 'DEFERRED_SLICE',
  'HUMAN_DECISION_REQUIRED', 'REVOKED',
];
// 顶层必填（`generated_at` 与 `packet_digest` 契约都明写「允许缺失」，故不在此列）
//
// 2026-11-25 锐评实测：`packet_digest` 原先在 REQUIRED 里，而 handoff-schema.md:68
// 的「缺失时行为」写的是**「允许缺失；如果存在但不匹配，拒绝整个包」**——
// 契约允许的包被判 missing_field 拒绝。接线到 close 门之后，那是一条
// 「合法包收不了口」的真实路径。形态存在时仍查它是不是 64 位 hex（WARN）。
const REQUIRED = ['schema_version', 'round_id', 'wave_id', 'wave_status', 'trace_id'];

// 2026-11-25 补：其余闭集。此前只校验了 open_items.kind 一个枚举，
// `conflicts.resolution` / `deferred_items.kind` / `deferred_items.reason` 三处
// 契约里写死的闭集**完全没有校验**——契约说「必须是闭集」，工具不知道闭集是什么。
const RESOLUTIONS = ['PENDING', 'ARBITRATING', 'UPHELD', 'DOWNGRADED', 'REVOKED'];
const RESOLVED = ['UPHELD', 'DOWNGRADED', 'REVOKED'];
const DEFERRED_KINDS = ['SLICE', 'FINDING', 'VERIFICATION'];
const DEFERRED_REASONS = ['ADMISSION_CEILING', 'HARNESS_CAP', 'PERMANENT_FAILURE', 'CONTRACT_VIOLATION_UNRESOLVED'];

function checkPacket(obj, label) {
  const errors = [];
  const warn = [];
  const E = (rule, field, msg) => errors.push({ rule, field, msg });

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    E('not_an_object', '(root)', 'Resume Packet 必须是一个 JSON 对象');
    return { label, errors, warnings: warn };
  }

  // H1 必填
  for (const k of REQUIRED) {
    const v = obj[k];
    if (v === undefined || v === null || v === '') {
      E('missing_field', k, `Resume Packet 必填字段 ${k} 缺失。契约明写「缺失时行为：拒绝整个包」`);
    }
  }

  // H2 schema_version
  if (obj.schema_version !== undefined && obj.schema_version !== SCHEMA_VERSION) {
    E('bad_schema_version', 'schema_version',
      `必须精确等于 "${SCHEMA_VERSION}"，实际是 ${JSON.stringify(obj.schema_version)}。`
      + '契约要求版本不匹配时不得尝试兼容');
  }

  // H3 wave_id
  if (obj.wave_id !== undefined && !WAVE_IDS.includes(obj.wave_id)) {
    E('bad_wave_id', 'wave_id',
      `必须在 ${WAVE_IDS.join(' | ')} 内，实际是 ${JSON.stringify(obj.wave_id)}`);
  }

  // H4 wave_status
  if (obj.wave_status !== undefined && !WAVE_STATUS.includes(obj.wave_status)) {
    E('bad_wave_status', 'wave_status',
      `必须在 ${WAVE_STATUS.join(' | ')} 内，实际是 ${JSON.stringify(obj.wave_status)}`);
  }

  // H7 round_id 形态
  if (typeof obj.round_id === 'string' && !/^round\d+$/.test(obj.round_id)) {
    E('bad_round_id', 'round_id',
      `应形如 "round30"，实际是 ${JSON.stringify(obj.round_id)}`);
  }

  // H5 open_items[].kind
  if (obj.open_items !== undefined) {
    if (!Array.isArray(obj.open_items)) {
      E('open_items_wrong_shape', 'open_items', 'open_items 必须是数组');
    } else {
      obj.open_items.forEach((it, i) => {
        if (!it || typeof it !== 'object') {
          E('open_item_not_object', `open_items[${i}]`, '条目必须是对象');
          return;
        }
        if (!Object.prototype.hasOwnProperty.call(it, 'kind')) {
          E('missing_open_item_kind', `open_items[${i}].kind`, '缺 kind');
        } else if (!OPEN_ITEM_KINDS.includes(it.kind)) {
          E('bad_open_item_kind', `open_items[${i}].kind`,
            `不在 10 种闭集内：${JSON.stringify(it.kind)}`);
        }
        // H6 原始正文
        for (const [k, v] of Object.entries(it)) {
          if (typeof v !== 'string') continue;
          if (v.length > 2000) {
            E('raw_body_in_packet', `open_items[${i}].${k}`,
              `字段长度 ${v.length} 字符，疑似塞入了原始正文。`
              + '契约：Resume Packet 不得包含子 Agent 的原始正文或完整 findings 数组，'
              + '只允许指针（artifact_path）、摘要、裁决、未闭合项的结构化表示');
          }
          if (/(^|\n)\s*"evidence"\s*:\s*\{/.test(v) || /(^|\n)\s*"findings"\s*:\s*\[/.test(v)) {
            E('raw_body_in_packet', `open_items[${i}].${k}`,
              '字段内容里出现了 evidence/findings 的 JSON 片段，疑似把子 Agent 的原始返回塞了进来');
          }
        }
      });
    }
  }

  // packet_digest 形态（只查形态，不查内容——见文件头「不检查什么」）
  if (typeof obj.packet_digest === 'string' && !/^[a-f0-9]{64}$/i.test(obj.packet_digest)) {
    warn.push({
      rule: 'digest_not_sha256_hex', field: 'packet_digest',
      msg: 'packet_digest 看起来不是 SHA256 十六进制串（64 位 hex）。本工具不校验它与内容是否一致',
    });
  }

  checkConflicts(obj, E, warn);
  checkDeferredItems(obj, E, warn);
  checkCoveredModules(obj, E);
  checkBlockingSemantics(obj, E, warn);
  checkPendingConflictsBlockClose(obj, E, warn);
  checkNoRawBodyAnywhere(obj, E);
  checkClosedWaves(obj, E);

  return { label, errors, warnings: warn };
}

// ── 原始正文：整份包，不只是 open_items（H6 的补全）───────────────
//
// 2026-11-25 锐评实测：handoff-schema.md:21-23 的硬规则是**整份 Resume Packet**
// 不得包含子 Agent 的原始正文或完整 findings 数组，而实现只在 open_items 的
// 字符串字段上扫。实测把 5000 字正文塞进 `conflicts[0].resolution_reason`、
// `closed_waves[0].summary`、`deferred_items[0].artifact_ref`，全部 exit 0。
//
// `closed_waves[].summary` 尤其要查：第 2 节对它有一条独立的硬约束
// （2–4 句、约 100 token 预算），越界同样是「包退化成第二份报告」。
function checkNoRawBodyAnywhere(obj, E) {
  const RAW_MAX = 2000;

  // 哪些字段是**明确规定可以是长散文**的，不参与长度判定。
  //
  // 2026-11-25 验收实测：上一版对整份包所有字符串字段一律 >2000 就判 ERROR，
  // 而契约 §4 把 `resolution_reason` 定义为 `string|null`（仲裁理由，本来就可能长），
  // §6 的 `scale_decision` 也没限字段长度。一段 2500 字的合法仲裁理由 →
  // `raw_body_in_packet` → **挂在 close 门上就是「合规包收不了口」**。
  // 这与上一版「SUCCESS + upheld_count>0 拒绝契约示例」是同一条路径。
  //
  // 只对**明确是指针 / 标识 / 摘要**的字段查长度；`resolution_reason` 这类
  // 明说是散文的字段跳过长度检查（仍查 evidence/findings 片段，那是「塞正文」的硬信号）。
  const PROSE_FIELDS = new Set(['resolution_reason', 'summary', 'note', 'reason', 'message']);

  const walk = (node, at, depth, key) => {
    if (depth > 6 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${at}[${i}]`, depth + 1, key));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const pat = `${at}.${k}`;
      if (typeof v === 'string') {
        if (v.length > RAW_MAX && !PROSE_FIELDS.has(k)) {
          E('raw_body_in_packet', pat,
            `字段长度 ${v.length} 字符，疑似塞入了原始正文。`
            + '契约：Resume Packet 不得包含子 Agent 的原始正文或完整 findings 数组，'
            + '只允许指针（artifact_path）、摘要、裁决、未闭合项的结构化表示');
        }
        if (/(^|\n)\s*"evidence"\s*:\s*\{/.test(v) || /(^|\n)\s*"findings"\s*:\s*\[/.test(v)) {
          E('raw_body_in_packet', pat,
            '字段内容里出现了 evidence/findings 的 JSON 片段，疑似把子 Agent 的原始返回塞了进来');
        }
      } else {
        walk(v, pat, depth + 1, k);
      }
    }
  };
  walk(obj, '$', 0, null);
}

// ── closed_waves（第 2 节）─────────────────────────────────────────────
function checkClosedWaves(obj, E) {
  if (obj.closed_waves === undefined) return;
  if (!Array.isArray(obj.closed_waves)) {
    E('closed_waves_wrong_shape', 'closed_waves', 'closed_waves 必须是数组');
    return;
  }
  const GATE_RESULTS = ['PASS', 'PASS_WITH_DEFERRED', 'FAIL'];
  obj.closed_waves.forEach((w, i) => {
    const at = `closed_waves[${i}]`;
    if (!w || typeof w !== 'object' || Array.isArray(w)) {
      E('closed_wave_not_object', at, '条目必须是对象');
      return;
    }
    if (w.wave_id !== undefined && !WAVE_IDS.includes(w.wave_id)) {
      E('bad_closed_wave_id', `${at}.wave_id`,
        `必须在 ${WAVE_IDS.join(' | ')} 内，实际是 ${JSON.stringify(w.wave_id)}`);
    }
    if (w.gate_result !== undefined && !GATE_RESULTS.includes(w.gate_result)) {
      E('bad_gate_result', `${at}.gate_result`,
        `必须是闭集 ${GATE_RESULTS.join(' | ')} 之一，实际是 ${JSON.stringify(w.gate_result)}`);
    }
    if (w.artifact_paths !== undefined && !Array.isArray(w.artifact_paths)) {
      E('bad_artifact_paths', `${at}.artifact_paths`,
        '必须是路径数组（契约：Resume Packet 只带指针，不带内容）');
    }
    // 第 2 节：summary「不超过 2–4 句话，且只允许陈述结构化事实」。
    // 「只允许陈述结构化事实」静态判不了，但长度能判——而长度是这条约束的可执行部分：
    // 一段 5000 字的 summary 一定不是「2–4 句话」。
    if (typeof w.summary === 'string' && w.summary.length > 400) {
      E('summary_over_budget', `${at}.summary`,
        `summary 长 ${w.summary.length} 字符。第 2 节要求 2–4 句、约 100 token——`
        + '越界的 summary 就是「包退化成第二份报告」的起点');
    }
  });
}

// ── PENDING 冲突必须阻止闭合（第 4 节第一条硬约束）────────────────────
//
// 2026-11-25 锐评实测：这是第 4 节的**第一条**硬约束，而上一版完全没实现，
// 同时我还在文档里写了「本节的三条硬约束由 H8 实现」——一句假自述。
//
// 契约原文：「如果存在 resolution 为 PENDING 的冲突，且该冲突对应的
// open_item.blocking = true，则波次不得闭合。」
//
// 两者怎么对应：`conflicts[].finding_ref` ↔ `open_items[].finding_ref`。
//
// 2026-11-25 验收实测：上一版注释写「关联不上时归到一条 WARN」，
// 而**代码里没有那条 WARN**——一条没有 finding_ref 的 PENDING 冲突
// 加上一个 blocking 的 open_item 会 exit 0 且零警告，等于开了一条静默旁路。
// 而且「注释说有、代码里没有」正是本轮要抓的那个形态。
// 现在真的发了那条 WARN（`conflict_not_linked`），旁路在输出里可见。
function checkPendingConflictsBlockClose(obj, E, warn) {
  if (!Array.isArray(obj.conflicts) || !Array.isArray(obj.open_items)) return;
  if (obj.wave_status === 'FAILED') return;   // 失败收尾不受此约束

  const blockingByFinding = new Set();
  for (const it of obj.open_items) {
    if (it && it.blocking === true && typeof it.finding_ref === 'string') {
      blockingByFinding.add(it.finding_ref);
    }
  }
  const blockingCount = obj.open_items.filter((it) => it && it.blocking === true).length;

  obj.conflicts.forEach((c, i) => {
    if (!c || typeof c !== 'object') return;
    if (!['PENDING', 'ARBITRATING'].includes(c.resolution)) return;
    if (typeof c.finding_ref !== 'string') {
      // 未裁决的冲突关联不到任何发现 → 无法判断它是否挡住了闭合。
      // 契约没法机械判，但至少要让人看见有人在裸奔。
      if (blockingCount > 0) {
        warn.push({
          rule: 'conflict_not_linked', field: `conflicts[${i}].finding_ref`,
          msg: `未裁决的冲突 ${c.conflict_id ?? i} 没有 finding_ref，无法与任何 open_item 关联——`
            + `包里还有 ${blockingCount} 条 blocking 项，但它们是不是同一条，机械判不了`,
        });
      }
      return;
    }
    if (!blockingByFinding.has(c.finding_ref)) return;
    E('pending_conflict_blocks_close', `conflicts[${i}].resolution`,
      `冲突 ${c.conflict_id ?? i} 仍是 ${c.resolution}，而它对应的 open_item（finding_ref=${c.finding_ref}）`
      + `标了 blocking=true。第 4 节：这种情况下波次不得闭合（wave_status=${obj.wave_status}）`);
  });
}

// ── conflicts（handoff-schema.md 第 4 节）──────────────────────────────
//
// 三条硬约束，契约原文都在第 4 节：
//   1. `resolution` 必须是闭集
//   2. `parties` 中每一条必须携带 `artifact_ref`
//   3. `resolution` 为 UPHELD / DOWNGRADED / REVOKED 时 `arbiter_artifact_ref` 必填
//   4. PENDING / ARBITRATING + 对应 open_item.blocking=true → 不得闭合
//      （见 checkPendingConflictsBlockClose）
//
// 第 3 条同时对应 §9 校验步骤第 5 条「UPHELD 的条目 arbiter_artifact_ref 存在且可读」。
//
// **只校验必填，不校验文件是否可读**——那是运行时才知道的信息（包可以被搬到别处），
// 静态校验器检查它会变成假保险。
//
// 2026-11-25 锐评实测：上一版这里写的是「文件存在性由 gate 的 close 门在真实路径上
// 另行确认」——**gate 没做这件事**，它只把参数转给本脚本。这和本轮要修的那个
// 不完整的 SKIPPED 理由是同一形态（用一句话把缺口说成已闭环）。已删掉那句。
// 现状：`arbiter_artifact_ref` 的**存在性**没有任何工具检查。这是已知缺口。
function checkConflicts(obj, E, warn) {
  if (obj.conflicts === undefined) return;
  if (!Array.isArray(obj.conflicts)) {
    E('conflicts_wrong_shape', 'conflicts', 'conflicts 必须是数组');
    return;
  }
  obj.conflicts.forEach((c, i) => {
    const at = `conflicts[${i}]`;
    if (!c || typeof c !== 'object' || Array.isArray(c)) {
      E('conflict_not_object', at, '冲突条目必须是对象');
      return;
    }

    // ── 下面三条只判契约**明写**的约束；「示例里有、正文没写必填」的降为 WARN ──
    //
    // 2026-11-25 锐评实测：`resolution` 缺失、`conflict_id` 缺失、`parties: []`
    // 这三处上一版都判 ERROR，但契约 §4 **没有**「缺失时行为」表，也没写它们必填。
    // `parties: []` 尤其明显——契约写的是「`parties` 中每一条必须携带 artifact_ref」，
    // 空数组是空真，没有条目违反它。
    //
    // 这与 `open_items[].blocking` 是同一类，必须用同一套标准：
    // **校验器不得比契约严**（output-contract/audit.md:180）。
    // 要让它们变成 ERROR，先在本文件对应的契约里写出「必填 / 缺失时行为」。
    if (!c.conflict_id) {
      warn.push({
        rule: 'missing_conflict_id', field: `${at}.conflict_id`,
        msg: '缺 conflict_id：下游无法引用这条冲突（契约未列为必填，故只提示）',
      });
    }

    if (c.resolution === undefined) {
      warn.push({
        rule: 'missing_resolution', field: `${at}.resolution`,
        msg: '缺 resolution：无法判断该冲突是否已裁决，下一波不知道该不该开始修复'
          + '（契约未列为必填，故只提示；实践上应显式写 PENDING）',
      });
    } else if (!RESOLUTIONS.includes(c.resolution)) {
      E('bad_resolution', `${at}.resolution`,
        `必须是闭集 ${RESOLUTIONS.join(' | ')} 之一，实际是 ${JSON.stringify(c.resolution)}`);
    }

    if (!Array.isArray(c.parties)) {
      // 2026-11-25 验收实测：上一版对「parties 键缺失」判 ERROR、对 `parties: []` 判 WARN，
      // 而契约写的是「`parties` 中**每一条**必须携带 artifact_ref」——两者都是空真，
      // 没有任何条目违反它。同一份文件两套标准，正是它声称已修掉的那个毛病。
      // 现在两者统一为 WARN。
      warn.push({
        rule: 'conflict_no_parties', field: `${at}.parties`,
        msg: 'parties 缺失或不是数组：契约要求冲突「显式捕获并携带冲突方」，'
          + '没有 parties 的冲突无法追溯到任何证据（契约未把它列为必填，故只提示）',
      });
    } else if (c.parties.length === 0) {
      warn.push({
        rule: 'empty_parties', field: `${at}.parties`,
        msg: 'parties 是空数组：没有条目的数组不违反「每一条必须携带 artifact_ref」，'
          + '但这样的冲突无法追溯到任何证据（契约未禁止空数组，故只提示）',
      });
    } else {
      c.parties.forEach((p, j) => {
        const pat = `${at}.parties[${j}]`;
        if (!p || typeof p !== 'object') {
          E('party_not_object', pat, 'parties 条目必须是对象');
          return;
        }
        if (!p.artifact_ref) {
          E('party_without_artifact_ref', `${pat}.artifact_ref`,
            'parties 中每一条必须携带 artifact_ref，指向该方立场的证据出处（第 4 节硬约束）');
        }
      });
    }

    // 这条是契约明写的「必填」，保持 ERROR
    if (RESOLVED.includes(c.resolution) && !c.arbiter_artifact_ref) {
      E('resolved_without_arbiter_ref', `${at}.arbiter_artifact_ref`,
        `resolution=${c.resolution} 时 **必填** arbiter_artifact_ref（指向仲裁Agent的产出文件）。`
        + '契约第 4 节：主Agent不得自行填写 resolution，它只能由 Arbiter 的返回填充——'
        + '没有裁决记录路径的 UPHELD 就是一个「主Agent自己说了算」的裁决');
    }
  });
}

// ── deferred_items（第 7 节）───────────────────────────────────────────
function checkDeferredItems(obj, E, warn) {
  if (obj.deferred_items === undefined) return;
  if (!Array.isArray(obj.deferred_items)) {
    E('deferred_items_wrong_shape', 'deferred_items', 'deferred_items 必须是数组');
    return;
  }
  obj.deferred_items.forEach((d, i) => {
    const at = `deferred_items[${i}]`;
    if (!d || typeof d !== 'object' || Array.isArray(d)) {
      E('deferred_item_not_object', at, '条目必须是对象');
      return;
    }
    if (d.kind !== undefined && !DEFERRED_KINDS.includes(d.kind)) {
      E('bad_deferred_kind', `${at}.kind`,
        `必须是闭集 ${DEFERRED_KINDS.join(' | ')} 之一，实际是 ${JSON.stringify(d.kind)}`);
    }
    if (d.reason !== undefined && !DEFERRED_REASONS.includes(d.reason)) {
      E('bad_deferred_reason', `${at}.reason`,
        `必须是闭集 ${DEFERRED_REASONS.join(' | ')} 之一，实际是 ${JSON.stringify(d.reason)}`);
    }
    // 契约：「如果 requires_human_intervention 为真，最终报告须单列」——
    // 但正文没写它是必填（与 blocking 同源）。所以只提示，不判错。
    // 2026-11-25 锐评实测点中了这里的**双重标准**：上一版 blocking 判 WARN、
    // 本字段判 ERROR，而两者在契约里的地位完全相同。同一份文件两套标准，
    // 说明判据不是从契约推出来的，而是就手边的松紧定的。
    if (d.requires_human_intervention !== undefined
        && typeof d.requires_human_intervention !== 'boolean') {
      // 与 blocking 同标准：WARN，不判 ERROR。
      warn.push({
        rule: 'non_boolean_requires_human_intervention', field: `${at}.requires_human_intervention`,
        msg: `给了就必须是布尔值，实际是 ${JSON.stringify(d.requires_human_intervention)}`
          + '（契约未把它列为必填，故只提示）',
      });
    } else if (d.requires_human_intervention === undefined) {
      warn.push({
        rule: 'missing_requires_human_intervention', field: `${at}.requires_human_intervention`,
        msg: '缺 requires_human_intervention：第 7 节要求最终报告逐条标注它——'
          + '包这一层缺了，报告无法机械生成（契约未列为必填，故只提示）',
      });
    }
  });
}

// ── covered_modules（第 5 节）──────────────────────────────────────────
function checkCoveredModules(obj, E) {
  if (obj.covered_modules === undefined) return;
  if (!Array.isArray(obj.covered_modules)) {
    E('covered_modules_wrong_shape', 'covered_modules', 'covered_modules 必须是数组');
    return;
  }
  obj.covered_modules.forEach((m, i) => {
    const at = `covered_modules[${i}]`;
    if (!m || typeof m !== 'object' || Array.isArray(m)) {
      E('covered_module_not_object', at, '条目必须是对象');
      return;
    }
    if (m.audit_verdict !== undefined && !['SUCCESS', 'PARTIAL', 'FAILED'].includes(m.audit_verdict)) {
      E('bad_audit_verdict', `${at}.audit_verdict`,
        `必须是 SUCCESS | PARTIAL | FAILED 之一，实际是 ${JSON.stringify(m.audit_verdict)}`);
    }
    // 契约：「如果 upheld_count = 0 且 audit_verdict = SUCCESS，该模块才**有资格**
    // 被标记为 eligible_for_skip」。这是**单向**蕴含——它没说「有 upheld 就不能 SUCCESS」。
    //
    // 2026-11-25 锐评实测：上一版本在这里加了「SUCCESS + upheld_count>0 自相矛盾」，
    // 而 handoff-schema.md:220-231 的示例 JSON 恰好就是 SUCCESS + upheld_count:2
    // （上一轮审出 2 条、修复波修完、该模块当然 SUCCESS）。**校验器拒绝了契约自己的示例。**
    // 这是 output-contract/audit.md:180 记过的形态，而且挂在 close 门上就是
    // 「合规的包拿不到 CLOSED」。
    //
    // 所以这里只判**类型**，不判推断出来的语义。要加那条语义，先改契约正文。
    for (const k of ['finding_count', 'upheld_count']) {
      if (m[k] !== undefined && !Number.isInteger(m[k])) {
        E('non_integer_count', `${at}.${k}`,
          `${k} 必须是整数，实际是 ${JSON.stringify(m[k])}（${typeof m[k]}）。`
          + '字符串 "2" 或 null 会让折减判断失效且悄无声息');
      }
    }
  });
}

// ── blocking 语义（第 3 节）─────────────────────────────────────────────
function checkBlockingSemantics(obj, E, warn) {
  if (!Array.isArray(obj.open_items)) return;
  // 可自动消解 / 人工阻塞两类的划分，契约第 3 节给的是闭集
  const HUMAN_ONLY = ['HUMAN_DECISION_REQUIRED', 'REVOKED'];
  obj.open_items.forEach((it, i) => {
    if (!it || typeof it !== 'object') return;
    // `blocking` 与 `requires_human_intervention` 在契约里地位相同：都只出现在示例 JSON 里、
    // 正文都没写必填。所以「缺失」与「类型错」都必须用同一套标准（都是 WARN）。
    // 2026-11-25 验收实测：上一版只统一了「缺失」，`blocking: 'yes'` 是 WARN
    // 而 `requires_human_intervention: 'yes'` 是 ERROR——同一份文件两套标准。
    if (typeof it.blocking !== 'boolean') {
      warn.push({
        rule: 'missing_blocking', field: `open_items[${i}].blocking`,
        msg: 'blocking 不是布尔值。契约第 3 节的门控只检查 blocking: true 的项——'
          + '缺了它这条 open_item 在门控里等于不存在（契约未把它列为必填，故只提示）',
      });
    }
    // 人工阻塞类被标 blocking:true 是合法的（它确实阻塞「把这缺陷记为已修复」），
    // 但那意味着本轮只能以 PARTIALLY_CLOSED 收尾。给一条提示，不判错。
    if (it.blocking === true && HUMAN_ONLY.includes(it.kind)) {
      warn.push({
        rule: 'human_blocker_present', field: `open_items[${i}].kind`,
        msg: `${it.kind} 是人工阻塞类：本轮只能以 PARTIALLY_CLOSED 收尾，最终报告须单列「待人工裁决」`,
      });
    }
  });
}

// ── 收集目标 ──
let targets = [];
if (ARGS.dir) {
  if (!existsSync(ARGS.dir) || !statSync(ARGS.dir).isDirectory()) {
    console.error(`目录不存在: ${ARGS.dir}`);
    process.exit(2);
  }
  targets = readdirSync(ARGS.dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => join(ARGS.dir, f));
  if (targets.length === 0) {
    console.error('[预期失败] 目录里没有任何 .json——分母为 0 不等于通过');
    process.exit(2);
  }
} else if (ARGS.target) {
  if (!existsSync(ARGS.target)) {
    console.error(`文件不存在: ${ARGS.target}`);
    process.exit(2);
  }
  targets = [ARGS.target];
} else {
  console.error('用法: node check-handoff.mjs <packet.json> | --dir <目录>');
  process.exit(2);
}

// ── 执行 ──
const results = [];
for (const t of targets) {
  let obj;
  try {
    obj = JSON.parse(readFileSync(t, 'utf8'));
  } catch (e) {
    results.push({ label: basename(t), errors: [{ rule: 'json_parse_failed', field: '(root)', msg: e.message }], warnings: [] });
    continue;
  }
  results.push(checkPacket(obj, basename(t)));
}

const totalErrors = results.reduce((a, r) => a + r.errors.length, 0);
const totalWarns = results.reduce((a, r) => a + r.warnings.length, 0);

if (ARGS.json) {
  console.log(JSON.stringify({ ok: totalErrors === 0, files: results.length, errors: totalErrors, warnings: totalWarns, results }, null, 2));
} else {
  console.log(`\nResume Packet 校验（${results.length} 份）\n`);
  for (const r of results) {
    if (r.errors.length === 0 && r.warnings.length === 0) {
      console.log(`  ✓ ${r.label}`);
      continue;
    }
    console.log(`  ${r.errors.length ? '✗' : '⚠️ '} ${r.label}`);
    for (const e of r.errors) console.log(`      [${e.rule}] ${e.field}\n        ${e.msg}`);
    for (const w of r.warnings) console.log(`      [${w.rule}] ${w.field}\n        ${w.msg}`);
  }
  console.log('');
  if (totalErrors === 0) console.log(`  ✅ 全部合规${totalWarns ? `（${totalWarns} 项警告）` : ''}\n`);
  else console.log(`  ✗ ${totalErrors} 项违规\n`);
}

process.exit(totalErrors > 0 ? 1 : 0);
