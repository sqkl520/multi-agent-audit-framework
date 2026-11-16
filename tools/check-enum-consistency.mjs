#!/usr/bin/env node
/**
 * check-enum-consistency.mjs — 同一个枚举在「契约 / 校验器 / 示例」三处是否一致
 *
 * 为什么需要：
 *   这个仓库里枚举是闭集，写错一个词整个产物作废（契约 §1「不允许自定义状态值」）。
 *   而同一个枚举会出现在至少三处：
 *
 *     契约切片   给人读的说明          "CRITICAL | HIGH | MEDIUM | LOW"
 *     校验器     ENUM_CHECKS 里的数组  ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
 *     示例       生成出来的产物         "severity": "HIGH"
 *
 *   三处漂移不会让任何单独一方报错——校验器只会说「你这个值不合法」，
 *   不会说「因为文档和我的清单不一致」。agent 于是陷入「我按文档写的却被拒」。
 *
 *   历史上真发生过：模板里写过 `NONE` 这个严重性，而契约的闭集不含它。
 *   （见 templates/wave2-audit.md 里那段专门解释为什么不能写 NONE 的说明。）
 *
 * 做法：从校验器的 ENUM_CHECKS 抽出「字段 → 合法值集合」，
 *       再逐处比对契约切片与示例里该字段的写法。
 *
 * 用法：node check-enum-consistency.mjs [--json]
 * 退出码：0 = 一致   1 = 有漂移   2 = 结构异常
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const VALIDATOR = join(HERE, 'check-payload.mjs');
const SLICE_DIR = join(ROOT, 'framework', 'components', 'output-contract');
const EXAMPLE_DIR = join(SLICE_DIR, 'examples');
const WRAPPERS = join(ROOT, 'framework', 'wrappers');
// 2026-11-14 补：templates/ 此前不在扫描范围，于是同一个 reachability 枚举
// 在同一份 wave2a-sweep.md 里出现了两套——第 81 行的 JSON 骨架写 4 个值（缺 ENTRY），
// 第 132 行的正文表格写 5 个值并专门解释了 ENTRY。
// agent 照 JSON 骨架写，永远拿不到 ENTRY 这一档，而 ENTRY 正是把
// 「CLI 脚本 / CI 调用的工具」从 UNREACHABLE 里救出来的取值。
const TEMPLATES = join(ROOT, 'framework', 'templates');

const jsonOut = process.argv.includes('--json');

const toolSrc = readFileSync(VALIDATOR, 'utf8');

// ── 从 ENUM_CHECKS 抽出字段 → 合法值 ──
// 形如 { path: 'findings[].severity', values: ['CRITICAL', 'HIGH', ...] }
const enumDefs = [];
const enumBlock = toolSrc.match(/const ENUM_CHECKS\s*=\s*\[([\s\S]*?)\n\s*\];/);
if (!enumBlock) {
  console.error('[预期失败] 无法从 check-payload.mjs 解析出 ENUM_CHECKS');
  process.exit(2);
}

for (const m of enumBlock[1].matchAll(
  /path:\s*'([\w.\[\]]+)'\s*,\s*values:\s*\[([^\]]*)\]/g,
)) {
  const path = m[1];
  const raw = m[2].split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);

  // 有些枚举的 values 里混了布尔字面量（如
  //   values: ['true', 'false', 'untested', true, false]
  // 表示「字符串 'true' 或布尔 true 都接受」。
  // 不能把它们过滤掉——否则闭集只剩 'untested'，示例里合法的 "true" 会被误报非法。
  const values = [...new Set(raw.map((v) => {
    const s = String(v).trim();
    // 布尔字面量规范成小写字符串：JSON 里通常写成 "true"（字符串），
    // 校验器两种都接受
    if (s === 'true' || s === 'false') return s.toLowerCase();
    return s;
  }))].filter((v) => v !== 'null' && v !== 'undefined');

  if (values.length === 0) continue;

  const field = path.split(/[.\[]/).pop().replace(/\]$/, '');
  enumDefs.push({ path, field, values });
}

if (enumDefs.length === 0) {
  console.error('ENUM_CHECKS 解析出 0 条，结构可能变了');
  process.exit(2);
}

const problems = [];
const notes = [];

/**
 * 在文本里找该字段的「管道写法」声明，例如：
 *   "severity": "CRITICAL | HIGH | MEDIUM | LOW"
 *   `severity` 取 `CRITICAL` / `HIGH` / `MEDIUM` / `LOW`
 * 抽出其中的词，与校验器的清单比对。
 */
