#!/usr/bin/env node
/**
 * check-contract-examples.mjs — 契约里的 JSON 示例，本身能不能通过校验器？
 *
 * 为什么需要：
 *   wrapper 里写着「你的产物必须以 json 信封结尾，用 check-payload.mjs --role X 校验」。
 *   agent 最自然的做法是**照抄契约里的示例**再改。如果示例本身就通不过校验器，
 *   那么「照做反而失败」——agent 会陷入「我按文档写的却被拒」的困境，
 *   而且没有任何提示告诉他文档是错的。
 *
 *   这是「三层闭环」之外的第 0 层：**示例必须是真的**。
 *   示例错了，前面三层写得再对也没用，因为大家是照着示例学的。
 *
 * 做法：从每个角色切片里抽出所有 ```json 块，凡看起来像完整信封的
 * （含 schema_version / role / payload），就喂给 check-payload.mjs。
 *
 * 用法：node check-contract-examples.mjs [--json]
 * 退出码：0 = 全部示例通过   1 = 有示例通不过   2 = 结构异常
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SLICE_DIR = join(ROOT, 'framework', 'components', 'output-contract');
const EXAMPLE_DIR = join(SLICE_DIR, 'examples');
const VALIDATOR = join(HERE, 'check-payload.mjs');

const jsonOut = process.argv.includes('--json');

if (!existsSync(SLICE_DIR)) {
  console.error(`切片目录不存在: ${SLICE_DIR}——先跑 node tools/gen-contract-slices.mjs`);
  process.exit(2);
}

/** 抽出一个文件里所有 ```json 块 */
function jsonBlocks(text) {
  const out = [];
  const re = /```json\s*\n([\s\S]*?)```/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const body = m[1];
    // 行号：块起始符所在行
    const lineNo = text.slice(0, m.index).split('\n').length;
    out.push({ body, lineNo });
  }
  return out;
}

/**
 * 这段文本看起来是不是一个**可校验的真示例**（而不是骨架模板）？
 *
 * 第一个版本只看有没有 "payload"，结果把 §1 的骨架模板也当真示例了：
 *   { "agent_id": "string", "role": "recon | sweep | …", "payload": { } }
 * 那是**枚举占位符**，永远不可能通过校验——它是给人看结构的，不是给人抄的。
 *
 * 现在要求「字段值是真的」：role 必须是单一角色名，不能是 `a | b | c` 这种枚举写法；
 * agent_id / artifact_path 不能是 `"string"` 这种占位。这样骨架模板会被跳过，
 * 而「某人真的写了一份能过的产物贴在文档里」会被校验。
 */
function looksLikeRealExample(body) {
  if (!/"payload"\s*:/.test(body)) return false;
  if (!/"schema_version"\s*:/.test(body)) return false;

  let parsed;
  try { parsed = JSON.parse(body); } catch { return false; }

  // role 必须是单一角色名，不能含 `|`
  if (typeof parsed.role !== 'string' || parsed.role.includes('|')) return false;
  if (!['recon', 'sweep', 'audit', 'critique', 'fix', 'verify', 'planner'].includes(parsed.role)) return false;

  // 占位符值：说明这是模板不是真产物
  const PLACEHOLDERS = new Set(['string', '<agent_id>', 'agent_id', 'xxx', '...']);
  if (PLACEHOLDERS.has(String(parsed.agent_id ?? ''))) return false;
  if (Object.prototype.hasOwnProperty.call(parsed, 'artifact_path') &&
      PLACEHOLDERS.has(String(parsed.artifact_path ?? ''))) return false;

  // payload 不能是空对象——空 payload 一定过不了角色必填字段检查
  if (parsed.payload && Object.keys(parsed.payload).length === 0) return false;

  return true;
}

const results = [];
const problems = [];
const tmp = mkdtempSync(join(tmpdir(), 'cx-'));

