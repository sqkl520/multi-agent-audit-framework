#!/usr/bin/env node
/**
 * detect-harness.mjs — 探测运行环境，输出并发/超时/能力的实际值
 *
 * 为什么需要它：2026-11-09 核实发现，不同 harness 的并发上限差异极大
 *    - Claude Code workflow 默认 16（受 CPU 影响，可调 1–256）
 *    - Claude Code subagent 默认 20
 *    - 纯 subagent harness 可能只有 4
 * 写死任何一个数字都会在别的环境里出错。
 *
 * 设计原则：**探测不到就标 unknown，绝不猜。**
 *
 * 用法：node detect-harness.mjs [--json]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsonOut = process.argv.includes('--json');
const HERE = dirname(fileURLToPath(import.meta.url));

const result = {
  probed_at: new Date().toISOString(),
  os: { platform: platform(), release: release(), cpu_count: cpus().length },
  harness: { name: 'unknown', version: null, evidence: [] },
  workflow: { available: 'unknown', min_version: '2.1.150', evidence: [] },
  concurrency: {
    workflow_max: { value: null, source: 'unknown' },
    subagent_max: { value: null, source: 'unknown' },
    recommended: null,
    basis: null,
  },
  stall: { timeout_ms: { value: null, source: 'unknown' }, harness_retries: 'unknown' },
  warnings: [],
};

// ────────────────────────────────────────────────────────────────────
// 1. 探测是否为 Claude Code
// ────────────────────────────────────────────────────────────────────
function detectClaudeCode() {
  // a) 环境变量
  const envHints = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDECODE', 'CLAUDE_CODE_VERSION'];
  for (const k of envHints) {
    if (process.env[k]) {
      result.harness.evidence.push(`env ${k}=${process.env[k]}`);
    }
  }

  // b) 可执行文件名（父进程链里是否有 claude）
  let exe = null;
  try {
    if (platform() === 'win32') {
      exe = execFileSync('powershell', ['-NoProfile', '-Command',
        "(Get-CimInstance Win32_Process -Filter \"Name='claude.exe'\" | Select-Object -First 1).Name"],
        { encoding: 'utf8', timeout: 8000 }).trim();
    } else {
      exe = execFileSync('sh', ['-c', 'ps -o comm= -p $PPID 2>/dev/null || true'],
        { encoding: 'utf8', timeout: 8000 }).trim();
    }
  } catch { /* 探测失败不致命 */ }

  if (exe && /claude/i.test(exe)) {
    result.harness.name = 'claude-code';
    result.harness.evidence.push(`process: ${exe}`);
  }

  // c) 版本
  try {
    const v = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 10000 }).trim();
    if (v) {
      result.harness.name = result.harness.name === 'unknown' ? 'claude-code' : result.harness.name;
      result.harness.version = v;
      result.harness.evidence.push(`claude --version → ${v}`);
    }
  } catch {
    result.harness.evidence.push('claude --version → 不可用');
  }
}

// ────────────────────────────────────────────────────────────────────
// 2. 判断 Workflow 是否可用（版本 ≥ 2.1.150）
// ────────────────────────────────────────────────────────────────────
function detectWorkflow() {
  const v = result.harness.version;
  if (!v) {
    result.workflow.evidence.push('无版本号，无法判断');
    return;
  }
  const m = v.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) { result.workflow.evidence.push(`版本号格式不识别: ${v}`); return; }

  const [_, maj, min, pat] = m.map(Number);
  // 语义化版本比较：(major, minor, patch) 逐级比。
  // 之前写成 (maj-a)*1e6 + (min-b)*1e3 + (pat-c) 是错的——
  // minor 的权重必须大于 patch 的可能范围，而 1e3 不够（patch 可能 >999 天知道）。
  // 改成逐级比较，无歧义。
  const cmpTo = (a, b, c) => {
    if (maj !== a) return maj - a;
    if (min !== b) return min - b;
    return pat - c;
  };

  // 官方：Workflow 随 v2.1.150 起发布（research preview）。
  // 版本号形如 MAJOR.MINOR.PATCH，所以阈值是 major=2, minor=1, patch=150。
  // （此前误传成 (2,150,0)，把 150 当成了 minor——导致 2.1.289 被误判为更低。）
  if (cmpTo(2, 1, 150) >= 0) {
    result.workflow.available = 'likely';
    result.workflow.evidence.push(`版本 ${maj}.${min}.${pat} ≥ 2.1.150（research preview 起始）`);
  } else {
    result.workflow.available = 'unavailable';
    result.workflow.evidence.push(`版本 ${maj}.${min}.${pat} < 2.1.150`);
  }
}

