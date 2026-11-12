#!/usr/bin/env node
/**
 * check-deliverables.test.mjs — 交付物检查器的自测
 *
 * 每个 case 构造一个真实的轮次目录，验证：
 *   - 两类必交付缺失时报 FAIL
 *   - 报告缺节时报 FAIL
 *   - 覆盖率无分母时报 WARN
 *   - 自由命名文件报 WARN
 *   - 子目录报 WARN
 *   - 完整合规时不报错
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'check-deliverables.mjs');
let pass = 0, fail = 0;
const expect = (n, c, d = '') => {
  if (c) { pass++; console.log(`  ✓ ${n}`); }
  else { fail++; console.log(`  ✗ ${n}${d ? ' — ' + d : ''}`); }
};
;

function run(dir) {
  try {
    const out = execFileSync('node', [SCRIPT, '--round-dir', dir, '--json'], { encoding: 'utf8' });
    return JSON.parse(out);
  } catch (e) {
    try { return JSON.parse(e.stdout); } catch { return { error: e.stdout + e.stderr }; }
  }
}

const has = (r, level, rule) => (r.findings ?? []).some((f) => f.level === level && f.rule === rule);

function fixture(roundId, files) {
  const root = mkdtempSync(join(tmpdir(), 'cd-test-'));
  const dir = join(root, roundId);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    if (content === null) mkdirSync(join(dir, name), { recursive: true });
    else writeFileSync(join(dir, name), content);
  }
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const FULL_REPORT = `# round9 审计报告

## 0. 一句话结论
三行以内。

## 1. 元信息
| 项 | 值 |

## 2. 覆盖说明
覆盖率 3/8 = 37.5%

## 3. 发现汇总
| id |

## 4. 失败与未闭合
| item |

## 5. 零写入自证
git status 输出

## 6. 下一步
自动开 round10。
`;

const FULL_LEDGER = `# round9 账本

## 1. 切片状态表
| slice |

## 2. 预算
| cap |

## 3. 失败分类
| slice |

## 4. 裁量日志
| seq |
`;

console.log('\n=== 交付物检查器自测 ===\n');

// 1. 完整合规 → 全 PASS
console.log('case 1: 两类交付物齐全且结构完整 → 全 PASS');
{
  const f = fixture('round9', {
    'round9-final-report.md': FULL_REPORT,
    'round9-ledger.md': FULL_LEDGER,
    'round9-02-sweep-slice-01.md': '# sweep\n',
    'state.json': '{}',
  });
  const r = run(f.dir);
  expect('无 FAIL', !has(r, 'FAIL', 'D1') && !has(r, 'FAIL', 'D2') && !has(r, 'FAIL', 'D3'),
    JSON.stringify((r.findings ?? []).filter(x => x.level === 'FAIL')));
  expect('无 WARN', (r.counts?.WARN ?? 0) === 0, JSON.stringify((r.findings ?? []).filter(x => x.level === 'WARN')));
  f.cleanup();
}

// 2. 缺 ledger → FAIL
console.log('case 2: 缺 ledger → D1 FAIL');
{
  const f = fixture('round9', {
    'round9-final-report.md': FULL_REPORT,
    'round9-02-sweep-slice-01.md': '# x\n',
  });
  const r = run(f.dir);
  expect('D1 判 FAIL', has(r, 'FAIL', 'D1'));
  expect('报出 ledger 缺失', JSON.stringify(r.findings).includes('ledger'), JSON.stringify(r.findings.filter(x => x.level === 'FAIL')));
  f.cleanup();
}

// 3. 缺报告 → FAIL
console.log('case 3: 缺 final-report → D1 FAIL');
{
  const f = fixture('round9', { 'round9-ledger.md': FULL_LEDGER });
  const r = run(f.dir);
  expect('D1 判 FAIL', has(r, 'FAIL', 'D1'));
  f.cleanup();
}

// 4. 报告缺节 → FAIL
console.log('case 4: 报告缺「零写入自证」→ D2 FAIL');
{
  const broken = FULL_REPORT.replace('## 5. 零写入自证\ngit status 输出\n', '');
  const f = fixture('round9', {
    'round9-final-report.md': broken,
    'round9-ledger.md': FULL_LEDGER,
  });
  const r = run(f.dir);
  const d2 = (r.findings ?? []).find((x) => x.rule === 'D2' && x.level === 'FAIL');
  expect('D2 判 FAIL', !!d2);
  expect('报出缺哪节', /零写入/.test(d2?.msg ?? ''), d2?.msg);
  f.cleanup();
}

// 5. 空文件 → FAIL
console.log('case 5: 交付物是空文件 → D1 FAIL');
{
  const f = fixture('round9', {
    'round9-final-report.md': '',
    'round9-ledger.md': FULL_LEDGER,
  });
  const r = run(f.dir);
  expect('D1 判 FAIL', has(r, 'FAIL', 'D1'));
  f.cleanup();
}

// 6. 覆盖率无分母 → WARN
console.log('case 6: 覆盖率写法不合规 → WARN');
{
  const noCov = FULL_REPORT.replace('覆盖率 3/8 = 37.5%', '覆盖率很高');
  const f = fixture('round9', {
    'round9-final-report.md': noCov,
    'round9-ledger.md': FULL_LEDGER,
  });
  const r = run(f.dir);
  expect('D2 判 WARN', has(r, 'WARN', 'D2'));
  expect('不判 FAIL', !has(r, 'FAIL', 'D2'), JSON.stringify((r.findings ?? []).filter(x => x.level === 'FAIL')));
  f.cleanup();
}

// 7. 自由命名文件 → WARN
console.log('case 7: 目录里有自由命名的文件 → D4 WARN');
{
  const f = fixture('round9', {
    'round9-final-report.md': FULL_REPORT,
    'round9-ledger.md': FULL_LEDGER,
    '命令处理器.md': '自由命名',
    'random-notes.txt': 'x',
  });
  const r = run(f.dir);
  expect('D4 判 WARN', has(r, 'WARN', 'D4'));
  f.cleanup();
}

// 8. 有子目录 → WARN
console.log('case 8: 出现子目录（违反扁平）→ D5 WARN');
{
  const f = fixture('round9', {
    'round9-final-report.md': FULL_REPORT,
    'round9-ledger.md': FULL_LEDGER,
    'deliverables': null,   // 目录
  });
  const r = run(f.dir);
  expect('D5 判 WARN', has(r, 'WARN', 'D5'));
  f.cleanup();
}

// 9. 账本缺节 → FAIL
console.log('case 9: 账本缺「失败分类」→ D3 FAIL');
{
  const broken = FULL_LEDGER.replace('## 3. 失败分类\n| slice |\n', '');
  const f = fixture('round9', {
    'round9-final-report.md': FULL_REPORT,
    'round9-ledger.md': broken,
  });
  const r = run(f.dir);
  expect('D3 判 FAIL', has(r, 'FAIL', 'D3'));
  f.cleanup();
}



console.log('case 10: 报告缺「证据覆盖率」→ D2b FAIL');
{
  const f = fixture('round10', { 'round10-final-report.md': FULL_REPORT });
  const r = run(f.dir);
  expect('D2b 判 FAIL', has(r, 'FAIL', 'D2b'));
  f.cleanup();
}

console.log('case 11: 有证据覆盖率且 >5% → D2b PASS');
{
  const rep = FULL_REPORT.replace(
    '覆盖率 3/8 = 37.5%',
    '覆盖率 3/8 = 37.5%\n\n证据覆盖率 = 42 / 80 = 52.5%',
  );
  const f = fixture('round11', { 'round11-final-report.md': rep });
  const r = run(f.dir);
  expect('D2b 判 PASS', (r.findings ?? []).some(x => x.rule === 'D2b' && x.level === 'PASS'));
  f.cleanup();
}

console.log(`
=== 结果: ${pass} 通过 / ${fail} 失败 ===
`);
process.exit(fail > 0 ? 1 : 0);
