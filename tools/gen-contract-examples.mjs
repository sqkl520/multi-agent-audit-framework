#!/usr/bin/env node
/**
 * gen-contract-examples.mjs — 为每个角色生成一份「能通过校验器」的最小完整产物示例
 *
 * 为什么需要：
 *   实测发现契约里没有任何一份可抄的完整示例——
 *     §1 是信封骨架（role 写成 "recon | sweep | …" 枚举占位符）
 *     §2.x 是 payload 片段（没有信封层）
 *     §3 是错误对象（只在失败时出现）
 *   于是 agent 只能靠理解规则自己拼。拼错了要等 check-payload 报错才发现，
 *   而报错信息只说「缺字段」，不说「完整长什么样」。
 *
 *   这属于「三层闭环」之外的第 0 层：**示例必须是真的**。
 *   前三层（模板/契约/校验器）都对了，但没人给样例，学习成本全落在模型身上。
 *
 * 做法：按 ROLE_REQUIRED 和各角色的 payload 结构，生成最小合规产物，
 *       然后**立刻用校验器验证**——不通过就报错退出，绝不写出一份假示例。
 *
 * 输出：framework/components/output-contract/examples/<role>.md
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT_DIR = join(ROOT, 'framework', 'components', 'output-contract', 'examples');
const VALIDATOR = join(HERE, 'check-payload.mjs');

// ── 每个角色的最小合规 payload ──
// 这些不是「随便编的」，每份都要过 check-payload.mjs 才写出。
// 取值尽量贴近真实场景，让 agent 能直接看懂「这一项该填什么」。
const EXAMPLES = {
  planner: {
    tier: 'T2',
    score: 21,
    score_breakdown: { size: 5, risk: 6, dependency: 4, ambiguity: 3, churn: 3 },
    members: [
      { role: 'execute', provider: 'inherit', model: 'inherit', count: 6, reason: '六个切片并行宽扫' },
      { role: 'critique', provider: 'inherit', model: 'inherit', count: 3, reason: '三视角独立锐评' },
    ],
    member_count: 9,
  },
  recon: {
    slice_count: 2,
    audit_slices: [
      {
        slice_id: 'S1', files: ['src/store.js'], reachability_hint: 'PROD',
        entry_point: 'src/store.js:12 Store.set', risk_note: '状态写入路径，改动影响面大',
      },
      {
        slice_id: 'S2', files: ['src/render.js'], reachability_hint: 'PROD',
        entry_point: 'src/render.js:8 render', risk_note: '模板渲染，用户可见输出',
      },
    ],
    entry_points: [
      {
        path: 'src/store.js:12',
        location: 'src/store.js:12',
        kind: 'public-api',
        evidence: 'export function set(value) {',
        evidence_quote: 'export function set(value) {',
      },
    ],
    unverified: [],
  },
  sweep: {
    slice_id: 'S1',
    reachability: 'PROD',
    files_read: [
      { path: 'src/store.js', lines: 120, quote: 'this.#persist(value);' },
    ],
    leads: [
      {
        id: 'L1', file: 'src/store.js', line: 57, confidence: 'HIGH',
        suspected_dimension: 'error-handling',
        note: '持久化失败时未捕获异常，调用方无从得知写入失败',
      },
    ],
    lead_count: 1,
    dimension_histogram: { 'error-handling': 1 },
  },
  audit: {
    findings: [
      {
        finding_id: 'F1',
        severity: 'HIGH',
        dimension: 'error-handling',
        // 契约 §2.2：evidence 是**对象**，不是数组
        evidence: {
          file: 'src/store.js',
          line: 57,
          quote: 'renameSync(tmp, this.#path);',
        },
        // 契约 §2.2：inference 是**对象** {claim, basis, alternatives}，不是字符串
        inference: {
          claim: '持久化失败被静默吞掉，调用方拿不到失败信号',
          basis: 'renameSync 在跨设备或权限不足时抛异常，而 set() 没有任何 try/catch，'
            + '异常直接冒到调用方；但调用方按返回值判断成功与否。',
          // HIGH/CRITICAL 要求至少两个可检查的替代解释
          alternatives: [
            '如果应用层在调用链上游统一捕获了异常并转成返回值，则问题不成立——'
              + '需检查 src/api.js:30 saveHandler 的 try/catch 覆盖范围',
            '如果 renameSync 的失败已被 node:fs 的默认行为静默处理，则不会抛异常——'
              + '需在只读目录实测一次',
          ],
        },
        status: 'CONFIRMED',
      },
    ],
    self_checks: {
      identifier_reconcile: {
        status: 'DONE',
        note: '文件中 7 个标识符全部能在源码里找到定义；`renameSync` 的导入缺失已单列为一条发现',
      },
      self_check_audit: {
        status: 'DONE',
        note: '用 3 个用例跑过自检脚本，未发现自身误报',
      },
      runtime_validation: {
        status: 'DONE',
        note: '在只读目录下调用 set()，观察到 EACCES 未被捕获，证实发现成立',
      },
    },
  },
  critique: {
    critique_role: 'skeptic',
    // 契约 §2.3：skeptic 必填。缺失 = 未完成职责，全部 verdicts 作废。
    discipline_audit: {
      performed: true,
      log_entries_checked: 3,
      dispatch_records_checked: 2,
      undeclared_discretions: [],
      mechanical_check_failures: [],
      l0_violations: [],
    },
    verdicts: [
      {
        finding_id: 'F1',
        verdict: 'holds',
        reason: '独立复现：把文件设为只读后调用 set()，异常确实冒到调用方且无人处理。',
        five_step: {
          evidence_opened: true,
          evidence_supports_claim: true,
          path_reachable: 'true',
          already_handled: 'false',
          failure_chain_holds: true,
        },
        runtime_applicable: true,
        runtime_evidence: {
          method: 'adversarial_execution',
          control_case: '同一段代码在可写目录下调用 set()，写入成功且无异常——证明刚才的失败不是探针本身坏了',
          observed: '在只读目录下调用 set()，EACCES 直接抛出且无任何捕获',
          command: 'chmod 555 /tmp/x && node -e "require(\'./src/store.js\').set(1)"',
        },
        direct_contradiction: null,
      },
    ],
  },
  fix: {
    files_touched: [
      { path: 'src/store.js', lines_added: 6, lines_removed: 1 },
    ],
    verification_commands: [
      { command: 'node -e "require(\'./src/store.js\')"', exit_code: 0 },
    ],
    affected_issues: ['F1'],
    residual_risks: ['未覆盖网络文件系统场景'],
  },
  verify: {
    finding_id: 'F1',
    verdict: 'PASS',
    escalation_required: false,
    evidence: {
      method: 'mutating_call_site',
      mutation_scope: 'implementation_only',
      observed: '把 renameSync 改回旧行为后，定向测试变红；恢复修复后变绿。',
    },
    notes: '修复有效，且只在实现层回退即可复现，说明修复点正确。',
  },
};

mkdirSync(OUT_DIR, { recursive: true });

const tmp = mkdtempSync(join(tmpdir(), 'cx-gen-'));
const built = [];
const failures = [];

for (const [role, payload] of Object.entries(EXAMPLES)) {
  // ── artifact_path 的处理 ──
  // 校验器要求 SUCCESS 时 artifact_path 指向的文件**真实存在**（`artifact_not_found`）。
  // 这带来一个先有鸡还是先有蛋的问题：示例文件的内容里要写 artifact_path，
  // 而 artifact_path 指向的就是这个还没写出来的文件。
  // 解法：先往目标位置写一个占位文件，验证通过后再用真实内容覆盖它。
  const target = join(OUT_DIR, `${role}.md`);
  if (!existsSync(target)) writeFileSync(target, '<!-- placeholder -->\n');

  const envelope = {
    schema_version: 'output-contract-v1',
    agent_id: `${role}-1`,
    role,
    status: 'SUCCESS',
    contract_valid: true,
    // artifact_path 用 `<OUTDIR>` 占位——这是 protocol.md 约定了语义的写法，
    // 指向「审计输出目录」而不是本仓库。
    //
    // 为什么不写仓库内的相对路径：校验器按 **cwd** 解析相对路径，
    // 从 tools/ 目录跑就找不到文件，示例会时灵时不灵。
    // 也不能写绝对路径——换一台机器就失效。
    // 所以这里用约定占位，并用 --no-exists 校验格式（存在性由调用方的实际产物保证）。
    artifact_path: '<OUTDIR>/round1-02-audit-S1-logic.md',
    payload,
    error: null,
  };

  const json = JSON.stringify(envelope, null, 2);

  // ── 立刻验证：不通过就不写 ──
  const probe = join(tmp, `${role}.md`);
  writeFileSync(probe, `# ${role} 示例\n\n\`\`\`json\n${json}\n\`\`\`\n`);

  let code = 0;
  let out = '';
  try {
    // --no-exists: 示例里的 artifact_path 是 <OUTDIR> 占位，不可能存在于本仓库。
    // 存在性这道检查留给真实产物，示例只验证「格式与必填字段是否正确」。
    out = execFileSync(process.execPath, [VALIDATOR, probe, '--role', role, '--no-exists'],
      { encoding: 'utf8' });
  } catch (e) {
    code = e.status ?? 1;
    out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
  }

  if (code !== 0) {
    failures.push({ role, out: out.trim().slice(0, 500) });
    continue;
  }

  built.push({ role, json });
}

rmSync(tmp, { recursive: true, force: true });

if (failures.length > 0) {
  console.error('这些角色的示例没能通过校验，**不写出**（写出假示例比没有示例更糟）：\n');
  for (const f of failures) {
    console.error(`=== ${f.role} ===`);
    console.error(f.out);
    console.error('');
  }
  process.exit(1);
}

for (const { role, json } of built) {
  const body = `<!--
  自动生成，请勿手改。生成器：tools/gen-contract-examples.mjs
  这份示例**已经过 check-payload.mjs 验证**，可以直接照抄再改。
-->

# ${role} 角色的最小合规产物

这是能通过校验的最小完整信封。字段含义见 \`components/output-contract/${role}.md\`。
**照抄这份再替换内容**，比从零拼要可靠。

\`\`\`json
${json}
\`\`\`

## 自检

写完产物后运行：

\`\`\`bash
node <FRAMEWORK_ROOT>/tools/check-payload.mjs <你的产物文件> --role ${role}
\`\`\`
`;

  writeFileSync(join(OUT_DIR, `${role}.md`), body);
  console.log(`${role.padEnd(10)} ✓ 已生成并验证`);
}

console.log(`\n共 ${built.length} 份示例，全部通过 check-payload.mjs。输出目录: ${OUT_DIR}`);
