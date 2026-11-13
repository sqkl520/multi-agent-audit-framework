#!/usr/bin/env node
/**
 * check-payload.mjs — 子 Agent 返回的**准入检查**（事前门，不是事后补救）
 *
 * 设计依据（2026-11-09 对比 dsh-superagent 后确定）：
 *
 *   参考项目用 `z.object().strict().refine()` 让「accept 必须有 worktree_name」
 *   变成一个**工具调用失败**——错误在产生的那一刻就被挡住。
 *
 *   而我们的 verify-artifacts.mjs 里有一半代码在做 salvageFromMarkdown，
 *   补偿「输出不是结构化产生的」。**这是事后补救。**
 *
 *   实测代价：15 个真实产物，**0 个含 JSON 信封**（100% 需要 salvage）。
 *   根因不是子 Agent 不听话，是 `output-contract.md` 要求 JSON 信封，
 *   而各模板只在示例里出现过一次，**没有一句「必须写」**。
 *
 * 所以这个脚本做两件事：
 *   1. 给主 Agent 一个**派发前的检查器**：收到返回先跑它，不合规就当场判违规
 *   2. 输出**可直接粘回给子 Agent 的错误信息**，说明缺什么
 *
 * 用法：node check-payload.mjs <产物文件> [--role sweep|audit|...] [--json]
 * 退出码：0 合规 / 1 不合规 / 2 用法错误
 */

import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const roleIdx = args.indexOf('--role');
const expectRole = roleIdx >= 0 ? args[roleIdx + 1] : null;
const file = args.find((a) => !a.startsWith('--') && a !== expectRole);

if (!file) {
  console.error('用法: node check-payload.mjs <产物文件> [--role sweep|audit|recon|critique|fix|verify] [--json]');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`文件不存在: ${file}`);
  process.exit(2);
}

const text = readFileSync(file, 'utf8');
const errors = [];
const warnings = [];

// ────────────────────────────────────────────────────────────────────
// 1 · 必须有一个可解析的 JSON 信封
// ────────────────────────────────────────────────────────────────────
const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)```/g)];
if (blocks.length === 0) {
  errors.push({
    field: '(root)',
    rule: 'no_json_envelope',
    msg: '产物里没有 ```json 代码块。契约要求返回必须包在 JSON 信封里。',
    fix: '在产物文件末尾追加一个 ```json 块，内容见 components/output-contract.md §1',
  });
} else if (blocks.length > 1) {
  warnings.push({
    field: '(root)',
    rule: 'multiple_json_blocks',
    msg: `发现 ${blocks.length} 个 json 块，会取最后一个是信封的那个`,
  });
}

// ── 取哪个 json 块当信封 ──
// 2026-11-14 修：此前固定取 blocks[0]，而契约 §1 和全部 wrapper 都写的是
// 「你产物的**最后**一个代码块必须是完整 JSON 信封」，且 wrapper §4 明确
// 鼓励「正文随便写（分析、证据、表格）」。
// 于是 agent 越认真写正文（正文里带示例 json），越会被判违规：
// 实测一份产物末尾有完全正确的信封，只因正文有两个示例块，被判 7 项违规、
// `role: undefined`。**认真写反而失败**，这是最坏的一类缺陷。
//
// 现在的做法：从后往前找第一个「看起来是信封」的块（含 schema_version 或 role）；
// 都不像信封时退回最后一个可解析的块。
const looksLikeEnvelope = (s) => /"schema_version"\s*:/.test(s) || /"role"\s*:/.test(s);
let envelopeBlockIdx = -1;
for (let i = blocks.length - 1; i >= 0; i--) {
  if (looksLikeEnvelope(blocks[i][1])) { envelopeBlockIdx = i; break; }
}
if (envelopeBlockIdx < 0 && blocks.length > 0) envelopeBlockIdx = blocks.length - 1;