// ── 第一类：examples/ 下的示例文件必须真的能过校验 ──
// 这些是给 agent 照抄的，错了比没有更糟——它会让人「按文档写却被拒」。
const EXAMPLES = ['planner', 'recon', 'sweep', 'audit', 'critique', 'fix', 'verify'];
if (!existsSync(EXAMPLE_DIR)) {
  problems.push({
    role: '(all)', kind: 'examples_dir_missing',
    detail: `示例目录不存在: ${EXAMPLE_DIR}——跑 node tools/gen-contract-examples.mjs`,
  });
} else {
  for (const role of EXAMPLES) {
    const p = join(EXAMPLE_DIR, `${role}.md`);
    if (!existsSync(p)) {
      problems.push({ role, kind: 'example_missing', detail: `没有 ${role}.md 示例` });
      continue;
    }
    let code = 0;
    let out = '';
    try {
      // 示例里的 artifact_path 是 `<OUTDIR>` 约定占位（见 gen-contract-examples.mjs
      // 的注释：相对路径会随 cwd 变，绝对路径不可移植）。
      // 所以验格式用 --no-exists；存在性由真实产物在各自运行里保证。
      out = execFileSync(process.execPath, [VALIDATOR, p, '--role', role, '--no-exists'],
        { encoding: 'utf8' });
    } catch (e) {
      code = e.status ?? 1;
      out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
    }
    results.push({ slice: `examples/${role}`, line: 0, envelopeRole: role, passes: code === 0, message: '' });
    if (code !== 0) {
      // 校验器的输出是多行的：「✗ N 项违规:」下一行才是 `[rule_name] field`。
      // 只截含 ✗ 的那一行会丢掉规则名——而规则名才是可操作的诊断信息。
      const ruleLines = out.split('\n')
        .map((l) => l.trim())
        .filter((l) => /^\[[a-z_]+\]/.test(l))
        .slice(0, 3);
      problems.push({
        role, kind: 'example_file_rejected',
        detail: `示例文件 ${role}.md 被校验器拒绝: ${ruleLines.join(' | ') || out.trim().slice(0, 200)}`,
      });
    }
  }
}

try {
  const roles = readdirSync(SLICE_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''));

  for (const role of roles) {
    const p = join(SLICE_DIR, `${role}.md`);
    const text = readFileSync(p, 'utf8');

    for (const { body, lineNo } of jsonBlocks(text)) {
      if (!looksLikeRealExample(body)) continue;

      // JSON 本身能不能解析？
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch (e) {
        problems.push({
          role, line: lineNo, kind: 'example_invalid_json',
          detail: `示例不是合法 JSON: ${e.message}`,
        });
        continue;
      }

      const declaredRole = parsed.role;
      const file = join(tmp, `${role}-${lineNo}.md`);
      writeFileSync(file, '# 契约示例\n\n```json\n' + body + '```\n');

      let code = 0;
      let out = '';
      try {
        out = execFileSync(process.execPath, [VALIDATOR, file, '--role', declaredRole ?? role], { encoding: 'utf8' });
      } catch (e) {
        code = e.status ?? 1;
        out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
      }

      results.push({
        slice: role, line: lineNo, envelopeRole: declaredRole ?? role,
        passes: code === 0,
        message: (out.match(/^\s*[✗✘].*$/m)?.[0] ?? '').trim().slice(0, 160),
      });

      if (code !== 0) {
        problems.push({
          role, line: lineNo, kind: 'example_rejected',
          detail: `示例被校验器拒绝（--role ${declaredRole ?? role}）: ${results.at(-1).message || out.trim().slice(0, 160)}`,
        });
      }
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (jsonOut) {
  console.log(JSON.stringify({ results, problems }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

console.log('\n=== 契约示例能否通过校验器 ===\n');
if (results.length === 0) {
  console.log('没有找到任何示例，也没找到可校验的内嵌示例。');
  process.exit(problems.length ? 1 : 0);
}

console.log('来源'.padEnd(24) + 'role'.padEnd(12) + '结果');
for (const r of results) {
  const src = r.line ? `${r.slice}:${r.line}` : r.slice;
  console.log(`${src.padEnd(24)}${(r.envelopeRole ?? '?').padEnd(12)}${r.passes ? '通过' : '拒绝'}`);
}

console.log('');
if (problems.length === 0) {
  console.log(`${results.length} 个完整信封示例，全部通过校验器。`);
  process.exit(0);
}
console.log(`发现 ${problems.length} 个问题：`);
for (const p of problems) console.log(`  [${p.kind}] ${p.role}:${p.line} ${p.detail}`);
process.exit(1);
