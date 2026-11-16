#!/usr/bin/env node
/**
 * check-enum-consistency.test.mjs — 枚举跨层一致性检查器自测
 *
 * 为什么这个检查器值得单独存在：
 *   枚举写错不会让任何单独一方报错。校验器只会说「你这个值不合法」，
 *   不会说「因为文档和我的清单不一致」。agent 于是陷入「按文档写却被拒」。
 *
 *   历史上真发生过：模板里写过 `NONE` 这个严重性，而契约闭集不含它。
 *   所以下面第一个"必须有牙齿"的用例就是往 audit 切片里加 `NONE`。
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, cpSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TOOL = join(HERE, 'check-enum-consistency.mjs');

let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};

function withCopy(mutator, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'en-test-'));
  cpSync(join(ROOT, 'framework'), join(dir, 'framework'), { recursive: true });
  mkdirSync(join(dir, 'tools'), { recursive: true });
  cpSync(TOOL, join(dir, 'tools', 'check-enum-consistency.mjs'));
  cpSync(join(HERE, 'check-payload.mjs'), join(dir, 'tools', 'check-payload.mjs'));
  mutator(join(dir, 'framework'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function runIn(dir) {
  try {
    const out = execFileSync(process.execPath,
      [join(dir, 'tools', 'check-enum-consistency.mjs'), '--json'], { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    const out = e.stdout?.toString() ?? '';
    try { return { code: e.status, data: JSON.parse(out) }; }
    catch { return { code: e.status, data: null, raw: out }; }
  }
}

console.log('\n=== 枚举一致性检查器自测 ===\n');

console.log('case 1: 真实仓库应一致');
{
  try {
    const out = execFileSync(process.execPath, [TOOL], { encoding: 'utf8' });
    expect('退出码 0', true);
    expect('报告一致', /四处与校验器闭集一致/.test(out), out.slice(-200));
  } catch (e) {
    expect('退出码 0', false, `实际 ${e.status}: ${e.stdout?.toString().slice(-300)}`);
  }
}

console.log('case 2: 文档声明里加了闭集外的值（历史上真出现过的 NONE）→ 必须报错');
{
  const r = withCopy((fw) => {
    const p = join(fw, 'components', 'output-contract', 'audit.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace(
      '"CRITICAL | HIGH | MEDIUM | LOW"', '"CRITICAL | HIGH | MEDIUM | LOW | NONE"'));
  }, runIn);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'doc_has_illegal_value');
  expect('报 doc_has_illegal_value', !!hit, JSON.stringify(r.data?.problems));
  expect('点名 NONE', /NONE/.test(hit?.detail ?? ''), hit?.detail);
}

console.log('case 3: 文档声明的闭集比校验器少一个值 → 必须报错');
{
  const r = withCopy((fw) => {
    const p = join(fw, 'components', 'output-contract', 'sweep.md');
    // 去掉 GENERATED
    writeFileSync(p, readFileSync(p, 'utf8').replace(
      '"PROD | ENTRY | TEST_ONLY | UNREACHABLE | GENERATED"',
      '"PROD | ENTRY | TEST_ONLY | UNREACHABLE"'));
  }, runIn);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'doc_missing_legal_value');
  expect('报 doc_missing_legal_value', !!hit, JSON.stringify(r.data?.problems));
  expect('点名 GENERATED', /GENERATED/.test(hit?.detail ?? ''), hit?.detail);
}

console.log('case 4: 示例里用了闭集外的值 → 必须报错（agent 照抄就会失败）');
{
  const r = withCopy((fw) => {
    const p = join(fw, 'components', 'output-contract', 'examples', 'audit.md');
    writeFileSync(p, readFileSync(p, 'utf8').replace('"severity": "HIGH"', '"severity": "SEVERE"'));
  }, runIn);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'example_illegal_value');
  expect('报 example_illegal_value', !!hit, JSON.stringify(r.data?.problems));
  expect('点名 SEVERE', /SEVERE/.test(hit?.detail ?? ''), hit?.detail);
}

console.log('case 5: 布尔型枚举（path_reachable）不得被误报 —— 回归：曾把它过滤成只剩 untested');
{
  // 校验器里写的是 values: ['true','false','untested', true, false]。
  // 第一版把非字符串字面量全过滤了，闭集只剩 untested，于是示例里合法的
  // "true" 被误报为非法。这个用例钉住「布尔字面量必须保留」。
  const r = withRunInRealRepo();
  const rp = (r.data?.enumDefs ?? []).find((e) => e.field === 'path_reachable');
  expect('path_reachable 闭集含 true', rp?.values?.includes('true'), JSON.stringify(rp?.values));
  expect('path_reachable 闭集含 false', rp?.values?.includes('false'), JSON.stringify(rp?.values));
  expect('path_reachable 闭集含 untested', rp?.values?.includes('untested'), JSON.stringify(rp?.values));
}

function withRunInRealRepo() {
  try {
    const out = execFileSync(process.execPath, [TOOL, '--json'], { encoding: 'utf8' });
    return { code: 0, data: JSON.parse(out) };
  } catch (e) {
    try { return { code: e.status, data: JSON.parse(e.stdout?.toString() ?? '{}') }; }
    catch { return { code: e.status, data: null }; }
  }
}

console.log('case 6: ENUM_CHECKS 消失 → 必须拒绝执行，不能瞎报绿');
{
  // 注意 mutator 只收到一个参数（framework 目录）；tools 是它的兄弟目录。
  const r = withCopy((fw) => {
    const p = join(fw, '..', 'tools', 'check-payload.mjs');
    writeFileSync(p, readFileSync(p, 'utf8').replace(/const ENUM_CHECKS\s*=/, 'const GONE_ENUM_CHECKS ='));
  }, runIn);
  expect('退出码 2', r.code === 2, `实际 ${r.code}`);
}

console.log('case 7: templates/ 必须在扫描范围内（回归：reachability 曾在模板里有两套枚举）');
{
  // 2026-11-14 实测：wave2a-sweep.md:81 的 JSON 骨架写 4 个值（缺 ENTRY），
  // 同文件 :132 的正文表格写 5 个值。agent 照骨架写永远拿不到 ENTRY 这一档。
  // 根因是扫描目录列表里没有 templates/。
  const r = withCopy((fw) => {
    const p = join(fw, 'templates', 'wave2a-sweep.md');
    const t = readFileSync(p, 'utf8');
    // 把 correct 的 5 值改成 4 值（缺 ENTRY），模拟漂移
    writeFileSync(p, t.replace(
      '"PROD | ENTRY | TEST_ONLY | UNREACHABLE | GENERATED"',
      '"PROD | TEST_ONLY | UNREACHABLE | GENERATED"'));
  }, runIn);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'doc_missing_legal_value');
  expect('模板里的枚举漂移被抓到', !!hit, JSON.stringify(r.data?.problems));
  expect('指向模板文件', /模板/.test(hit?.where ?? ''), hit?.where);
}

// ────────────────────────────────────────────────────────────────────
// case 8-10：递归上限跨文件一致性（2026-11-16 新增）
//
// 实战暴露的矛盾：triage.md 说 T2 = 3 层，wrappers/planner.md 说 T2 = 2 层。
// 一次真实修复任务里，agent 读到 planner 的「2」，按 depth 2 保守执行，
// 在收尾报告里把「depth 3 vs 上限 2」写成「框架文档/闸门矛盾」。
// 同一份框架，T2 的上限一个说 3 一个说 2 —— 这不该靠 agent 写报告来发现。
// ────────────────────────────────────────────────────────────────────
const DEPTH_MARK = '<!-- RECURSION-DEPTH-TABLE -->';

/** 在标记之后的表格里，把某个 TIER 的层数改成另一个数字 */
function mutateDepthRow(file, tier, value) {
  const t = readFileSync(file, 'utf8');
  const i = t.indexOf(DEPTH_MARK);
  if (i < 0) throw new Error(`${file} 里找不到 ${DEPTH_MARK}`);
  const head = t.slice(0, i);
  const tail = t.slice(i);
  const re = new RegExp(`\\|\\s*${tier}\\s*\\|\\s*\\d+\\s*\\|`);
  if (!re.test(tail)) throw new Error(`${file} 的递归表里找不到 ${tier} 行`);
  writeFileSync(file, head + tail.replace(re, `| ${tier} | ${value} |`));
}