// ────────────────────────────────────────────────────────────────────
// 3. 并发上限
// ────────────────────────────────────────────────────────────────────
function detectConcurrency() {
  const cpus_n = cpus().length;

  // workflow 并发
  const wfEnv = process.env.CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS;
  if (wfEnv && /^\d+$/.test(wfEnv)) {
    result.concurrency.workflow_max = { value: Number(wfEnv), source: 'env CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS' };
  } else if (result.workflow.available === 'likely') {
    result.concurrency.workflow_max = {
      value: 16,
      source: '官方文档默认值 16（受 CPU 影响，实际可能更低）',
    };
    if (cpus_n < 16) {
      result.warnings.push(`CPU 只有 ${cpus_n} 核，官方说明默认并发会随 CPU 下调，实际可能 < 16`);
    }
  }

  // subagent 并发
  const saEnv = process.env.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS;
  if (saEnv && /^\d+$/.test(saEnv)) {
    result.concurrency.subagent_max = { value: Number(saEnv), source: 'env CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS' };
  } else if (result.harness.name === 'claude-code') {
    result.concurrency.subagent_max = { value: 20, source: '官方文档默认值 20' };
  }

  // 推荐值：取可用的最小值，保守
  const candidates = [result.concurrency.workflow_max.value, result.concurrency.subagent_max.value].filter((x) => typeof x === 'number');
  if (candidates.length > 0) {
    result.concurrency.recommended = Math.min(...candidates);
    result.concurrency.basis = `min(可用值) = ${result.concurrency.recommended}`;
  } else {
    result.concurrency.recommended = 4;
    result.concurrency.basis = '未能探测到任何上限，使用保守默认 4';
    result.warnings.push('未能探测并发上限，建议用户告知或用默认值 4 起步');
  }
}

// ────────────────────────────────────────────────────────────────────
// 4. stall 超时
// ────────────────────────────────────────────────────────────────────
function detectStall() {
  const env = process.env.CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS;
  if (env && /^\d+$/.test(env)) {
    result.stall.timeout_ms = { value: Number(env), source: 'env CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS' };
  } else if (result.harness.name === 'claude-code') {
    result.stall.timeout_ms = { value: null, source: '未设置，使用 harness 内部默认' };
    result.stall.harness_retries = '5（官方文档：stall retry 最多重启 5 次）';
  } else {
    result.stall.timeout_ms = { value: null, source: 'unknown' };
    result.stall.harness_retries = 'unknown';
  }
}

// ────────────────────────────────────────────────────────────────────
// 5. 关键警告：不要发明自己的超时
// ────────────────────────────────────────────────────────────────────
function finalWarnings() {
  if (result.harness.name === 'claude-code' && result.workflow.available === 'likely') {
    result.warnings.push(
      '本环境支持 Workflow。按 protocol.md §0.0.1，编排应交给 harness，' +
      '只保留判断层（审什么/证据标准/锐评/交付物）'
    );
  } else if (result.harness.name === 'claude-code') {
    result.warnings.push(
      '是 Claude Code 但版本 < 2.1.150，Workflow 不可用。' +
      '回退到 Markdown 编排（protocol.md §3 + scale-mapping.md）'
    );
  } else {
    result.warnings.push(
      '未识别为 Claude Code。使用完整 Markdown 编排层。' +
      '**不要写死并发与超时**——先问用户实际值'
    );
  }
}

// ────────────────────────────────────────────────────────────────────
detectClaudeCode();
detectWorkflow();
detectConcurrency();
detectStall();
finalWarnings();

// ────────────────────────────────────────────────────────────────────
// 输出
// ────────────────────────────────────────────────────────────────────
if (jsonOut) {
  console.log(JSON.stringify(result, null, 2));
} else {
  const line = (k, v) => console.log(`  ${String(k).padEnd(22)} ${v}`);

  console.log('\n═══ 环境探测 ═══\n');
  line('OS', `${result.os.platform} (${result.os.release}), ${result.os.cpu_count} 核`);
  line('harness', result.harness.name + (result.harness.version ? ` (${result.harness.version})` : ''));
  line('Workflow 可用', result.workflow.available);

  console.log('\n  并发上限:');
  line('  workflow', result.concurrency.workflow_max.value === null
    ? 'unknown' : `${result.concurrency.workflow_max.value}  ← ${result.concurrency.workflow_max.source}`);
  line('  subagent', result.concurrency.subagent_max.value === null
    ? 'unknown' : `${result.concurrency.subagent_max.value}  ← ${result.concurrency.subagent_max.source}`);
  line('  建议使用', `${result.concurrency.recommended}  (${result.concurrency.basis})`);

  console.log('\n  超时:');
  line('  stall', result.stall.timeout_ms.value === null
    ? result.stall.timeout_ms.source : `${result.stall.timeout_ms.value}ms`);
  line('  harness 重试', result.stall.harness_retries);

  if (result.harness.evidence.length) {
    console.log('\n  证据:');
    for (const e of result.harness.evidence) console.log(`    · ${e}`);
  }

  if (result.warnings.length) {
    console.log('\n  ⚠️  警告:');
    for (const w of result.warnings) console.log(`    · ${w}`);
  }

  console.log('\n  ────────────────────────────────────');
  console.log('  探测不到的值标 unknown，**不要猜**。');
  console.log('  先问用户，再测，最后才假设。\n');
}

process.exit(0);
