// 变异探针 v2：每个变异都先验证「真的改到了文件」，改不到就报 MUTATION_NOOP 并跳过，
// 绝不把 noop 计成 MISSED —— 那是探针自己的 bug，不是框架的漏洞。
import { readFileSync, writeFileSync, copyFileSync, unlinkSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();

function run(args, cwd) {
  try {
    const out = execFileSync('node', args, { encoding: 'utf8', cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 'SIG', out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

/**
 * @param rel      要变异的文件（相对仓库根）
 * @param fn       变异函数，必须真的改变内容
 * @param check    [script, cwd]
 * @param expect   人类描述：这个变异代表什么现实错误
 */
function mutate(rel, fn, check, expect) {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) return { rel, result: 'FILE_MISSING', expect };
  const bak = abs + '.mutbak';
  copyFileSync(abs, bak);
  let code = 0, output = '';
  try {
    const orig = readFileSync(abs, 'utf8');
    const next = fn(orig);
    if (next === undefined || next === orig) {
      return { rel, result: 'MUTATION_NOOP', expect, note: '变异函数未改变内容——探针自身无效' };
    }
    writeFileSync(abs, next);
    const r = run(check[0], check[1]);
    code = r.code;
    output = r.out;
  } finally {
    copyFileSync(bak, abs);
    unlinkSync(bak);
  }
  return { rel, result: code !== 0 ? 'CAUGHT' : 'MISSED', code, output, expect };
}

const T = join(ROOT, 'tools');

const CASES = [
  // ── A 组：契约/模板被改坏，有没有校验器会响 ──
  mutate(
    'framework/templates/wave2-audit.md',
    (s) => s.replace(/(### 4\.8\.2[^\n]*)/, '$1\n\n| **99** | 探针：故意插入的假模式 | **已证实** | **硬检查项** |'),
    [['check-pattern-coverage.mjs'], T],
    '在「高频缺陷模式」清单里插一条假模式 99（审查员会去查一个不存在的模式）',
  ),
  mutate(
    'framework/templates/wave2-audit.md',
    (s) => s.replace(/门 0/g, '门 0-探针改坏'),
    [['check-rule-doc-link.mjs'], T],
    '把模板里所有「门 0」改坏——门 0 是框架最核心的证据规则',
  ),
  mutate(
    'framework/components/output-contract.md',
    (s) => s.replace(/\|\s*`status`\s*\|/, '| `status_RENAMED` |'),
    [['check-payload.mjs', 'framework/components/output-contract/examples/audit.md', '--role', 'audit'], T],
    '契约里把必填字段 status 改名（照契约写产物的 Agent 会全部失败）',
  ),
  mutate(
    'framework/wrappers/audit-specialist.md',
    (s) => s.replace(/门\s*0|Gate\s*0/g, '（已删除）'),
    [['check-wrapper-contract.mjs'], T],
    '从 audit wrapper 里删掉门 0 的全部表述',
  ),
  // ── B 组：run-state / protocol 被改坏 ──
  mutate(
    'framework/artifacts/run-state.md',
    (s) => s.replace(/IN_PROGRESS/g, 'IN_PROGRESSZZZ'),
    [['simulate-round-chain.mjs'], T],
    'state.json 的核心状态枚举被改名',
  ),
  mutate(
    'framework/artifacts/round-detection.md',
    (s) => s.replace(/round\((\\d\+|\\d\+)/, 'roundX($1'),
    [['check-round-detection.mjs', '--self-test'], T],
    '轮次探测正则被改坏',
  ),
  // ── C 组：契约切片与总契约脱钩 ──
  mutate(
    'framework/components/output-contract/verify.md',
    (s) => s.replace(/input_space_basis/g, 'input_space_basis_REMOVED'),
    [['check-contract-slices.mjs'], T],
    'verify 切片删掉一个总契约要求的必填字段',
  ),
  // ── D 组：术语表被绕过 ──
  mutate(
    'framework/templates/wave1-recon.md',
    (s) => s.replace(/子 Agent/g, '子Agent'),
    [['lint-terminology.mjs'], T],
    '把「子 Agent」批量写成「子Agent」（违反术语规范）',
  ),
];

console.log('变异测试 v2\n');
console.log('结果              现实错误');
console.log('─'.repeat(90));
let caught = 0, missed = 0, noop = 0;
for (const c of CASES) {
  const mark = c.result === 'CAUGHT' ? '✓ CAUGHT'
    : c.result === 'MISSED' ? '✗ MISSED'
      : `? ${c.result}`;
  console.log(`${mark.padEnd(16)} ${c.expect}`);
  console.log(`${''.padEnd(16)} ← ${c.rel}`);
  if (c.result === 'CAUGHT') caught++;
  else if (c.result === 'MISSED') {
    missed++;
    const tail = String(c.output).trim().split('\n').slice(-2).join(' / ');
    console.log(`${''.padEnd(16)}   exit=${c.code}  ${tail.slice(0, 120)}`);
  } else noop++;
  console.log('');
}
console.log('─'.repeat(90));
console.log(`抓到 ${caught} / 漏掉 ${missed} / 探针无效 ${noop}  （总计 ${CASES.length}）`);