console.log('case 8: 两个文件的递归上限表都存在且一致 → 必须通过');
{
  const r = withCopy(() => {}, runIn);
  const depthProbs = (r.data?.problems ?? []).filter((p) => /^recursion_depth/.test(p.kind));
  expect('无 recursion_depth_* 问题', depthProbs.length === 0, JSON.stringify(depthProbs));
  expect('解析出两个来源的递归表', (r.data?.recursionDepth?.sources?.length ?? 0) === 2,
    JSON.stringify(r.data?.recursionDepth));
  const triageVals = r.data?.recursionDepth?.sources?.find?.((s) => /triage/.test(s.file))?.depths;
  expect('triage 解析出 T2 = 3', triageVals?.T2 === 3, JSON.stringify(triageVals));
}

console.log('case 9: planner 的 T2 改成 2（实战里真实发生的那次漂移）→ 必须点名 T2 并给两个数字');
{
  const r = withCopy((fw) => {
    mutateDepthRow(join(fw, 'wrappers', 'planner.md'), 'T2', 2);
  }, runIn);
  expect('退出码 1', r.code === 1, `实际 ${r.code}`);
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'recursion_depth_mismatch');
  expect('报 recursion_depth_mismatch', !!hit, JSON.stringify(r.data?.problems));
  expect('点名 TIER = T2', /T2:/.test(hit?.detail ?? ''), hit?.detail);
  expect('报出两个数字（triage 3 / planner 2）',
    /3/.test(hit?.detail ?? '') && /2/.test(hit?.detail ?? ''), hit?.detail);
}

console.log('case 10: planner 缺递归表 → 必须报错，不得因为「找不到」就静默通过');
{
  const r = withCopyWithMissingTable();
  const hit = (r.data?.problems ?? []).find((p) => p.kind === 'recursion_depth_table_missing');
  expect('报 recursion_depth_table_missing', !!hit, JSON.stringify(r.data?.problems));
  expect('点名缺表的文件', /planner\.md/.test(hit?.detail ?? ''), hit?.detail);
  expect('退出码非 0', r.code !== 0, `实际 ${r.code}`);
}

/** 把 planner 里的整张递归表删掉（含标记行），模拟「表格被改写/搬走」 */
function withCopyWithMissingTable() {
  return withCopy((fw) => {
    const p = join(fw, 'wrappers', 'planner.md');
    const t = readFileSync(p, 'utf8');
    const i = t.indexOf(DEPTH_MARK);
    if (i < 0) throw new Error('planner.md 里找不到递归表标记');
    // 从标记行删到表格结束（遇到第一个空行之后的行即停）
    const lines = t.slice(i).split('\n');
    let end = 1;
    for (; end < lines.length; end++) {
      const ln = lines[end].trim();
      if (ln !== '' && !ln.startsWith('|')) break;
    }
    writeFileSync(p, t.slice(0, i) + lines.slice(end).join('\n'));
  }, runIn);
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
