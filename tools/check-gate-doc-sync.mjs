#!/usr/bin/env node
/**
 * check-gate-doc-sync.mjs — `gate.mjs` 实际要的参数 vs `protocol.md` 示例里写的参数
 *
 * 为什么需要（2026-11-20）：
 *   刚给 close 门加了两个强制检查，参数从 2 个变成 5 个，但 `protocol.md` §1.8.1
 *   的调用示例没跟着改。于是**照文档跑必然被拒**——这正是
 *   `components/output-contract/audit.md:180` 记过的形态：
 *   「校验器比契约严，结果是子 Agent 照契约写会被判违规」。
 *
 *   那次是靠人发现的。这类漂移只要工具改一次参数就会重演一次，必须机械化。
 *
 * ── 判据 ────────────────────────────────────────────────────────────
 *   对每道门：
 *     1. 从 `gate.mjs` 里读出该分支实际 `getArg('--x')` 到的参数，且**该参数为
 *        必需**（缺失时走 `add(..., false, '未提供 ...')` 的失败分支）。
 *     2. 从 `protocol.md` 的 bash 代码块里读出该门的示例命令。
 *     3. 示例里缺任何一个必需参数 → FAIL。
 *     4. 示例里出现工具根本不认的参数 → FAIL（照抄会 exit 2）。
 *
 *   反向（工具认但文档没写的可选参数）只报 WARN，因为可选参数不写也能跑通。
 *
 * 用法：node check-gate-doc-sync.mjs [--json]
 * 退出码：0 一致 / 1 有漂移 / 2 解析失败（gate.mjs 或 protocol.md 结构变了）
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const GATE = join(HERE, 'gate.mjs');
const PROTO = join(ROOT, 'framework', 'orchestrator', 'protocol.md');
const jsonOut = process.argv.includes('--json');

const gateSrc = readFileSync(GATE, 'utf8');
const protoSrc = readFileSync(PROTO, 'utf8');

// ── 1 · 从 gate.mjs 抽每道门的必需参数 ──
//
// 做法：按 `if (gate === 'x')` 切段，段内找 `getArg('--y')`，
// 以及紧跟其后 `} else { add(..., false, '未提供 --y ...') }` 的模式。
// 只要该参数出现在某个 add(..., false, ...) 的失败信息里，就认为它必需。
const GATE_BLOCK = /if \(gate === '(\w+)'\) \{([\s\S]*?)\n\}/g;
const toolGates = new Map();   // gate -> { required: Set, optional: Set }

for (const m of gateSrc.matchAll(GATE_BLOCK)) {
  const [, name, body] = m;
  const all = new Set();
  for (const a of body.matchAll(/getArg\('(--[\w-]+)'\)/g)) all.add(a[1]);

  // 必需：出现在「未提供 --x」这类失败信息里
  const required = new Set();
  for (const a of all) {
    const bare = a.replace(/^--/, '');
    // 失败分支的写法有两种：'未提供 --x' 与 '未提供 --x / --y'
    const re = new RegExp(`add\\([^,]+,\\s*false,\\s*['"\`][^'"\`]*--${bare.replace(/[-]/g, '\\-')}[^'"\`]*['"\`]`);
    if (re.test(body)) required.add(a);
  }
  toolGates.set(name, { required, optional: new Set([...all].filter((x) => !required.has(x))) });
}

if (toolGates.size === 0) {
  console.error('[预期失败] 没能从 gate.mjs 解析出任何 `if (gate === ...)` 分支——结构可能变了');
  process.exit(2);
}

// ── 2 · 从 protocol.md 抽每道门的示例命令 ──
const docGates = new Map();   // gate -> Set(args)
// 匹配 ```bash ... ``` 块里的 `node tools/gate.mjs ... --gate <name> ...`
// 支持反斜杠续行。
for (const block of protoSrc.matchAll(/```bash\n([\s\S]*?)```/g)) {
  const text = block[1].replace(/\\\n\s*/g, ' ');
  for (const line of text.split('\n')) {
    if (!/gate\.mjs/.test(line)) continue;
    const gm = line.match(/--gate\s+(\w+)/);
    if (!gm) continue;
    const args = new Set();
    for (const a of line.matchAll(/(--[\w-]+)(?=[\s]|$)/g)) args.add(a[1]);
    args.delete('--gate');
    if (!docGates.has(gm[1])) docGates.set(gm[1], new Set());
    for (const a of args) docGates.get(gm[1]).add(a);
  }
}

if (docGates.size === 0) {
  console.error('[预期失败] 没能在 protocol.md 里找到任何 `gate.mjs --gate ...` 示例——文档结构可能变了');
  process.exit(2);
}

// ── 3 · 对账 ──
const problems = [];
const warnings = [];

for (const [name, { required, optional }] of toolGates) {
  const documented = docGates.get(name);
  if (!documented) {
    problems.push({ gate: name, kind: 'gate_undocumented',
      detail: `gate.mjs 有 --gate ${name}，但 protocol.md 里没有任何示例命令` });
    continue;
  }
  for (const req of required) {
    if (!documented.has(req)) {
      problems.push({ gate: name, kind: 'missing_required_arg_in_doc', arg: req,
        detail: `--gate ${name} 的示例命令里缺 ${req}，而工具缺它会判 FAIL。`
          + '**照文档跑必然被拒**——这就是「校验器比契约严」' });
    }
  }
  for (const d of documented) {
    if (!required.has(d) && !optional.has(d) && !['--json', '--help', '-h'].includes(d)) {
      problems.push({ gate: name, kind: 'unknown_arg_in_doc', arg: d,
        detail: `--gate ${name} 的示例里用了 ${d}，但 gate.mjs 不认这个参数（照抄会 exit 2）` });
    }
  }
  for (const opt of optional) {
    if (!documented.has(opt)) {
      warnings.push({ gate: name, kind: 'optional_arg_not_documented', arg: opt,
        detail: `--gate ${name} 支持可选参数 ${opt}，文档示例没提（可选，不写也能跑通）` });
    }
  }
}

for (const name of docGates.keys()) {
  if (!toolGates.has(name)) {
    problems.push({ gate: name, kind: 'documented_gate_not_in_tool',
      detail: `protocol.md 写了 --gate ${name}，但 gate.mjs 里没有这个分支` });
  }
}

const ok = problems.length === 0;
if (jsonOut) {
  console.log(JSON.stringify({ ok, gates: [...toolGates.keys()], problems, warnings }, null, 2));
  process.exit(ok ? 0 : 1);
}

console.log('\n门禁文档同步检查（gate.mjs 参数 vs protocol.md 示例）\n');
for (const [name, { required }] of toolGates) {
  console.log(`  --gate ${name.padEnd(10)} 必需参数: ${[...required].join(' ') || '(无)'}`);
}
console.log('');
if (problems.length === 0) {
  console.log('  ✓ 文档示例与工具要求一致');
} else {
  console.log(`  ✗ ${problems.length} 处漂移：`);
  for (const p of problems) console.log(`    [${p.kind}] ${p.gate}${p.arg ? ' ' + p.arg : ''}\n      ${p.detail}`);
}
if (warnings.length > 0) {
  console.log(`\n  ! ${warnings.length} 条提示（不影响判定）：`);
  for (const w of warnings) console.log(`    [${w.kind}] ${w.gate} ${w.arg ?? ''}`);
}
console.log('');
process.exit(ok ? 0 : 1);
