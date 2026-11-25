#!/usr/bin/env node
/**
 * check-contract-slice-fidelity.mjs — 证明「拆分无损」：每份切片都完整保留了该角色那一节
 *
 * 与 check-contract-slices.mjs 的分工：
 *   check-contract-slices  回答「**必填字段**还在不在」——只查 ROLE_REQUIRED 那十几个
 *   本脚本                  回答「**这一节讲的东西**还在不在」——查该角色节里出现的全部字段标识符
 *
 * 为什么两个都要：
 *   前者防的是「agent 写不出合规产物」，后者防的是「切片时切掉了上下文」。
 *   一个字段即使在 ROLE_REQUIRED 里、切片里也出现了，它周围的**约束说明**
 *   （枚举闭集、算术自洽、条件必填）仍可能在切分时丢失。那种情况下校验器会拒绝产物，
 *   而 agent 不知道自己错在哪——因为切片里只留了字段名，没留规则。
 *
 * 判定方式：从母文件的角色节里抽出全部 snake_case 字段标识符，
 * 逐个检查是否出现在该角色的切片里。零缺失才算无损。
 *
 * 用法：node check-contract-slice-fidelity.mjs [--json]
 * 退出码：0 = 无损   1 = 有丢失   2 = 结构异常
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SRC = join(ROOT, 'framework/components/output-contract.md');
const SLICE_DIR = join(ROOT, 'framework/components/output-contract');

const jsonOut = process.argv.includes('--json');

if (!existsSync(SRC)) {
  console.error(`母文件不存在: ${SRC}`);
  process.exit(2);
}

const lines = readFileSync(SRC, 'utf8').split(/\r?\n/);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const find = (re) => lines.findIndex((l) => re.test(l));
const marks = {
  s20: find(/^#### 2\.0 /),
  s21: find(/^#### 2\.1 /),
  s22a: find(/^#### 2\.2a /),
  s22: find(/^#### 2\.2 /),
  s23: find(/^#### 2\.3 /),
  s24: find(/^#### 2\.4 /),
  s25: find(/^#### 2\.5 /),
  s3: find(/^## 第 3 节/),
};

const missingMarks = Object.entries(marks).filter(([, v]) => v < 0).map(([k]) => k);
if (missingMarks.length) {
  console.error(`[预期失败] 母文件缺这些节: ${missingMarks.join(', ')}——母文件结构变了，先同步本脚本`);
  process.exit(2);
}

if (marks.s20 > marks.s21 || marks.s21 > marks.s22a || marks.s22a > marks.s22 ||
    marks.s22 > marks.s23 || marks.s23 > marks.s24 || marks.s24 > marks.s25 || marks.s25 > marks.s3) {
  console.error('[预期失败] 母文件的角色节顺序不是 2.0 < 2.1 < 2.2a < 2.2 < 2.3 < 2.4 < 2.5 < 第3节——脚本假设被打破');
  process.exit(2);
}

const ROLE_SECTION = {
  planner: [marks.s20, marks.s21],
  recon: [marks.s21, marks.s22a],
  sweep: [marks.s22a, marks.s22],
  audit: [marks.s22, marks.s23],
  critique: [marks.s23, marks.s24],
  fix: [marks.s24, marks.s25],
  verify: [marks.s25, marks.s3],
};

// 只认「像字段名」的标识符：snake_case（至少一个下划线），避免把普通英文单词算进来
function extractFields(text) {
  const out = new Set();
  for (const m of text.matchAll(/`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g)) out.add(m[1]);
  for (const m of text.matchAll(/"([a-z][a-z0-9]*(?:_[a-z0-9]+)+)"\s*:/g)) out.add(m[1]);
  return out;
}

const results = [];
const problems = [];

for (const [role, [a, b]] of Object.entries(ROLE_SECTION)) {
  const sectionText = lines.slice(a, b).join('\n');
  const sectionFields = [...extractFields(sectionText)].sort();

  const slicePath = join(SLICE_DIR, `${role}.md`);
  if (!existsSync(slicePath)) {
    problems.push({ role, kind: 'slice_missing', detail: `没有 ${role}.md` });
    continue;
  }
  const slice = readFileSync(slicePath, 'utf8');
  const missing = sectionFields.filter((f) => !new RegExp(`\\b${escapeRe(f)}\\b`).test(slice));

  results.push({ role, sectionFields: sectionFields.length, missing });
  if (missing.length) {
    problems.push({
      role, kind: 'slice_lost_fields',
      detail: `该角色那一节里的 ${missing.length} 个字段没进切片: ${missing.join(', ')}`,
    });
  }

  // 附加检查：切片必须标注自己是"裁出来的"，否则读者会以为它和母文件等价
  if (!/自动生成|母文件/.test(slice)) {
    problems.push({
      role, kind: 'slice_not_marked_generated',
      detail: '切片没有标注「自动生成 / 母文件在哪」，读者会以为它是独立权威',
    });
  }

  // 附加检查：父节标题必须在。
  // 切片只保留一个角色分支，若连「## 第 2 节：Payload 的角色分支」这个父标题也不带，
  // `#### 2.0` 就会直接跟在 `#### 顶层字段` 后面——读的人不知道它属于哪一节，
  // 更看不到「payload 用 oneOf 按 role 分支」这个前提。
  if (!/^##\s*第\s*2\s*节/m.test(slice)) {
    problems.push({
      role, kind: 'slice_missing_parent_heading',
      detail: '切片缺「第 2 节：Payload 的角色分支」父标题，角色小节成了孤儿',
    });
  }

  // 附加检查：切片不能自称是母文件的路径。
  // frontmatter 写 `file: components/output-contract.md` 会让读者照着去找完整版，
  // 于是读到 703 行而不是手上这份——「自称与实际不符」比缺内容更容易误导。
  if (/^file:\s*components\/output-contract\.md\s*$/m.test(slice)) {
    problems.push({
      role, kind: 'slice_mislabels_itself',
      detail: `切片 frontmatter 自称是母文件路径，应为 components/output-contract/${role}.md`,
    });
  }
}

if (jsonOut) {
  console.log(JSON.stringify({ results, problems }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

console.log('\n=== 契约切片保真度（拆分是否无损） ===\n');
console.log('角色'.padEnd(12) + '本节字段'.padEnd(12) + '切片缺失');
for (const r of results) {
  console.log(`${r.role.padEnd(12)}${String(r.sectionFields).padEnd(12)}${r.missing.length === 0 ? '0 ✓' : r.missing.length}`);
}

const totalFields = results.reduce((s, r) => s + r.sectionFields, 0);

// 分母为 0 不等于通过（H1，2026-11-25 锐评实测）。
//
// `extractFields` 只认反引号/JSON 键形式的 snake_case。把 output-contract.md 里的
// `_` 全换成 `-`（等价于一次 camelCase 重构）后，7 份切片的字段数全变 0，
// `missing` 恒为空，于是打印「7 份切片无损：角色本节共 0 个字段，全部保留」并 exit 0。
//
// 同仓库的 check-doc-paths / check-rule-doc-link / lint-terminology 都有这条守卫，
// 而这条校验器被 check-repo 当作「13 个真实仓库校验器」之一在跑——它不能空转。
if (totalFields === 0) {
  console.error('');
  console.error(`✗ 从 ${results.length} 份切片的角色小节里抽到 0 个字段——分母为 0，不能判「无损」。`);
  console.error('  多半是 output-contract.md 的字段命名形态变了（extractFields 只认 snake_case）。');
  console.error('  修 extractFields 的判据，而不是把这条守卫删掉。');
  process.exit(2);
}

console.log('');
if (problems.length === 0) {
  console.log(`${results.length} 份切片无损：角色本节共 ${totalFields} 个字段，全部保留。`);
  process.exit(0);
}
console.log(`发现 ${problems.length} 个问题：`);
for (const p of problems) console.log(`  [${p.kind}] ${p.role}: ${p.detail}`);
process.exit(1);