let envelope = null;
if (blocks.length > 0) {
  // 2026-11-14 修：尾随逗号的「容错」正则不尊重字符串边界，会**静默改写 quote 的内容**。
  // 实测：源码里引用 `if (a) { return {x,}; }`，正则把 `,}` 改成 `}`，
  // 解析出来的 quote 变成 `if (a) { return {x}; }`——而 quote 正是门 0 要求
  // 「逐字来自本回合读到的原文」的那一项。改写了却没任何警告。
  //
  // 正确做法：先按原样解析。原样能解析就**绝不改写**（绝大多数产物都是合法 JSON）。
  // 只有原样解析失败时才启用容错，且容错生效必须留下 WARN——
  // 因为一旦容错改动了内容，这份产物就不能再声称「quote 逐字」。
  const raw = blocks[envelopeBlockIdx][1]
    .split('\n').filter((ln) => !/^\s*\/\//.test(ln)).join('\n');

  let parseErr = null;
  try {
    envelope = JSON.parse(raw);
  } catch (e) {
    parseErr = e;
    const tolerant = raw.replace(/,(\s*[}\]])/g, '$1');
    if (tolerant !== raw) {
      try {
        envelope = JSON.parse(tolerant);
        warnings.push({
          field: '(root)', rule: 'json_trailing_comma_fixed',
          msg: '原样 JSON 无法解析，已自动修复尾随逗号后通过。'
            + '**但该修复会改动字符串内的内容**（例如 quote 里的 `,}` 变成 `}`），'
            + '因此本产物的 quote 不能视为「逐字原文」——请让 agent 输出合法 JSON',
        });
      } catch {
        envelope = null;
      }
    }
  }

  if (envelope === null) {
    errors.push({
      field: '(root)',
      rule: 'json_parse_failed',
      msg: `JSON 解析失败: ${parseErr?.message ?? '未知'}（取的是第 ${envelopeBlockIdx + 1}/${blocks.length} 个 json 块）`,
      fix: '检查是否有多余逗号、单引号、未转义的引号',
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// 2 · 顶层信封字段（缺一即违规）
// ────────────────────────────────────────────────────────────────────
const REQUIRED_TOP = ['schema_version', 'agent_id', 'role', 'status', 'contract_valid', 'payload'];
if (envelope) {
  for (const k of REQUIRED_TOP) {
    if (!(k in envelope)) {
      errors.push({ field: k, rule: 'missing_top_field', msg: `顶层缺字段: ${k}` });
    }
  }
  if (envelope.schema_version && envelope.schema_version !== 'output-contract-v1') {
    errors.push({
      field: 'schema_version',
      rule: 'wrong_schema_version',
      msg: `schema_version 必须精确等于 "output-contract-v1"，实际是 "${envelope.schema_version}"`,
    });
  }
  const VALID_ROLES = ['recon', 'sweep', 'audit', 'critique', 'fix', 'verify', 'planner'];
  if (envelope.role && !VALID_ROLES.includes(envelope.role)) {
    errors.push({
      field: 'role', rule: 'invalid_role',
      msg: `role 必须是 ${VALID_ROLES.join(' / ')} 之一，实际是 "${envelope.role}"`,
    });
  }
  if (expectRole && envelope.role !== expectRole) {
    errors.push({
      field: 'role', rule: 'role_mismatch',
      msg: `期望 role="${expectRole}"，实际 "${envelope.role}"`,
    });
  }
  const VALID_STATUS = ['SUCCESS', 'RETRYABLE_FAILURE', 'CONTRACT_VIOLATION', 'PERMANENT_FAILURE'];
  if (envelope.status && !VALID_STATUS.includes(envelope.status)) {
    errors.push({
      field: 'status', rule: 'invalid_status',
      msg: `status 必须是 ${VALID_STATUS.join(' / ')} 之一，实际是 "${envelope.status}"`,
    });
  }
  // artifact_path 与 status 的联动（output-contract §1）
  if (envelope.status === 'SUCCESS') {
    if (!envelope.artifact_path) {
      errors.push({
        field: 'artifact_path', rule: 'missing_artifact_path',
        msg: 'status=SUCCESS 时 artifact_path 必填',
      });
    } else if (typeof envelope.artifact_path === 'string') {
      // 2026-11-10 修正：output-contract.md:92 宣称「artifact_path 指向的文件不存在
      // = CONTRACT_VIOLATION，这道校验是机械的」——但此前本工具只检查非空，
      // 从不检查存在性。一个指向 D:/不存在.md 的信封能拿到「✅ 契约合规」。
      //
      // 2026-11-14 修：契约 §1 明确允许两种写法——
      //   「仓库外绝对路径 **或** `<OUTDIR>` 相对路径`」
      // 但本工具此前只实现了第一种，于是用 `<OUTDIR>` 写的产物一律被拒。
      // 更糟的是我上一轮为了让示例「能过」，把示例的路径改成 `<OUTDIR>` 后用
      // --no-exists 校验——**等于把校验器的不完整实现，用「跳过检查」掩盖过去**。
      // 正确的修法是让校验器实现契约允许的语义：`<OUTDIR>` 是「运行时才知道的
      // 输出目录」，静态校验不可能验证它，因此按约定视为「存在性待运行时确认」，
      // 并给一条 WARN 提醒主 Agent 在接收时核对真实路径。
      const skipExists = args.includes('--no-exists');
      const p = envelope.artifact_path;
      const isOutdirPlaceholder = /^<OUTDIR>[/\\]/.test(p);

      if (isOutdirPlaceholder) {
        warnings.push({
          field: 'artifact_path', rule: 'artifact_outdir_placeholder',
          msg: `artifact_path 使用 <OUTDIR> 占位（契约 §1 允许）：${p}。`
            + '静态校验无法验证它——**主 Agent 在接收时必须核对 <OUTDIR> 展开后的真实文件是否存在**',
        });
      } else if (!skipExists && !existsSync(p)) {
        errors.push({
          field: 'artifact_path', rule: 'artifact_not_found',
          msg: `artifact_path 指向的文件不存在: ${p}。` +
               `output-contract.md §1 要求 SUCCESS 必须有真实落盘的产物——` +
               `「格式完美但产物没写出来」不构成完成。`
               + '（若这是运行时才知道的输出目录，请按契约写成 `<OUTDIR>/文件名`）',
        });
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 3 · 按角色的 payload 必填字段
// ────────────────────────────────────────────────────────────────────
const ROLE_REQUIRED = {
  recon: ['slice_count', 'audit_slices', 'entry_points', 'unverified'],
  sweep: ['slice_id', 'reachability', 'files_read', 'leads', 'lead_count'],
  audit: ['findings', 'self_checks'],
  critique: ['critique_role', 'verdicts'],
  fix: ['files_touched'],
  verify: ['finding_id', 'verdict'],
  planner: ['tier', 'score', 'members', 'member_count'],
};

if (envelope && envelope.payload && envelope.role) {
  // 2026-11-14 修：`ROLE_REQUIRED[envelope.role]` 是普通对象直查，role 取
  // "__proto__" / "constructor" / "toString" 等原型链键时会取到**函数**而非
  // undefined，`?? []` 兜不住，`for...of` 直接抛 TypeError: req is not iterable。
  // 结果是把「契约违规」误报成「校验器崩了」，错误信息变成 JS 堆栈。
  // 这正是本项目 GT-015/GT-018 那类缺陷（裸下标查表）在自家工具里的复现。
  const req = Object.prototype.hasOwnProperty.call(ROLE_REQUIRED, envelope.role)
    ? ROLE_REQUIRED[envelope.role]
    : [];
  for (const k of req) {
    if (!(k in envelope.payload)) {
      errors.push({
        field: `payload.${k}`, rule: 'missing_role_field',
        msg: `role="${envelope.role}" 的 payload 缺必填字段: ${k}`,
      });
    }
  }

  // 角色特定的算术自洽
  const p = envelope.payload;
  // 通用枚举校验（2026-11-10 新增）：闭集写错一个词，整个产物就该作废
  const ENUM_CHECKS = [
    { path: 'leads[].confidence',         values: ['HIGH', 'MEDIUM', 'LOW'] },
    { path: 'leads[].suspected_dimension',values: ['logic', 'concurrency', 'security', 'error-handling', 'data-consistency', 'contract'] },
    { path: 'findings[].severity',        values: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', null] },
    { path: 'findings[].dimension',       values: ['logic', 'concurrency', 'security', 'error-handling', 'data-consistency', 'contract'] },
    { path: 'audit_slices[].reachability_hint', values: ['PROD', 'ENTRY', 'TEST_ONLY', 'UNREACHABLE', 'GENERATED', 'MIXED'] },
    // 2026-11-10（蓝队 A2）：sweep 的 payload 顶层 reachability 此前完全没有枚举校验，
    // 实测写 "TOTALLY_IGNORE_ME" 仍判契约合规。这个字段决定要不要花钱深挖。
    { path: 'reachability', values: ['PROD', 'ENTRY', 'TEST_ONLY', 'UNREACHABLE', 'GENERATED'] },
    { path: 'verdicts[].five_step.path_reachable',  values: ['true', 'false', 'untested', true, false] },
    { path: 'verdicts[].five_step.already_handled', values: ['true', 'false', 'untested', true, false] },
  ];
  for (const { path: fp, values } of ENUM_CHECKS) {
    // 顶层字段（如 reachability）：直接校验，不走数组遍历
    if (!fp.includes('[].')) {
      const v = fp.split('.').reduce((o, k) => (o == null ? o : o[k]), p);
      if (v === undefined) continue;
      if (!values.includes(v)) {
        errors.push({
          field: `payload.${fp}`, rule: 'invalid_enum_value',
          msg: `${fp} 只能取 [${values.map(x => JSON.stringify(x)).join(' | ')}]，实际是 ${JSON.stringify(v)}`,
        });
      }
      continue;
    }
    const [arrayKey, field] = fp.split('[].');
    const arr = p[arrayKey];
    if (!Array.isArray(arr)) continue;
    arr.forEach((item, idx) => {
      // 支持嵌套字段（如 five_step.path_reachable）
      const segs = field.split('.');
      let v = item;
      for (const s of segs) { if (v == null) break; v = v[s]; }
      if (v === undefined) return;
      if (!values.includes(v)) {
        errors.push({
          field: `payload.${arrayKey}[${idx}].${field}`, rule: 'invalid_enum_value',
          msg: `${fp} 只能取 [${values.map(x => JSON.stringify(x)).join(' | ')}]，实际是 ${JSON.stringify(v)}`,
        });
      }
    });
  }
  if (envelope.role === 'sweep') {
    // 2026-11-10（蓝队 A3）：GENERATED 必须给出生成器引用。
    // 实测：reachability=GENERATED 但完全不写 generator_ref → 契约合规。
    // 这让「文件头写一行 DO NOT EDIT 就免检」成为最廉价的逃避通道。
    if (p.reachability === 'GENERATED') {
      const gr = p.generator_ref;
      if (!gr || typeof gr !== 'string' || gr.trim().length < 3) {
        errors.push({
          field: 'payload.generator_ref', rule: 'generated_without_generator_ref',
          msg: `reachability=GENERATED 时必须写 generator_ref（生成器路径或命令）。` +
               `否则「标 GENERATED 就不深挖」等于一个免检开关——文件头写一行 DO NOT EDIT 即可绕过全部审计`,
        });
      }
    }
    if (typeof p.lead_count === 'number' && Array.isArray(p.leads) && p.lead_count !== p.leads.length) {
      errors.push({
        field: 'payload.lead_count', rule: 'count_mismatch',
        msg: `lead_count=${p.lead_count} 但 leads.length=${p.leads.length}`,
      });
    }
    // dimension_histogram 各值之和必须等于 lead_count（契约 §2.2a 明文，
    // 2026-11-12 实测此前从未校验）。直方图是覆盖率记账的唯一来源，
    // 对不上就等于覆盖率数字可以随手编。
    if (Array.isArray(p.leads) && p.dimension_histogram && typeof p.dimension_histogram === 'object') {
      const histSum = Object.values(p.dimension_histogram)
        .filter((v) => typeof v === 'number')
        .reduce((s, v) => s + v, 0);
      if (histSum !== p.leads.length) {
        errors.push({
          field: 'payload.dimension_histogram', rule: 'histogram_mismatch',
          msg: `dimension_histogram 各值之和=${histSum}，但 leads.length=${p.leads.length}。` +
               `契约 §2.2a 要求两者相等——直方图是覆盖率记账的唯一来源，对不上则覆盖率不可信`,
        });
      }
    }
  }
  if (envelope.role === 'recon') {
    if (typeof p.slice_count === 'number' && Array.isArray(p.audit_slices) && p.slice_count !== p.audit_slices.length) {
      errors.push({
        field: 'payload.slice_count', rule: 'count_mismatch',
        msg: `slice_count=${p.slice_count} 但 audit_slices.length=${p.audit_slices.length}`,
      });
    }
    // 入口点必须是带证据的对象，不是 "path:line" 字符串（2026-11-09 修正）
    if (Array.isArray(p.entry_points)) {
      p.entry_points.forEach((e, i) => {
        if (typeof e === 'string') {
          errors.push({
            field: `payload.entry_points[${i}]`, rule: 'entry_point_not_object',
            msg: `入口点必须是对象（含 location + evidence_quote），实际是字符串 "${e}"。旧契约写成 ["path:line"] 是错的`,
          });
          return;
        }
        for (const k of ['location', 'evidence_quote']) {
          if (!e?.[k]) {
            errors.push({
              field: `payload.entry_points[${i}].${k}`, rule: 'missing_entry_point_field',
              msg: `入口点 ${e?.entry_id ?? `#${i}`} 缺 ${k}——没有 evidence_quote 的入口等同凭印象列的，门 0 不通过`,
            });
          }
        }
      });
    }
    // 切片独立性：files 与 shared_dependencies 不得相交，且各切片 files 两两不相交
    if (Array.isArray(p.audit_slices)) {
      const seen = new Map();
      p.audit_slices.forEach((s, i) => {
        const sid = s?.slice_id ?? `#${i}`;
        const files = Array.isArray(s?.files) ? s.files : [];
        const shared = Array.isArray(s?.shared_dependencies) ? s.shared_dependencies : [];
        for (const f of files) {
          if (seen.has(f)) {
            errors.push({
              field: `payload.audit_slices[${i}].files`, rule: 'slice_overlap',
              msg: `文件 ${f} 同时出现在 ${seen.get(f)} 与 ${sid}——切片必须两两不相交（共享文件应进 shared_dependencies）`,
            });
          } else seen.set(f, sid);
        }
        for (const f of shared) {
          if (files.includes(f)) {
            errors.push({
              field: `payload.audit_slices[${i}].shared_dependencies`, rule: 'shared_in_files',
              msg: `${f} 同时在 files 和 shared_dependencies 里——共享文件不得计入 files / file_count`,
            });
          }
        }
      });
    }
    // 静默截断：声明了 truncated 却没在 unverified 里说明
    if (p.entry_points_truncated === true) {
      const hasNote = Array.isArray(p.unverified) &&
        p.unverified.some((u) => /截断|truncat/i.test(String(u?.reason ?? '')));
      if (!hasNote) {
        errors.push({
          field: 'payload.entry_points_truncated', rule: 'silent_truncation',
          msg: 'entry_points_truncated=true 但 unverified 里没有说明截断了多少——静默截断判违规',
        });
      }
    }
  }
  if (envelope.role === 'audit') {
    // findings[].status 枚举校验（2026-11-10 蓝队实测新增）
    // 实测：status 写 "TOTALLY_FINE_TRUST_ME" → ✅ 契约合规。
    // 这个字段决定发现是否进入锐评/修复，任意字符串等于没有约束。
    const FINDING_STATUS = ['CONFIRMED', 'NO_EVIDENCE_FOUND', 'GATE_0_FAILED', 'UNREADABLE', 'EVIDENCE_GAP'];
    const fs4 = Array.isArray(p.findings) ? p.findings : [];
    // findings 不得为空数组（契约 §2.2 明文：「空数组一律视为 CONTRACT_VIOLATION」）。
    // 实测：findings: [] 曾拿到「✅ 契约合规」——「没查」和「查了没发现」在契约上
    // 必须可区分，而空数组恰好把两者抹平了，让「什么都不做」成为最省事的通过方式。
    if (Array.isArray(p.findings) && p.findings.length === 0) {
      errors.push({
        field: 'payload.findings', rule: 'empty_findings',
        msg: `findings 是空数组。没发现任何问题时也必须返回一条 status="NO_EVIDENCE_FOUND" 的条目，` +
             `并在 searched_scope 里写明读了哪些文件、查了哪些模式——` +
             `否则「没查」和「查了没发现」无法区分`,
      });
    }
    fs4.forEach((f, j) => {
      // 2026-11-14 修：此前是 `f?.status !== undefined && ...`——**不写 status 就跳过检查**。
      // 但契约 §2.2 把 status 列为 findings 条目的字段，且「空 findings」被明确禁止，
      // 意味着每条 finding 都必须声明它的状态。缺省即违规，否则「省略最省事」。
      if (f?.status === undefined || f?.status === null) {
        errors.push({
          field: `payload.findings[${j}].status`, rule: 'missing_finding_status',
          msg: `findings[${j}] 缺 status。契约 §2.2 要求每条发现声明状态`
            + `（${FINDING_STATUS.join(' | ')}）——否则下游无法区分「已确认」和「证据不足」`,
        });
      } else if (!FINDING_STATUS.includes(f.status)) {
        errors.push({
          field: `payload.findings[${j}].status`, rule: 'invalid_finding_status',
          msg: `finding.status 只能取 ${FINDING_STATUS.join(' | ')}，实际是 "${f.status}"`,
        });
      }

      // 2026-11-14 修：finding 的字段名与结构此前完全没校验，导致
      // **示例里的错误结构能通过校验器，进而变成「错误但被验证过的规范」**。
      // 实测：我生成的 audit 示例用 `id`（契约是 `finding_id`）、把 `evidence` 写成
      // 数组（契约是对象）、把 `inference` 写成字符串（契约是 {claim,basis,alternatives}），
      // 全部通过了校验器，因为这里只查顶层必填键。
      //
      // 后果比「示例不标准」严重：第 366 行那段 CRITICAL 检查读 `inf.claim`，
      // 如果 inference 是字符串，`f.inference ?? {}` 拿到字符串、`.claim` 是 undefined，
      // **检查静默失效而不是报错**。
      const FIELD_ALIASES = {
        finding_id: 'id',
        evidence: null,
        inference: null,
      };
      if (f && typeof f === 'object') {
        if (!f.finding_id && f.id) {
          errors.push({
            field: `payload.findings[${j}].finding_id`, rule: 'wrong_field_name',
            msg: `findings[${j}] 用了 "id"，契约 §2.2 的字段名是 "finding_id"`,
          });
        } else if (!f.finding_id) {
          errors.push({
            field: `payload.findings[${j}].finding_id`, rule: 'missing_finding_id',
            msg: `findings[${j}] 缺 finding_id——下游锐评/修复/vrify 都靠它挂接`,
          });
        }

        if (f.evidence !== undefined) {
          if (Array.isArray(f.evidence)) {
            errors.push({
              field: `payload.findings[${j}].evidence`, rule: 'evidence_wrong_shape',
              msg: `findings[${j}].evidence 是数组，契约 §2.2 要求是对象 {file, line, quote}`,
            });
          } else if (!f.evidence || typeof f.evidence !== 'object') {
            errors.push({
              field: `payload.findings[${j}].evidence`, rule: 'evidence_wrong_shape',
              msg: `findings[${j}].evidence 必须是对象 {file, line, quote}`,
            });
          }
        }

        if (f.inference !== undefined && (typeof f.inference !== 'object' || Array.isArray(f.inference))) {
          errors.push({
            field: `payload.findings[${j}].inference`, rule: 'inference_wrong_shape',
            msg: `findings[${j}].inference 是 ${typeof f.inference}，契约 §2.2 要求对象`
              + ` {claim, basis, alternatives}。写成字符串会让 CRITICAL 准入检查静默失效`,
          });
        }
      }

      // CONFIRMED 必须真有证据（2026-11-10 蓝队实测新增）
      // 实测：CONFIRMED + severity:null + evidence 全 null → 契约合规。
      // 这意味着「已确认」可以完全没有证据——比「洗白」严重一个量级。
      if (f?.status === 'CONFIRMED') {
        const ev = f?.evidence;
        // 注意：quote 必须是非空字符串。只判 `!= null` 会放过 quote:""，
        // 红队实测过——CONFIRMED + quote:"" + basis:"looked" 曾拿到「✅ 契约合规」。
        const hasRealQuote = (e) =>
          e && typeof e.file === 'string' && e.file !== '' &&
          typeof e.quote === 'string' && e.quote.trim() !== '';
        const ok = ev && (Array.isArray(ev)
          ? ev.length > 0 && ev.every(hasRealQuote)
          : hasRealQuote(ev));
        if (!ok) {
          errors.push({
            field: `payload.findings[${j}].evidence`, rule: 'confirmed_without_evidence',
            msg: `status=CONFIRMED 但 evidence 的 file 为空或 quote 不是非空字符串（实际 quote=${JSON.stringify(ev?.quote)}）。` +
                 `CONFIRMED 的含义是「有门 0 级证据」，没有可引用的原文只能标 EVIDENCE_GAP`,
          });
        }
        if (!f?.severity) {
          errors.push({
            field: `payload.findings[${j}].severity`, rule: 'confirmed_without_severity',
            msg: `status=CONFIRMED 但 severity 为空。确认了缺陷却不判严重性，下游无法定级`,
          });
        }
        // CRITICAL 的准入门槛（wave2-audit.md §3.3，2026-11-12 之前无机械校验）
        // 契约原文：「不得把任何发现标为 CRITICAL，除非同时提供调用链证据
        // （从入口到问题点的完整路径）或可复现触发条件。仅有定义位置 + 推断的，最高 HIGH」
        //
        // 实测：4 个 agent 里有 3 个把「escapeHtml 顺序错」标成 CRITICAL，
        // 但只给了单元级测试输出，没有调用链——按 §3.3 应降为 HIGH。
        // 规则存在但从未被执行，等于不存在。
        if (f.severity === 'CRITICAL') {
          const inf = f.inference ?? {};
          const text = [
            inf.claim, inf.basis, f.runtime_evidence?.observed, f.runtime_evidence?.command,
            ...(Array.isArray(inf.alternatives) ? inf.alternatives : []),
          ].filter((x) => typeof x === 'string').join(' ');
          // 调用链：形如 a() → b() → c，或明确写了「调用链 / 入口 / caller」
          const hasCallChain = /调用链|调用路径|从\s*\S+\s*到|入口.*→|→.*→|caller|call site/i.test(text);
          // 可复现触发条件：明确的输入 → 输出，或命令 + 结果
          const hasTrigger = /(输入|传入|调用).{0,40}(得|返回|输出|→|抛出|抛错)|可复现|复现步骤|命令.{0,20}输出/i.test(text)
            || (f.runtime_evidence && typeof f.runtime_evidence.observed === 'string' && f.runtime_evidence.observed.trim() !== '');
          if (!hasCallChain && !hasTrigger) {
            errors.push({
              field: `payload.findings[${j}].severity`, rule: 'critical_without_call_chain',
              msg: `severity=CRITICAL 但既没有调用链证据、也没有可复现触发条件（wave2-audit.md §3.3）。` +
                   `仅凭定义位置 + 推断的最高只能标 HIGH——` +
                   `把 CRITICAL 锁在硬证据后面，是为了防止「看上去吓人」的东西挤占修复队列`,
            });
          }
        }
      }
    });
    // NO_EVIDENCE_FOUND 必须带搜索范围与方法（2026-11-10 新增）
    // 红队实测：一个 quote 为空、basis 只有 "looked" 三个字母的 NO_EVIDENCE_FOUND
    // 条目能拿到「✅ 契约合规」。这让「什么都不做」成为最廉价的攻击。
    const noEv = fs4.filter((f) => f?.status === 'NO_EVIDENCE_FOUND');
    if (noEv.length > 0) {
      const sc = p.searched_scope;
      const validScope = sc && typeof sc === 'object' &&
        Array.isArray(sc.files_read) && sc.files_read.length > 0 &&
        Array.isArray(sc.dimension_checklist) && sc.dimension_checklist.length > 0;
      if (!validScope) {
        errors.push({
          field: 'payload.searched_scope', rule: 'no_evidence_without_scope',
          msg: `${noEv.length} 条 NO_EVIDENCE_FOUND 但 payload.searched_scope 缺失或不完整（需 files_read + dimension_checklist 非空）。` +
               `「我查了没发现」必须证明「我真查了」——否则「什么都不做」就是最廉价的攻击`,
        });
      }
      // 每条 NO_EVIDENCE_FOUND 的 basis 不能是空话
      noEv.forEach((f, j) => {
        const basis = String(f?.inference?.basis ?? '').trim();
        if (basis.length < 15) {
          errors.push({
            field: `payload.findings[${j}].inference.basis`, rule: 'vacuous_basis',
            msg: `NO_EVIDENCE_FOUND 的 basis 只有 ${basis.length} 字（"${basis}"）——至少要说明查了哪些模式、覆盖了什么`,
          });
        }
      });
    }
    // 三项必做自检必须有承载字段（wave2-audit.md §6）
    // 没有这三个字段时，「必做」在契约上无法验证——子 Agent 做了主 Agent 也看不到。
    const sc = p.self_checks;
    if (sc && typeof sc === 'object' && !Array.isArray(sc)) {
      const REQUIRED_CHECKS = ['identifier_reconcile', 'self_check_audit', 'runtime_validation'];
      for (const k of REQUIRED_CHECKS) {
        if (!(k in sc)) {
          errors.push({
            field: `payload.self_checks.${k}`, rule: 'missing_self_check',
            msg: `缺少必做自检项 ${k}（wave2-audit.md §6 三项必做之一）。若确实不适用，写 "SKIPPED" 并在 note 说明理由`,
          });
          continue;
        }
        const VALID = ['DONE', 'SKIPPED', 'NOT_APPLICABLE'];
        const v = sc[k];
        const status = typeof v === 'string' ? v : v?.status;
        if (!VALID.includes(status)) {
          errors.push({
            field: `payload.self_checks.${k}`, rule: 'invalid_self_check_status',
            msg: `${k} 的 status 必须是 ${VALID.join(' / ')} 之一，实际是 "${status}"`,
          });
        }
        // SKIPPED / NOT_APPLICABLE 必须给理由，否则等同于静默跳过
        if ((status === 'SKIPPED' || status === 'NOT_APPLICABLE')) {
          const note = typeof v === 'string' ? null : (v?.note ?? v?.reason);
          if (!note || String(note).trim().length < 10) {
            errors.push({
              field: `payload.self_checks.${k}`, rule: 'self_check_no_reason',
              msg: `${k} 标为 ${status} 但没给具体理由（note 至少 10 字）——静默跳过等于没做`,
            });
          }
        }
      }
    }
  }
  if (envelope.role === 'critique') {
    const vs = Array.isArray(p.verdicts) ? p.verdicts : [];
    // verdicts 必须覆盖全部 target_finding_ids（2026-11-10 蓝队 A12）
    // wave3-critique.md 的自检表写了「verdicts 覆盖派发时传入的全部 target_finding_ids」，
    // 但校验器从来没查过。实测：只覆盖 1/3 个 target → EXIT=0。
    const targets = Array.isArray(p.target_finding_ids) ? p.target_finding_ids : [];
    if (targets.length > 0) {
      const covered = new Set(vs.map((v) => v?.finding_id).filter(Boolean));
      const missing = targets.filter((t) => !covered.has(t));
      if (missing.length > 0) {
        errors.push({
          field: 'payload.verdicts', rule: 'verdict_missing_for_target',
          msg: `以下 target_finding_ids 没有任何 verdict: ${missing.join(', ')}。` +
               `漏审一条等于放它直接进入修复波——锐评波的价值全在「每条都被攻击过」`,
        });
      }
    }
    // 裁决枚举按子角色分支（output-contract §2.3）
    const VERDICT_BY_ROLE = {
      skeptic: ['holds', 'refuted', 'untested'],
      arbiter: ['UPHELD', 'DOWNGRADED', 'REVOKED'],
      devils_advocate: [],   // 它不返回 verdicts
    };
    const allowed = VERDICT_BY_ROLE[p.critique_role];
    if (allowed && allowed.length > 0) {
      vs.forEach((v, i) => {
        if (v?.verdict !== undefined && !allowed.includes(v.verdict)) {
          errors.push({
            field: `payload.verdicts[${i}].verdict`, rule: 'invalid_verdict_enum',
            msg: `${p.critique_role} 的 verdict 只能取 ${allowed.join(' | ')}，实际是 "${v.verdict}"`,
          });
        }
      });
    }
    // devils_advocate 不得填 verdicts
    if (p.critique_role === 'devils_advocate' && vs.length > 0) {
      errors.push({
        field: 'payload.verdicts', rule: 'devils_advocate_has_verdicts',
        msg: `devils_advocate 只评覆盖，不评发现。verdicts 必须为空数组，实际有 ${vs.length} 条`,
      });
    }

    // 2026-11-14 修：coverage_gaps.kind 是契约声明的闭集，但此前**零校验**。
    // 实测 `kind: "TOTALLY_MADE_UP"` → ✅ 契约合规。
    // 而 kind 决定下一波派谁（SLICE_UNCOVERED → REASSIGN_TO_NEW_AUDIT 等），
    // 枚举不闭合 = 调度器收到未知指令。
    const COVERAGE_KIND = ['SLICE_UNCOVERED', 'FILE_UNREAD', 'DIMENSION_OMITTED', 'ENTRY_UNCOVERED'];
    const gaps = Array.isArray(p.coverage_gaps) ? p.coverage_gaps : [];
    gaps.forEach((g, i) => {
      if (g?.kind !== undefined && !COVERAGE_KIND.includes(g.kind)) {
        errors.push({
          field: `payload.coverage_gaps[${i}].kind`, rule: 'invalid_coverage_kind',
          msg: `coverage_gaps[${i}].kind 只能取 ${COVERAGE_KIND.join(' | ')}，实际是 "${g.kind}"`,
        });
      }
      // 契约 §2.3 表格：每条缺口都要有 gap_id / kind / target / evidence.observation /
      // potential_impact / recommended_action，缺任一即无法被主 Agent 机械消费。
      for (const k of ['kind', 'target', 'recommended_action']) {
        if (g && typeof g === 'object' && g[k] === undefined) {
          errors.push({
            field: `payload.coverage_gaps[${i}].${k}`, rule: 'incomplete_coverage_gap',
            msg: `coverage_gaps[${i}] 缺 ${k}——每条缺口必须可被主 Agent 机械消费成下一步动作`,
          });
        }
      }
    });

    // 2026-11-14：Devil's Advocate 的四个覆盖扫描布尔。
    // wave3-critique.md:493 原文：「`slice_scan_performed`、`file_scan_performed`、
    // `dimension_scan_performed`、`entry_scan_performed`，四者均为 `true`」。
    // 实测：这四者在全仓 tools/ 里**零命中**，DA 完全靠自述「我扫了」。
    // 而 DA 是锐评波里唯一负责覆盖完整性的角色——它有没有真扫是**二值可判**的，
    // 不需要设计判据，是本轮性价比最高的一条。
    if (p.critique_role === 'devils_advocate') {
      const SCANS = ['slice_scan_performed', 'file_scan_performed', 'dimension_scan_performed', 'entry_scan_performed'];
      for (const k of SCANS) {
        if (p[k] !== true) {
          errors.push({
            field: `payload.${k}`, rule: 'missing_scan_flag',
            msg: `devils_advocate 必须以 ${k}: true 声明四类覆盖扫描均执行（wave3-critique.md:493）。`
              + '四者缺一即无法证明真的扫过，等于把「有没有查」退回自述',
          });
        }
      }
    }

    // 契约 §2.3 原文（:490 / :503）：
    //   「仅 critique_role == "skeptic" 时必填。devils_advocate 与 arbiter 不得返回
    //     该字段（返回即越界，判 CONTRACT_VIOLATION）」
    //   「skeptic 缺失该字段 = 未完成职责，其全部 verdicts 作废」
    // 没这条校验时，我生成的 critique 示例（skeptic、无 discipline_audit）
    // 能通过校验器——于是示例成了「错误但被验证过的规范」。
    const hasDiscipline = p.discipline_audit !== undefined && p.discipline_audit !== null;
    if (p.critique_role === 'skeptic') {
      if (!hasDiscipline) {
        errors.push({
          field: 'payload.discipline_audit', rule: 'missing_discipline_audit',
          msg: 'skeptic 必填 discipline_audit（契约 §2.3）。缺失该字段 = 未完成职责，'
            + '其全部 verdicts 按契约作废——未申报的裁量只有被主动找出来才能发现',
        });
      } else if (typeof p.discipline_audit === 'object' && !Array.isArray(p.discipline_audit)) {
        // performed 是这条审计的核心开关：声称做了就必须有可核对的结构
        if (p.discipline_audit.performed === undefined) {
          errors.push({
            field: 'payload.discipline_audit.performed', rule: 'discipline_audit_no_performed',
            msg: 'discipline_audit 缺 performed。这一项决定「有没有真的查」——省略等于没申报',
          });
        }
      }
    } else if (['devils_advocate', 'arbiter'].includes(p.critique_role) && hasDiscipline) {
      errors.push({
        field: 'payload.discipline_audit', rule: 'discipline_audit_out_of_role',
        msg: `${p.critique_role} 不得返回 discipline_audit（契约 §2.3：返回即越界，判 CONTRACT_VIOLATION）`,
      });
    }

    // 2026-11-14：pattern_sweep 同样有角色分支（仅 devils_advocate + 存在
    // HIGH/CRITICAL 时必填，其他子角色返回即越界），此前也未校验。
    const hasSweep = p.pattern_sweep !== undefined && p.pattern_sweep !== null;
    if (hasSweep && p.critique_role !== 'devils_advocate') {
      errors.push({
        field: 'payload.pattern_sweep', rule: 'pattern_sweep_out_of_role',
        msg: `pattern_sweep 仅 devils_advocate 可用，${p.critique_role} 返回即越界（契约 §2.3）`,
      });
    }
    for (let i = 0; i < vs.length; i++) {
      const v = vs[i];
      const fid = v?.finding_id ?? `#${i}`;
      // five_step 必填且五步齐全（wave3-critique.md §2.1）
      if (p.critique_role === 'skeptic') {
        const fs2 = v?.five_step;
        if (!fs2 || typeof fs2 !== 'object') {
          errors.push({
            field: `payload.verdicts[${i}].five_step`, rule: 'missing_five_step',
            msg: `${fid} 缺 five_step——Skeptic 必须逐条执行五步测试，不允许用「整体看起来没问题」替代`,
          });
        } else {
          for (const k of ['evidence_opened', 'evidence_supports_claim', 'path_reachable', 'already_handled', 'failure_chain_holds']) {
            if (!(k in fs2)) {
              errors.push({
                field: `payload.verdicts[${i}].five_step.${k}`, rule: 'incomplete_five_step',
                msg: `${fid} 的五步测试缺第 ${k} 步`,
              });
            }
          }
        }
      }
      // sub_claims：裁决作用在子主张上（2026-11-10 新增）
      const subs = v?.sub_claims;
      // 强制：verdict=holds 但 reason 在否定原危害/后果 → 必须拆子主张
      // （不写就是「部分成立」被压成二元裁决，下游无法判断该不该降级）
      if (p.critique_role === 'skeptic' && v?.verdict === 'holds') {
        const reason = String(v?.reason ?? '');
        const deniesHarm = /后果|危害|影响方向|方向相反|方向说反|不至于|被夸大|高估|降级/.test(reason);
        if (deniesHarm && !(Array.isArray(subs) && subs.length > 0)) {
          errors.push({
            field: `payload.verdicts[${i}].sub_claims`, rule: 'missing_sub_claims',
            msg: `${fid} 的 reason 在否定原危害/后果（判为 holds 但说方向错了），却没拆 sub_claims。这种「机制对、后果错」必须逐条给结论，否则下游无法区分「全对」和「一半对」`,
          });
        }
      }
      if (Array.isArray(subs) && subs.length > 0) {
        const SUB_VALID = ['holds', 'refuted', 'untested'];
        let hasHold = false, hasRefute = false;
        subs.forEach((s, j) => {
          const sid = `${fid}.sub[${j}]`;
          if (!s?.claim || !s?.verdict) {
            errors.push({
              field: `payload.verdicts[${i}].sub_claims[${j}]`, rule: 'incomplete_sub_claim',
              msg: `${sid} 缺 claim 或 verdict——子主张必须可独立判定`,
            });
            return;
          }
          if (!SUB_VALID.includes(s.verdict)) {
            errors.push({
              field: `payload.verdicts[${i}].sub_claims[${j}].verdict`, rule: 'invalid_sub_verdict',
              msg: `${sid} 的 verdict 只能取 ${SUB_VALID.join(' | ')}，实际是 "${s.verdict}"——不要发明新枚举`,
            });
          }
          if (s.verdict === 'refuted' && !s.direct_contradiction && !s.reason) {
            errors.push({
              field: `payload.verdicts[${i}].sub_claims[${j}]`, rule: 'sub_refuted_without_basis',
              msg: `${sid} 判 refuted 但既没有 direct_contradiction 也没有 reason——空口反驳`,
            });
          }
          if (s.verdict === 'holds') hasHold = true;
          if (s.verdict === 'refuted') hasRefute = true;
        });
        // 机制对后果错时，reason 必须区分
        if (hasHold && hasRefute) {
          const reason = String(v?.reason ?? '');
          if (!/机制|后果|危害/.test(reason)) {
            errors.push({
              field: `payload.verdicts[${i}].reason`, rule: 'mixed_sub_claims_unexplained',
              msg: `${fid} 同时有 holds 和 refuted 子主张，但 reason 没说明哪类是机制、哪类是后果——下游无法判断该不该降级`,
            });
          }
        }
      }
      // verdict=refuted 时，五个「不可自信领域」必须有 direct_contradiction
      // refuted 但没给直接矛盾证据（2026-11-10 蓝队 A12）
      // 五个「不可自信领域」里，只有 concurrency 与 dimension 是一对一映射，
      // 所以那一个硬执行，其余保持警告（避免凭空造一张映射表）。
      if (v?.verdict === 'refuted' && !v?.direct_contradiction) {
        const dim = v?.dimension;
        if (dim === 'concurrency') {
          errors.push({
            field: `payload.verdicts[${i}].direct_contradiction`, rule: 'sensitive_refuted_without_contradiction',
            msg: `${fid} 属于 concurrency 领域且判 refuted，但没有 direct_contradiction。` +
                 `并发类缺陷最难判断，误杀代价最高——必须给出一行直接矛盾的代码`,
          });
        } else {
          warnings.push({
            field: `payload.verdicts[${i}].direct_contradiction`, rule: 'refuted_without_contradiction',
            msg: `${fid} 判 refuted 但没有 direct_contradiction。若该发现属于内存安全/并发/声明一致性/行为变更/未使用参数，按 §2.2 不得判 refuted`,
          });
        }
      }
      // runtime_evidence 的对照实验（2026-11-10 新增）
      const re2 = v?.runtime_evidence;
      // 先要求显式声明「这条发现是否涉及运行时可观察行为」——
      // 否则「该跑没跑」无法机械判定（契约层拿不到语义）
      if (p.critique_role === 'skeptic' && v?.runtime_applicable === undefined) {
        errors.push({
          field: `payload.verdicts[${i}].runtime_applicable`, rule: 'missing_runtime_applicable',
          msg: `${fid} 缺 runtime_applicable。你必须显式回答「这条发现是否涉及运行时可观察行为」——` +
               `不声明就无法判断你是否该跑一遍，而「该跑没跑」的 holds 是不可信的`,
        });
      }
      if (v?.runtime_applicable === true && (!re2 || !re2.method || re2.method === 'null')) {
        errors.push({
          field: `payload.verdicts[${i}].runtime_evidence`, rule: 'runtime_required_but_missing',
          msg: `${fid} 声明了 runtime_applicable=true 却没有 runtime_evidence——声明的运行时行为必须真跑一次`,
        });
      }
      if (re2 && typeof re2 === 'object' && re2.method && re2.method !== 'null') {
        if (!re2.control_case || String(re2.control_case).trim().length < 5) {
          warnings.push({
            field: `payload.verdicts[${i}].runtime_evidence.control_case`, rule: 'runtime_no_control',
            msg: `${fid} 给了 runtime_evidence 但没有 control_case——没有对照的实验不可采信（无法区分「真的没反应」和「探针失灵」）`,
          });
        }
        if (!re2.observed || String(re2.observed).trim().length < 3) {
          errors.push({
            field: `payload.verdicts[${i}].runtime_evidence.observed`, rule: 'runtime_no_output',
            msg: `${fid} 的 runtime_evidence 缺 observed 原始输出。「我跑过了」不构成证据`,
          });
        }
        // 2026-11-11 实测修正：main_path 从「必填」降级为「建议」。
        // 对照实验（3 组有规则 vs 3 组无规则）显示：强制要求「设计运行验证」
        // 会让 recall 下降 7.9 个点（70.6% vs 78.5%，Cohen's d=1.63）——
        // 多漏的全是「跑起来看不出、只有读代码才知道」的缺陷。
        // 唯一保留硬要求的是 control_case（没有对照无法区分缺陷与探针故障）。
        const mp = re2.main_path;
        if (!mp || typeof mp !== 'object') {
          warnings.push({
            field: `payload.verdicts[${i}].runtime_evidence.main_path`, rule: 'runtime_no_main_path',
            msg: `${fid} 的 runtime_evidence 没有 main_path（建议但非必需）。` +
                 `若跑过公开 API 主路径，请写出期望值 vs 实际值；没跑也接受，但不得声称已验证运行时行为`,
          });
        } else {
          if (!mp.expected || !mp.observed) {
            errors.push({
              field: `payload.verdicts[${i}].runtime_evidence.main_path`, rule: 'runtime_main_path_incomplete',
              msg: `${fid} 的 main_path 缺 expected 或 observed——没有「期望值 vs 实际值」就不构成验证`,
            });
          } else if (String(mp.expected).trim() === String(mp.observed).trim()) {
            warnings.push({
              field: `payload.verdicts[${i}].runtime_evidence.main_path`, rule: 'runtime_main_path_trivial',
              msg: `${fid} 的 main_path 期望值与实际值完全相同——这条运行验证没有区分力（是不是只跑了语法检查？）`,
            });
          }
        }
      }
    }
  }
  if (envelope.role === 'planner') {
    const sum = Object.values(p.score_breakdown ?? {}).reduce((a, b) => a + b, 0);
    if (typeof p.score === 'number' && sum > 0 && p.score !== sum) {
      errors.push({
        field: 'payload.score', rule: 'score_mismatch',
        msg: `score=${p.score} 但 breakdown 之和=${sum}`,
      });
    }
    if (typeof p.member_count === 'number' && Array.isArray(p.members)) {
      // 2026-11-14 修：契约 §2.0 的 members[] 结构是
      //     { agent_id, role, depends_on, note }        ← 逐 agent 列出，没有 count
      // 而 wrappers/planner.md §5 的结构是
      //     { role, count, scope, sees, must_not_see }  ← 按职能聚合，有 count
      // 校验器此前只认后者（reduce 求 count 之和），于是**严格照契约写必被拒**：
      // 一份完全按 §2.0 写的产物会得到 `member_count=2 但 members 展开数=0`。
      // 契约里的 schema 通不过自己的校验器 —— 这是最坏的一类缺陷。
      //
      // 两种表示法本身都合法：
      //   逐个列出 → 每个成员代表 1 个 agent（count 缺省为 1）
      //   按职能聚合 → 显式给 count
      // 所以校验器两种都认：有 count 用 count，没有就按 1 计。
      const msum = p.members.reduce(
        (a, x) => a + (typeof x?.count === 'number' ? x.count : 1), 0);
      if (p.member_count !== msum) {
        errors.push({
          field: 'payload.member_count', rule: 'count_mismatch',
          msg: `member_count=${p.member_count} 但 members 展开数=${msum}`
            + '（逐个列出时每项按 1 计，按职能聚合时按 count 计）',
        });
      }
      // 两种结构都必须能唯一确定「这个成员是谁」。逐个列出要有 agent_id；
      // 按职能聚合要有 role + scope。两者都没有时，下游无法从 members 复原面板。
      p.members.forEach((m, i) => {
        const hasId = typeof m?.agent_id === 'string' && m.agent_id.trim() !== '';
        const hasFunc = typeof m?.role === 'string' && m.role.trim() !== '';
        if (!hasId && !hasFunc) {
          errors.push({
            field: `payload.members[${i}]`, rule: 'member_unidentifiable',
            msg: `members[${i}] 既没有 agent_id 也没有 role——下游无法知道这个成员是谁`,
          });
        }
      });
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 4 · 验收角色：FAIL 时必须给出归因与可复现触发条件
// ────────────────────────────────────────────────────────────────────
// 2026-11-14 补：契约 §2.5 白纸黑字写了两条条件必填——
//   `failure_category`  `verdict: FAIL` 时必填（决定回波次四还是判 REVOKED）
//   `failure_trigger`   `verdict: FAIL` 时必填（可复现的触发条件）
// 但校验器此前**完全不检查**。实测一个 `verdict: "FAIL"`、没有任何归因的
// 产物被判「✅ 契约合规」——规则写在文档里，要求没有强制力。
//
// 为什么这两条重要：没有 `failure_category`，主Agent无法判断该重派（FIX_INCOMPLETE）
// 还是该撤稿（FIX_INCORRECT）；没有 `failure_trigger`，下一轮修复 Agent
// 只能盲猜复现路径，等于把验收结论退化成一句「没过」。
if (envelope && envelope.role === 'verify') {
  const vp = envelope.payload ?? {};
  // 2026-11-14 修：verdict 枚举此前完全不校验。契约 §2.5 写死闭集 PASS | FAIL。
  // 实测 `verdict: "fail"` 会让整段 FAIL 检查被跳过（因为 !== "FAIL"），
  // 而人类读到的是「验收没通过」——主 Agent 不进故障分支，人却以为失败了。
  // 同文件对 critique 的 verdicts[].verdict 有 invalid_verdict_enum，verify 却没有。
  if (vp.verdict !== undefined) {
    if (!['PASS', 'FAIL'].includes(vp.verdict)) {
      errors.push({
        field: 'payload.verdict', rule: 'invalid_verify_verdict',
        msg: `verdict 只能取 PASS | FAIL，实际是 ${JSON.stringify(vp.verdict)}。`
          + '大小写不符会让 FAIL 的必填检查被静默跳过',
      });
    }
  }
  if (vp.verdict === 'FAIL') {
    if (!vp.failure_category) {
      errors.push({
        field: 'payload.failure_category', rule: 'missing_failure_category',
        msg: 'verdict=FAIL 时必须给出 failure_category（FIX_INCOMPLETE / FIX_INCORRECT / '
          + 'BASELINE_INVALID / ENVIRONMENT）——主Agent靠它判断该重派还是该撤稿',
      });
    } else if (!['FIX_INCOMPLETE', 'FIX_INCORRECT', 'BASELINE_INVALID', 'ENVIRONMENT'].includes(vp.failure_category)) {
      errors.push({
        field: 'payload.failure_category', rule: 'invalid_failure_category',
        msg: `failure_category="${vp.failure_category}" 不在闭集内`
          + '（FIX_INCOMPLETE | FIX_INCORRECT | BASELINE_INVALID | ENVIRONMENT）',
      });
    }
    if (!vp.failure_trigger || String(vp.failure_trigger).trim() === '') {
      errors.push({
        field: 'payload.failure_trigger', rule: 'missing_failure_trigger',
        msg: 'verdict=FAIL 时必须给出可复现的触发条件——否则下一轮修复 Agent 只能盲猜复现路径',
      });
    }
  }
  // ENVIRONMENT 归因与 FAIL 状态自相矛盾：环境问题是可重试的，不该判 FAIL
  if (vp.failure_category === 'ENVIRONMENT' && vp.verdict === 'FAIL') {
    warnings.push({
      field: 'payload.failure_category', rule: 'environment_should_be_retryable',
      msg: 'failure_category=ENVIRONMENT 时应改用 RETRYABLE_FAILURE 顶层状态而非 FAIL'
        + '（契约 §2.5 明文）',
    });
  }
}

// ────────────────────────────────────────────────────────────────────
// 5 · 验收角色的变异检验 vs 只读身份
// ────────────────────────────────────────────────────────────────────
if (envelope && envelope.role === 'verify' && envelope.payload?.evidence?.mutation_check === 'performed') {
  // 变异检验要求改文件再改回来——验收 Agent 是只读角色（wrappers/verifier.md）
  warnings.push({
    field: 'payload.evidence.mutation_check',
    rule: 'mutation_check_vs_readonly',
    msg: '声称做了变异检验，但验收 Agent 是只读角色。确认它真的有写权限',
  });
}

// ────────────────────────────────────────────────────────────────────
// 输出
// ────────────────────────────────────────────────────────────────────
const result = {
  file,
  ok: errors.length === 0,
  role: envelope?.role ?? null,
  errors,
  warnings,
};

if (jsonOut) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`\n契约准入检查: ${file}\n`);
  if (envelope) console.log(`  role: ${envelope.role}   status: ${envelope.status}\n`);

  if (errors.length === 0) {
    console.log('  ✅ 契约合规\n');
  } else {
    console.log(`  ✗ ${errors.length} 项违规:\n`);
    for (const e of errors) {
      console.log(`    [${e.rule}] ${e.field}`);
      console.log(`      ${e.msg}`);
      if (e.fix) console.log(`      修法: ${e.fix}`);
    }
    console.log();
  }
  if (warnings.length) {
    console.log(`  ⚠️  ${warnings.length} 项警告:`);
    for (const w of warnings) console.log(`    [${w.rule}] ${w.msg}`);
    console.log();
  }
}

process.exit(errors.length > 0 ? 1 : 0);
