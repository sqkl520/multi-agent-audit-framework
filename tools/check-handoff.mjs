#!/usr/bin/env node
/**
 * check-handoff.mjs — Resume Packet 的机械校验
 *
 * ── 为什么需要它（2026-11-19 补）────────────────────────────────────
 *   `framework/components/handoff-schema.md` 定义了波次之间传递的 Resume Packet：
 *   7 个必填字段、`wave_id` 5 值枚举、`wave_status` 3 值枚举、`open_items.kind` 10 种。
 *   文件里写着「缺失时行为：拒绝整个包」「违反此规则视为 CONTRACT_VIOLATION」。
 *
 *   但 `grep -rln "Resume Packet" tools/*.mjs` 的结果里**没有任何校验器**。
 *   也就是说：这份契约的每一条约束，从写下那天起就没有被执行过。
 *
 *   这不是「引用断了」，是「根本没有检测器」——比规则句出口率 0% 那类更彻底。
 *
 * ── 检查项 ──────────────────────────────────────────────────────────
 *   H1  顶层必填字段缺失（schema_version / round_id / wave_id / wave_status / trace_id / packet_digest）
 *   H2  `schema_version` 不等于 "handoff-schema-v1"
 *   H3  `wave_id` 不在 {wave-1..wave-5}
 *   H4  `wave_status` 不在 {CLOSED, PARTIALLY_CLOSED, FAILED}
 *   H5  `open_items[].kind` 不在 10 种闭集内
 *   H6  `open_items` 里出现原始正文（Resume Packet 不得包含子 Agent 的原始正文或完整 findings 数组）
 *   H7  `round_id` 与 `wave_id` 的形态不对（round_id 应形如 round{N}）
 *
 * ── 级别 ────────────────────────────────────────────────────────────
 *   H1–H5、H7 → ERROR（契约明写「拒绝整个包」）
 *   H6        → ERROR（契约明写「视为 CONTRACT_VIOLATION」）
 *
 * ── 它检查什么、不检查什么 ──────────────────────────────────────────
 *   检查：结构、枚举、必填、以及「有没有把原始正文塞进来」这一条最关键的约束。
 *   **不检查** `packet_digest` 与内容是否真的对得上——那需要包生成器的确定性序列化约定，
 *   当前没有定义，猜一个算法会让这条检查本身变成假保险。
 *   也不检查 `open_items` 与上一波产物的一致性——那需要读产物，超出本工具范围。
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
// 顶层必填（`generated_at` 契约明写「允许缺失」，故不在此列）
const REQUIRED = ['schema_version', 'round_id', 'wave_id', 'wave_status', 'trace_id', 'packet_digest'];

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

  return { label, errors, warnings: warn };
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