function checkPipedDeclaration(text, field, legalValues, where) {
  const results = [];

  // 形式 1: "field": "A | B | C"
  const re1 = new RegExp(`"${field}"\\s*:\\s*"([^"]+)"`, 'g');
  for (const m of text.matchAll(re1)) {
    if (!m[1].includes('|')) continue;         // 不是枚举声明（是具体取值）
    results.push(m[1]);
  }

  // 形式 2: `field` 取 `A` | `B` | `C`
  const re2 = new RegExp('`' + field + '`[^\\n]{0,40}?([' + '`A-Z_(/|)\\s]{6,})\\n', 'g');
  for (const m of text.matchAll(re2)) {
    if (!m[1].includes('|') && !m[1].includes('/')) continue;
    results.push(m[1]);
  }

  for (const decl of results) {
    const declared = decl
      .split(/[|/]/)
      .map((v) => v.replace(/[`\s]/g, ''))
      .filter(Boolean)
      .filter((v) => /^[A-Z][A-Z0-9_]*$/.test(v));   // 只认全大写下划线形态

    if (declared.length === 0) continue;

    const missingInValidator = declared.filter((v) => !legalValues.includes(v));
    const missingInDoc = legalValues.filter((v) => !declared.includes(v));

    if (missingInValidator.length > 0) {
      problems.push({
        where, field, kind: 'doc_has_illegal_value',
        detail: `${where} 里 ${field} 的声明含校验器不接受的值: ${missingInValidator.join(', ')}`
          + `（校验器闭集: ${legalValues.join(' | ')}）`,
      });
    }
    if (missingInDoc.length > 0) {
      problems.push({
        where, field, kind: 'doc_missing_legal_value',
        detail: `${where} 里 ${field} 的声明缺校验器接受的合法值: ${missingInDoc.join(', ')}`,
      });
    }
  }

  return results.length;
}

// ── 检查契约切片 ──
let docDeclsFound = 0;
if (existsSync(SLICE_DIR)) {
  for (const f of readdirSync(SLICE_DIR)) {
    if (!f.endsWith('.md')) continue;
    const text = readFileSync(join(SLICE_DIR, f), 'utf8');
    for (const { field, values } of enumDefs) {
      docDeclsFound += checkPipedDeclaration(text, field, values, `切片 ${f}`);
    }
  }
}

// ── 检查 wrapper ──
for (const f of readdirSync(WRAPPERS)) {
  if (!f.endsWith('.md')) continue;
  const text = readFileSync(join(WRAPPERS, f), 'utf8');
  for (const { field, values } of enumDefs) {
    docDeclsFound += checkPipedDeclaration(text, field, values, `wrapper ${f}`);
  }
}

// ── 检查 templates（2026-11-14 新增；此前不在扫描范围）──
if (existsSync(TEMPLATES)) {
  for (const f of readdirSync(TEMPLATES)) {
    if (!f.endsWith('.md')) continue;
    const text = readFileSync(join(TEMPLATES, f), 'utf8');
    for (const { field, values } of enumDefs) {
      docDeclsFound += checkPipedDeclaration(text, field, values, `模板 ${f}`);
    }
  }
}

// ── 检查示例里用到的值是否合法（这是最容易出错的：示例写了个不存在于闭集的值）──
let exampleValuesChecked = 0;
if (existsSync(EXAMPLE_DIR)) {
  for (const f of readdirSync(EXAMPLE_DIR)) {
    if (!f.endsWith('.md')) continue;
    const text = readFileSync(join(EXAMPLE_DIR, f), 'utf8');
    const re = /```json\s*\n([\s\S]*?)```/g;
    for (const m of text.matchAll(re)) {
      let obj;
      try { obj = JSON.parse(m[1]); } catch { continue; }

      for (const { field, values } of enumDefs) {
        // 在 payload 里递归找该字段
        const found = [];
        (function walk(node) {
          if (!node || typeof node !== 'object') return;
          if (Array.isArray(node)) { node.forEach(walk); return; }
          for (const [k, v] of Object.entries(node)) {
            if (k === field && typeof v === 'string') found.push(v);
            walk(v);
          }
        })(obj.payload ?? {});

        for (const v of found) {
          exampleValuesChecked++;
          if (!values.includes(v)) {
            problems.push({
              where: `示例 ${f}`, field, kind: 'example_illegal_value',
              detail: `示例里 ${field} = "${v}"，但校验器闭集是 ${values.join(' | ')}`,
            });
          }
        }
      }
    }
  }
}

// ────────────────────────────────────────────────────────────────────
// 规则 recursion_depth_mismatch（2026-11-16 新增）
//
// 实战暴露：triage.md 说 T2 = 3 层，wrappers/planner.md 说 T2 = 2 层。
// 两者都是「对同一件事的声明」，任何单独一方读起来都自洽，
// 只有并排看才发现冲突。agent 读到 planner 的 2 就按 2 执行，
// 然后在收尾报告里把「任务书要 3」写成框架缺陷——这个发现成本本来不该由 agent 承担。
//
// 提取方式：**不用正则去猜自然语言**，而是要求两处都放一张带标记的结构化表格：
//
//   <!-- RECURSION-DEPTH-TABLE -->
//   | TIER | 递归上限（层） |
//   |---|---|
//   | T0 | 1 |
//   | T1 | 2 |
//   | T2 | 3 |
//
// 标记行让「找到表」这件事变成存在性判断，而不是猜标题措辞。
// 表格让「取哪一列」变成位置判断，而不是从散文里抽数字。
//
// 关键：**找不到表不是跳过，是失败。** 如果提取失败就放行，
// 这个校验器等于没有——首个用例（case 10）就是钉这一点的。
// ────────────────────────────────────────────────────────────────────
const DEPTH_MARK = '<!-- RECURSION-DEPTH-TABLE -->';
const DEPTH_SOURCES = [
  { file: 'orchestrator/triage.md', path: join(ROOT, 'framework', 'orchestrator', 'triage.md') },
  { file: 'wrappers/planner.md', path: join(WRAPPERS, 'planner.md') },
];
const TIERS = ['T0', 'T1', 'T2'];
const recursionDepth = { sources: [] };

/**
 * 从标记之后的第一个 markdown 表格里抽取 TIER → 层数。
 * 返回 { ok, depths, reason }。
 */
function extractDepthTable(text, label) {
  const at = text.indexOf(DEPTH_MARK);
  if (at < 0) {
    return { ok: false, reason: `找不到标记 ${DEPTH_MARK}（递归表被搬走或改写成散文）` };
  }
  const lines = text.slice(at + DEPTH_MARK.length).split('\n');

  const depths = {};
  let sawTable = false;
  let sawSeparator = false;

  for (const raw of lines) {
    const ln = raw.trim();
    if (ln === '') { if (sawTable) break; else continue; }   // 空行：表前忽略，表后结束
    if (!ln.startsWith('|')) { if (sawTable) break; else continue; }

    const cells = ln.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;

    // 分隔行 |---|---|
    if (/^:?-{2,}:?$/.test(cells[1])) { sawSeparator = true; continue; }
    // 表头
    if (/TIER/i.test(cells[0])) { sawTable = true; continue; }

    const tier = cells[0].replace(/[^A-Z0-9]/g, '');
    if (!TIERS.includes(tier)) continue;
    const m = cells[1].match(/\d+/);
    if (!m) return { ok: false, reason: `${tier} 行的层数格无数字: "${cells[1]}"` };
    depths[tier] = Number(m[0]);
    sawTable = true;
  }

  if (!sawTable) return { ok: false, reason: `标记之后找不到表格` };
  if (!sawSeparator) return { ok: false, reason: `标记之后的表格缺分隔行，不是合法 markdown 表` };

  const missing = TIERS.filter((t) => !(t in depths));
  if (missing.length) {
    return { ok: false, reason: `表里缺 TIER: ${missing.join(', ')}（表格不完整，不能当作「已声明」）` };
  }
  return { ok: true, depths };
}

for (const { file, path } of DEPTH_SOURCES) {
  if (!existsSync(path)) {
    problems.push({
      where: file, field: 'recursion.max_depth', kind: 'recursion_depth_table_missing',
      detail: `${file} 不存在，无法比对递归上限——缺文件不是「一致」`,
    });
    continue;
  }
  const r = extractDepthTable(readFileSync(path, 'utf8'), file);
  if (!r.ok) {
    problems.push({
      where: file, field: 'recursion.max_depth', kind: 'recursion_depth_table_missing',
      detail: `${file} 的递归上限表无法提取: ${r.reason}。**提取失败不等于通过**`,
    });
    continue;
  }
  recursionDepth.sources.push({ file, depths: r.depths });
}

// 两个来源都拿到了才逐 TIER 比对；少一个已经在上面报过 missing。
if (recursionDepth.sources.length === DEPTH_SOURCES.length) {
  const [a, b] = recursionDepth.sources;
  const bad = [];
  for (const tier of TIERS) {
    if (a.depths[tier] !== b.depths[tier]) {
      bad.push(`${tier}: ${a.file} 说 ${a.depths[tier]} 层，${b.file} 说 ${b.depths[tier]} 层`);
    }
  }
  if (bad.length) {
    problems.push({
      where: `${a.file} vs ${b.file}`, field: 'recursion.max_depth',
      kind: 'recursion_depth_mismatch',
      detail: `递归上限不一致 —— ${bad.join('；')}。`
        + `两处必须逐 TIER 相同（harness 能力不足造成的更低上限由 compatibility.md 处理，不写进这两张表）`,
    });
  }
  recursionDepth.consistent = bad.length === 0;
}

if (jsonOut) {
  console.log(JSON.stringify({ enumDefs, problems, docDeclsFound, exampleValuesChecked, recursionDepth }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

console.log('\n=== 枚举跨层一致性 ===\n');
console.log(`校验器定义 ${enumDefs.length} 个枚举字段；扫描到文档声明 ${docDeclsFound} 处、示例取值 ${exampleValuesChecked} 个。\n`);

console.log('字段'.padEnd(22) + '闭集');
for (const { field, values } of enumDefs) {
  console.log(field.padEnd(22) + values.join(' | '));
}

console.log('');
if (problems.length === 0) {
  console.log('结论：契约切片 / wrapper / 模板 / 示例四处与校验器闭集一致。');
  console.log(`递归上限：${recursionDepth.sources.map((s) => `${s.file} T0=${s.depths.T0} T1=${s.depths.T1} T2=${s.depths.T2}`).join(' | ')} — 逐 TIER 一致。`);
  process.exit(0);
}
console.log(`发现 ${problems.length} 处漂移：`);
for (const p of problems) console.log(`  [${p.kind}] ${p.where} — ${p.detail}`);
process.exit(1);
