#!/usr/bin/env node
/**
 * check-contract-slices.mjs — 验证按角色拆分的契约切片没有丢失该角色的必填字段
 *
 * 为什么必须有这个：
 *   把 output-contract.md 拆成 7 份能解决 L16 的加载量超限，但**拆错比不拆更危险**——
 *   如果某个角色的切片漏掉了它自己的必填字段，那个角色的 agent 就再也写不出合规产物，
 *   而且表面上一切正常（文件存在、行数变小了、lint 也绿）。
 *
 *   这正是本仓库反复出现的失败模式：**一份「看起来完整」的产物掩盖了内容缺失**。
 *   所以拆分必须配一个机械验证：每个切片都得包含 check-payload.mjs 里该 role 的
 *   全部必填字段，且必须包含通用节（信封 / 错误对象 / 机械检查清单）。
 *
 * 用法：node check-contract-slices.mjs [--json]
 * 退出码：0 = 全部完整   1 = 有切片缺内容   2 = 母文件或产物结构异常
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const SLICE_DIR = join(ROOT, 'framework', 'components', 'output-contract');
const VALIDATOR = join(HERE, 'check-payload.mjs');

const jsonOut = process.argv.includes('--json');

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasField = (text, field) => new RegExp(`\\b${escapeRe(field)}\\b`).test(text);

// ── 角色必填字段（从校验器解析，不另写一份）──
const toolSrc = readFileSync(VALIDATOR, 'utf8');
const block = toolSrc.match(/const ROLE_REQUIRED\s*=\s*\{([\s\S]*?)\n\};/);
if (!block) {
  console.error('无法从 check-payload.mjs 解析 ROLE_REQUIRED');
  process.exit(2);
}
const roleRequired = {};
for (const m of block[1].matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)) {
  roleRequired[m[1]] = m[2].split(',').map((x) => x.trim().replace(/['"]/g, '')).filter(Boolean);
}

// ── 每份切片都必须带的通用节标记 ──
const REQUIRED_SECTIONS = [
  { name: '第 1 节 统一返回信封', re: /^##\s*第\s*1\s*节/m },
  { name: '第 3 节 错误对象', re: /^##\s*第\s*3\s*节/m },
  { name: '第 4 节 机械检查清单', re: /^##\s*第\s*4\s*节/m },
];

const results = [];
const problems = [];

for (const [role, fields] of Object.entries(roleRequired)) {
  // 2026-11-22：本循环读取的是 `framework/components/output-contract/<role>.md`，
  // 即 fix.md / sweep.md / recon.md 等一批**按角色拆出来的契约切片**。
  //
  // 为什么写这句废话一样的注释：`check-rule-ledger.mjs` 判断「一条规则有没有机器出口」
  // 时，只认「工具源码里出现过该规范的文件名」，而这里路径是模板字面量
  // `${role}.md`，文件名从不以字面量形式出现。于是 fix.md / sweep.md / recon.md
  // 被判成**没有任何校验器读过它们的死文档**，各自吃掉 2 条真出口。
  //
  // 试过让脚本自动推断这种读取关系（词频、独有词、正则子串），三版全失败，
  // 详见 check-rule-ledger.mjs 的注释。结论是只能由人接线，就是这几行。
  // 角色切片文件名：recon.md / sweep.md / audit.md / critique.md / fix.md / verify.md / planner.md
  const p = join(SLICE_DIR, `${role}.md`);
  if (!existsSync(p)) {
    problems.push({ role, kind: 'slice_missing', detail: `没有 ${role}.md` });
    continue;
  }
  const text = readFileSync(p, 'utf8');
  const lines = text.split(/\r?\n/).length;

  const missingFields = fields.filter((f) => !hasField(text, f));
  const missingSections = REQUIRED_SECTIONS.filter((s) => !s.re.test(text)).map((s) => s.name);

  results.push({ role, lines, fieldCount: fields.length, missingFields, missingSections });

  if (missingFields.length) {
    problems.push({
      role, kind: 'slice_missing_fields',
      detail: `缺必填字段: ${missingFields.join(', ')}——该角色的 agent 写不出合规产物`,
    });
  }
  if (missingSections.length) {
    problems.push({
      role, kind: 'slice_missing_sections',
      detail: `缺通用节: ${missingSections.join(', ')}`,
    });
  }
}

// 反向检查：目录里有切片但没有对应角色 = 孤儿文件（母文件删了节但没重跑生成）
if (existsSync(SLICE_DIR)) {
  const { readdirSync } = await import('node:fs');
  for (const f of readdirSync(SLICE_DIR)) {
    if (!f.endsWith('.md')) continue;
    const role = f.replace(/\.md$/, '');
    if (!roleRequired[role]) {
      problems.push({ role, kind: 'orphan_slice', detail: `有 ${f} 但校验器里没有这个角色` });
    }
  }
}

if (jsonOut) {
  console.log(JSON.stringify({ results, problems }, null, 2));
  process.exit(problems.length ? 1 : 0);
}

console.log('\n=== 契约切片完整性 ===\n');
console.log('角色'.padEnd(12) + '行数'.padEnd(8) + '必填字段'.padEnd(12) + '通用节');
for (const r of results) {
  const f = r.missingFields.length ? `缺 ${r.missingFields.length}` : `${r.fieldCount}/${r.fieldCount}`;
  const s = r.missingSections.length ? `缺 ${r.missingSections.length}` : '齐';
  console.log(`${r.role.padEnd(12)}${String(r.lines).padEnd(8)}${f.padEnd(12)}${s}`);
}

console.log('');
if (problems.length === 0) {
  console.log(`${results.length} 份切片全部完整：每份都含该角色的全部必填字段与通用节。`);
  process.exit(0);
}
console.log(`发现 ${problems.length} 个问题：`);
for (const p of problems) console.log(`  [${p.kind}] ${p.role}: ${p.detail}`);
process.exit(1);
