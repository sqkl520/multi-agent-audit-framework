#!/usr/bin/env node
/**
 * check-wrapper-integrity.mjs — 检查每个 wrapper 是否「完整」，而不只是「合规」
 *
 * 为什么需要（2026-11-12 事故）：
 *   我用 `git checkout` 回退误操作，把 5 个 wrapper 退回到旧版本。
 *   恢复 §3/§4 之后，lint 报 0 FAIL —— 但 audit-specialist 从 104 行掉到 72 行，
 *   **丢了整整 32 行真实内容，而所有检查器都没报**。
 *
 *   根因：L11 查的是「有没有出现『产物格式（硬要求）』这几个字」，
 *   字符串在就算过。**它无法区分「一节写完整了」和「只剩一个标题」。**
 *
 * 这个脚本查三件 lint 查不到的事：
 *   1. 必备小节齐全（顺序也对）
 *   2. 每节**非空**（只有标题没有正文 = 这次的典型形态）
 *   3. 关键段落存在（Write 权限说明、实例唯一性等）
 *
 * 用法：node check-wrapper-integrity.mjs [--json] [--baseline <json>]
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const FW = join(HERE, '..', 'framework');
const WRAP = join(FW, 'wrappers');

const jsonOut = process.argv.includes('--json');
const bi = process.argv.indexOf('--baseline');
const baselinePath = bi >= 0 ? process.argv[bi + 1] : null;

const findings = [];
const add = (level, file, msg) => findings.push({ level, file, msg });

// 每个 wrapper 都必须有这五节，顺序固定
// minBody 是「非空」的下限，不是「够详细」的标准——
// planner 的强制加载只有 1 个文件（它确实只需要 triage.md），
// 所以这里给 40 而不是 80。阈值定太高会把正确的短节判成骨架。
const REQUIRED_SECTIONS = [
  { re: /^## ?1\. ?身份声明/m, name: '身份声明', minBody: 80 },
  { re: /^## ?2\. ?触发条件/m, name: '触发条件', minBody: 120 },
  { re: /^## ?3\. ?强制加载/m, name: '强制加载', minBody: 40 },
  { re: /^## ?4\. ?产物格式（硬要求）/m, name: '产物格式（硬要求）', minBody: 150 },
  { re: /^## ?5\. ?返回要求/m, name: '返回要求', minBody: 60 },
];

// 关键段落：有这些才说明这一节是写完整的，不是骨架
const KEY_PASSAGES = [
  { re: /`Write`/, name: 'Write 权限说明', required: false },
  { re: /check-payload\.mjs/, name: '自检工具引用', required: true },
  { re: /json 代码块结尾/, name: 'JSON 信封要求', required: true },
  { re: /report-naming\.md/, name: '产物命名引用', required: false },
];

const files = readdirSync(WRAP).filter((f) => f.endsWith('.md'));

const results = [];

for (const f of files) {
  const raw = readFileSync(join(WRAP, f), 'utf8');
  const lines = raw.split('\n');
  const name = basename(f, '.md');

  // 按二级标题切节
  const sections = [];
  let cur = null;
  for (const l of lines) {
    if (/^## ?\d+\./.test(l) || /^## \d+\./.test(l)) {
      if (cur) sections.push(cur);
      cur = { title: l.trim(), body: [] };
    } else if (cur) {
      cur.body.push(l);
    }
  }
  if (cur) sections.push(cur);

  const issues = [];

  // 1. 必备小节
  for (const req of REQUIRED_SECTIONS) {
    const sec = sections.find((s) => req.re.test(s.title));
    if (!sec) {
      issues.push(`缺小节「${req.name}」`);
      continue;
    }
    // 2. 非空判据：去掉空行后的正文长度
    const body = sec.body.join('\n').trim();
    if (body.length < req.minBody) {
      issues.push(`小节「${req.name}」正文只有 ${body.length} 字符（应 ≥ ${req.minBody}）——可能是只剩标题的骨架`);
    }
  }

  // 3. 关键段落
  for (const kp of KEY_PASSAGES) {
    if (kp.required && !kp.re.test(raw)) {
      issues.push(`缺关键段落「${kp.name}」`);
    }
  }

  // 4. tools 字段
  const toolsM = raw.match(/^tools:\s*(.+)$/m);
  if (!toolsM) {
    issues.push('缺 tools 字段');
  } else if (!/Write/.test(toolsM[1])) {
    issues.push(`tools 不含 Write（当前：${toolsM[1].trim()}）——产物写不出来`);
  }

  // 5. 交叉引用的文件必须存在
  for (const m of raw.matchAll(/`(components|templates|orchestrator|artifacts)\/([a-z0-9-]+\.md)`/g)) {
    const p = join(FW, m[1], m[2]);
    if (!existsSync(p)) issues.push(`引用了不存在的文件 ${m[1]}/${m[2]}`);
  }

  results.push({ name, lines: lines.length, issues });

  for (const i of issues) add('FAIL', `wrappers/${f}`, i);
}

// ── 行数基线对比（若提供）──
if (baselinePath && existsSync(baselinePath)) {
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
  for (const r of results) {
    const base = baseline[r.name];
    if (typeof base === 'number' && r.lines < base * 0.9) {
      const pct = ((1 - r.lines / base) * 100).toFixed(0);
      // 必须同时写进 r.issues，否则表格按 r.issues 画 ✓、合计按 findings 数问题，
      // 同一份输出会自相矛盾（2026-11-13 实测：表格全 ✓ 却报「5 项问题」）。
      add('FAIL', `wrappers/${r.name}.md`,
        `行数 ${r.lines} 比基线 ${base} 少了 ${pct}%——疑似内容丢失`);
      r.issues.push(`行数 ${r.lines} < 基线 ${base}（少 ${pct}%）`);
    }
  }
}

if (jsonOut) {
  console.log(JSON.stringify({ results, findings }, null, 2));
  process.exit(findings.length ? 1 : 0);
}

console.log('\n=== Wrapper 完整性检查 ===\n');
console.log('文件                         行数   问题');
for (const r of results) {
  const mark = r.issues.length ? '✗' : '✓';
  console.log(`${mark} ${r.name.padEnd(26)} ${String(r.lines).padStart(4)}   ${r.issues.length ? r.issues.length + ' 项' : '—'}`);
  for (const i of r.issues) console.log(`      · ${i}`);
}

const fails = findings.filter((f) => f.level === 'FAIL').length;
console.log(`\n合计: ${fails} 项问题 / ${results.length} 个文件\n`);
process.exit(fails ? 1 : 0);
