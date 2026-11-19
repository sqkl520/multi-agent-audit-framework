// 公平变异测试：每个变异都跑「全套 36 个检查」而非单一检查器。
// 只有全套都不响，才算「这个错误没有被任何东西看见」。
import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOT = process.cwd();
const T = join(ROOT, 'tools');

function fullSuite() {
  try {
    const out = execFileSync('node', ['check-all.mjs'], { encoding: 'utf8', cwd: T, stdio: ['ignore','pipe','pipe'], timeout: 480000 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 'SIG', out: (e.stdout ?? '') + (e.stderr ?? '') };
  }
}

function mutate(rel, fn, expect) {
  const abs = join(ROOT, rel);
  const bak = abs + '.mutbak';
  copyFileSync(abs, bak);
  let code = 0, out = '', failedLines = [];
  try {
    const orig = readFileSync(abs, 'utf8');
    const next = fn(orig);
    if (next === undefined || next === orig) {
      return { rel, result: 'NOOP', expect };
    }
    writeFileSync(abs, next);
    const r = fullSuite();
    code = r.code; out = r.out;
    if (code !== 0) {
      // 找出是哪个套件失败
      const lines = out.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (/^✗/.test(lines[i].trim())) failedLines.push(lines[i].trim());
      }
    }
  } finally {
    copyFileSync(bak, abs);
    unlinkSync(bak);
  }
  return { rel, result: code !== 0 ? 'CAUGHT' : 'MISSED', failedLines, expect };
}

const CASES = [
  mutate('framework/templates/wave2-audit.md',
    (s) => s.replace(/(### 4\.8\.2[^\n]*)/, '$1\n\n| **99** | 探针：故意插入的假模式 | **已证实** | **硬检查项** |'),
    '高频缺陷模式清单里插一条假模式 99'),

  mutate('framework/templates/wave2-audit.md',
    (s) => s.replace(/门 0/g, '门 0探针'),
    '模板里每条「门 0」都被改坏（门 0 = 框架最核心证据规则）'),

  mutate('framework/wrappers/audit-specialist.md',
    (s) => s.replace(/门\s*0|Gate\s*0/g, '（已删）'),
    'audit wrapper 里删除全部「门 0」表述'),

  mutate('framework/artifacts/run-state.md',
    (s) => s.replace(/IN_PROGRESS/g, 'IN_PROGRESSZZZ'),
    'state 核心枚举 IN_PROGRESS 被改名'),

  mutate('framework/artifacts/round-detection.md',
    (s) => s.replace(/\^round\(\d\+\)\(\[a-z\]\*\)\$/g, '^roundX($1)'),
    '轮次探测正则被改坏'),

  mutate('framework/components/output-contract/verify.md',
    (s) => s.replace(/input_space_basis/g, 'input_space_basisGONE'),
    'verify 切片删掉必填字段 input_space_basis'),

  mutate('framework/templates/wave2a-sweep.md',
    (s) => s.replace(/子 Agent/g, '子Agent').replace(/子Agent(?=.*)/, '子Agent'),
    '宽扫模板术语写错（子 Agent → 子Agent）'),

  mutate('framework/components/handoff-schema.md',
    (s) => s.replace(/PARTIALLY_CLOSED/g, 'PARTIALLY_CLOSEDX'),
    'handoff 契约里的枚举被改名'),

  mutate('framework/artifacts/report-naming.md',
    (s) => s.replace(/\\.md\$/g, '\.js$'),
    '报告命名正则允许 .js 后缀'),

  mutate('framework/components/evidence-policy.md',
    (s) => s.replace(/门\s*0/g, '门 0探针改'),
    '证据政策文件里所有「门 0」被改坏'),
];

console.log('公平变异测试（每个变异跑全套 36 项检查）\n');
let caught = 0, missed = 0, noop = 0;
for (const c of CASES) {
  const mk = c.result === 'CAUGHT' ? '✓ 抓到' : c.result === 'MISSED' ? '✗ 漏掉' : '? 无效';
  console.log(`${mk.padEnd(8)} ${c.expect}`);
  console.log(`${''.padEnd(8)} ${c.rel}`);
  if (c.result === 'CAUGHT') { caught++; if (c.failedLines.length) console.log(`${''.padEnd(8)} 由这些套件抓到: ${c.failedLines.join(' | ').slice(0,150)}`); }
  else if (c.result === 'MISSED') missed++;
  else noop++;
  console.log('');
}
console.log('─'.repeat(80));
console.log(`抓到 ${caught} / 漏掉 ${missed} / 探针无效 ${noop}`);
